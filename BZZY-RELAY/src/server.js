import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { authText, verify, verifyPresence } from './identity.js';
import { LIMITS, VERSION, RateLimiter, RelayError, b64, fail, opaque, random, record, relayUrl } from './protocol.js';
import { RelayPushService } from './push.js';

export async function startRelay({ store, audience, host = '127.0.0.1', port = 0, allowInsecureLocal = false, limits: overrides = {}, audit = () => {}, push = {} } = {}) {
  if (!store) fail('STORE_REQUIRED');
  if (!['127.0.0.1', '::1'].includes(host)) fail('LOOPBACK_PROXY_REQUIRED');
  const limits = { ...LIMITS, ...overrides };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_LIMIT');
  let relayAudience = audience ? relayUrl(audience, allowInsecureLocal) : null;
  if (!relayAudience && !allowInsecureLocal) fail('AUDIENCE_REQUIRED');
  const pushService = new RelayPushService({ ...push, store }).start();
  const sockets = new Set(), peers = new Map(), pending = new Map();
  const attempts = new RateLimiter({ maxKeys: limits.ipBuckets, limit: limits.attemptsPerMinute });
  const requests = new RateLimiter({ maxKeys: limits.devices + limits.connections, limit: limits.requestsPerMinute });
  const transfers = new RateLimiter({ maxKeys: limits.grants * 2, limit: limits.transferRequestsPerMinute });
  let stopping = false;
  // Only fixed event names/decisions and known opaque IDs. Never pass frames or errors.
  const emitAudit = (event, decision, deviceId, grantId) => {
    try { audit({ event, decision, ...(deviceId ? { deviceId: opaque(deviceId) } : {}), ...(grantId ? { grantId: opaque(grantId) } : {}) }); }
    catch { /* logging cannot affect authorization */ }
  };
  const buffered = () => [...sockets].reduce((n, s) => n + s.ws.bufferedAmount, 0);
  const send = (state, value) => {
    if (!state || state.ws.readyState !== WebSocket.OPEN) return false;
    const data = JSON.stringify(value), bytes = Buffer.byteLength(data);
    if (bytes > limits.frameBytes || state.ws.bufferedAmount + bytes > limits.bufferedBytes || buffered() + bytes > limits.globalBufferedBytes) {
      state.ws.close(1013, 'BACKPRESSURE'); return false;
    }
    state.ws.send(data, error => { if (error) state.ws.terminate(); });
    return true;
  };
  const event = (state, type, data) => send(state, { v: VERSION, event: type, data });
  const online = id => peers.get(id)?.ws.readyState === WebSocket.OPEN && !store.device(id)?.revokedAt;
  const forgetDeliveries = predicate => {
    for (const [id, delivery] of pending) if (predicate(delivery)) {
      pending.delete(id);
      event(peers.get(delivery.from), 'delivery.uncertain', { messageId: delivery.messageId });
    }
  };
  const revoked = grant => {
    forgetDeliveries(d => d.grantId === grant.id);
    for (const id of [grant.hostId, grant.recipientId]) event(peers.get(id), 'grant.revoked', { grantId: grant.id });
    emitAudit('grant', 'revoked', grant.hostId, grant.id);
  };
  const grantView = (grant, deviceId) => {
    const other = grant.hostId === deviceId ? grant.recipientId : grant.hostId;
    return { ...grant, peer: store.device(other).certificate, online: online(other), presence: online(other) ? peers.get(other).presence : null };
  };
  const statusView = (row, deviceId) => ({ claimId: row.claimId, state: row.state,
    ...(row.state === 'approved' ? { grant: grantView(store.activeGrant(row.grantId, deviceId), deviceId) } : {}) });
  const transferGrant = (state, frame) => {
    // A higher data budget never applies to authentication, invitations, claims,
    // enumeration, guessed IDs, revoked grants, or non-participants.
    let id;
    if (['grant.inspect', 'route.send'].includes(frame.op)) id = frame.grantId;
    else if (frame.op === 'delivery.ack') {
      const delivery = pending.get(frame.deliveryId);
      if (delivery?.to === state.cert.id && delivery.expiresAt > Date.now()) id = delivery.grantId;
    }
    if (!id) return null;
    try {
      const grant = store.activeGrant(id, state.cert.id);
      const portable = ['AGENT', 'TERMINAL', 'LIBRARY'].includes(grant.spec.kind) && grant.spec.mode === 'portable' && grant.spec.actions.length === 1 && grant.spec.actions[0] === 'import';
      // The Relay cannot inspect encrypted Core operations. An explicitly
      // approved live PAIR gets the same bounded data-plane budget; Core still
      // enforces separate command, telemetry and valid-ACK quotas after decrypt.
      const livePair = grant.spec.kind === 'PAIR' && grant.spec.mode === 'pair';
      return portable || livePair ? grant : null;
    } catch { return null; }
  };
  const process = (state, frame) => {
    const { op } = frame;
    const fields = {
      'host.register': [], 'invite.create': ['spec'], 'invite.claim': ['code'], 'invite.status': ['claimId'],
      'invite.decide': ['claimId', 'approve', 'recipient'], 'invite.revoke': ['invitationId'],
      'grant.list': [], 'grant.inspect': ['grantId'], 'grant.revoke': ['grantId'],
      'peer.revoke': ['peerId'], 'route.send': ['grantId', 'messageId', 'box'],
      'delivery.ack': ['deliveryId'], 'push.register': ['deviceToken', 'environment', 'enabled', 'grantIds'], 'push.status': ['environment'],
      'push.enqueue': ['grantId', 'notificationId', 'environment', 'payload', 'occurredAt']
    };
    if (!Object.hasOwn(fields, op)) fail('UNKNOWN_OPERATION');
    record(frame, ['v', 'id', 'op', ...fields[op]]);
    const deviceId = state.cert.id;
    switch (op) {
      case 'push.status': {
        store.host(deviceId);
        if (!['sandbox', 'production'].includes(frame.environment)) fail('INVALID_PUSH');
        return { providerConfigured: Boolean(pushService.configuration(frame.environment)) };
      }
      case 'push.register': return pushService.register(deviceId, { enabled: frame.enabled,
        ...(frame.deviceToken !== undefined ? { deviceToken: frame.deviceToken } : {}), ...(frame.environment !== undefined ? { environment: frame.environment } : {}),
        ...(frame.grantIds !== undefined ? { grantIds: frame.grantIds } : {}) });
      case 'push.enqueue': return pushService.enqueue(deviceId, { grantId: frame.grantId, id: frame.notificationId,
        environment: frame.environment, payload: frame.payload, occurredAt: frame.occurredAt });
      case 'host.register': {
        const result = store.provisionHost(state.cert);
        emitAudit('host', 'registered', deviceId); return result;
      }
      case 'invite.create': {
        const result = store.createInvitation(deviceId, frame.spec); emitAudit('invitation', 'created', deviceId); return result;
      }
      case 'invite.claim': {
        const row = store.claim(frame.code, state.cert, online);
        event(peers.get(row.hostId), 'invite.requested', { claimId: row.claimId, invitationId: row.id, recipient: row.recipient, spec: row.spec, expiresAt: row.expiresAt });
        emitAudit('invitation', 'claimed', deviceId);
        return { claimId: row.claimId, state: 'pending' };
      }
      case 'invite.status': return statusView(store.claimStatus(frame.claimId, deviceId), deviceId);
      case 'invite.decide': {
        if (typeof frame.approve !== 'boolean') fail('INVALID_DECISION');
        const { invitation, grant } = store.decide(deviceId, frame.claimId, frame.approve, frame.recipient);
        event(peers.get(invitation.recipient.id), 'invite.decided', statusView(invitation, invitation.recipient.id));
        emitAudit('invitation', grant ? 'approved' : 'denied', deviceId, grant?.id);
        return statusView(invitation, deviceId);
      }
      case 'invite.revoke': {
        store.host(deviceId); opaque(frame.invitationId);
        const row = store.invitation(frame.invitationId);
        if (!row || row.hostId !== deviceId) fail('INVITE_UNAVAILABLE');
        row.state = 'revoked'; store.saveInvitation(row);
        // Revoking a consumed invitation does not revoke its separate grant or recall a copy.
        return { revoked: true };
      }
      case 'grant.list': return { grants: store.grantsFor(deviceId).map(g => grantView(g, deviceId)) };
      case 'grant.inspect': return grantView(store.activeGrant(frame.grantId, deviceId), deviceId);
      case 'grant.revoke': {
        const grant = store.revokeGrant(deviceId, frame.grantId); revoked(grant); return { revoked: true };
      }
      case 'peer.revoke': {
        const grants = store.revokePeer(deviceId, frame.peerId); grants.forEach(revoked); return { revoked: grants.length };
      }
      case 'route.send': {
        const grant = store.activeGrant(frame.grantId, deviceId);
        opaque(frame.messageId); record(frame.box, ['nonce', 'ciphertext']);
        b64(frame.box.nonce, 24); const ciphertext = b64(frame.box.ciphertext);
        if (ciphertext.length < 16 || ciphertext.length > 45 * 1024) fail('INVALID_BOX');
        const to = deviceId === grant.hostId ? grant.recipientId : grant.hostId;
        if (!online(to)) fail('PEER_OFFLINE');
        if (pending.size >= limits.pendingDeliveries) fail('DELIVERY_CAPACITY');
        if ([...pending.values()].some(d => d.from === deviceId && d.messageId === frame.messageId)) fail('DUPLICATE_MESSAGE');
        const deliveryId = random();
        const delivery = { from: deviceId, to, messageId: frame.messageId, grantId: grant.id, expiresAt: Date.now() + limits.deliveryTimeoutMs };
        pending.set(deliveryId, delivery);
        if (!event(peers.get(to), 'delivery', { deliveryId, from: deviceId, to, grantId: grant.id, messageId: frame.messageId, box: frame.box })) {
          pending.delete(deliveryId); fail('PEER_BACKPRESSURE');
        }
        return { messageId: frame.messageId, status: 'forwarded' };
      }
      case 'delivery.ack': {
        opaque(frame.deliveryId);
        const delivery = pending.get(frame.deliveryId);
        if (!delivery || delivery.to !== deviceId || delivery.expiresAt <= Date.now()) fail('DELIVERY_UNAVAILABLE');
        store.activeGrant(delivery.grantId, deviceId);
        pending.delete(frame.deliveryId);
        event(peers.get(delivery.from), 'delivery.received', { messageId: delivery.messageId });
        return { received: true };
      }
    }
  };
  const server = http.createServer((request, response) => {
    const ok = request.method === 'GET' && request.url === '/healthz' && !stopping;
    response.writeHead(ok ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(ok ? { ok: true, version: VERSION } : { error: 'NOT_FOUND' }));
  });
  server.headersTimeout = 10000; server.requestTimeout = 10000; server.keepAliveTimeout = 5000;
  server.maxConnections = limits.connections + 8;
  server.maxHeadersCount = 32; server.maxRequestsPerSocket = 32;
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.frameBytes, perMessageDeflate: false, handleProtocols: () => 'bzzy-relay.v1' });
  server.on('upgrade', (request, socket, head) => {
    const ip = request.socket.remoteAddress;
    if (stopping || request.url !== '/v1/socket' || request.headers.origin || request.headers['sec-websocket-protocol'] !== 'bzzy-relay.v1' ||
      !attempts.take(ip) || sockets.size >= limits.connections || [...sockets].filter(s => s.ip === ip).length >= limits.connectionsPerIp) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  wss.on('connection', (ws, request) => {
    const state = { ws, ip: request.socket.remoteAddress, cert: null, presence: null, alive: true, challenge: random() };
    sockets.add(state);
    const authTimer = setTimeout(() => ws.close(1008, 'AUTH_TIMEOUT'), limits.authTimeoutMs);
    send(state, { v: VERSION, event: 'challenge', data: { challenge: state.challenge, audience: relayAudience } });
    ws.on('pong', () => { state.alive = true; });
    ws.on('error', () => emitAudit('connection', 'transport_error'));
    ws.on('message', (data, binary) => {
      let id;
      try {
        if (binary) fail('JSON_REQUIRED');
        const frame = JSON.parse(data.toString('utf8'));
        if (frame?.v !== VERSION) fail('VERSION_UNSUPPORTED');
        id = opaque(frame.id);
        if (!state.cert) {
          record(frame, ['v', 'id', 'op', 'certificate', 'signature', 'presence']);
          if (frame.op !== 'auth') fail('AUTH_REQUIRED');
          store.certificate(frame.certificate);
          verifyPresence(frame.certificate, frame.presence);
          if (!verify(frame.certificate, authText(relayAudience, state.challenge, frame.presence.epoch), frame.signature)) fail('AUTH_FAILED');
          if (online(frame.certificate.id)) fail('DEVICE_CONNECTED');
          state.cert = frame.certificate; state.presence = frame.presence; state.challenge = null;
          peers.set(state.cert.id, state); clearTimeout(authTimer);
          send(state, { v: VERSION, id, ok: true, result: { deviceId: state.cert.id, role: store.device(state.cert.id)?.role || 'candidate' } });
          emitAudit('authentication', 'accepted', state.cert.id); return;
        }
        store.certificate(state.cert);
        const transfer = transferGrant(state, frame);
        if (!(transfer ? transfers.take(`${state.cert.id}:${transfer.id}`) : requests.take(state.cert.id))) fail('RATE_LIMITED');
        const result = process(state, frame);
        send(state, { v: VERSION, id, ok: true, result });
      } catch (error) {
        const code = error instanceof RelayError ? error.code : 'INVALID_MESSAGE';
        if (id) send(state, { v: VERSION, id, ok: false, error: { code } });
        else ws.close(1008, 'INVALID_MESSAGE');
        emitAudit('request', 'rejected', state.cert?.id);
        if (!state.cert) ws.close(1008, code === 'DEVICE_CONNECTED' ? 'DEVICE_CONNECTED' : 'AUTH_FAILED');
      }
    });
    ws.on('close', () => {
      clearTimeout(authTimer); sockets.delete(state);
      if (state.cert && peers.get(state.cert.id) === state) {
        peers.delete(state.cert.id); forgetDeliveries(d => d.from === state.cert.id || d.to === state.cert.id);
      }
    });
  });
  const heartbeat = setInterval(() => {
    for (const state of sockets) {
      if (!state.alive || (state.cert && store.device(state.cert.id)?.revokedAt)) { state.ws.terminate(); continue; }
      state.alive = false; state.ws.ping();
    }
  }, limits.heartbeatMs);
  let sweeps = 0;
  const maintenance = setInterval(() => {
    forgetDeliveries(d => {
      if (d.expiresAt <= Date.now()) return true;
      try { store.activeGrant(d.grantId, d.from); return false; } catch { return true; }
    });
    for (const state of sockets) if (state.cert && store.device(state.cert.id)?.revokedAt) state.ws.close(1008, 'DEVICE_REVOKED');
    if (++sweeps % 60 === 0) { try { store.sweep(); } catch { emitAudit('maintenance', 'failed'); } }
  }, 1000);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  } catch (error) { clearInterval(heartbeat); clearInterval(maintenance); await pushService.close(); wss.close(); throw error; }
  relayAudience ||= `ws://${host === '::1' ? '[::1]' : host}:${server.address().port}/v1/socket`;
  return {
    audience: relayAudience, address: server.address(),
    metrics: () => ({ connections: sockets.size, pendingDeliveries: pending.size, bufferedBytes: buffered(), rssBytes: processMemory() }),
    async close() {
      stopping = true; clearInterval(heartbeat); clearInterval(maintenance);
      await pushService.close();
      for (const state of sockets) state.ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
    }
  };
}
const processMemory = () => globalThis.process.memoryUsage().rss;
