import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexLaunch } from '../src/engine/engines/codex.js';
import { learningDisabledFeatures, learningWorkingDirectory } from '../src/engine/learning-backend.js';
import { createSession } from '../src/engine/store.js';
import { BUILTINS, saveConfig } from '../src/engine/providers.js';
import { launch } from '../src/engine/process.js';
import { Rpc } from '../src/engine/rpc.js';
import { rpcFailure } from '../src/engine/rpc-failure.js';

const nativeBinary = process.env.BZZY_TEST_NATIVE_CODEX;
let directory, priorEnvironment, executable, providers;
test.beforeEach(() => {
  priorEnvironment = process.env;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-restricted-config-')));
  const owner = path.join(directory, 'owner'), auth = path.join(owner, '.codex');
  fs.mkdirSync(auth, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(auth, 'auth.json'), '{}', { mode: 0o600 });
  executable = path.join(directory, 'synthetic .codex "資料" executable');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  // An entirely new environment prevents real account variables or owner
  // configuration from entering even an explicitly opted-in native check.
  process.env = { PATH: priorEnvironment.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: owner, CODEX_HOME: auth,
    BZZY_HOME: path.join(owner, '.bzzy "資料"'), BZZY_CODEX_HOME: auth, BZZY_CODEX_BIN: executable,
    DEEPSEEK_API_KEY: 'synthetic-not-an-account-key', EXPLABS_API_KEY: 'synthetic-not-an-account-key', TMPDIR: directory };
  providers = { codex: { ...BUILTINS.codex }, deepseek: { ...BUILTINS.deepseek, baseUrl: 'http://127.0.0.1:9/v1' },
    experiential: { ...BUILTINS.experiential, baseUrl: 'http://127.0.0.1:9/v1' } };
  saveConfig({ version: 1, providers });
});
test.afterEach(() => {
  process.env = priorEnvironment;
  fs.rmSync(directory, { recursive: true, force: true });
});

function prepare(mode, providerId = 'codex', effort = 'default') {
  const provider = providers[providerId], session = createSession(provider, process.env.BZZY_HOME, provider.model || 'gpt-6.1-sol');
  const options = { yolo: false, tokenBudget: 12000, policy: { mode: 'read-only', network: 'disabled', writablePaths: [] }, maxTurns: 1 };
  if (mode === 'agent') {
    session.cwd = path.join(directory, 'agent .bzzy "資料" work', session.id); fs.mkdirSync(session.cwd, { mode: 0o700, recursive: true });
    options.agentScope = { agentId: 'fixture-agent', cwd: session.cwd, projectRoot: session.cwd };
  } else {
    session.cwd = learningWorkingDirectory(session.id); session.role = 'learning-review'; options.learningReview = true;
    if (mode === 'document') { session.purpose = 'document'; options.documentOnly = true; options.documentTaskInstructions = 'Assess synthetic supplied state only.'; }
  }
  session.selectedEffort = effort;
  return { session, options, config: codexLaunch(provider, session, options) };
}
function values(args, key) {
  return args.filter((value, index) => args[index - 1] === '-c' && value.startsWith(key + '=')).map(value => value.slice(key.length + 1));
}

for (const mode of ['document', 'learning', 'agent']) test(`${mode} launch encodes a literal dotted/quoted/Unicode project path while preserving its isolated restrictions`, () => {
  const { session, config } = prepare(mode), profileName = mode === 'agent' ? 'bzzy_agent_isolated_v1' : 'bzzy_learning_review_v1';
  assert.match(session.cwd, /\.bzzy/); assert.match(session.cwd, /"資料"/);
  assert.deepEqual(values(config.args, 'projects'), ['{' + JSON.stringify(session.cwd) + ' = {"trust_level" = "untrusted"}}']);
  assert.equal(config.args.some((value, index) => config.args[index - 1] === '-c' && value.startsWith('projects.')), false,
    'Strict Codex treats the dynamic quoted path as an unknown dotted override');
  assert.deepEqual(values(config.args, 'default_permissions'), [JSON.stringify(profileName)]);
  assert.deepEqual(values(config.args, 'approval_policy'), ['"never"']);
  const [profile] = values(config.args, 'permissions.' + profileName);
  for (const marker of ['":root" = "deny"', '":minimal" = "read"', '":tmpdir" = "deny"', '":slash_tmp" = "deny"',
    JSON.stringify(session.cwd) + ' = "read"', JSON.stringify(fs.realpathSync(executable)) + ' = "read"', '"network" = {"enabled" = false}']) assert.ok(profile.includes(marker), marker);
  const disabled = mode === 'agent' ? ['shell_tool', 'multi_agent', 'multi_agent_v2', 'view_image', 'image_generation',
    'apps', 'plugins', 'remote_plugin', 'hooks', 'skill_search', 'skill_mcp_dependency_install'] : learningDisabledFeatures;
  for (const feature of disabled) assert.ok(values(config.args, 'features.' + feature).every(value => value === 'false') && values(config.args, 'features.' + feature).length > 0, feature);
  assert.deepEqual(values(config.args, 'features.skip_host_skill_discovery'), ['true']);
  assert.deepEqual(values(config.args, 'shell_environment_policy.inherit'), ['"none"']);
  assert.deepEqual(values(config.args, 'shell_environment_policy.set'), ['{"PATH" = "/usr/bin:/bin"}']);
  assert.ok(values(config.args, 'mcp_servers').every(value => value === '{}'));
  assert.ok(values(config.args, 'web_search').every(value => value === '"disabled"'));
  if (mode !== 'agent') {
    assert.deepEqual(values(config.args, 'project_doc_max_bytes'), ['0']);
    assert.deepEqual(values(config.args, 'project_doc_fallback_filenames'), ['[]']);
  }
  assert.equal(config.args.includes('--strict-config'), mode !== 'agent');
});

test('opt-in official Codex initializes the actual restricted launch matrix without auth, threads or model work',
  { skip: !nativeBinary, timeout: 45000 }, async () => {
    assert.ok(path.isAbsolute(nativeBinary), 'BZZY_TEST_NATIVE_CODEX must explicitly name an absolute executable path');
    executable = fs.realpathSync(nativeBinary); process.env.BZZY_CODEX_BIN = executable;
    const variants = [['document', 'codex', 'default'], ['document', 'codex', 'high'], ['document', 'codex', 'max'],
      ['document', 'deepseek', 'default'], ['document', 'deepseek', 'high'], ['document', 'deepseek', 'max'],
      ['document', 'experiential', 'default'], ['document', 'experiential', 'none'], ['document', 'experiential', 'high'], ['document', 'experiential', 'max'],
      ['learning', 'codex', 'default'], ['learning', 'deepseek', 'high'], ['learning', 'experiential', 'none'],
      ['agent', 'codex', 'default'], ['agent', 'deepseek', 'max'], ['agent', 'experiential', 'high']];
    for (const [mode, provider, effort] of variants) {
      const { session, config } = prepare(mode, provider, effort);
      // Force file-only authentication storage for the diagnostic's empty
      // synthetic account home; all production restriction arguments remain.
      config.args.push('-c', 'cli_auth_credentials_store="file"');
      const rpc = new Rpc(launch('codex', config.args, { env: config.env, cwd: session.cwd, stdio: ['pipe', 'pipe', 'pipe'],
        canonicalExecutable: true }), async () => { throw new Error('The initialize-only test exposes no tools.'); });
      rpc.on('failure', () => {});
      let failure;
      try {
        await rpc.request('initialize', { clientInfo: { name: 'bzzy', title: 'bzzy', version: '0.2.0' }, capabilities: { experimentalApi: true } }, 3000);
        rpc.notify('initialized');
      } catch (error) { failure = { rpcCode: error.rpcCode, transportFailure: rpcFailure(error) }; }
      finally { await rpc.close(); }
      assert.equal(failure, undefined, JSON.stringify({ mode, provider, effort, failure }));
    }
  });
