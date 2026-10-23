import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BzzyCore } from '../../src/index.js';
import { getRecord, listRecords } from '../../src/engine/database.js';
import { runtimeInfo, runtimeRequest } from '../../src/engine/runtime.js';
import { identityAlive } from '../../src/engine/process-identity.js';
import { runner } from '../../src/engine/process.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const workspace = process.argv[2];
const stop = async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let attempt = 0; info && identityAlive(info.identity) && attempt < 100; attempt++) await delay(20);
};
try {
  assert.equal(runner, path.join(packageRoot, 'bin', 'bzzy-engine.js'));
  const core = new BzzyCore(); await core.start();
  const session = core.createConversation({ provider: 'codex', cwd: workspace }, { requestId: randomUUID() });
  const owner = randomUUID(), request = { owner, prompt: 'Return the sample native message.', requestId: randomUUID() };
  await core.claim(session.id, owner);
  const execution = await core.execute(session.id, request);
  const deadline = Date.now() + 15000;
  let job;
  while (Date.now() < deadline) {
    job = getRecord('execution', execution.executionId);
    if (job && !['queued', 'launching', 'running'].includes(job.state)) break;
    await delay(25);
  }
  assert.equal(job?.exitCode, 0, job?.error || 'Standalone fixture did not finish.');
  assert.equal((await core.execute(session.id, request)).executionId, execution.executionId);
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 1);
  await core.release(session.id, owner);
  const fixture = fs.readFileSync(process.env.BZZY_TEST_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(fixture.length, 1);
  assert.ok(fixture[0].parent.includes(runner), 'The actual execution runner must come from the standalone Core.');
  assert.ok(fixture[0].parent.includes(`internal-execution ${execution.executionId}`));
  assert.doesNotMatch(fixture[0].parent, /BZZY-CLI|bin\/bzzy\.js/);
  const history = await core.events(session.id);
  const text = history.events.filter(event => event.type === 'text').map(event => event.data.text).join('');
  assert.equal(text, fixture[0].body);
  const seen = [];
  await core.processEvents(session.id, { consumerId: 'native-fixture', handle: event => seen.push(event.id) });
  await stop(); await core.start();
  const restarted = new BzzyCore();
  const replay = await restarted.events(session.id);
  assert.equal(replay.events.filter(event => event.type === 'text').map(event => event.data.text).join(''), text);
  assert.equal((await restarted.processEvents(session.id, { consumerId: 'native-fixture', handle: () => assert.fail('Processed history was repeated.') })).processed, 0);
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 1);
  console.log(JSON.stringify({ standalone: true, coreRunner: true, rawBodyPreserved: true, replayPreserved: true, executionCount: 1, processedEvents: seen.length }));
} finally { await stop(); }
