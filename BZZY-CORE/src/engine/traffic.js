import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { home, privateDir } from './files.js';
import { digest, putRecord, appendEvent, now } from './database.js';
import { artifact } from './evidence.js';
import { assertScopeOperation } from './program-scope.js';
import { diagnosticRedactor } from './diagnostic-redaction.js';

const sensitive = /authorization|cookie|password|passwd|secret|token|api[-_]?key/i;
export function redactedHeaders(headers) { return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, sensitive.test(k) ? '[redacted]' : v])); }
export function redactedUrl(value) {
  const url = new URL(value); url.username = ''; url.password = '';
  for (const key of url.searchParams.keys()) if (sensitive.test(key)) url.searchParams.set(key, '[redacted]');
  return url.href;
}
function openssl(args) {
  const result = spawnSync('openssl', args, { encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) throw new Error(`Local HTTPS capture needs openssl: ${result.error?.message || result.stderr?.slice(-1000)}`);
}
export function captureCA(namespace = 'default') {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(namespace)) throw new Error('Invalid CA namespace.');
  const dir = path.join(home(), 'traffic-ca', namespace); privateDir(dir);
  const key = path.join(dir, 'ca.key'), cert = path.join(dir, 'ca.pem');
  if (!fs.existsSync(cert)) {
    // A separate random directory avoids concurrent first-run creation overwriting a live CA.
    const temp = fs.mkdtempSync(path.join(dir, 'create-'));
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(temp, 'ca.key'), '-out', path.join(temp, 'ca.pem'), '-subj', '/CN=bzzy local assessment capture', '-days', '365', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    try {
      fs.copyFileSync(path.join(temp, 'ca.key'), key, fs.constants.COPYFILE_EXCL);
      fs.copyFileSync(path.join(temp, 'ca.pem'), cert, fs.constants.COPYFILE_EXCL);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  fs.chmodSync(key, 0o600); fs.chmodSync(cert, 0o600);
  return { dir, key, cert };
}
function certificate(hostname, ca) {
  if (!/^[a-zA-Z0-9.:-]{1,253}$/.test(hostname)) throw new Error('Invalid TLS hostname.');
  const dir = path.join(ca.dir, 'hosts'); privateDir(dir);
  const prefix = path.join(dir, digest(hostname)), key = prefix + '.key', cert = prefix + '.pem';
  if (!fs.existsSync(cert)) {
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', prefix + '.csr', '-subj', `/CN=${hostname}`]);
    fs.writeFileSync(prefix + '.ext', `subjectAltName=${net.isIP(hostname) ? 'IP' : 'DNS'}:${hostname}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
    openssl(['x509', '-req', '-in', prefix + '.csr', '-CA', ca.cert, '-CAkey', ca.key, '-set_serial', '0x' + randomBytes(16).toString('hex'), '-out', cert, '-days', '30', '-extfile', prefix + '.ext']);
    fs.chmodSync(key, 0o600); fs.chmodSync(cert, 0o600);
  }
  return tls.createSecureContext({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
}
function modelHost(hostname, provider) {
  const excluded = ['openai.com', 'chatgpt.com', 'anthropic.com', 'claude.ai', 'claude.com'];
  if (provider.baseUrl) excluded.push(new URL(provider.baseUrl).hostname);
  return excluded.some(domain => hostname === domain || hostname.endsWith('.' + domain));
}
export class TrafficRecorder {
  constructor(session, provider, ui) { Object.assign(this, { session, provider, ui }); this.sockets = new Set(); this.token = randomUUID(); }
  emit(type, data) {
    this.ui.event(type, data);
    if (this.session.parentSessionId) appendEvent(this.session.parentSessionId, type, { ...data, agent: this.session.agentNamespace || this.session.provider });
  }
  async open() {
    this.ca = captureCA(this.session.id);
    this.server = http.createServer((request, response) => {
      if (!this.authorized(request)) { response.writeHead(407); response.end(); return; }
      this.forward(request, response, request.url);
    });
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); socket.on('error', () => {}); });
    this.server.on('connect', (request, socket, head) => {
      if (!this.authorized(request)) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
      let target;
      try { target = new URL(`https://${request.url}`); } catch { socket.destroy(); return; }
      const hostname = target.hostname.replace(/^\[|\]$/g, ''), port = Number(target.port || 443);
      if (modelHost(hostname, this.provider)) {
        // Model/auth traffic is tunneled without TLS interception, headers or payload logging.
        const upstream = net.connect(port, hostname, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
        this.sockets.add(upstream); upstream.on('close', () => this.sockets.delete(upstream)); upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy()); return;
      }
      try {
        const secureContext = certificate(hostname, this.ca);
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) socket.unshift(head);
        const secured = new tls.TLSSocket(socket, { isServer: true, secureContext });
        secured.on('error', error => { this.emit('network.error', { message: error.message, host: hostname, provenance: 'proxy-observed' }); secured.destroy(); });
        const inner = http.createServer((req, res) => this.forward(req, res, new URL(req.url, target.origin).href));
        inner.emit('connection', secured);
      } catch (error) { this.emit('network.error', { message: error.message, host: hostname }); socket.destroy(); }
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    const proxy = `http://bzzy:${this.token}@127.0.0.1:${this.server.address().port}`;
    const bundle = path.join(this.ca.dir, 'bundle.pem');
    let roots = tls.rootCertificates.join('\n');
    for (const file of ['/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/cert.pem']) if (fs.existsSync(file)) { roots += '\n' + fs.readFileSync(file, 'utf8'); break; }
    if (process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(process.env.NODE_EXTRA_CA_CERTS)) roots += '\n' + fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8');
    fs.writeFileSync(bundle, roots + '\n' + fs.readFileSync(this.ca.cert, 'utf8'), { mode: 0o600 });
    this.env = { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: '', no_proxy: '',
      NODE_EXTRA_CA_CERTS: bundle, SSL_CERT_FILE: bundle, REQUESTS_CA_BUNDLE: bundle, CURL_CA_BUNDLE: bundle };
    this.emit('network.capture', { enabled: true, coverage: 'Proxy-aware child processes only; direct sockets and clients ignoring proxy/CA settings are not captured.', https: true, modelTrafficRecorded: false });
    return this;
  }
  authorized(request) { return request.headers['proxy-authorization'] === 'Basic ' + Buffer.from(`bzzy:${this.token}`).toString('base64'); }
  forward(request, response, value) {
    let url;
    try { url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported proxy URL.'); }
    catch { response.writeHead(400); response.end('Invalid target'); return; }
    const excluded = modelHost(url.hostname, this.provider), id = randomUUID(), started = Date.now();
    const requestHash = createHash('sha256'), responseHash = createHash('sha256'); let requestBytes = 0, responseBytes = 0;
    const headers = { ...request.headers, host: url.host }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const entry = { id, sessionId: this.session.id, method: request.method, url: redactedUrl(url.href), requestHeaders: redactedHeaders(headers), startedAt: now(), provenance: 'proxy-observed' };
    if (!excluded) { putRecord('traffic', id, entry); this.emit('network.request', entry); }
    const upstream = (url.protocol === 'https:' ? https : http).request(url, { method: request.method, headers, agent: false }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.on('data', chunk => { responseBytes += chunk.length; responseHash.update(chunk); });
      incoming.pipe(response);
      incoming.once('end', () => {
        if (excluded) return;
        const result = { ...entry, status: incoming.statusCode, responseHeaders: redactedHeaders(incoming.headers), durationMs: Date.now() - started,
          requestBytes, responseBytes, requestBodySha256: requestHash.digest('hex'), responseBodySha256: responseHash.digest('hex'), completedAt: now() };
        putRecord('traffic', id, result); this.emit('network.response', result);
      });
    });
    upstream.setTimeout(60000, () => upstream.destroy(new Error('Proxy upstream timeout.')));
    upstream.on('socket', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    upstream.on('error', error => { if (!response.headersSent) response.writeHead(502); response.end(); if (!excluded) { putRecord('traffic', id, { ...entry, error: error.message }); this.emit('network.error', { ...entry, message: error.message }); } });
    request.on('data', chunk => { requestBytes += chunk.length; requestHash.update(chunk); }); request.pipe(upstream);
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
  }
  async close() { for (const socket of this.sockets) socket.destroy(); if (this.server) await new Promise(resolve => this.server.close(resolve)); }
}
function targetAllowed(url, scope) {
  const match = pattern => {
    if (pattern.startsWith('http://') || pattern.startsWith('https://')) {
      const allowed = new URL(pattern.replace(/\*$/, ''));
      return url.origin === allowed.origin && (allowed.pathname === '/' || url.pathname === allowed.pathname || url.pathname.startsWith(allowed.pathname.replace(/\/$/, '') + '/'));
    }
    return pattern.startsWith('*.') ? url.hostname.endsWith(pattern.slice(1)) : url.hostname === pattern;
  };
  return Boolean(scope.allowedTargets?.some(match) && !scope.excludedTargets?.some(match));
}
export async function observedRequest(session, input, ui) {
  const emit = (type, data) => {
    ui.event(type, data);
    if (session.parentSessionId) appendEvent(session.parentSessionId, type, { ...data, actorSessionId: session.id, agent: session.agentNamespace || session.provider });
  };
  let url = new URL(input.url); const scope = session.contract?.scope || {};
  const method = (input.method || 'GET').toUpperCase();
  assertScopeOperation(session, { url: url.href, method });
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method) || !['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported HTTP method or URL.');
  if (!targetAllowed(url, scope)) throw new Error('HTTP target is not within the contract’s declared allowedTargets, or is excluded.');
  if (session.policy?.mode === 'read-only' && !['GET', 'HEAD', 'OPTIONS'].includes(method)) throw new Error('This read-only task does not permit mutating HTTP methods.');
  if (session.policy?.network === 'disabled') throw new Error('Task policy disables network access.');
  if (input.body && typeof input.body !== 'string') throw new Error('HTTP body must be a string.');
  if ((input.body?.length || 0) > 1024 * 1024) throw new Error('HTTP body exceeds 1 MiB.');
  const id = randomUUID(), started = Date.now(), entry = { id, sessionId: session.id, method, url: redactedUrl(url.href), requestHeaders: redactedHeaders(input.headers || {}), startedAt: now(), provenance: 'host-observed' };
  putRecord('traffic', id, entry); emit('network.request', entry);
  const response = await fetch(url, { method, headers: input.headers || {}, body: input.body, redirect: 'manual', signal: AbortSignal.timeout(Math.min(input.timeoutSeconds || 30, 120) * 1000) });
  const chunks = []; let bytes = 0, truncated = false;
  for await (const chunk of response.body || []) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { truncated = true; break; } chunks.push(chunk); }
  const content = Buffer.concat(chunks), evidence = artifact(session, content, `http-response:${id}`, response.headers.get('content-type') || 'application/octet-stream');
  const textual = /(?:text\/|json|xml|javascript|x-www-form-urlencoded)/i.test(response.headers.get('content-type') || '');
  const responsePreview = textual ? diagnosticRedactor({ maxString: 8192 }).scrub(content.toString('utf8')) : undefined;
  const result = { ...entry, status: response.status, responseHeaders: redactedHeaders(Object.fromEntries(response.headers)), durationMs: Date.now() - started, responseBytes: content.length, truncated, evidence: evidence.id, completedAt: now(), redirectFollowed: false,
    ...(responsePreview !== undefined ? { responsePreview, previewRedacted: true } : {}) };
  putRecord('traffic', id, result); emit('network.response', result);
  return { ...result, preview: content.subarray(0, 8192).toString('utf8'), next: 'Use read_artifact for the recorded response. Redirects require a separate in-scope request.' };
}
