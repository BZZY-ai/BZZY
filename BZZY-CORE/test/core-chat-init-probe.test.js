import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { learningDisabledFeatures } from '../src/engine/learning-backend.js';

const script = fileURLToPath(new URL('../scripts/core-chat-init-probe.py', import.meta.url));
let directory, binary, log, owner;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-init-probe-test-')));
  binary = path.join(directory, 'synthetic codex.py'); log = path.join(directory, 'calls.jsonl'); owner = path.join(directory, 'owner');
  fs.mkdirSync(owner); fs.writeFileSync(path.join(owner, 'auth.json'), 'SYNTHETIC_PRIVATE_OWNER_AUTH');
  fs.writeFileSync(path.join(owner, 'config.toml'), 'SYNTHETIC_PRIVATE_OWNER_CONFIG');
});
test.afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
function run(mode = 'success', timeout) {
  fs.writeFileSync(binary, `#!/usr/bin/env python3
import json,os,sys,signal,time
if '--version' in sys.argv: print('codex-cli 0.162.0'); sys.exit(23 if ${JSON.stringify(mode)}=='version-exit' else 0)
def log(value):
 with open(${JSON.stringify(log)},'a') as output: output.write(json.dumps(value)+'\\n')
args=sys.argv[1:]; catalog=None
for value in args:
 if value.startswith('model_catalog_json='):
  with open(json.loads(value.split('=',1)[1])) as source: catalog=json.load(source)
log({'args':args,'cwd':os.getcwd(),'home':os.environ['HOME'],'codexHome':os.environ['CODEX_HOME'],'keys':list(os.environ),'catalog':catalog})
mode=${JSON.stringify(mode)}
if mode=='exit': sys.stderr.write('unknown configuration field SYNTHETIC_PRIVATE_STDERR_DETAIL'); sys.exit(23)
if mode=='flood': sys.stderr.write('SYNTHETIC_PRIVATE_STDERR_DETAIL'*10000); sys.stderr.flush(); time.sleep(20)
if mode=='timeout':
 signal.signal(signal.SIGTERM,signal.SIG_IGN)
 time.sleep(20)
for line in sys.stdin:
 request=json.loads(line); log({'method':request.get('method')})
 if request.get('method')=='initialize':
  print(json.dumps({'id':1,'error':{'code':-32602,'message':'SYNTHETIC_PRIVATE_RPC_DETAIL'}} if mode=='rpc' else {'id':1,'result':{}}),flush=True)
`, { mode: 0o700 });
  const args = [script, '--codex', binary, ...(timeout ? ['--timeout', String(timeout)] : [])];
  const child = spawnSync('python3', args, { env: { PATH: process.env.PATH, HOME: owner, CODEX_HOME: owner, BZZY_HOME: owner,
    OPENAI_API_KEY: 'SYNTHETIC_PRIVATE_ACCOUNT_KEY', DEEPSEEK_API_KEY: 'SYNTHETIC_PRIVATE_ACCOUNT_KEY' },
    encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, '');
  assert.doesNotMatch(child.stdout, /SYNTHETIC_PRIVATE/);
  return JSON.parse(child.stdout);
}
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);

test('the portable probe uses production restricted flags and synthetic input only, sends no thread/model requests, and removes its own state', () => {
  const result = run(); assert.equal(result.native.version, '0.162.0'); assert.equal(result.modelTurnsStarted, 0);
  assert.equal(result.ownedProcessCleanup, 'complete'); assert.equal(result.ownerStateRead, false);
  assert.ok(Object.values(result.cases).every(row => row.state === 'initialized'));
  const records = calls(), processes = records.filter(row => row.args);
  assert.equal(processes.length, 2);
  for (const row of records.filter(row => row.method)) assert.ok(['initialize', 'initialized'].includes(row.method));
  assert.equal(records.filter(row => row.method === 'initialize').length, 2);
  for (const row of processes) {
    assert.notEqual(row.home, owner); assert.notEqual(row.codexHome, owner); assert.ok(row.cwd.startsWith('/private/tmp/bzzy-chat-init-') || row.cwd.startsWith('/tmp/bzzy-chat-init-'));
    assert.equal(row.keys.includes('OPENAI_API_KEY'), false); assert.equal(row.keys.includes('DEEPSEEK_API_KEY'), false);
    assert.equal(fs.existsSync(row.home), false); assert.equal(fs.existsSync(row.codexHome), false); assert.equal(fs.existsSync(row.cwd), false);
    assert.ok(row.args.includes('--strict-config'));
    const overrides = new Map(row.args.filter((_, index) => row.args[index - 1] === '-c').map(value => {
      const split = value.indexOf('='); return [value.slice(0, split), value.slice(split + 1)];
    }));
    for (const feature of learningDisabledFeatures) assert.equal(overrides.get('features.' + feature), 'false', feature);
    assert.equal(overrides.get('features.skip_host_skill_discovery'), 'true');
    assert.equal(overrides.get('default_permissions'), '"bzzy_learning_review_v1"');
    assert.match(overrides.get('permissions.bzzy_learning_review_v1'), /":root" = "deny"/);
    assert.match(overrides.get('permissions.bzzy_learning_review_v1'), /"network" = \{"enabled" = false\}/);
    assert.equal(overrides.get('mcp_servers'), '{}'); assert.equal(overrides.get('web_search'), '"disabled"');
    assert.equal(overrides.get('cli_auth_credentials_store'), '"file"');
    assert.ok(row.cwd.includes('/.bzzy/runtime/learning/'));
    assert.ok(row.codexHome.includes('/.bzzy/runtime/agent-backends/'));
    assert.equal(overrides.get('projects'), '{' + JSON.stringify(row.cwd) + ' = {"trust_level" = "untrusted"}}');
    assert.equal([...overrides.keys()].some(key => key.startsWith('projects.')), false);
  }
  const api = processes.find(row => row.catalog); assert.equal(api.catalog.models[0].slug, 'bzzy-initialize-probe');
  assert.equal(api.catalog.models[0].context_window, 32768);
  assert.equal(fs.readFileSync(path.join(owner, 'auth.json'), 'utf8'), 'SYNTHETIC_PRIVATE_OWNER_AUTH');
  assert.equal(fs.readFileSync(path.join(owner, 'config.toml'), 'utf8'), 'SYNTHETIC_PRIVATE_OWNER_CONFIG');
});

test('instant backend exit and RPC rejection expose only safe bounded diagnostics', () => {
  let result = run('exit');
  for (const row of Object.values(result.cases)) assert.deepEqual(row, { state: 'failed', category: 'configuration_rejected', exitCode: 23 });
  result = run('rpc');
  for (const row of Object.values(result.cases)) assert.deepEqual(row, { state: 'failed', category: 'rpc_rejected', rpcCode: -32602 });
});

test('a failed version command never starts the native app server', () => {
  const result = run('version-exit');
  assert.equal(result.category, 'version_check_failed');
  assert.equal(result.native.state, 'failed'); assert.equal(result.native.exitCode, 23);
  assert.deepEqual(result.cases, {}); assert.equal(fs.existsSync(log), false);
});

test('output floods and unresponsive processes are bounded and cleaned up without private output', () => {
  let result = run('flood', 0.5);
  for (const row of Object.values(result.cases)) assert.deepEqual(row, { state: 'failed', category: 'output_limit' });
  result = run('timeout', 0.2);
  for (const row of Object.values(result.cases)) assert.deepEqual(row, { state: 'failed', category: 'timeout' });
  assert.equal(result.ownedProcessCleanup, 'complete');
});
