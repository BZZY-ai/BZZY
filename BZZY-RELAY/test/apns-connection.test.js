import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http2 from 'node:http2';
import net from 'node:net';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { APNsClient } from '../src/apns.js';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const configuration = { privateKey, environment: 'sandbox', topic: 'app.bzzy.fixture', keyId: 'ABCDEFGHIJ', teamId: 'ABCDEFGHIJ' };
const request = () => ({ token: 'ab'.repeat(32), payload: { aps: { alert: 'Synthetic fixture' } }, id: randomUUID(), collapseID: 'fixture' });

function pendingSession() {
  const session = new EventEmitter();
  session.destroyed = false; session.closed = false; session.requests = [];
  session.destroy = () => {
    if (session.destroyed) return;
    session.destroyed = true; queueMicrotask(() => session.emit('close'));
  };
  session.request = headers => {
    session.requests.push(headers);
    const stream = new EventEmitter(); stream.close = () => {}; stream.end = () => {};
    session.stream = stream;
    return stream;
  };
  return session;
}

test('DNS and TLS connection failures cannot send a POST and remain safe to retry', async t => {
  let session = pendingSession();
  t.mock.method(http2, 'connect', () => session);
  const client = new APNsClient({ configuration }); t.after(() => client.close());
  for (const code of ['EAI_AGAIN', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    session = pendingSession(); let dispatchFences = 0;
    const sent = client.send({ ...request(), beforeDispatch: () => dispatchFences++ });
    assert.equal(session.requests.length, 0, 'No request may be constructed before TLS connects');
    session.emit('error', Object.assign(new Error('fixture connection failure'), { code }));
    await assert.rejects(sent, error => error.code === 'APNS_UNAVAILABLE' && error.uncertain !== true);
    assert.equal(session.requests.length, 0); assert.equal(dispatchFences, 0);
    assert.equal(session.destroyed, true);
  }
});

test('dispatch fence runs only after TLS readiness and can stop POST before headers', async t => {
  const session = pendingSession();
  t.mock.method(http2, 'connect', () => session);
  const client = new APNsClient({ configuration }); t.after(() => client.close());
  let fences = 0;
  const sent = client.send({ ...request(), beforeDispatch: () => { fences++; throw new Error('fixture durable fence unavailable'); } });
  assert.equal(fences, 0);
  session.emit('connect');
  await assert.rejects(sent, error => error.code === 'APNS_UNAVAILABLE' && error.uncertain !== true);
  assert.equal(fences, 1); assert.equal(session.requests.length, 0);
});

test('cancellation from the dispatch fence cannot post after the promise was rejected', async t => {
  const session = pendingSession();
  t.mock.method(http2, 'connect', () => session);
  const client = new APNsClient({ configuration }); t.after(() => client.close());
  const controller = new AbortController();
  const sent = client.send({ ...request(), signal: controller.signal, beforeDispatch: () => controller.abort() });
  session.emit('connect');
  await assert.rejects(sent, error => error.code === 'APNS_UNAVAILABLE' && error.uncertain !== true);
  assert.equal(session.requests.length, 0);
});

test('connection timeout and cancellation before TLS are retryable without posting', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let session = pendingSession();
  t.mock.method(http2, 'connect', () => session);
  const client = new APNsClient({ configuration }); t.after(() => client.close());
  const timedOut = client.send(request());
  t.mock.timers.tick(5000);
  await assert.rejects(timedOut, error => error.code === 'APNS_UNAVAILABLE' && error.uncertain !== true);
  assert.equal(session.requests.length, 0);
  session = pendingSession();
  const controller = new AbortController();
  const cancelled = client.send({ ...request(), signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, error => error.code === 'APNS_UNAVAILABLE' && error.uncertain !== true);
  assert.equal(session.requests.length, 0);
});

test('timeout and cancellation after connected POST construction remain uncertain', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let session = pendingSession();
  t.mock.method(http2, 'connect', () => session);
  const client = new APNsClient({ configuration }); t.after(() => client.close());
  const timedOut = client.send(request());
  session.emit('connect');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.requests.length, 1);
  t.mock.timers.tick(5000);
  await assert.rejects(timedOut, error => error.code === 'APNS_UNAVAILABLE' && error.uncertain === true);
  assert.equal(session.destroyed, true, 'A broken transport cannot poison the next distinct alert');
  session = pendingSession();
  const controller = new AbortController();
  const cancelled = client.send({ ...request(), signal: controller.signal });
  session.emit('connect');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.requests.length, 1);
  controller.abort();
  await assert.rejects(cancelled, error => error.code === 'APNS_UNAVAILABLE' && error.uncertain === true);
});

test('invalid response after POST cannot authorize a blind retry', async t => {
  const session = pendingSession();
  t.mock.method(http2, 'connect', () => session);
  const client = new APNsClient({ configuration }); t.after(() => client.close());
  const sent = client.send(request());
  session.emit('connect');
  await new Promise(resolve => setImmediate(resolve));
  session.stream.emit('response', { ':status': 200 });
  session.stream.emit('data', Buffer.alloc(2049, 65));
  await assert.rejects(sent, error => error.code === 'APNS_RESPONSE_INVALID' && error.uncertain === true);
});

test('actual refused connection recovers through a new session with the original alert identity', async t => {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const client = new APNsClient({ configuration, endpoint: `http://127.0.0.1:${port}`, allowInsecureLocal: true });
  t.after(() => client.close());
  const alert = request();
  await assert.rejects(client.send(alert), error => error.code === 'APNS_UNAVAILABLE' && error.uncertain !== true);
  const received = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    received.push(headers);
    stream.resume(); stream.on('end', () => { stream.respond({ ':status': 200, 'apns-id': alert.id }); stream.end(); });
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { client.close(); server.close(resolve); }));
  const receipt = await client.send(alert);
  assert.equal(receipt.accepted, true);
  assert.equal(received.length, 1, 'The outage did not send an earlier POST');
  assert.equal(received[0]['apns-id'], alert.id);
  assert.equal(received[0]['apns-collapse-id'], alert.collapseID);
});

test('real HTTP/2 RST_STREAM(NO_ERROR) after POST without headers remains uncertain', async t => {
  let posts = 0, connections = 0;
  const server = http2.createServer();
  server.on('session', () => connections++);
  server.on('stream', stream => {
    stream.on('error', () => {}); stream.resume();
    stream.on('end', () => {
      posts++;
      if (posts === 1) stream.close(http2.constants.NGHTTP2_NO_ERROR);
      else { stream.respond({ ':status': 200 }); stream.end(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new APNsClient({ configuration, endpoint: `http://127.0.0.1:${server.address().port}`, allowInsecureLocal: true });
  t.after(() => new Promise(resolve => { client.close(); server.close(resolve); }));
  await assert.rejects(client.send(request()), error => error.code === 'APNS_RESPONSE_INVALID' && error.uncertain === true);
  assert.equal(posts, 1, 'A possibly consumed POST must not be transparently repeated');
  assert.equal((await client.send(request())).accepted, true, 'A distinct future alert can use a fresh session');
  assert.equal(posts, 2); assert.equal(connections, 2, 'The ambiguous session must be discarded');
});

test('only APNs200 or explicit final error status can settle a posted response', async t => {
  let session = pendingSession();
  t.mock.method(http2, 'connect', () => session);
  const client = new APNsClient({ configuration }); t.after(() => client.close());
  for (const status of [undefined, 103, 204, 302, 600, 'invalid']) {
    session = pendingSession();
    const sent = client.send(request()); session.emit('connect');
    await new Promise(resolve => setImmediate(resolve));
    if (status !== undefined) session.stream.emit('response', { ':status': status });
    session.stream.emit('end');
    await assert.rejects(sent, error => error.code === 'APNS_RESPONSE_INVALID' && error.uncertain === true);
    assert.equal(session.destroyed, true);
  }
  for (const status of [429, 500, 503]) {
    session = pendingSession();
    const sent = client.send(request()); session.emit('connect');
    await new Promise(resolve => setImmediate(resolve));
    session.stream.emit('response', { ':status': status }); session.stream.emit('end');
    await assert.rejects(sent, error => error.code === 'APNS_REJECTED' && error.uncertain !== true && error.permanent === false && error.status === status);
    client.close();
  }
});
