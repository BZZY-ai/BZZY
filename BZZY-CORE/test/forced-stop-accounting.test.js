import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSession } from '../src/engine/controller.js';
import { CodexEngine } from '../src/engine/engines/codex.js';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { newGoal } from '../src/engine/goals.js';
import { listRecords } from '../src/engine/database.js';
import { budgetUsage } from '../src/engine/delegation-usage.js';

const names = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN'];
let directory, prior, notification, session, forceImmediately;
test.beforeEach(() => {
  prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-forced-stop-')));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'auth'),
    BZZY_CODEX_BIN: path.join(directory, 'offline-backend.mjs') });
  fs.mkdirSync(process.env.BZZY_CODEX_HOME); fs.writeFileSync(path.join(process.env.BZZY_CODEX_HOME, 'auth.json'), '{}', { mode: 0o600 });
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'offline-stop-fixture');
  session.goal = newGoal('Inspect only this offline fixture. Preserve its saved goal and accounting.', 200);
  saveSession(session);
  notification = CodexEngine.prototype.notification;
  forceImmediately = false;
  // Exercise the real controller callback after an intermediate receipt. Loop
  // classification is tested separately; this verifies its forced-stop path.
  CodexEngine.prototype.notification = function (method, params) {
    const result = notification.call(this, method, params);
    if (!this.fixtureStopRequested && method === 'thread/goal/updated' && params.goal?.tokensUsed === 17) {
      this.fixtureStopRequested = true;
      this.options.onContextStall();
      if (forceImmediately) this.options.onContextStall();
    }
    return result;
  };
});
test.afterEach(() => {
  CodexEngine.prototype.notification = notification;
  for (const name of names) if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name];
  fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(acknowledgesStop) {
  fs.writeFileSync(process.env.BZZY_CODEX_BIN, `#!${process.execPath}
import readline from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.162.0 (offline stop fixture)'); process.exit(0); }
if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const send = value => console.log(JSON.stringify(value));
const notify = (method, params) => send({method,params:{threadId:'stop-thread',...params}});
let goal;
for await (const line of readline.createInterface({input:process.stdin})) {
  const request = JSON.parse(line); let result = {};
  if (request.method === 'thread/start') result = {thread:{id:'stop-thread'}};
  else if (request.method === 'thread/goal/get') result = {goal};
  else if (request.method === 'thread/goal/set') {
    if (request.params.status === 'paused') {
      if (!${JSON.stringify(acknowledgesStop)}) continue;
      goal = {...goal,status:'paused',tokensUsed:23}; result = {goal};
      notify('thread/tokenUsage/updated',{tokenUsage:{total:{totalTokens:23}}});
      notify('thread/goal/updated',{goal});
      notify('turn/completed',{turn:{id:'stop-turn',status:'interrupted'}});
    } else {
      goal = {id:'stop-goal',status:'active',tokensUsed:0}; result = {goal};
      setTimeout(() => {
        notify('turn/started',{turn:{id:'stop-turn'}});
        notify('thread/tokenUsage/updated',{tokenUsage:{total:{totalTokens:17}}});
        goal = {...goal,tokensUsed:17}; notify('thread/goal/updated',{goal});
      },10);
    }
  } else if (request.method === 'turn/interrupt') {
    if (!${JSON.stringify(acknowledgesStop)}) continue;
    notify('turn/completed',{turn:{id:'stop-turn',status:'interrupted'}});
  }
  if (request.id !== undefined) send({id:request.id,result});
}
`, { mode: 0o700 });
}
const ui = { interactive: false, json: true, event() {}, newline() {}, async ask() { return ''; }, async approve() { return false; } };

test('a forced stop after partial usage preserves measured tokens and conservatively charges its unknown remainder', { timeout: 12000 }, async () => {
  fixture(false);
  const id = session.goal.id, objective = session.goal.objective;
  const code = await runSession(getProvider('codex'), session, { pet: false }, ui, '', { goal: true });
  const [receipt] = listRecords('usage.run');
  assert.equal(code, 2); assert.equal(receipt.measuredTokens, 17);
  assert.equal(receipt.uncertainEnd, true); assert.equal(receipt.accountingComplete, false);
  assert.equal(receipt.chargedTokens, 200); assert.equal(budgetUsage(session), 200);
  const saved = loadSession(session.id);
  assert.equal(saved.goal.id, id); assert.equal(saved.goal.objective, objective);
  assert.equal(saved.goal.tokenBudget, 200); assert.equal(saved.goal.status, 'paused');
  assert.equal(saved.goal.reason, 'context_no_progress');
  assert.equal(listRecords('usage.run').length, 1, 'Stopping cannot create a replacement run');
});

test('an acknowledged terminal stop retains its reported remaining budget', async () => {
  fixture(true);
  await runSession(getProvider('codex'), session, { pet: false }, ui, '', { goal: true });
  const [receipt] = listRecords('usage.run');
  assert.equal(receipt.measuredTokens, 23); assert.equal(receipt.chargedTokens, 23);
  assert.equal(receipt.accountingComplete, true); assert.equal(receipt.uncertainEnd, undefined);
  assert.equal(budgetUsage(session), 23);
});

test('a second stop cannot hide uncertain usage by closing before the grace timer', async () => {
  fixture(false); forceImmediately = true;
  await runSession(getProvider('codex'), session, { pet: false }, ui, '', { goal: true });
  const [receipt] = listRecords('usage.run');
  assert.equal(receipt.measuredTokens, 17); assert.equal(receipt.chargedTokens, 200);
  assert.equal(receipt.uncertainEnd, true); assert.equal(receipt.accountingComplete, false);
});
