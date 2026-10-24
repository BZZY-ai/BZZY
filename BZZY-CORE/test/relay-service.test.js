import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CoreRelayService, prepareRelayService } from '../src/relay/service.js';

let directory, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-relay-service-'));
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

class FixtureGateway extends EventEmitter {
  starts = 0; closes = 0;
  async start() { this.starts++; await Promise.resolve(); }
  async close() { this.closes++; }
  status() { return { transport: this.closes ? 'offline' : 'online', gateway: 'ready' }; }
  pendingPairings() { return []; }
  grants() { return []; }
}

test('Relay registers on first startup, shares concurrent starts, restores and honors explicit disconnect', async () => {
  const instances = [];
  const gatewayFactory = () => { const gateway = new FixtureGateway(); instances.push(gateway); return gateway; };
  prepareRelayService();
  const first = new CoreRelayService({ gatewayFactory });
  assert.equal((await first.restore()).status.enabled, true);
  assert.equal(instances.length, 1);
  await Promise.all([first.connect(), first.connect(), first.request('GET', 'status')]);
  assert.equal(instances.length, 1); assert.equal(instances[0].starts, 1);
  assert.equal(first.snapshot().status.managed, true);
  await first.close();
  assert.equal(instances[0].closes, 1);
  const restarted = new CoreRelayService({ gatewayFactory });
  assert.equal((await restarted.restore()).status.transport, 'online');
  assert.equal(instances.length, 2);
  await restarted.disconnect();
  assert.equal(restarted.snapshot().status.enabled, false);
  const disabled = new CoreRelayService({ gatewayFactory });
  await disabled.restore(); assert.equal(instances.length, 2);
  await disabled.close();
});

test('connection errors remain sanitized and disabled service does not reconnect', async () => {
  let attempts = 0;
  const service = new CoreRelayService({ retryMs: 5, gatewayFactory: () => {
    attempts++;
    const gateway = new FixtureGateway();
    gateway.start = async () => { throw new Error('fixture-private-account-token'); };
    return gateway;
  } });
  await assert.rejects(service.connect(), error => error.code === 'CONNECTION_FAILED' && !error.message.includes('private'));
  assert.equal(attempts, 1);
  assert.doesNotMatch(JSON.stringify(service.snapshot()), /fixture-private/);
  await service.disconnect();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(attempts, 1);
});
