import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from '../src/cli.js';
import { createTaskSession } from '@bzzy/core/engine/host-commands.js';
import { savedGoalStatus } from '@bzzy/core/engine/host-goal-control.js';
import { getProvider } from '../src/providers.js';
import { loadSession, saveSession } from '../src/store.js';
import { appendEvent, listRecords, getRecord, putRecord, digest } from '../src/database.js';
import { runtimeInfo, runtimeRequest, operatorStopRequested } from '../src/runtime.js';
import { identityAlive, processIdentity } from '../src/process-identity.js';

let directory, prior;
const keys = ['BZZY_HOME','BZZY_CODEX_HOME','BZZY_CODEX_BIN','BZZY_DIRECT','BZZY_TEST_SCENARIO','BZZY_TEST_LOG'];
test.beforeEach(() => {
  prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-gcmd-')));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'native'),
    BZZY_CODEX_BIN: new URL('../../../BZZY-CORE/test/fixtures/codex.mjs', import.meta.url).pathname,
    BZZY_DIRECT: '0', BZZY_TEST_SCENARIO: 'interrupt', BZZY_TEST_LOG: path.join(directory, 'backend.jsonl') });
  fs.mkdirSync(process.env.BZZY_HOME); fs.mkdirSync(path.join(directory, 'project'));
  fs.writeFileSync(path.join(process.env.BZZY_HOME, 'config.json'), JSON.stringify({ executionEnvironment: { allow: ['BZZY_TEST_SCENARIO','BZZY_TEST_LOG'] } }));
});
async function until(check) {
  for (let i = 0; i < 300; i++) { const result = check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.fail('Goal control fixture timed out');
}
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/operator-stop', {}).catch(() => {});
  await until(() => !info || !identityAlive(info.identity));
  for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
function goal(status = 'paused') {
  const { session } = createTaskSession(getProvider('codex'), { cwd: path.join(directory, 'project'), model: 'fixture-model', alias: 'nasa_v3', tokenBudget: 20000 }, 'Continue the offline authorized fixture', { goal: true });
  session.goal.status = status; session.goal.reason = status === 'paused' ? 'user_pause' : 'scope_dependency'; session.executionState = 'paused';
  saveSession(session); return session;
}
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('../bin/bzzy.js', import.meta.url).pathname, ...args], { cwd: directory, env: process.env, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Goal CLI did not return')); }, 15000);
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
const invoke = (action, extra = []) => run(['--attach','nasa_v3','--g',action,'--json',...extra]);

test('--g parses three actions and rejects mixed goal definitions', () => {
  for (const action of ['continue','pause','status']) assert.equal(parseArgs(['--attach','nasa_v3','--g',action]).options.goalAction, action);
  for (const args of [['--g','status'], ['--attach','nasa_v3','--g','clear'], ['--attach','nasa_v3','--g','continue','--goal','new'], ['--attach','nasa_v3','--g','continue','--preprompt','new.txt'], ['--attach','nasa_v3','--g','continue','--workflow','new'], ['--attach','nasa_v3','--g','pause','--token-budget','100'], ['--attach','nasa_v3','--g','status','--g','pause']]) assert.throws(() => parseArgs(args));
});

test('missing and goal-less sessions error without creation or starting Core', async () => {
  for (const action of ['status','pause','continue']) assert.notEqual((await invoke(action)).code, 0);
  assert.equal(listRecords('session').length, 0); assert.equal(runtimeInfo(), null);
  const session = goal(); session.goal = null; saveSession(session);
  assert.equal(JSON.parse((await invoke('status')).stdout).status, 'no_goal');
  assert.notEqual((await invoke('continue')).code, 0); assert.notEqual((await invoke('pause')).code, 0);
  assert.equal(listRecords('session').length, 1); assert.equal(listRecords('execution').length, 0);
});

test('status maps saved states without writes, model calls or Core activation', async () => {
  const session = goal();
  for (const [raw, reason, expected] of [['paused','user_pause','paused'], ['blocked','scope_dependency','stalled'], ['budget_limited','token_limit','stalled'], ['usage_limited','quota','stalled'], ['awaiting_review',null,'stalled'], ['paused','context_no_progress','stalled'], ['complete',null,'achieved'], ['cancelled','user_cancel','cancelled']]) {
    session.goal.status = raw; session.goal.reason = reason; saveSession(session);
    const before = digest(loadSession(session.id)), output = await invoke('status');
    assert.equal(output.code, 0, output.stderr); const value = JSON.parse(output.stdout);
    assert.equal(value.status, expected); assert.equal(value.rawStatus, raw); assert.equal(value.goalId, session.goal.id);
    assert.equal(digest(loadSession(session.id)), before); assert.equal(runtimeInfo(), null);
  }
  session.goal.importedHistorical = true; saveSession(session); assert.equal(savedGoalStatus('nasa_v3').status, 'historical');
  assert.match((await run(['--attach','nasa_v3','--g','status'])).stdout, /nasa_v3 · historical/);
  session.goal.importedHistorical = false; session.goal.status = 'active'; session.executionState = 'running'; saveSession(session);
  assert.equal(savedGoalStatus('nasa_v3').status, 'unknown', 'Missing liveness cannot be presented as running or achieved');
  putRecord('run', session.id, { sessionId: session.id, goalId: 'another-goal', goalMode: false, runner: processIdentity() });
  assert.equal(savedGoalStatus('nasa_v3').status, 'unknown', 'An unrelated live chat must not present this goal as running');
  assert.equal(fs.existsSync(process.env.BZZY_TEST_LOG), false);
});

for (const initial of ['paused','blocked']) test(`actual ${initial} goal continues detached, deduplicates a retry and pauses through Core`, async () => {
  const session = goal(initial), id = session.goal.id, contract = digest(session.contract);
  appendEvent(session.id, 'text', { text: 'Saved earlier investigation notes' });
  const first = await invoke('continue',['--request-id','continue-once']); assert.equal(first.code, 0, first.stderr);
  const receipt = JSON.parse(first.stdout); assert.equal(receipt.goalId, id); assert.ok(receipt.executionId); assert.equal(receipt.accepted, true);
  await until(() => loadSession(session.id).executionState === 'running' && getRecord('run', session.id)?.runner);
  assert.equal(JSON.parse((await invoke('status')).stdout).status, 'running');
  const again = await invoke('continue',['--request-id','continue-once']); assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).executionId, receipt.executionId); assert.equal(listRecords('execution').length, 1);
  const pause = await invoke('pause',['--request-id','pause-once']); assert.equal(pause.code, 0, pause.stderr); assert.ok(JSON.parse(pause.stdout).controlId);
  await until(() => loadSession(session.id).executionState === 'paused');
  assert.equal(JSON.parse((await invoke('status')).stdout).status, 'paused');
  assert.equal(loadSession(session.id).goal.id, id); assert.equal(digest(loadSession(session.id).contract), contract);
  assert.equal(listRecords('session').length, 1);
  const info = runtimeInfo(); await runtimeRequest(info, 'POST', '/operator-stop', {}); await until(() => !identityAlive(info.identity));
  assert.equal((await invoke('status')).code, 0); assert.equal(operatorStopRequested(), true); assert.equal(runtimeInfo(), null);
});

test('achieved goals are not restarted and exhausted budgets are not reset', async () => {
  const session = goal('complete'); assert.notEqual((await invoke('continue')).code, 0); assert.equal(runtimeInfo(), null);
  session.goal.status = 'budget_limited'; session.goal.tokensUsed = session.goal.tokenBudget; saveSession(session);
  const limited = await invoke('continue'); assert.notEqual(limited.code, 0); assert.match(limited.stderr, /budget.*exhausted/i);
  assert.equal(listRecords('execution').length, 0); assert.equal(loadSession(session.id).goal.tokensUsed, session.goal.tokenBudget);
});
