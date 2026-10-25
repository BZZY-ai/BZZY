import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, saveSession, loadSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { prepareTask } from '../src/task.js';
import { newGoal } from '../src/goals.js';
import { runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';
import { executeManaged } from '../src/runtime-client.js';
import { delay } from '../src/delegation.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const active = state => ['queued', 'launching', 'running'].includes(state);
async function until(check, message) {
  for (let count = 0; count < 1000; count++) { if (check()) return; await delay(10); }
  assert.fail(message);
}

test('submitting achieved /validate during final execution replay keeps the child prompt alive and completes the handler once', { timeout: 20000 }, async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-watch-completion-')));
  const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_ADVANCED', 'BZZY_TEST_LOG', 'BZZY_DIRECT'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]])), originalFetch = globalThis.fetch;
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'), BZZY_TEST_ADVANCED: 'wait', BZZY_TEST_LOG: path.join(directory, 'backend.jsonl') });
  delete process.env.BZZY_DIRECT;
  fs.writeFileSync(path.join(directory, 'source.txt'), 'Synthetic supplied evidence.');
  const session = createSession(BUILTINS.codex, directory, 'fixture-brain');
  prepareTask(session, {}, 'Assess supplied evidence'); session.goal = newGoal(session.contract.objective); saveSession(session);
  const prompts = [], childReady = Promise.withResolvers(); let parentPrompt, childPrompt;
  let sourceReads = 0, completing = false, intercepted = false, handlerCalls = 0, handlerCompleted = 0, childCancelled = false, task;
  const ui = { interactive: true, cursors: new Map(), setSession() {}, updateSession() {}, clearHistory() {}, event() {},
    ask(question) {
      const pending = Promise.withResolvers(), child = question.startsWith('Validate child');
      const prompt = { child, answer: pending.resolve }, reader = { close() { if (child) childCancelled = true; pending.resolve(null); } };
      ui.reader = reader; prompts.push(prompt);
      if (child) childPrompt = prompt; else parentPrompt = prompt;
      return pending.promise.finally(() => { if (ui.reader === reader) ui.reader = null; });
    },
    async onDebate(id, focus) {
      handlerCalls++; assert.equal(id, session.id); assert.equal(focus, '');
      assert.equal(loadSession(session.id).goal.status, 'complete');
      const answer = ui.ask('Validate child review input'); childReady.resolve();
      if (await answer === 'review complete') handlerCompleted++;
    },
  };
  t.after(async () => {
    for (const prompt of prompts) prompt.answer(null);
    await task?.catch(() => {});
    globalThis.fetch = originalFetch;
    const info = runtimeInfo();
    if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
    for (let count = 0; count < 100 && info && identityAlive(info.identity); count++) await delay(20);
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  // The real local HTTP runtime and actual public managed API own the run. Only
  // the final events response is delayed, placing input in its asynchronous gap.
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args), url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url);
    if (url.pathname === `/sessions/${session.id}` && (!args[1]?.method || args[1].method === 'GET')) {
      const snapshot = await response.clone().json(); sourceReads++;
      if (sourceReads > 1 && snapshot.execution && !active(snapshot.execution.state)) completing = true;
    }
    if (!intercepted && completing && url.pathname === `/sessions/${session.id}/events`) {
      intercepted = true; parentPrompt.answer('/validate');
      await childReady.promise;
    }
    return response;
  };
  task = executeManaged(BUILTINS.codex, session, {}, ui, session.goal.objective, { goal: true });
  await until(() => intercepted && childPrompt, 'The completed execution never reached the final replay/input boundary.');
  await delay(50);
  assert.equal(childCancelled, false, 'The finishing parent watcher must not close the nested validation reader.');
  assert.equal(handlerCompleted, 0, 'The review remains active until its own answer arrives.');
  childPrompt.answer('review complete');
  await task;
  assert.equal(handlerCalls, 1); assert.equal(handlerCompleted, 1); assert.equal(ui.detached, undefined);
  assert.equal(loadSession(session.id).goal.status, 'complete');
});
