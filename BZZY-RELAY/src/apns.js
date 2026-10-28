import fs from 'node:fs';
import path from 'node:path';
import http2 from 'node:http2';
import { createPrivateKey, sign, createHash, randomUUID } from 'node:crypto';

export class PushError extends Error {
  constructor(code, options = {}) { super('Push delivery unavailable.'); this.code = code; Object.assign(this, options); }
}
const privateFile = file => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768 || (stat.mode & 0o077) || process.getuid && stat.uid !== process.getuid()) throw new PushError('APNS_CONFIGURATION_INVALID');
  return fs.readFileSync(file, 'utf8');
};

// Only the local host owner configures Apple credentials. No RPC accepts topic,
// endpoint, signing material, headers, payload text or a destination URL.
export function loadAPNsConfigurationFile(file, { strict = false } = {}) {
  try {
    if (!fs.existsSync(file)) return null;
    const value = JSON.parse(privateFile(file));
    if (!value || Object.keys(value).some(key => !['keyId', 'teamId', 'topic', 'environment', 'signingKeyFile'].includes(key)) ||
      !/^[A-Z0-9]{10}$/.test(value.keyId) || !/^[A-Z0-9]{10}$/.test(value.teamId) ||
      typeof value.topic !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/.test(value.topic) ||
      !['sandbox', 'production'].includes(value.environment) || typeof value.signingKeyFile !== 'string' || !path.isAbsolute(value.signingKeyFile)) throw new PushError('APNS_CONFIGURATION_INVALID');
    const pem = privateFile(value.signingKeyFile), privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new PushError('APNS_CONFIGURATION_INVALID');
    return { ...value, privateKey, fingerprint: createHash('sha256').update(JSON.stringify(value)).update(pem).digest('hex') };
  } catch {
    if (strict) throw new PushError('APNS_CONFIGURATION_INVALID');
    return null;
  }
}

export function deviceToken(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64,512}$/.test(value) || value.length % 2) throw new PushError('INVALID_REQUEST');
  return value.toLowerCase();
}

export class APNsClient {
  #configuration; #session; #connected = new WeakSet(); #jwt; #jwtAt = 0; #clock; #endpoint;
  constructor({ configuration, endpoint, allowInsecureLocal = false, clock = Date.now } = {}) {
    if (!configuration?.privateKey) throw new PushError('APNS_CONFIGURATION_INVALID');
    const expected = configuration.environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    const target = new URL(endpoint || expected);
    if (target.href !== new URL(expected).href && !(allowInsecureLocal && target.protocol === 'http:' && target.hostname === '127.0.0.1' &&
      !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash)) throw new PushError('APNS_CONFIGURATION_INVALID');
    this.#configuration = configuration; this.#endpoint = target.origin; this.#clock = clock;
  }
  #authorization() {
    const seconds = Math.floor(this.#clock() / 1000);
    if (!this.#jwt || seconds < this.#jwtAt || seconds - this.#jwtAt >= 45 * 60) {
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: this.#configuration.keyId })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ iss: this.#configuration.teamId, iat: seconds })).toString('base64url');
      const input = `${header}.${claims}`;
      this.#jwt = `${input}.${sign('sha256', Buffer.from(input), { key: this.#configuration.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
      this.#jwtAt = seconds;
    }
    return `bearer ${this.#jwt}`;
  }
  #discard(session) {
    if (this.#session === session) this.#session = null;
    session.destroy();
  }
  async #connection(signal) {
    if (signal?.aborted) throw new PushError('APNS_UNAVAILABLE');
    let session = this.#session;
    if (!session || session.destroyed || session.closed) {
      try { session = http2.connect(this.#endpoint); }
      catch { throw new PushError('APNS_UNAVAILABLE'); }
      this.#session = session;
      const current = session;
      session.once('connect', () => this.#connected.add(current));
      // Idle broken sessions must not poison the next distinct alert. No
      // notification is resent here; each in-flight stream retains its outcome.
      session.on('error', () => this.#discard(current));
      session.on('goaway', () => { if (this.#session === current) this.#session = null; });
    }
    if (this.#connected.has(session)) return session;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        session.off('connect', connected); session.off('error', failed); session.off('close', failed);
        if (error) { this.#discard(session); reject(error); } else resolve();
      };
      // Until HTTP/2's connect event, TLS has not completed and no POST has
      // been constructed. DNS/TLS/connect-timeout/abort can safely retry.
      const failed = () => finish(new PushError('APNS_UNAVAILABLE'));
      const connected = () => finish();
      const abort = failed;
      const timer = setTimeout(failed, 5000); timer.unref?.();
      session.once('connect', connected); session.once('error', failed); session.once('close', failed);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    return session;
  }
  async send({ token, payload, id = randomUUID(), collapseID, signal, beforeDispatch } = {}) {
    token = deviceToken(token);
    const data = Buffer.from(JSON.stringify(payload));
    if (data.length > 4096 || !/^[a-f0-9-]{36}$/i.test(id) || typeof collapseID !== 'string' || Buffer.byteLength(collapseID) > 64) throw new PushError('APNS_PAYLOAD_INVALID', { permanent: true });
    if (signal?.aborted) throw new PushError('APNS_UNAVAILABLE');
    const session = await this.#connection(signal);
    if (signal?.aborted || session.destroyed || session.closed) throw new PushError('APNS_UNAVAILABLE');
    return new Promise((resolve, reject) => {
      let stream, settled = false, dispatched = false, status, responseID, body = '';
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) {
          stream?.close(http2.constants.NGHTTP2_CANCEL);
          if (['APNS_UNAVAILABLE', 'APNS_RESPONSE_INVALID'].includes(error.code)) this.#discard(session);
          reject(error);
        } else resolve(value);
      };
      const unavailable = () => new PushError('APNS_UNAVAILABLE', { uncertain: dispatched });
      const abort = () => finish(unavailable());
      const timer = setTimeout(abort, 5000); timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const headers = { ':method': 'POST', ':path': `/3/device/${token}`, authorization: this.#authorization(),
          'apns-topic': this.#configuration.topic, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-id': id,
          'apns-expiration': String(Math.floor(this.#clock() / 1000) + 3600), 'apns-collapse-id': collapseID, 'content-type': 'application/json' };
        // The owner can durably fence dispatch and recheck authorization after
        // connection setup. It must complete synchronously before any headers.
        beforeDispatch?.();
        if (settled || signal?.aborted) { abort(); return; }
        // On a connected HTTP/2 session, request() may immediately emit the
        // POST headers. Any later ambiguity must not become an automatic replay.
        dispatched = true;
        stream = session.request(headers);
        stream.on('response', headers => { status = Number(headers[':status']); responseID = headers['apns-id']; });
        stream.on('data', chunk => { body += chunk.toString(); if (Buffer.byteLength(body) > 2048) finish(new PushError('APNS_RESPONSE_INVALID', { uncertain: true })); });
        stream.on('error', () => finish(unavailable()));
        stream.on('end', () => {
          // HTTP/2 can end a posted stream without response headers (for
          // example RST_STREAM(NO_ERROR)). Missing/nonfinal/unexpected status
          // is not an explicit Apple rejection and cannot authorize a retry.
          if (!Number.isInteger(status) || status !== 200 && (status < 400 || status > 599)) {
            finish(new PushError('APNS_RESPONSE_INVALID', { uncertain: true })); return;
          }
          if (status === 200) { finish(null, { accepted: true, apnsId: /^[a-f0-9-]{36}$/i.test(String(responseID)) ? responseID : id }); return; }
          let reason, timestamp;
          try { const response = JSON.parse(body); reason = response.reason; timestamp = Number.isFinite(response.timestamp) ? response.timestamp : undefined; } catch {}
          const invalidated = status === 410 || status === 400 && reason === 'BadDeviceToken';
          finish(new PushError(invalidated ? 'APNS_TOKEN_INVALID' : 'APNS_REJECTED', { permanent: invalidated || status >= 400 && status < 500 && status !== 429,
            invalidated, ...(timestamp !== undefined ? { timestamp } : {}), status }));
        });
        stream.end(data);
      } catch (error) { finish(error instanceof PushError ? error : unavailable()); }
    });
  }
  close() { if (this.#session) this.#discard(this.#session); }
}
