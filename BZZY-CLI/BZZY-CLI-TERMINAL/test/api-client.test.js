import test from 'node:test';
import assert from 'node:assert/strict';
import { BzzyClient } from '../src/api-client.js';

const event = (seq, type = 'activity', text = 'café 🐝') => ({ version: 1, sessionId: 'session', id: `session:${seq}`, seq, type, data: { text } });
test('client accepts existing /v1 service URLs without duplicating the API version', async () => {
  const urls = [], client = new BzzyClient({ url: 'http://local/v1/', token: 'fixture', fetch: async url => { urls.push(url); return new Response('{}'); } });
  await client.capabilities(); await client.sessions();
  assert.deepEqual(urls, ['http://local/v1/capabilities', 'http://local/sessions']);
});
function frames(text, split = false) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
test('SSE client handles split UTF-8, CRLF, multiline data, duplicates and reconnect cursors', async () => {
  const urls = [], abort = new AbortController();
  const client = new BzzyClient({ url: 'http://local', token: 'fixture-token', fetch: async url => {
    urls.push(url);
    if (urls.length === 1) return frames(`: heartbeat\r\n\r\ndata: ${JSON.stringify(event(1, 'usage.updated'))}\r\n\r\ndata: ${JSON.stringify(event(2))}\r\n\r\n`, true);
    const json = JSON.stringify(event(3), null, 2).split('\n').map(line => `data: ${line}`).join('\n');
    return frames(`data: ${JSON.stringify(event(2))}\n\n${json}\n\n`);
  } });
  const seen = [];
  for await (const item of client.stream('session', { signal: abort.signal, types: ['activity'], reconnectDelayMs: 0 })) { seen.push(item); if (seen.length === 2) abort.abort(); }
  assert.deepEqual(seen.map(e => e.seq), [2, 3]); assert.equal(seen[0].data.text, 'café 🐝');
  assert.match(urls[1], /after=2$/);
});
test('SSE client terminates on bad cursors, invalid envelopes, oversized frames and authorization failures', async () => {
  for (const response of [new Response('{}', { status: 400 }), new Response('{}', { status: 401 }), frames('data: {invalid}\n\n'),
    frames(`data: ${JSON.stringify({ ...event(1), sessionId: 'another-session' })}\n\n`), frames('data: ' + 'x'.repeat(1024 * 1024 + 1))]) {
    const client = new BzzyClient({ url: 'http://local', token: 'fixture-token', fetch: async () => response });
    await assert.rejects(client.stream('session', { reconnectDelayMs: 0 }).next());
  }
  const client = new BzzyClient({ url: 'http://local', token: 'fixture-token' });
  await assert.rejects(client.stream('session', { after: -1 }).next(), /cursor/);
  assert.throws(() => client.answer('session', {}), /stable requestId/);
  assert.throws(() => client.control('session', {}), /stable requestId/);
});
