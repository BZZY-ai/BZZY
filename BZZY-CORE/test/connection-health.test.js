import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RelayConnectionHealth } from '../src/relay/connection-health.js';

class Socket extends EventEmitter {
  readyState = 1; terminated = 0;
  ping(nonce, callback) { this.nonce = nonce; callback(); }
  terminate() { this.terminated++; this.readyState = 3; this.emit('close'); }
}
test('Relay requires a matching fresh pong on the authenticated current socket', async () => {
  let time = 0;
  const client = { status: 'online', ws: new Socket() }, health = new RelayConnectionHealth(client, { clock: () => time });
  assert.equal(health.snapshot().online, false, 'socket/auth flags alone cannot show green');
  const pending = health.probe();
  client.ws.emit('pong', Buffer.from('wrong')); assert.equal(health.snapshot().online, false);
  client.ws.emit('pong', client.ws.nonce); await pending;
  assert.equal(health.snapshot().online, true);
  time = 6001; assert.equal(health.snapshot().online, false);
  const old = client.ws, stale = health.probe(); client.ws = new Socket();
  old.emit('pong', old.nonce); await assert.rejects(stale); assert.equal(health.snapshot().online, false);
  const next = health.probe(); client.ws.emit('pong', client.ws.nonce); await next;
  client.status = 'offline'; assert.equal(health.snapshot().online, false);
  health.close();
});
test('a silent Relay times out, clears proof and reconnects without replaying application work', async () => {
  const client = { status: 'online', ws: new Socket() }, health = new RelayConnectionHealth(client, { timeoutMs: 20 });
  const keeper = setTimeout(() => {}, 100);
  try {
    const first = health.probe(), second = health.probe(); assert.equal(first, second);
    await assert.rejects(first);
    assert.equal(client.ws.terminated, 0); assert.equal(health.snapshot().online, false);
    await assert.rejects(health.probe()); assert.equal(client.ws.terminated, 1);
    client.ws.emit('pong', client.ws.nonce); assert.equal(health.snapshot().online, false);
  } finally { clearTimeout(keeper); health.close(); }
});
test('local event-loop stalls invalidate green status without destroying an in-flight Relay transfer', async () => {
  let time = 0;
  const client = { status: 'online', ws: new Socket() }, health = new RelayConnectionHealth(client, { timeoutMs: 20, clock: () => time });
  const keeper = setTimeout(() => {}, 100);
  try {
    const pending = health.probe(); time = 100;
    await assert.rejects(pending); assert.equal(health.snapshot().online, false); assert.equal(client.ws.terminated, 0);
  } finally { clearTimeout(keeper); health.close(); }
});
