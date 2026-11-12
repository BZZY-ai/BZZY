import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { Rpc } from '../src/engine/rpc.js';

function transport(t, onRequest = async () => { throw new Error('No tools requested'); }) {
  const child = new EventEmitter();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: 0 });
  const rpc = new Rpc(child, onRequest);
  rpc.on('failure', () => {});
  t.after(() => rpc.close());
  return { child, rpc };
}

for (const cp of [0x2028, 0x2029]) {
  test(`valid JSON string containing U+${cp.toString(16)} remains one RPC record`, async t => {
    const { child, rpc } = transport(t), value = 'before' + String.fromCodePoint(cp) + 'after';
    const result = rpc.request('test', {}, 5000);
    child.stdout.write(JSON.stringify({ id: 1, result: { value } }) + '\n');
    assert.deepEqual(await result, { value });
  });
}

test('UTF-8 characters split across chunks survive protocol framing', async t => {
  const { child, rpc } = transport(t), value = 'é🙂' + String.fromCodePoint(0x2028) + 'end';
  const result = rpc.request('test', {}, 5000);
  const record = Buffer.from(JSON.stringify({ id: 1, result: { value } }) + '\n');
  for (const byte of record) child.stdout.write(Buffer.from([byte]));
  assert.deepEqual(await result, { value });
});

test('multiple records and CRLF keep their request IDs and notifications', async t => {
  const { child, rpc } = transport(t), notifications = [];
  rpc.on('notification', (method, params) => notifications.push({ method, params }));
  const first = rpc.request('first', {}, 5000), second = rpc.request('second', {}, 5000);
  child.stdout.write(JSON.stringify({ method: 'status', params: { value: 'ready' } }) + '\r\n' +
    JSON.stringify({ id: 2, result: { value: 2 } }) + '\n' + JSON.stringify({ id: 1, result: { value: 1 } }) + '\n');
  assert.deepEqual(await Promise.all([first, second]), [{ value: 1 }, { value: 2 }]);
  assert.deepEqual(notifications, [{ method: 'status', params: { value: 'ready' } }]);
});

test('malformed stdout is diagnosed without exposing its contents, and later responses still work', async t => {
  const { child, rpc } = transport(t), diagnostics = [];
  rpc.on('diagnostic', data => diagnostics.push(data));
  const result = rpc.request('test', {}, 5000);
  child.stdout.write('SYNTHETIC_PRIVATE_INVALID_JSON\n' + JSON.stringify({ id: 1, result: { ok: true } }) + '\n');
  assert.deepEqual(await result, { ok: true });
  assert.equal(diagnostics.length, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics), /SYNTHETIC_PRIVATE/);
});

test('EOF completes a final JSON record and explicit close detaches the reader', async t => {
  const { child, rpc } = transport(t);
  const result = rpc.request('test', {}, 5000);
  child.stdout.end(JSON.stringify({ id: 1, result: { ok: true } }));
  assert.deepEqual(await result, { ok: true });
  await rpc.close();
  assert.equal(child.stdout.listenerCount('data'), 0);
});

test('Unicode notification and backend request parameters reach their handlers intact', async t => {
  const value = 'before' + String.fromCodePoint(0x2028, 0x2029) + 'after', notifications = [];
  const { child, rpc } = transport(t, async (method, params) => {
    assert.equal(method, 'item/tool/call'); assert.deepEqual(params, { value });
    return { echoed: params.value };
  });
  rpc.on('notification', (method, params) => notifications.push({ method, params }));
  const response = once(child.stdin, 'data');
  child.stdout.write(JSON.stringify({ method: 'status', params: { value } }) + '\n' +
    JSON.stringify({ id: 'native-request', method: 'item/tool/call', params: { value } }) + '\n');
  const [chunk] = await response;
  assert.deepEqual(JSON.parse(chunk.toString()), { id: 'native-request', result: { echoed: value } });
  assert.deepEqual(notifications, [{ method: 'status', params: { value } }]);
});

test('stdout read errors reject pending requests and explicit close releases the reader', async t => {
  const { child, rpc } = transport(t), error = new Error('synthetic stdout read failure');
  const pending = rpc.request('test', {}, 5000);
  child.stdout.emit('error', error);
  await assert.rejects(pending, value => value === error);
  await rpc.close();
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stdout.listenerCount('end'), 0);
});
