import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CoreConnectionsClient } from '../src/connections.js';
import { runtimeFile } from '../src/engine/runtime.js';
import { writeJson } from '../src/engine/files.js';
import { processIdentity } from '../src/engine/process-identity.js';

test('local connection polling verifies Core identity, separates Relay proof and never starts Core', async () => {
  const previous = process.env.BZZY_HOME, directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-connectivity-'));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const identity = processIdentity(), token = 'fixture-local-capability'; let mode = 'online', requests = 0;
  const server = http.createServer((request, response) => {
    requests++; assert.equal(request.url, '/v1/connections'); assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version: 1, sampledAt: new Date(Date.now() - (mode === 'stale' ? 10_000 : 0)).toISOString(),
      identity: mode === 'wrong' ? { ...identity, pid: identity.pid + 1 } : identity,
      core: { online: true }, relay: { online: mode === 'online' } }));
  });
  try {
    const client = new CoreConnectionsClient();
    await assert.rejects(client.read());
    assert.equal(fs.existsSync(runtimeFile()), false, 'observation cannot create a daemon');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    writeJson(runtimeFile(), { identity, token, url: `http://127.0.0.1:${server.address().port}` });
    assert.equal((await client.read()).relay, true);
    mode = 'offline'; const state = await client.read(); assert.equal(state.core, true); assert.equal(state.relay, false);
    assert.ok(!JSON.stringify(state).includes(token));
    for (mode of ['wrong', 'stale']) await assert.rejects(client.read());
    const count = requests; process.env.BZZY_HOME = path.join(directory, 'other'); await assert.rejects(client.read());
    assert.equal(requests, count);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
