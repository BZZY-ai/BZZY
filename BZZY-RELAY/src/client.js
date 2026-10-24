import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { authText, open, presenceText, ReplayGuard, seal, sign, verifyCertificate, verifyPresence } from './identity.js';
import { LIMITS, VERSION, RelayError, b64, fail, opaque, random, record, relayUrl } from './protocol.js';

export class RelayClient extends EventEmitter {
  constructor({ url, identity, allowInsecureLocal = false, autoReconnect = true, requestTimeoutMs = 10000, maxPending = 64 } = {}) {
    super();
    verifyCertificate(identity.certificate);
    Object.assign(this, { url: relayUrl(url, allowInsecureLocal), identity, autoReconnect, requestTimeoutMs, maxPending });
    this.pending = new Map(); this.trusted = new Map(); this.revoked = new Set(); this.inspections = new Map();
    this.status = 'offline'; this.stopped = true; this.reconnectAttempt = 0;
  }
  trustPeer(certificate) {
    verifyCertificate(certificate);
    const known = this.trusted.get(certificate.id);
    if (known && known.boxKey !== certificate.boxKey) fail('IDENTITY_CHANGED');
    this.trusted.set(certificate.id, structuredClone(certificate));
    return certificate.id;
  }
  forgetPeer(deviceId) { this.trusted.delete(deviceId); }
  setStatus(status) { this.status = status; this.emit('status', status); }
  async connect() {
    if (this.connecting) return this.connecting;
    if (this.status === 'online') return;
    this.stopped = false; clearTimeout(this.reconnectTimer);
    this.connecting = this.establish();
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  async establish() {
    this.setStatus('connecting'); this.epoch = random(); this.replay = new ReplayGuard(); this.revoked.clear(); this.inspections.clear();
    const epoch = this.epoch;
    const ws = new WebSocket(this.url, 'bzzy-relay.v1', { maxPayload: LIMITS.frameBytes, perMessageDeflate: false, handshakeTimeout: this.requestTimeoutMs, followRedirects: false });
    this.ws = ws;
    return new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => { reject(new RelayError('CONNECTION_TIMEOUT')); ws.terminate(); }, this.requestTimeoutMs);
      ws.on('error', () => { if (!ready) reject(new RelayError('CONNECTION_FAILED')); this.emit('fault', { code: 'TRANSPORT_ERROR' }); });
      ws.on('close', (_code, reason) => {
        clearTimeout(timeout);
        if (this.ws !== ws) return;
        for (const row of this.pending.values()) { clearTimeout(row.timer); row.reject(new RelayError('DISCONNECTED_UNCERTAIN')); }
        this.pending.clear();
        if (!ready) reject(new RelayError('CONNECTION_CLOSED'));
        this.setStatus('offline');
        if (['AUTH_FAILED', 'DEVICE_REVOKED'].includes(reason.toString())) { this.stopped = true; this.emit('fault', { code: 'AUTHORIZATION_REJECTED' }); }
        this.scheduleReconnect();
      });
      ws.on('message', (data, binary) => {
        try {
          if (binary) fail('INVALID_MESSAGE');
          const frame = JSON.parse(data.toString('utf8'));
          if (frame.v !== VERSION) fail('VERSION_UNSUPPORTED');
          if (frame.event === 'challenge') {
            if (ready || this.authenticating || frame.data.audience !== this.url) fail('INVALID_CHALLENGE');
            b64(frame.data.challenge, 32); this.authenticating = true;
            const presence = { epoch, signature: sign(this.identity, presenceText(this.identity.certificate.id, epoch)) };
            this.request('auth', { certificate: this.identity.certificate, presence,
              signature: sign(this.identity, authText(this.url, frame.data.challenge, epoch)) }, true).then(result => {
              if (this.stopped || this.ws !== ws) return;
              ready = true; clearTimeout(timeout); this.reconnectAttempt = 0; this.setStatus('online'); resolve(result);
            }).catch(error => {
              reject(error);
              if (error.code !== 'DEVICE_CONNECTED') this.stopped = true;
              ws.close(1008, error.code === 'DEVICE_CONNECTED' ? 'RETRY_LATER' : 'AUTH_FAILED');
            }).finally(() => { this.authenticating = false; });
            return;
          }
          if (frame.id) {
            const row = this.pending.get(frame.id); if (!row) return;
            clearTimeout(row.timer); this.pending.delete(frame.id);
            if (frame.ok) row.resolve(frame.result); else row.reject(new RelayError(frame.error?.code || 'REQUEST_FAILED'));
            return;
          }
          if (!ready) fail('AUTH_REQUIRED');
          if (frame.event === 'delivery') {
            this.receive(frame.data, epoch).catch(error => {
              const code = error instanceof RelayError ? error.code : 'INVALID_MESSAGE';
              this.emit('rejected', { code });
              // A failed transport receipt must not silently consume a valid
              // message while leaving the application apparently online. Restore
              // transport so Core can replay its processed cursor; never replay
              // application commands here. Invalid encrypted content stays rejected.
              if (this.ws === ws && this.epoch === epoch && ['OFFLINE', 'RATE_LIMITED', 'REQUEST_CAPACITY', 'BACKPRESSURE',
                'DELIVERY_UNAVAILABLE', 'PEER_OFFLINE', 'REQUEST_TIMEOUT_UNCERTAIN', 'SEND_UNCERTAIN', 'DISCONNECTED_UNCERTAIN'].includes(code)) ws.terminate();
            });
          } else if (frame.event === 'grant.revoked') {
            this.revoked.add(frame.data.grantId); this.emit(frame.event, frame.data);
          } else if (['invite.requested', 'invite.decided', 'delivery.received', 'delivery.uncertain'].includes(frame.event)) this.emit(frame.event, frame.data);
        } catch {
          this.emit('fault', { code: 'INVALID_SERVER_MESSAGE' }); ws.close(1008, 'INVALID_MESSAGE');
        }
      });
    });
  }
  scheduleReconnect() {
    if (this.stopped || !this.autoReconnect) return;
    // Only restore transport. Never retain or resend a request or application command.
    const delay = Math.min(30000, 500 * 2 ** Math.min(this.reconnectAttempt++, 6)) * (0.75 + Math.random() * 0.5);
    this.reconnectTimer = setTimeout(() => this.connect().catch(() => {}), delay);
  }
  request(op, fields = {}, authenticating = false) {
    if ((!authenticating && this.status !== 'online') || this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new RelayError('OFFLINE'));
    if (this.pending.size >= this.maxPending) return Promise.reject(new RelayError('REQUEST_CAPACITY'));
    const id = random(), data = JSON.stringify({ v: VERSION, id, op, ...fields });
    if (Buffer.byteLength(data) > LIMITS.frameBytes || this.ws.bufferedAmount + Buffer.byteLength(data) > LIMITS.bufferedBytes) return Promise.reject(new RelayError('BACKPRESSURE'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RelayError('REQUEST_TIMEOUT_UNCERTAIN')); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(data, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new RelayError('SEND_UNCERTAIN')); } });
    });
  }
  createInvitation(spec) { return this.request('invite.create', { spec }); }
  claim(code) { return this.request('invite.claim', { code }); }
  claimStatus(claimId) { return this.request('invite.status', { claimId }); }
  async approve(claimId, confirmedRecipient) {
    // Caller must compare this certificate with the recipient over a trusted channel.
    verifyCertificate(confirmedRecipient);
    const result = await this.request('invite.decide', { claimId, approve: true, recipient: confirmedRecipient });
    if (result.grant.peer.id !== confirmedRecipient.id || result.grant.peer.boxKey !== confirmedRecipient.boxKey) {
      await this.request('grant.revoke', { grantId: result.grant.id }); fail('RECIPIENT_MISMATCH');
    }
    this.trustPeer(confirmedRecipient); return result;
  }
  deny(claimId) { return this.request('invite.decide', { claimId, approve: false }); }
  revokeInvitation(invitationId) { return this.request('invite.revoke', { invitationId }); }
  grants() { return this.request('grant.list'); }
  revokeGrant(grantId) { return this.request('grant.revoke', { grantId }); }
  revokePeer(peerId) { return this.request('peer.revoke', { peerId }); }
  async route(grantId) {
    // Share concurrent inspections only. Keeping presence beyond the in-flight
    // request would encrypt to an obsolete receiver epoch after peer reconnect.
    if (this.inspections.has(grantId)) return this.inspections.get(grantId);
    const epoch = this.epoch;
    const inspection = (async () => {
      const grant = await this.request('grant.inspect', { grantId });
      if (this.epoch !== epoch) fail('CONNECTION_CHANGED');
      const peer = this.trusted.get(grant.peer.id);
      if (!peer || peer.boxKey !== grant.peer.boxKey || peer.signKey !== grant.peer.signKey) fail('UNTRUSTED_PEER');
      if (grant.expiresAt <= Date.now() || this.revoked.has(grantId)) fail('GRANT_UNAVAILABLE');
      if (!grant.online || !grant.presence) fail('PEER_OFFLINE');
      verifyPresence(peer, grant.presence);
      return { grant, peer };
    })();
    this.inspections.set(grantId, inspection);
    try { return await inspection; }
    finally { if (this.inspections.get(grantId) === inspection) this.inspections.delete(grantId); }
  }
  async send(grantId, payload, { messageId = random() } = {}) {
    opaque(messageId);
    const epoch = this.epoch, { grant, peer } = await this.route(grantId);
    if (epoch !== this.epoch) fail('CONNECTION_CHANGED');
    const envelope = { v: VERSION, from: this.identity.certificate.id, to: peer.id, grantId, messageId,
      receiverEpoch: grant.presence.epoch, expiresAt: Date.now() + LIMITS.messageTtlMs, payload };
    const box = seal(this.identity, peer, envelope);
    return this.request('route.send', { grantId, messageId, box });
  }
  async receive(data, epoch) {
    record(data, ['deliveryId', 'from', 'to', 'grantId', 'messageId', 'box']);
    const { grant, peer } = await this.route(data.grantId);
    if (epoch !== this.epoch || data.to !== this.identity.certificate.id || data.from !== peer.id) fail('ROUTING_MISMATCH');
    const value = open(this.identity, peer, data.box);
    record(value, ['v', 'from', 'to', 'grantId', 'messageId', 'receiverEpoch', 'expiresAt', 'payload']);
    if (value.v !== VERSION || value.from !== data.from || value.to !== data.to || value.grantId !== data.grantId || value.messageId !== data.messageId || value.receiverEpoch !== epoch) fail('ROUTING_MISMATCH');
    if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() - LIMITS.clockSkewMs || value.expiresAt > Date.now() + LIMITS.messageTtlMs + LIMITS.clockSkewMs) fail('MESSAGE_EXPIRED');
    this.replay.accept(`${peer.id}:${value.messageId}`, value.expiresAt + LIMITS.clockSkewMs);
    if (this.revoked.has(grant.id)) fail('GRANT_UNAVAILABLE');
    // Receipt is transport acceptance after decryption, never proof of command execution.
    await this.request('delivery.ack', { deliveryId: data.deliveryId });
    if (epoch !== this.epoch || this.revoked.has(grant.id)) fail('GRANT_UNAVAILABLE');
    this.emit('message', { from: peer.id, grant, messageId: value.messageId, payload: value.payload });
  }
  async close() {
    this.stopped = true; clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise(resolve => { ws.once('close', resolve); ws.terminate(); });
  }
}
