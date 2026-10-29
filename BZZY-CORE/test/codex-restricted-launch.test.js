import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { codexLaunch, assertProgramScopeCodexConfig, CodexEngine } from '../src/engine/engines/codex.js';
import { learningDisabledFeatures, learningWorkingDirectory } from '../src/engine/learning-backend.js';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS, saveConfig } from '../src/engine/providers.js';
import { launch } from '../src/engine/process.js';
import { Rpc } from '../src/engine/rpc.js';
import { rpcFailure } from '../src/engine/rpc-failure.js';
import { initializeProject } from '../src/engine/project.js';
import { newGoal } from '../src/engine/goals.js';
import { normalizeContract } from '../src/engine/contracts.js';
import { getRecord } from '../src/engine/database.js';
import { programScopeOperation, programScopePermissionProfile, programScopeDisabledFeatures } from '../src/engine/program-scope.js';
import { sandboxSupport } from '../src/engine/policy.js';

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

function prepare(mode, providerId = 'codex', effort = 'default', { simpleScope = false } = {}) {
  if (simpleScope) { process.env.BZZY_HOME = path.join(directory, 'scope-private'); fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 }); }
  const provider = providers[providerId]; let session = createSession(provider, process.env.BZZY_HOME, provider.model || 'gpt-6.1-sol');
  const options = { yolo: false, tokenBudget: 12000, policy: { mode: 'read-only', network: 'disabled', writablePaths: [] }, maxTurns: 1 };
  if (mode === 'agent') {
    session.cwd = path.join(directory, 'agent .bzzy "資料" work', session.id); fs.mkdirSync(session.cwd, { mode: 0o700, recursive: true });
    options.agentScope = { agentId: 'fixture-agent', cwd: session.cwd, projectRoot: session.cwd };
  } else if (mode === 'scope') {
    session.cwd = path.join(directory, simpleScope ? 'scope-work' : 'scope .bzzy "資料" work', session.id); fs.mkdirSync(session.cwd, { mode: 0o700, recursive: true });
    initializeProject(session); session.goal = newGoal('Review synthetic scope.', 1000); session.contract = normalizeContract({}, session.goal.objective); session.policy = session.contract.policy; saveSession(session);
    const proposal = programScopeOperation('scope.propose', { reviewed: true, requestId: 'proposal', expectedRevision: 0,
      scope: { allowedTargets: ['test.invalid'], allowedActions: ['GET'], networkMode: 'mediated' }, sources: [{ reference: 'synthetic source', sha256: 'a'.repeat(64) }] }, { session });
    const approval = programScopeOperation('scope.approve', { reviewed: true, requestId: 'approve', expectedRevision: 1, proposalId: proposal.proposal.id }, { session });
    programScopeOperation('scope.continue', { reviewed: true, requestId: 'continue', expectedRevision: 2, approvalId: approval.approval.id, expectedGoalId: session.goal.id }, { session });
    session = getRecord('session', session.id); options.policy = session.policy; options.strictPolicy = true;
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

function scopeConfig(config) {
  return { default_permissions: programScopePermissionProfile, permissions: { [programScopePermissionProfile]: config.scopePermissions },
    approval_policy: 'never', web_search: 'disabled', mcp_servers: {}, features: { ...Object.fromEntries(programScopeDisabledFeatures.map(name => [name, false])), skip_host_skill_discovery: true },
    shell_environment_policy: { inherit: 'none', set: { PATH: '/usr/bin:/bin' } }, project_doc_max_bytes: 0 };
}
test('scoped native launch blocks all inherited egress and requires an acknowledged effective configuration', () => {
  const { session, config } = prepare('scope');
  assert.equal(config.scopeAdmission.nativeProfile, programScopePermissionProfile);
  assert.ok(config.args.includes('--strict-config')); assert.ok(config.args.includes('goals'));
  assert.deepEqual(values(config.args, 'default_permissions'), [JSON.stringify(programScopePermissionProfile)]);
  assert.equal(values(config.args, 'sandbox_mode').length, 0);
  assert.equal(config.scopePermissions.network.enabled, false);
  assert.equal(config.scopePermissions.filesystem[session.engineHome], 'deny');
  const effective = scopeConfig(config);
  assert.doesNotThrow(() => assertProgramScopeCodexConfig({ config: effective }, config.scopePermissions));
  const changed = change => { const bad = structuredClone(effective); change(bad); assert.throws(() => assertProgramScopeCodexConfig({ config: bad }, config.scopePermissions), /No thread or turn/); };
  changed(value => { value.permissions[programScopePermissionProfile].network.enabled = true; });
  changed(value => { value.features.hooks = true; });
  changed(value => { value.mcp_servers.inherited = { url: 'https://test.invalid/mcp' }; });
  changed(value => { value.permissions[programScopePermissionProfile].filesystem[':root'] = 'write'; });
  changed(value => { delete value.permissions; });
});

for (const failure of ['config', 'profile', 'activation']) test(`scoped adapter refuses unacknowledged ${failure} before any turn`, async t => {
  if (!sandboxSupport()) { t.skip('Requires the enforced native OS sandbox.'); return; }
  executable = fileURLToPath(new URL('./fixtures/program-scope-codex.mjs', import.meta.url)); process.env.BZZY_CODEX_BIN = executable;
  const { session, options, config } = prepare('scope');
  fs.writeFileSync(path.join(session.engineHome, 'fixture-config.json'), JSON.stringify({ config: scopeConfig(config), failure }));
  const engine = new CodexEngine(providers.codex, session, options, { event() {}, newline() {} });
  try {
    await assert.rejects(engine.open(), failure === 'config' ? /restricted program-scope configuration/ : failure === 'profile' ? /required isolated permission profile/ : /restricted program-scope profile/);
    const calls = fs.readFileSync(path.join(session.engineHome, 'fixture-calls.jsonl'), 'utf8');
    assert.doesNotMatch(calls, /"method":"turn\/start"|"method":"thread\/goal\/set"/);
    if (failure !== 'activation') assert.doesNotMatch(calls, /"method":"thread\/start"/);
  } finally { await engine.close(); }
});

test('opt-in official Codex initializes the actual restricted launch matrix without auth, threads or model work',
  { skip: !nativeBinary, timeout: 45000 }, async () => {
    assert.ok(path.isAbsolute(nativeBinary), 'BZZY_TEST_NATIVE_CODEX must explicitly name an absolute executable path');
    executable = fs.realpathSync(nativeBinary); process.env.BZZY_CODEX_BIN = executable;
    const variants = [['document', 'codex', 'default'], ['document', 'codex', 'high'], ['document', 'codex', 'max'],
      ['document', 'deepseek', 'default'], ['document', 'deepseek', 'high'], ['document', 'deepseek', 'max'],
      ['document', 'experiential', 'default'], ['document', 'experiential', 'none'], ['document', 'experiential', 'high'], ['document', 'experiential', 'max'],
      ['learning', 'codex', 'default'], ['learning', 'deepseek', 'high'], ['learning', 'experiential', 'none'],
      ['agent', 'codex', 'default'], ['agent', 'deepseek', 'max'], ['agent', 'experiential', 'high'], ['scope', 'codex', 'default']];
    for (const [mode, provider, effort] of variants) {
      // Codex 0.165's macOS sandbox currently rejects quoted Unicode paths at
      // command dispatch. Keep exotic-path config coverage above, and exercise
      // actual native isolation in a plain synthetic workspace here.
      const { session, config } = prepare(mode, provider, effort, { simpleScope: mode === 'scope' });
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
        if (mode === 'scope') {
          const effective = await rpc.request('config/read', { cwd: session.cwd, includeLayers: false });
          assertProgramScopeCodexConfig(effective, config.scopePermissions);
          const profiles = await rpc.request('permissionProfile/list', {});
          assert.ok(profiles.data.some(profile => profile.id === programScopePermissionProfile && profile.allowed === true));
          const local = await rpc.request('command/exec', { command: ['/bin/sh', '-c', 'printf scoped > native-scope-fixture.txt'], cwd: session.cwd, timeoutMs: 3000 });
          assert.equal(local.exitCode, 0, JSON.stringify(local)); assert.equal(fs.readFileSync(path.join(session.cwd, 'native-scope-fixture.txt'), 'utf8'), 'scoped');
          let connections = 0;
          const listener = net.createServer(socket => { connections++; socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'); });
          await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
          try {
            const denied = await rpc.request('command/exec', { command: ['/usr/bin/curl', '--silent', '--show-error', '--max-time', '2', `http://127.0.0.1:${listener.address().port}/`], cwd: session.cwd, timeoutMs: 3000 });
            assert.equal(denied.exitCode, 7); assert.match(denied.stderr, /^curl: /m);
            assert.equal(connections, 0, 'Native command networking must not reach even a loopback listener.');
          } finally { await new Promise(resolve => listener.close(resolve)); }
        }
      } catch (error) { failure = { rpcCode: error.rpcCode, transportFailure: rpcFailure(error), message: error.message }; }
      finally { await rpc.close(); }
      assert.equal(failure, undefined, JSON.stringify({ mode, provider, effort, failure }));
    }
  });
