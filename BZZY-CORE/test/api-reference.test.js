import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { authoringHelp } from '../src/engine/authoring-guides.js';
import { BzzyClient } from '../src/client.js';

const read = file => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const guide = authoringHelp(['--help-api']);

test('installed API reference covers the actual local routes, dispatchers and transport methods', () => {
  for (const [, route] of read('engine/runtime.js').matchAll(/pathname === '(\/[^']+)'/g)) {
    assert.ok(guide.includes(`/v1${route}`), `Missing runtime route ${route}`);
  }
  for (const action of ['events','usage','activities','traffic','claim','release','execute','control','answer','input','delete']) {
    assert.ok(guide.includes(`/v1/sessions/ID/${action}`), `Missing session route ${action}`);
  }
  for (const action of ['logs','events','cancel']) assert.ok(guide.includes(`/v1/jobs/JOB_ID/${action}`));
  for (const [, operation] of read('knowledge.js').matchAll(/case '([^']+)':/g)) {
    assert.ok(guide.includes('`' + operation + '`'), `Missing knowledge operation ${operation}`);
  }
  for (const [, operation] of read('engine/program-scope.js').matchAll(/operation === '(scope\.[^']+)'/g)) {
    assert.ok(guide.includes('`' + operation + '`'), `Missing scope operation ${operation}`);
  }
  for (const [, action] of read('relay/service.js').matchAll(/action === '([^']+)'/g)) {
    assert.ok(guide.includes(`/v1/relay/${action}`), `Missing gateway route ${action}`);
  }
  for (const [, method] of read('engine/api-client.js').matchAll(/^  (?:async \*?)?([a-zA-Z]+)\(/gm)) {
    if (method === 'constructor') continue;
    assert.ok(guide.includes('`' + method + '`'), `Missing BzzyClient method ${method}`);
  }
  assert.match(guide, /not an OpenAPI/);
  assert.match(guide, /No generic webhook/);
});

const example = /<!-- bzzy-api-example: goal-watcher -->\s*```js\n([\s\S]*?)\n```/.exec(guide)?.[1];
assert.ok(example, 'Reference includes its actual reusable watcher example');
const { watchGoal } = await import(`data:text/javascript;base64,${Buffer.from(example).toString('base64')}`);
const events = [
  { seq: 1, type: 'goal.completed', data: { goalId: 'old-goal' } },
  { seq: 2, type: 'goal.stalled', data: { goalId: 'current-goal', status: 'budget_limited' } },
  { seq: 3, type: 'future.type', data: {} },
  { seq: 4, type: 'goal.completed', data: { goalId: 'current-goal' } },
].map(event => ({ ...event, version: 1, id: `fixture:${event.seq}`, sessionId: 'fixture' }));
const client = () => new BzzyClient({ url: 'http://127.0.0.1:1', token: 'synthetic-private-token', fetch: async () => new Response(
  events.map(event => `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } }) });

test('printed goal watcher uses the real transport and ignores old-goal outcomes while saving processed cursors', async () => {
  const abort = new AbortController(), handled = [], cursors = [];
  await watchGoal(client(), 'fixture', 'current-goal', {
    handle: async event => handled.push(event.id),
    saveCursor: async seq => { cursors.push(seq); if (seq === 4) abort.abort(); }, signal: abort.signal,
  });
  assert.deepEqual(handled, ['fixture:2','fixture:4']);
  assert.deepEqual(cursors, [1,2,3,4]);
});

test('printed watcher does not checkpoint past a failed application handler', async () => {
  const cursors = [];
  await assert.rejects(watchGoal(client(), 'fixture', 'current-goal', {
    handle: async () => { throw new Error('application transaction failed'); },
    saveCursor: async seq => cursors.push(seq),
  }), /application transaction failed/);
  assert.deepEqual(cursors, [1], 'Restart can replay the unprocessed current-goal event');
});

const statusExample = /<!-- bzzy-api-example: session-goal-status -->\s*```js\n([\s\S]*?)\n```/.exec(guide)?.[1];
assert.ok(statusExample, 'Reference includes specific-session goal status example');
const { sessionGoalStatus } = await import(`data:text/javascript;base64,${Buffer.from(statusExample).toString('base64')}`);

test('printed nasa status example selects only the named session and returns its current goal without mutations', async () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', calls = [];
  const transport = new BzzyClient({ url: 'http://127.0.0.1:1', token: 'synthetic', fetch: async (url, options) => {
    calls.push({ url, method: options.method });
    return new Response(JSON.stringify(url.endsWith('/sessions')
      ? [{ id: 'unrelated', alias: 'other' }, { id, alias: 'nasa' }]
      : { session: { id, alias: 'nasa', goal: { id: 'current-goal', status: 'blocked', reason: 'scope_dependency' }, executionState: 'idle' } }));
  } });
  assert.deepEqual(await sessionGoalStatus(transport, 'nasa'), { sessionId: id, alias: 'nasa', goalId: 'current-goal', status: 'blocked', reason: 'scope_dependency', executionState: 'idle' });
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:1/sessions', method: 'GET' }, { url: `http://127.0.0.1:1/sessions/${id}`, method: 'GET' }]);
  calls.length = 0;
  await sessionGoalStatus(transport, id);
  assert.equal(calls.length, 1, 'Known UUID skips catalog lookup');
});

test('printed status example rejects missing/ambiguous aliases and preserves a no-goal state', async () => {
  for (const sessions of [[], [{ alias: 'nasa' }, { alias: 'nasa' }]]) {
    await assert.rejects(sessionGoalStatus({ sessions: async () => sessions,
      session: async () => assert.fail('Do not inspect a guessed session') }, 'nasa'), /not found|Ambiguous/);
  }
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const status = await sessionGoalStatus({ session: async () => ({ session: { id, alias: 'nasa', executionState: 'idle' } }) }, id);
  assert.equal(status.goalId, null); assert.equal(status.status, null);
});
