import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import { TrafficRecorder, observedRequest, redactedUrl, redactedHeaders } from '../src/traffic.js';
import { createSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { prepareTask } from '../src/task.js';
import { appendEvent, listRecords } from '../src/database.js';

let dir, session, seen, recorder, servers;
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-net-')); process.env.BZZY_HOME = path.join(dir, 'private');
  session = createSession(BUILTINS.codex, dir); prepareTask(session, {}, 'Inspect approved local fixtures'); seen = []; servers = [];
});
test.afterEach(async () => {
  await recorder?.close(); recorder = null;
  for (const server of servers) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  fs.rmSync(dir, { recursive: true, force: true }); delete process.env.BZZY_HOME;
});
const ui = () => ({ event(type, data) { seen.push({ type, data }); appendEvent(session.id, type, data); } });
async function listen(server) { servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
function throughProxy(proxy, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: proxy.hostname, port: proxy.port, path: url, headers: { ...headers, 'proxy-authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, text }));
    }); request.on('error', reject); request.end();
  });
}
test('traffic redacts credential headers and URL parameters without hiding tested identifiers', () => {
  const url = redactedUrl('https://user:password@example.test/users/getProfile?user_id=42&access_token=secret');
  assert.ok(url.includes('user_id=42')); assert.ok(!url.includes('password')); assert.ok(!url.includes('secret'));
  assert.deepEqual(redactedHeaders({ authorization: 'Bearer secret', cookie: 'session=secret', 'content-type': 'application/json' }), { authorization: '[redacted]', cookie: '[redacted]', 'content-type': 'application/json' });
});
test('the optional proxy records actual HTTP request and response metadata in real time', async () => {
  const port = await listen(http.createServer((request, response) => { assert.equal(request.headers.authorization, 'Bearer private'); response.setHeader('set-cookie', 'secret-session'); response.end('fixture response'); }));
  recorder = await new TrafficRecorder(session, { baseUrl: 'https://model.example' }, ui()).open();
  const result = await throughProxy(new URL(recorder.env.HTTP_PROXY), `http://127.0.0.1:${port}/users/getProfile?user_id=2&api_key=private`, { authorization: 'Bearer private' });
  assert.equal(result.status, 200); assert.equal(result.text, 'fixture response');
  const record = listRecords('traffic')[0]; assert.equal(record.method, 'GET'); assert.equal(record.status, 200); assert.equal(record.provenance, 'proxy-observed');
  assert.equal(record.requestHeaders.authorization, '[redacted]'); assert.equal(record.responseHeaders['set-cookie'], '[redacted]');
  assert.ok(!JSON.stringify(record).includes('Bearer private')); assert.ok(!record.url.includes('api_key=private'));
  assert.ok(seen.some(e => e.type === 'network.request')); assert.ok(seen.some(e => e.type === 'network.response'));
});
test('model-provider HTTP traffic is forwarded without recording payloads or credentials', async () => {
  const port = await listen(http.createServer((request, response) => response.end('model fixture')));
  recorder = await new TrafficRecorder(session, { baseUrl: `http://127.0.0.1:${port}` }, ui()).open();
  await throughProxy(new URL(recorder.env.HTTP_PROXY), `http://127.0.0.1:${port}/responses`, { authorization: 'Bearer model-key' });
  assert.equal(listRecords('traffic').length, 0);
  assert.ok(!seen.some(e => e.type === 'network.request'));
});
test('HTTPS CONNECT is decrypted with a private child-process CA and records the actual path', async () => {
  const key = path.join(dir, 'origin.key'), cert = path.join(dir, 'origin.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1', '-days', '1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const oldRoots = tls.getCACertificates('default'); tls.setDefaultCACertificates([...oldRoots, fs.readFileSync(cert, 'utf8')]);
  try {
    const port = await listen(https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => response.end('secure fixture')));
    recorder = await new TrafficRecorder(session, { baseUrl: 'https://model.example' }, ui()).open();
    const proxy = new URL(recorder.env.HTTPS_PROXY);
    const result = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `127.0.0.1:${port}`, headers: { 'proxy-authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') } });
      request.on('error', reject);
      request.on('connect', (response, socket) => {
        const secure = tls.connect({ socket, ca: fs.readFileSync(recorder.ca.cert), rejectUnauthorized: true, checkServerIdentity: (_host, peer) => tls.checkServerIdentity('127.0.0.1', peer) });
        secure.on('error', reject); let data = '';
        secure.on('secureConnect', () => secure.write(`GET /users/getProfile?user_id=9 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
        secure.on('data', chunk => { data += chunk; }); secure.on('end', () => resolve(data));
      }); request.end();
    });
    assert.match(result, /200 OK/); assert.match(result, /secure fixture/);
    assert.match(listRecords('traffic')[0].url, /https:.*users\/getProfile\?user_id=9/);
    assert.equal(fs.statSync(recorder.ca.key).mode & 0o777, 0o600);
  } finally { tls.setDefaultCACertificates(oldRoots); }
});
test('host-observed HTTP requires declared scope, does not follow redirects and saves evidence', async () => {
  let requests = 0;
  const port = await listen(http.createServer((request, response) => { requests++; response.writeHead(302, { location: 'https://outside.example' }); response.end('redirect fixture'); }));
  const url = `http://127.0.0.1:${port}/users/getProfile?user_id=3`;
  await assert.rejects(observedRequest(session, { url }, ui()), /allowedTargets/);
  session.contract.scope.allowedTargets = [`http://127.0.0.1:${port}`];
  const result = await observedRequest(session, { url }, ui());
  assert.equal(result.status, 302); assert.equal(result.redirectFollowed, false); assert.equal(requests, 1); assert.ok(result.evidence);
  session.policy.mode = 'read-only'; await assert.rejects(observedRequest(session, { url, method: 'POST' }, ui()), /mutating/);
});
