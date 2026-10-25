import { providerModels } from '../engine/provider-catalog.js';
import { remoteDefaults, configureRemoteDefaults } from '../engine/remote-settings.js';
import { requireUpdateGrant } from '../engine/update-access.js';
import { coreUpdates } from '../engine/updates.js';
import { terminalCatalogRevision } from '../engine/session-deletion.js';
import { CoreVoiceChat } from '../engine/voice-chat.js';
import { setTerminalYolo } from '../engine/terminal-permissions.js';
import { enqueueGoalTurn } from '../engine/session-operations.js';
import { parseGoalCommand } from '../engine/goals.js';
import { authorizedUpdateGrant as authorizedOwnPhone } from '../engine/update-access.js';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RelayConnectionHealth } from './connection-health.js';
import { BzzyCore } from '../core.js';
import { CoreAgents } from '../agents.js';
import { CoreAgentImports } from '../agent-imports.js';
import { BzzyClient, home, runtime, getRecord, putRecord, listRecords, transaction, database, appendEvent, digest, now,
  loadSession, createSessionAccess, revokeSessionAccess, sessionPermissions, activeAccess, lockFile } from '../engine.js';
import { object, opaque, uuid, fail } from '../validation.js';
import { terminalSession } from './terminal-catalog.js';
import { registerDeviceNotifications, updateDeviceNotifications, revokeDeviceNotifications } from '../push/registration.js';
import { RelayClient, verifyCertificate, encodeInvitation, renderInvitationQR } from './sdk.js';
import { DEFAULT_RELAY_URL, loadRelayIdentity, privateRelayDirectory } from './identity.js';
import { revokeLocalRelayGrant } from './revocation.js';
import { ProjectTransferService, libraryShareSelection } from './project-transfer.js';
import { PROTOCOL, VERSION, LIMITS, COMMANDS, OPERATIONS, validateRequest, permissionFor,
  boundedInteger, boundedPayload, sanitize, response, errorResponse } from './protocol.js';

const alive = row => row && !row.revokedAt && row.expiresAt > Date.now();
const publicGrant = row => ({ id: row.id, deviceId: row.peerId, resource: row.resource, sessionId: row.sessionId,
  permissions: row.permissions, sessionAccess: row.sessionAccess === true, shareAccess: row.shareAccess === true,
  agentAccess: row.agentAccess === true, expiresAt: row.expiresAt, revokedAt: row.revokedAt || null });
const pick = (value, keys) => value && Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const commandAcceptance = record => record.op === 'task.submit' ? { taskId: record.id } : record.result;
const safeCodes = new Set(['ASSISTANT_SETUP_REQUIRED', 'VOICE_UNAVAILABLE', 'FORBIDDEN', 'INVALID_REQUEST', 'CONFLICT', 'UNCERTAIN', 'OPERATION_DENIED', 'PROTOCOL_UNSUPPORTED',
  'REQUEST_TOO_LARGE', 'RESULT_TOO_LARGE', 'RATE_LIMITED', 'CAPACITY', 'INVALID_CURSOR', 'GRANT_UNAVAILABLE', 'AUTHORIZATION_REQUIRED',
  'WORKSPACE_SETUP_REQUIRED', 'WORKSPACE_CHANGED', 'WORKSPACE_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'CORE_STOPPED',
  'CONFIRMATION_REQUIRED', 'DEFAULT_REQUIRED', 'EXPORT_ACTIVE', 'SECRET_DETECTED', 'EXPORT_INVALID', 'SHARE_CONTEXT_INCOMPLETE',
  'IMPORT_UNAVAILABLE', 'IMPORT_INVALID', 'IMPORT_CONFLICT', 'CANCELLED', 'TRANSFER_UNAVAILABLE', 'SESSION_DELETED']);
const errorCode = error => {
  if ((error.status === 403 || error.status === 401) && (!safeCodes.has(error.code) || error.code === 'INVALID_REQUEST')) return 'FORBIDDEN';
  return safeCodes.has(error.code) ? error.code : 'GATEWAY_UNAVAILABLE';
};
const catalogLimit = 25, contextLimit = 32;

// Trusted home-host component. Only encrypted, allowlisted RPCs reach scoped Core
// clients. Neither an owner credential nor this administration object is remote.
export class RelayGateway extends EventEmitter {
  #home;
  #identity;
  #relay;
  #relayHealth;
  #core;
  #unlock;
  #started = false;
  #subscriptions = new Map();
  #inflight = new Map();
  #rates = new Map();
  #metricsRates = new Map();
  #ackRates = new Map();
  #chunkRates = new Map();
  #eventTransfers = new Map();
  #pollIntervalMs;
  #subscriptionLeaseMs;
  #maintenanceTimer;
  #maintenanceBusy = false;
  #transfers;
  #agents;
  #agentImports;
  #voice;

  constructor({ identity = loadRelayIdentity(), url = DEFAULT_RELAY_URL, allowInsecureLocal = false,
    autoReconnect = true, requestTimeoutMs = 10000, pollIntervalMs = 500, subscriptionLeaseMs = 60000, clientFactory = options => new RelayClient(options) } = {}) {
    super(); verifyCertificate(identity.certificate);
    this.#home = home(); this.#identity = structuredClone(identity); this.#core = new BzzyCore();
    this.#agents = new CoreAgents();
    this.#voice = new CoreVoiceChat({ client: context => this.#clientFor(context) });
    this.#agentImports = new CoreAgentImports({ agents: this.#agents, url, allowInsecureLocal });
    this.#pollIntervalMs = boundedInteger(pollIntervalMs, 100, 5000);
    this.#subscriptionLeaseMs = boundedInteger(subscriptionLeaseMs, 200, 120000);
    this.#relay = clientFactory({ identity: this.#identity, url, allowInsecureLocal, autoReconnect, requestTimeoutMs });
    this.#transfers = new ProjectTransferService({ client: this.#relay });
    const route = this.#relay.route.bind(this.#relay);
    this.#relay.route = async id => {
      const value = await route(id), local = getRecord('core.relay.grant', id);
      if (this.#transfers.authorizeRoute(value.grant, value.peer)) return value;
      this.#authorize(id, value.peer.id, local?.resource);
      return value;
    };
    this.#relay.on('status', status => {
      if (status !== 'online') this.#stopSubscriptions();
      this.emit('status', { transport: status, gateway: this.#started ? status === 'online' ? 'ready' : 'reconnecting' : status === 'offline' ? 'stopped' : 'starting' });
    });
    this.#relay.on('fault', () => this.emit('fault', { code: 'RELAY_TRANSPORT_ERROR' }));
    this.#relay.on('rejected', () => this.emit('fault', { code: 'RELAY_MESSAGE_REJECTED' }));
    this.#relay.on('invite.requested', data => { if (!this.#transfers.handleClaim(data)) this.#claim(data); });
    this.#relay.on('grant.revoked', data => {
      this.#transfers.handleRevocation(data.grantId);
      try { this.#revokeLocal(opaque(data.grantId)); }
      catch { this.emit('fault', { code: 'REVOCATION_FAILED' }); }
    });
    this.#relay.on('message', data => {
      void this.#transfers.handleMessage(data).then(handled => handled ? undefined : this.#message(data))
        .catch(() => this.emit('fault', { code: 'GATEWAY_REQUEST_FAILED' }));
    });
  }

  #check() {
    if (home() !== this.#home) fail('HOST_CONTEXT_CHANGED', 'The gateway host context changed.', 409);
  }
  async enqueuePush(registration, request) {
    this.#check();
    this.#authorize(registration.relayGrantId, registration.peerId, registration.resource);
    const result = await this.#relay.request('push.enqueue', { grantId: registration.relayGrantId,
      notificationId: request.id, environment: registration.environment, payload: request.payload, occurredAt: request.occurredAt });
    return result;
  }
  #rows(kind) { this.#check(); return listRecords(kind).filter(row => row.hostId === this.#identity.certificate.id && row.relayUrl === this.#relay.url); }
  #audit(row, decision, code) {
    this.#check();
    appendEvent(row.sessionId, 'relay.authorization', { decision, ...(code ? { code } : {}), provenance: 'host-policy' });
  }
  #authorize(id, peerId, resource, permission = 'observe') {
    this.#check();
    const row = getRecord('core.relay.grant', id), pin = row && getRecord('core.relay.pin', row.peerId);
    if (!this.#started || !alive(row) || row.hostId !== this.#identity.certificate.id || row.relayUrl !== this.#relay.url ||
      row.peerId !== peerId || !row.permissions.includes(permission) ||
      !pin || pin.revokedAt || pin.hostId !== row.hostId || digest(pin.certificate) !== row.peerDigest) fail('FORBIDDEN', 'Local gateway authorization denied.', 403);
    const access = getRecord('access-token', digest(row.token));
    if (!activeAccess(access) || access.id !== row.coreGrantId || access.sessionId !== row.sessionId || access.includeChildren !== false || !access.permissions.includes(permission)) fail('FORBIDDEN', 'Local Core permission is no longer active.', 403);
    if (row.resource === resource) return row;
    const child = getRecord('core.relay.context', resource);
    if (!alive(child) || child.relayGrantId !== row.id || child.peerId !== peerId ||
      child.hostId !== row.hostId || child.relayUrl !== row.relayUrl || child.peerDigest !== row.peerDigest || child.resource !== resource ||
      child.expiresAt > row.expiresAt || !child.permissions.includes(permission) || child.permissions.some(item => !row.permissions.includes(item))) fail('FORBIDDEN', 'This context is outside the approved device grant.', 403);
    if (child.kind === 'agent') {
      if (row.agentAccess !== true) fail('FORBIDDEN', 'Agent access requires explicit host approval.', 403);
      const agent = this.#agents.get(child.agentId);
      if (agent.archived || agent.sessionId !== child.sessionId) fail('FORBIDDEN', 'This agent context is no longer active.', 403);
    } else if (row.sessionAccess !== true || !terminalSession(loadSession(child.sessionId))) fail('FORBIDDEN', 'This terminal context is outside the catalog grant.', 403);
    const childAccess = getRecord('access-token', digest(child.token));
    if (!activeAccess(childAccess) || childAccess.id !== child.coreGrantId || childAccess.sessionId !== child.sessionId || childAccess.includeChildren !== false || !childAccess.permissions.includes(permission)) fail('FORBIDDEN', 'This terminal context is no longer active.', 403);
    return { ...child, id: row.id, sessionAccess: false, agentAccess: false,
      shareAccess: row.shareAccess === true && (child.kind !== 'agent' || row.agentAccess === true) };
  }

  async start() {
    this.#check();
    if (process.getuid?.() === 0) fail('NON_ROOT_REQUIRED', 'Run the gateway and model execution as a non-root user.');
    if (this.#started) return this.status();
    this.#unlock = lockFile(path.join(privateRelayDirectory(), 'gateway.lock'), 'A Core Relay gateway already owns this host identity.');
    try {
      this.#transfers.restore();
      for (const pin of this.#rows('core.relay.pin')) if (!pin.revokedAt) this.#relay.trustPeer(pin.certificate);
      const authentication = await this.#relay.connect();
      if (authentication?.role !== 'host') {
        try { await this.#relay.request('host.register'); }
        catch (error) {
          if (error.code === 'UNKNOWN_OPERATION') fail('HOST_ENROLLMENT_REQUIRED', 'Update Relay to support automatic host registration.');
          throw error;
        }
      }
      await this.#core.start(); this.#started = true;
      this.#relayHealth = new RelayConnectionHealth(this.#relay).start();
      for (const command of this.#rows('core.relay.command')) if (command.state === 'dispatching') putRecord('core.relay.command', command.id, { ...command, state: 'uncertain' });
      this.#maintenanceTimer = setInterval(() => { void this.#maintenance(); }, 1000);
      this.emit('status', { transport: this.#relay.status, gateway: 'ready' });
      return this.status();
    } catch (error) {
      await this.#relay.close(); this.#unlock?.(); this.#unlock = null;
      throw error;
    }
  }
  status() {
    this.#check();
    return { transport: this.#relay.status, connection: this.#relayHealth?.snapshot() || { online: false, verifiedAt: null, maximumAgeMs: 6000 }, gateway: this.#started ? this.#relay.status === 'online' ? 'ready' : 'reconnecting' : 'stopped', relayUrl: this.#relay.url,
      hostId: this.#identity.certificate.id, protocol: PROTOCOL, version: VERSION,
      activeGrants: this.#rows('core.relay.grant').filter(alive).length, subscriptions: this.#subscriptions.size,
      operations: [...OPERATIONS], portableSharing: true, portableKinds: ['TERMINAL', 'AGENT'], projectSharing: true };
  }
  grants() { return this.#rows('core.relay.grant').map(publicGrant); }
  pendingPairings() {
    return this.#rows('core.relay.pairing').filter(row => row.state === 'requested' && row.expiresAt > Date.now())
      .map(row => ({ claimId: row.claimId, deviceId: row.recipient.id, certificate: structuredClone(row.recipient),
        resource: row.resource, sessionId: row.sessionId, permissions: row.permissions, sessionAccess: row.sessionAccess === true, shareAccess: row.shareAccess === true,
        agentAccess: row.agentAccess === true, expiresAt: row.expiresAt }));
  }

  async createPairing(input) {
    this.#check(); object(input, ['sessionId', 'permissions', 'ttlSeconds', 'grantTtlSeconds', 'sessionAccess', 'shareAccess', 'agentAccess'], 'Pairing'); uuid(input.sessionId);
    if (input.sessionAccess !== undefined && typeof input.sessionAccess !== 'boolean') fail('INVALID_REQUEST', 'Catalog access must be explicitly boolean.');
    if (input.shareAccess !== undefined && typeof input.shareAccess !== 'boolean') fail('INVALID_REQUEST', 'Project sharing access must be explicitly boolean.');
    if (input.agentAccess !== undefined && typeof input.agentAccess !== 'boolean') fail('INVALID_REQUEST', 'Agent management access must be explicitly boolean.');
    if (!this.#started) fail('GATEWAY_OFFLINE', 'Start the gateway before pairing.');
    if (!loadSession(input.sessionId)) fail('INVALID_REQUEST', 'Choose an existing session.');
    if (input.sessionAccess === true && !terminalSession(loadSession(input.sessionId))) fail('FORBIDDEN', 'Approve terminal catalog access from a terminal session.', 403);
    if (input.shareAccess === true && !terminalSession(loadSession(input.sessionId))) fail('FORBIDDEN', 'Approve project sharing from a terminal session.', 403);
    const permissions = input.permissions ?? ['observe'];
    if (!Array.isArray(permissions) || !permissions.length || !permissions.includes('observe') || new Set(permissions).size !== permissions.length || permissions.some(value => !sessionPermissions.includes(value)) || permissions.some(value => value !== 'observe' && value !== 'claim') && !permissions.includes('claim')) fail('INVALID_REQUEST', 'Choose explicit session permissions including observe and claim for controls.');
    if (this.#rows('core.relay.pairing').filter(row => ['open', 'requested', 'approving'].includes(row.state) && row.expiresAt > Date.now()).length >= LIMITS.pendingPairings || this.#rows('core.relay.grant').filter(alive).length >= LIMITS.grants) fail('CAPACITY', 'The local pairing limit was reached.');
    const ttlSeconds = boundedInteger(input.ttlSeconds ?? 600, 1, 3600), grantTtlSeconds = boundedInteger(input.grantTtlSeconds ?? 86400, 120, 30 * 86400);
    const resource = randomUUID(), spec = { kind: 'PAIR', mode: 'pair', resource, actions: [...permissions], ttlSeconds, grantTtlSeconds };
    const grantExpiresAt = Date.now() + grantTtlSeconds * 1000;
    const invitation = await this.#relay.createInvitation(spec);
    this.#check();
    opaque(invitation.invitationId);
    if (digest(invitation.spec) !== digest(spec)) fail('FORBIDDEN', 'Relay changed the requested pairing scope.', 403);
    boundedInteger(invitation.expiresAt, Date.now() + 1, Date.now() + ttlSeconds * 1000 + 5000);
    putRecord('core.relay.pairing', invitation.invitationId, { id: invitation.invitationId, hostId: this.#identity.certificate.id,
      relayUrl: this.#relay.url, sessionId: input.sessionId, resource, permissions: [...permissions], spec,
      sessionAccess: input.sessionAccess === true, shareAccess: input.shareAccess === true, agentAccess: input.agentAccess === true,
      grantExpiresAt, expiresAt: invitation.expiresAt, state: 'open', createdAt: now() });
    const display = { relay: this.#relay.url, code: invitation.code, sender: this.#identity.certificate, expiresAt: invitation.expiresAt };
    // The sensitive QR/code is returned only to the trusted local setup UI.
    return { invitationId: invitation.invitationId, resource, sessionId: input.sessionId, permissions: [...permissions], sessionAccess: input.sessionAccess === true,
      shareAccess: input.shareAccess === true, agentAccess: input.agentAccess === true,
      expiresAt: invitation.expiresAt, code: invitation.code, qr: encodeInvitation(display, { allowInsecureLocal: this.#relay.url.startsWith('ws:') }),
      renderQR: options => renderInvitationQR(display, { ...options, allowInsecureLocal: this.#relay.url.startsWith('ws:') }) };
  }

  #claim(data) {
    try {
      this.#check(); object(data, ['claimId', 'invitationId', 'recipient', 'spec', 'expiresAt']);
      opaque(data.claimId); opaque(data.invitationId); verifyCertificate(data.recipient);
      const row = getRecord('core.relay.pairing', data.invitationId);
      if (!row || row.hostId !== this.#identity.certificate.id || row.relayUrl !== this.#relay.url ||
        !['open', 'requested'].includes(row.state) || row.expiresAt <= Date.now() || row.expiresAt !== data.expiresAt ||
        digest(row.spec) !== digest(data.spec) || row.claimId && row.claimId !== data.claimId) fail('FORBIDDEN', 'Unexpected pairing claim.');
      putRecord('core.relay.pairing', row.id, { ...row, state: 'requested', claimId: data.claimId, recipient: structuredClone(data.recipient) });
      this.emit('pairing.requested', this.pendingPairings().find(item => item.claimId === data.claimId));
    } catch { this.emit('fault', { code: 'PAIRING_CLAIM_REJECTED' }); }
  }

  async approvePairing(input) {
    this.#check(); object(input, ['claimId', 'confirmedCertificate', 'confirmedFingerprint'], 'Pairing approval'); opaque(input.claimId);
    verifyCertificate(input.confirmedCertificate);
    if (input.confirmedFingerprint !== input.confirmedCertificate.id) fail('CONFIRMATION_REQUIRED', 'Confirm the fingerprint displayed by the actual recipient.');
    const row = this.#rows('core.relay.pairing').find(item => item.claimId === input.claimId);
    if (!row || !['requested', 'approving', 'approved'].includes(row.state) || digest(row.recipient) !== digest(input.confirmedCertificate)) fail('FORBIDDEN', 'The confirmed recipient does not match this local pairing.', 403);
    if (row.state === 'approved') {
      const existing = this.#authorize(row.grantId, row.recipient.id, row.resource);
      return publicGrant(existing);
    }
    if (row.expiresAt <= Date.now()) fail('FORBIDDEN', 'This local pairing expired.', 403);
    const remaining = Math.floor((row.grantExpiresAt - Date.now()) / 1000);
    if (remaining < 60) fail('FORBIDDEN', 'Pairing has insufficient remaining authorization time.', 403);
    const pin = getRecord('core.relay.pin', row.recipient.id);
    if (pin && (pin.revokedAt || pin.hostId !== row.hostId || digest(pin.certificate) !== digest(row.recipient))) fail('FORBIDDEN', 'This device pin is revoked or changed.', 403);
    putRecord('core.relay.pairing', row.id, { ...row, state: 'approving' });
    let decided;
    if (row.state === 'approving') {
      // An explicit repeated approval may inspect an earlier uncertain result;
      // it never automatically reissues the side-effecting approval RPC.
      decided = await this.#relay.claimStatus(row.claimId);
      if (decided.state !== 'approved') fail('UNCERTAIN', 'Inspect the pairing before retrying approval.', 409);
    } else decided = await this.#relay.approve(row.claimId, input.confirmedCertificate);
    this.#check();
    const grant = decided.grant;
    if (!grant || grant.hostId !== row.hostId || grant.recipientId !== row.recipient.id || digest(grant.peer) !== digest(row.recipient) || digest(grant.spec) !== digest(row.spec) || grant.expiresAt <= Date.now()) fail('FORBIDDEN', 'Relay approval does not match the local authorization.', 403);
    opaque(grant.id);
    const alreadyApproved = getRecord('core.relay.pairing', row.id);
    if (alreadyApproved.state === 'approved') return publicGrant(this.#authorize(alreadyApproved.grantId, row.recipient.id, row.resource));
    this.#relay.trustPeer(row.recipient);
    const localToken = createSessionAccess({ sessionId: row.sessionId, permissions: row.permissions, recipient: `relay_${row.recipient.id}`,
      expiresInSeconds: Math.min(remaining, Math.floor((grant.expiresAt - Date.now()) / 1000)), includeChildren: false });
    try {
      transaction(db => {
        const latest = getRecord('core.relay.pairing', row.id);
        if (latest.state !== 'approving') fail('FORBIDDEN', 'Pairing was cancelled during approval.', 403);
        putRecord('core.relay.pin', row.recipient.id, { id: row.recipient.id, hostId: row.hostId, relayUrl: row.relayUrl, certificate: row.recipient, createdAt: now() }, db);
        putRecord('core.relay.grant', grant.id, { id: grant.id, hostId: row.hostId, relayUrl: row.relayUrl, peerId: row.recipient.id,
          peerDigest: digest(row.recipient), resource: row.resource, sessionId: row.sessionId, permissions: row.permissions,
          sessionAccess: row.sessionAccess === true,
          shareAccess: row.shareAccess === true,
          agentAccess: row.agentAccess === true,
          token: localToken.token, coreGrantId: localToken.id, expiresAt: Math.min(row.grantExpiresAt, localToken.expiresAt, grant.expiresAt), createdAt: now() }, db);
        putRecord('core.relay.pairing', row.id, { ...latest, state: 'approved', grantId: grant.id }, db);
      });
    } catch (error) { revokeSessionAccess(localToken.id); throw error; }
    const local = getRecord('core.relay.grant', grant.id); this.#audit(local, 'paired');
    return publicGrant(local);
  }

  async denyPairing(claimId) {
    this.#check(); opaque(claimId);
    const row = this.#rows('core.relay.pairing').find(item => item.claimId === claimId);
    if (!row || !['requested', 'approving'].includes(row.state)) fail('FORBIDDEN', 'No pending local pairing.', 403);
    putRecord('core.relay.pairing', row.id, { ...row, state: 'denied' });
    await this.#relay.deny(claimId); return { denied: true };
  }

  #revokeLocal(id) {
    this.#check();
    const row = getRecord('core.relay.grant', id);
    if (!row || row.hostId !== this.#identity.certificate.id || row.relayUrl !== this.#relay.url) return;
    revokeLocalRelayGrant(id, { hostId: this.#identity.certificate.id, relayUrl: this.#relay.url });
    for (const subscription of this.#subscriptions.values()) if (subscription.grantId === id) this.#stopSubscription(subscription);
  }
  async revokeGrant(id) {
    opaque(id); this.#revokeLocal(id);
    await this.#relay.revokeGrant(id);
    this.#check();
    const pending = getRecord('core.relay.revocation', id);
    if (pending) putRecord('core.relay.revocation', id, { ...pending, state: 'complete' });
    return { revoked: true };
  }
  async revokeDevice(peerId) {
    this.#check(); opaque(peerId);
    const pin = getRecord('core.relay.pin', peerId);
    if (!pin || pin.hostId !== this.#identity.certificate.id) fail('FORBIDDEN', 'Unknown local device.', 403);
    putRecord('core.relay.pin', peerId, { ...pin, revokedAt: pin.revokedAt || now() });
    for (const row of this.#rows('core.relay.grant')) if (row.peerId === peerId && !row.revokedAt) this.#revokeLocal(row.id);
    this.#relay.forgetPeer(peerId);
    await this.#relay.revokePeer(peerId); return { revoked: true };
  }

  #secrets() {
    const values = [this.#identity.signingSecret, this.#identity.boxSecret];
    for (const row of this.#rows('core.relay.grant')) values.push(row.token);
    for (const row of this.#rows('core.relay.context')) values.push(row.token);
    return values;
  }
  async #clientFor(row) {
    this.#check();
    if ((await runtime()).operatorStopRequested()) fail('CORE_STOPPED', 'Core was stopped by the local operator.', 409);
    let info = (await runtime()).runtimeInfo();
    if (!info) { await this.#core.start(); info = (await runtime()).runtimeInfo(); }
    const url = new URL(info.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) fail('FORBIDDEN', 'The Core listener must remain local.', 403);
    return new BzzyClient({ url: info.url, token: row.token,
      fetch: (target, options) => fetch(target, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) }) });
  }
  async #clean(value) {
    const ownerToken = (await runtime()).runtimeInfo()?.token;
    return sanitize(value, [...this.#secrets(), ownerToken]);
  }
  async #send(row, payload) {
    this.#authorize(row.id, row.peerId, row.resource);
    this.#assertDeletedDisclosure(row, payload);
    const clean = boundedPayload(await this.#clean(payload));
    this.#authorize(row.id, row.peerId, row.resource);
    this.#assertDeletedDisclosure(row, clean);
    return this.#relay.send(row.id, clean);
  }
  #assertDeletedDisclosure(row, payload) {
    const deletion = getRecord('session-deletion', row.sessionId);
    if (!deletion) return;
    const result = payload.type === 'events' ? payload : payload.ok === true ? payload.result : null;
    if (!result) return;
    if (result.session && result.capabilities?.sessionDeleted !== true
      || result.events?.some(event => digest(event) !== digest(deletion.event))
      || typeof result.data === 'string' && Number.isSafeInteger(result.seq) && result.seq !== deletion.event.seq) {
      fail('SESSION_DELETED', 'This chat was deleted.', 404);
    }
  }
  #takeRate(peerId, kind = 'requests') {
    const rates = kind === 'metrics' ? this.#metricsRates : kind === 'ack' ? this.#ackRates : kind === 'chunks' ? this.#chunkRates : this.#rates;
    const maximum = kind === 'metrics' ? LIMITS.metricsPerMinute : kind === 'ack' ? LIMITS.acknowledgmentsPerMinute : kind === 'chunks' ? LIMITS.chunksPerMinute : LIMITS.requestsPerMinute;
    const timestamp = Date.now();
    for (const [key, value] of rates) if (value.until <= timestamp) rates.delete(key);
    const bucket = rates.get(peerId) || { until: timestamp + 60000, count: 0 };
    if (!rates.has(peerId) && rates.size >= LIMITS.grants || ++bucket.count > maximum) fail('RATE_LIMITED', 'Gateway request rate reached.', 429);
    rates.set(peerId, bucket);
  }
  async #message(message) {
    if (!this.#started) return;
    let row, request, counted = false;
    try {
      this.#check(); opaque(message.from); opaque(message.grant.id);
      row = getRecord('core.relay.grant', message.grant.id);
      if (!row) return;
      this.#authorize(row.id, message.from, row.resource);
      try {
        request = validateRequest(message.payload);
        row = this.#authorize(row.id, message.from, request.resource, permissionFor(request));
        if (getRecord('session-deletion', row.sessionId) && ['input.claim', 'input.release', 'execution.execute', 'task.submit', 'question.answer', 'permissions.set', 'session.configure', 'session.mode', 'control.request'].includes(request.op)) {
          fail('SESSION_DELETED', 'This chat was deleted.', 404);
        }
        if ((await runtime()).operatorStopRequested()) fail('CORE_STOPPED', 'Core was stopped by the local operator.', 409);
        // Only an actual delivered/current-cursor acknowledgment gets the data
        // budget. Guessed subscriptions and invalid cursors retain normal limits.
        if (request.op === 'events.ack') this.#ackTarget(row, request.params);
        if (request.op === 'events.chunk') this.#chunkTarget(row, request.params);
      } catch (error) { this.#takeRate(message.from); throw error; }
      this.#takeRate(message.from, request.op === 'host.metrics' ? 'metrics' : request.op === 'events.ack' ? 'ack' : request.op === 'events.chunk' ? 'chunks' : 'requests');
      const total = [...this.#inflight.values()].reduce((a, b) => a + b, 0), peers = this.#inflight.get(message.from) || 0;
      if (total >= LIMITS.requests || peers >= LIMITS.requestsPerPeer) fail('CAPACITY', 'Gateway concurrency reached.');
      this.#inflight.set(message.from, peers + 1); counted = true;
      const result = COMMANDS.has(request.op) ? await this.#command(row, request) : await this.#read(row, request);
      if (['session.get', 'host.metrics', 'events.subscribe', 'events.ack', 'events.chunk'].includes(request.op)) this.#renewSubscriptions(row);
      await this.#send(row, response(request.id, result));
      if (request.op === 'events.ack') {
        const subscription = this.#subscriptionFor(row, request.params.subscriptionId);
        if (!subscription.pending) {
          clearTimeout(subscription.timer);
          subscription.timer = setTimeout(() => { void this.#pump(subscription); }, 0);
        }
      }
    } catch (error) {
      const code = errorCode(error);
      if (row) {
        try {
          this.#audit(row, 'denied', code);
          const id = request?.id || (typeof message.payload?.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(message.payload.id) ? message.payload.id : 'invalid');
          await this.#send(row, errorResponse(id, code));
        } catch { /* Revocation or disconnect prevents further disclosure. */ }
      }
    } finally {
      if (counted) { const count = this.#inflight.get(message.from) - 1; if (count) this.#inflight.set(message.from, count); else this.#inflight.delete(message.from); }
    }
  }

  #owner(row, value) { opaque(value, 'Client owner ID'); return `relay_${digest({ peer: row.peerId, resource: row.resource, owner: value })}`; }
  #yoloAllowed(row) {
    const parent = authorizedOwnPhone(row.relayGrantId || row.id), session = loadSession(row.sessionId);
    return Boolean(parent && parent.peerId === row.peerId && terminalSession(session) && session.contract?.policy?.mode !== 'read-only'
      && session.policy?.mode !== 'read-only' && row.permissions.includes('execute') && row.permissions.includes('answer'));
  }
  #commandKey(row, id) { return digest({ host: row.hostId, peer: row.peerId, resource: row.resource, request: id }); }
  #shareBinding(row) { return { grantId: row.id, peerId: row.peerId, resource: row.resource }; }
  #shareAuthorize(row) {
    const current = this.#authorize(row.id, row.peerId, row.resource);
    if (current.shareAccess !== true) fail('FORBIDDEN', 'Project sharing needs explicit host approval.', 403);
    if (current.kind === 'agent') this.#agents.forSession(current.sessionId);
    else if (!terminalSession(loadSession(current.sessionId))) fail('FORBIDDEN', 'This project cannot be shared.', 403);
    return current;
  }
  async createProjectShare(input) {
    this.#check(); if (!this.#started) fail('GATEWAY_OFFLINE', 'Connect the host gateway first.');
    if (!terminalSession(loadSession(input?.sessionId))) fail('FORBIDDEN', 'Share an existing root terminal.', 403);
    return this.#transfers.createShare(input);
  }
  async createLibraryShare(input) {
    this.#check(); if (!this.#started) fail('GATEWAY_OFFLINE', 'Connect the host gateway first.');
    object(input, ['cwd', 'expectedDigest', 'ttlSeconds', 'excludeGoalIds', 'kinds', 'excludeEntries']);
    if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd) || !/^[a-f0-9]{64}$/.test(input.expectedDigest || '')) fail('INVALID_REQUEST', 'Review the current Library before sharing.');
    const requestedCwd = input.cwd, cwd = fs.realpathSync(requestedCwd), pin = fs.statSync(cwd);
    const expectedDigest = input.expectedDigest, selection = libraryShareSelection(input);
    if (!pin.isDirectory()) fail('INVALID_REQUEST', 'Choose the current project directory.');
    const authorize = () => {
      this.#check();
      const current = fs.lstatSync(cwd);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== pin.dev || current.ino !== pin.ino || fs.realpathSync(requestedCwd) !== cwd) fail('HOST_CONTEXT_CHANGED', 'The shared Library project changed. Review it again.', 409);
    };
    return this.#transfers.createShare({ ...input, cwd, expectedDigest, ...selection, kind: 'LIBRARY' }, { authorize,
      exportArchive: async (_source, destination) => (await import('../engine/definition-bundle.js')).buildLibraryArchive(destination, { cwd, expectedDigest, ...selection }) });
  }
  projectShareStatus(shareId) { this.#check(); return this.#transfers.status(shareId); }
  approveProjectShare(input) { this.#check(); return this.#transfers.approveShare(input); }
  revokeProjectShare(shareId) { this.#check(); return this.#transfers.revokeShare(shareId); }
  async #shareCommand(row, request) {
    this.#shareAuthorize(row);
    const binding = this.#shareBinding(row), key = this.#commandKey(row, request.id), fingerprint = digest({ op: request.op, params: request.params });
    const previous = getRecord('core.relay.command', key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('CONFLICT', 'This request ID belongs to different input.', 409);
      if (previous.state !== 'accepted' || !previous.result) fail('UNCERTAIN', 'Inspect the saved share request before retrying.', 409);
      if (request.op === 'share.create') {
        const { terminalQR, ...result } = this.#transfers.invitation(previous.result.shareId, binding);
        return { state: 'accepted', ...result };
      }
      return previous.result;
    }
    putRecord('core.relay.command', key, { id: key, hostId: row.hostId, peerId: row.peerId, resource: row.resource,
      relayUrl: row.relayUrl, sessionId: row.sessionId, op: request.op, fingerprint, state: 'dispatching', createdAt: now() });
    try {
      let result, saved;
      if (request.op === 'share.create') {
        const kind = row.kind === 'agent' ? 'AGENT' : 'TERMINAL';
        const created = await this.#transfers.createShare({ sessionId: row.sessionId, kind }, { binding, authorize: () => this.#shareAuthorize(row),
          ...(kind === 'AGENT' ? { exportArchive: (session, destination) => this.#agents.exportArchive(session.id, destination) } : {}) });
        const { terminalQR, ...display } = created; result = { state: 'accepted', ...display }; saved = { shareId: created.shareId };
      } else if (request.op === 'share.approve') result = saved = await this.#transfers.approveShare(request.params, binding);
      else result = saved = await this.#transfers.revokeShare(opaque(request.params.shareId), binding);
      this.#shareAuthorize(row);
      putRecord('core.relay.command', key, { ...getRecord('core.relay.command', key), state: 'accepted', result: saved, acceptedAt: now() });
      return result;
    } catch (error) {
      putRecord('core.relay.command', key, { ...getRecord('core.relay.command', key), state: 'uncertain', code: errorCode(error) });
      throw error;
    }
  }
  #catalog(row) {
    const parent = this.#authorize(row.id, row.peerId, row.resource);
    if (parent.sessionAccess !== true || parent.relayGrantId) fail('FORBIDDEN', 'Terminal catalog access requires explicit host approval.', 403);
    return parent;
  }
  #agentAuthorize(row) {
    const parent = this.#authorize(row.id, row.peerId, row.resource);
    if (parent.agentAccess !== true || parent.relayGrantId) fail('FORBIDDEN', 'Agent management requires explicit host approval.', 403);
    return parent;
  }
  async #agentRead(row, request) {
    const parent = this.#agentAuthorize(row), params = request.params;
    switch (request.op) {
      case 'agents.status': return this.#agents.status();
      case 'agents.providers': return { providers: this.#agents.providers() };
      case 'agents.models': return this.#agents.models(params.provider, { after: params.after, limit: params.limit });
      case 'agents.import.status': return this.#agentImports.status(uuid(params.importId), this.#importOptions(parent));
      case 'agents.get': return { agent: this.#agents.get(uuid(params.agentId)) };
      case 'agents.list': {
        const page = this.#agents.list(params), contexts = this.#catalogContexts(parent);
        const agents = [];
        for (const agent of page.agents) {
          const context = contexts.find(value => value.kind === 'agent' && value.agentId === agent.id && value.sessionId === agent.sessionId);
          const selected = { ...agent, ...(context ? { existingResource: context.resource } : {}) };
          if (Buffer.byteLength(JSON.stringify([...agents, selected])) > LIMITS.payloadBytes - 2048) {
            if (!agents.length) fail('RESULT_TOO_LARGE', 'This agent metadata exceeds the page limit.');
            break;
          }
          agents.push(selected);
        }
        const hasMore = page.hasMore || agents.length < page.agents.length;
        return { agents, nextCursor: hasMore ? agents.at(-1)?.id ?? null : null, hasMore };
      }
      default: fail('OPERATION_DENIED', 'Agent operation is unavailable.', 403);
    }
  }
  async #agentCommand(row, request) {
    const parent = this.#agentAuthorize(row), params = request.params;
    const key = this.#commandKey(row, request.id), fingerprint = digest({ op: request.op, params });
    const previous = getRecord('core.relay.command', key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('CONFLICT', 'This request ID belongs to different input.', 409);
      const reconciled = this.#reconcile(row, previous);
      if (reconciled.state !== 'accepted' || !reconciled.acceptance) fail(reconciled.state === 'rejected' ? reconciled.code : 'UNCERTAIN', 'Inspect the saved agent request before retrying.', 409);
      if (request.op === 'agents.open') this.#authorize(parent.id, parent.peerId, previous.result.resource);
      return { state: 'accepted', ...reconciled.acceptance };
    }
    if (request.op === 'agents.open') return this.#agentOpen(parent, request, key, fingerprint);
    putRecord('core.relay.command', key, { id: key, hostId: parent.hostId, peerId: parent.peerId, resource: parent.resource,
      relayUrl: parent.relayUrl, sessionId: parent.sessionId, op: request.op, fingerprint, state: 'dispatching', createdAt: now() });
    try {
      if (request.op === 'agents.import' || request.op === 'agents.import.cancel') {
        const result = request.op === 'agents.import' ? this.#agentImports.start(params, this.#importOptions(parent))
          : await this.#agentImports.cancel(uuid(params.importId), this.#importOptions(parent));
        this.#agentAuthorize(row);
        const { state, ...receipt } = result;
        putRecord('core.relay.command', key, { ...getRecord('core.relay.command', key), state: 'accepted', result: receipt, acceptedAt: now() });
        return result;
      }
      const options = { requestId: `relay.${key}` };
      const agent = request.op === 'agents.create' ? await this.#agents.create(params, options)
        : request.op === 'agents.update' ? await this.#agents.update(params, options) : await this.#agents.archive(params, options);
      this.#agentAuthorize(row);
      if (request.op === 'agents.archive') {
        for (const context of this.#rows('core.relay.context').filter(value => value.kind === 'agent' && value.agentId === params.agentId && !value.revokedAt)) {
          putRecord('core.relay.context', context.resource, { ...context, revokedAt: now() }); revokeSessionAccess(context.coreGrantId);
          for (const subscription of this.#subscriptions.values()) if (subscription.resource === context.resource) this.#stopSubscription(subscription);
        }
      }
      const result = { agent };
      putRecord('core.relay.command', key, { ...getRecord('core.relay.command', key), state: 'accepted', result, acceptedAt: now() });
      return { state: 'accepted', ...result };
    } catch (error) {
      const action = request.op.split('.')[1], accepted = database().prepare('SELECT response FROM requests WHERE scope=? AND id=?').get(`core:agent:${action}`, `relay.${key}`);
      const rejected = !accepted?.response && ['FORBIDDEN', 'CONFLICT', 'INVALID_REQUEST', 'WORKSPACE_SETUP_REQUIRED', 'WORKSPACE_CHANGED', 'WORKSPACE_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'CAPACITY'].includes(error.code);
      putRecord('core.relay.command', key, { ...getRecord('core.relay.command', key), state: rejected ? 'rejected' : 'uncertain', code: errorCode(error) });
      throw error;
    }
  }
  #importOptions(row) {
    return { binding: row, authorize: () => {
      if (this.#relay.status !== 'online') fail('IMPORT_UNAVAILABLE', 'Reconnect Core before receiving an Agent.');
      this.#agentAuthorize(row);
    } };
  }
  #agentOpen(parent, request, key, fingerprint) {
    const agent = this.#agents.get(uuid(request.params.agentId));
    if (agent.archived) fail('FORBIDDEN', 'Archived agents cannot receive new control contexts.', 403);
    const contexts = this.#catalogContexts(parent);
    let context = contexts.find(value => value.kind === 'agent' && value.agentId === agent.id && value.sessionId === agent.sessionId), localToken;
    if (!context) {
      if (contexts.length >= contextLimit) fail('CAPACITY', 'This device grant has reached its context limit.');
      const remaining = Math.floor((parent.expiresAt - Date.now()) / 1000);
      if (remaining < 60) fail('GRANT_UNAVAILABLE', 'Renew host authorization before opening another agent.', 403);
      localToken = createSessionAccess({ sessionId: agent.sessionId, permissions: parent.permissions, recipient: `relay_${parent.peerId}`,
        expiresInSeconds: remaining, includeChildren: false });
      const resource = randomUUID();
      context = { id: resource, resource, kind: 'agent', agentId: agent.id, relayGrantId: parent.id, hostId: parent.hostId, relayUrl: parent.relayUrl,
        peerId: parent.peerId, peerDigest: parent.peerDigest, sessionId: agent.sessionId, permissions: [...parent.permissions],
        token: localToken.token, coreGrantId: localToken.id, expiresAt: Math.min(parent.expiresAt, localToken.expiresAt), createdAt: now() };
    }
    const result = { resource: context.resource, kind: 'agent', sessionId: agent.sessionId, agentId: agent.id, cwd: agent.cwd,
      provider: agent.provider, model: agent.model ?? null, effort: agent.effort || 'default' };
    try {
      transaction(db => {
        this.#agentAuthorize(parent);
        if (getRecord('core.relay.command', key)) fail('UNCERTAIN', 'This agent attachment is already reserved.', 409);
        if (localToken) putRecord('core.relay.context', context.resource, context, db);
        putRecord('core.relay.command', key, { id: key, hostId: parent.hostId, peerId: parent.peerId, resource: parent.resource,
          relayUrl: parent.relayUrl, sessionId: parent.sessionId, op: request.op, fingerprint, state: 'accepted', result, acceptedAt: now() }, db);
      });
    } catch (error) { if (localToken) revokeSessionAccess(localToken.id); throw error; }
    return { state: 'accepted', ...result };
  }
  #catalogContexts(parent) {
    return this.#rows('core.relay.context').filter(context => {
      const access = getRecord('access-token', digest(context.token));
      return context.relayGrantId === parent.id && alive(context) && activeAccess(access) && access.id === context.coreGrantId &&
        access.sessionId === context.sessionId && access.includeChildren === false;
    });
  }
  #catalogList(row, params) {
    const parent = this.#catalog(row), limit = boundedInteger(params.limit ?? catalogLimit, 1, catalogLimit);
    if (params.after !== undefined) uuid(params.after);
    const all = listRecords('session').filter(terminalSession).sort((a, b) => {
      const first = String(a.createdAt || ''), second = String(b.createdAt || '');
      return first === second ? a.id.localeCompare(b.id) : first > second ? -1 : 1;
    });
    const start = params.after === undefined ? 0 : all.findIndex(session => session.id === params.after) + 1;
    if (params.after !== undefined && start === 0) fail('INVALID_CURSOR', 'The terminal catalog cursor is unavailable.');
    const contexts = this.#catalogContexts(parent);
    const sessions = [];
    for (const session of all.slice(start, start + limit)) {
      const existing = contexts.find(context => context.sessionId === session.id);
      const item = { id: session.id, ...(session.alias ? { alias: session.alias } : {}), provider: session.provider, model: session.model ?? null,
        ...(session.mode ? { mode: session.mode } : {}), cwd: session.cwd, executionState: session.executionState || 'idle',
        ...(params.goalFeedback === true && session.goal ? { goalStatus: session.goal.status, goalReason: session.goal.reason || null } : {}),
        createdAt: session.createdAt, updatedAt: session.updatedAt || session.createdAt,
        ...(existing ? { existingResource: existing.resource } : {}) };
      if (Buffer.byteLength(JSON.stringify([...sessions, item])) > LIMITS.payloadBytes - 2048) {
        if (!sessions.length) fail('RESULT_TOO_LARGE', 'This terminal metadata exceeds the catalog page limit.');
        break;
      }
      sessions.push(item);
    }
    const hasMore = start + sessions.length < all.length;
    return { sessions, nextCursor: hasMore ? sessions.at(-1)?.id ?? null : null, hasMore };
  }
  #catalogOpen(row, request) {
    const parent = this.#catalog(row), sessionId = uuid(request.params.sessionId), session = loadSession(sessionId);
    if (!terminalSession(session)) fail('FORBIDDEN', 'This session is not an available terminal.', 403);
    const key = this.#commandKey(row, request.id), fingerprint = digest({ op: request.op, params: request.params });
    const previous = getRecord('core.relay.command', key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('CONFLICT', 'This request ID belongs to different input.', 409);
      if (previous.state !== 'accepted' || !previous.result) fail('UNCERTAIN', 'Inspect the saved terminal attachment.', 409);
      this.#authorize(parent.id, parent.peerId, previous.result.resource);
      return { state: 'accepted', ...previous.result };
    }
    const contexts = this.#catalogContexts(parent);
    let context = contexts.find(value => value.sessionId === sessionId), localToken;
    if (!context) {
      if (contexts.length >= contextLimit) fail('CAPACITY', 'This catalog grant has reached its terminal context limit.');
      const remaining = Math.floor((parent.expiresAt - Date.now()) / 1000);
      if (remaining < 60) fail('GRANT_UNAVAILABLE', 'Renew host authorization before opening another terminal.', 403);
      localToken = createSessionAccess({ sessionId, permissions: parent.permissions, recipient: `relay_${parent.peerId}`,
        expiresInSeconds: remaining, includeChildren: false });
      const resource = randomUUID();
      context = { id: resource, resource, relayGrantId: parent.id, hostId: parent.hostId, relayUrl: parent.relayUrl,
        peerId: parent.peerId, peerDigest: parent.peerDigest, sessionId, permissions: [...parent.permissions],
        token: localToken.token, coreGrantId: localToken.id, expiresAt: Math.min(parent.expiresAt, localToken.expiresAt), createdAt: now() };
    }
    const result = { resource: context.resource, sessionId, cwd: session.cwd, provider: session.provider,
      model: session.model ?? null, effort: session.selectedEffort || 'default' };
    try {
      transaction(db => {
        this.#catalog(row);
        if (getRecord('core.relay.command', key)) fail('UNCERTAIN', 'This terminal attachment is already reserved.', 409);
        if (localToken) putRecord('core.relay.context', context.resource, context, db);
        putRecord('core.relay.command', key, { id: key, hostId: parent.hostId, peerId: parent.peerId, resource: parent.resource,
          relayUrl: parent.relayUrl, sessionId: parent.sessionId, op: request.op, fingerprint, state: 'accepted', result, acceptedAt: now() }, db);
      });
    } catch (error) { if (localToken) revokeSessionAccess(localToken.id); throw error; }
    return { state: 'accepted', ...result };
  }
  async #read(row, request) {
    if (request.op.startsWith('settings.')) {
      requireUpdateGrant(row);
      if (request.op === 'settings.get') return remoteDefaults(row);
      if (request.op === 'settings.providers') return { providers: this.#agents.providers() };
      return providerModels(request.params.provider, { after: request.params.after, limit: request.params.limit, cwd: loadSession(row.sessionId)?.cwd });
    }
    if (request.op === 'voice.status') return this.#voice.status(row);
    if (request.op === 'voice.poll') return this.#voice.poll(row, request.params.requestId, request.params.cursor);
    if (request.op === 'updates.status') return coreUpdates().status(row);
    if (request.op === 'updates.check') return coreUpdates().checkNow(row);
    if (request.op.startsWith('agents.')) return this.#agentRead(row, request);
    const client = await this.#clientFor(row), params = request.params;
    switch (request.op) {
      case 'notifications.register': {
        if (params.relayPush === true) {
          const status = await this.#relay.request('push.status', { environment: params.environment });
          this.#authorize(row.relayGrantId || row.id, row.peerId, row.resource);
          putRecord('core.push.relay-status', 'current', { configured: status.providerConfigured === true, environment: params.environment, updatedAt: now() });
        }
        return registerDeviceNotifications(row, params);
      }
      case 'notifications.update': return updateDeviceNotifications(row, params);
      case 'notifications.revoke': return revokeDeviceNotifications(row, params);
      case 'sessions.list': return this.#catalogList(row, params);
      case 'host.metrics': return client.metrics();
      case 'share.status': this.#shareAuthorize(row); return this.#transfers.status(opaque(params.shareId), this.#shareBinding(row));
      case 'assistant.status': {
        const session = this.#assistantContext(row);
        return { provider: session.provider, model: session.model, effort: session.selectedEffort,
          purpose: session.purpose, selection: session.assistantSelection };
      }
      case 'task.get': {
        this.#assistantContext(row);
        const record = getRecord('core.relay.command', opaque(params.taskId));
        if (!record || record.op !== 'task.submit' || record.hostId !== row.hostId || record.peerId !== row.peerId ||
          record.resource !== row.resource || record.sessionId !== row.sessionId || record.relayUrl !== row.relayUrl) fail('FORBIDDEN', 'Task is outside this resource.', 403);
        const saved = this.#reconcile(row, record), current = getRecord('core.relay.command', record.id);
        const execution = current.result?.executionId ? getRecord('execution', current.result.executionId) : null;
        if (execution && execution.sessionId !== row.sessionId) fail('FORBIDDEN', 'Task execution is outside this resource.', 403);
        const boundary = type => execution && database().prepare("SELECT seq FROM events WHERE session_id=? AND type=? AND json_extract(data,'$.id')=? ORDER BY seq LIMIT 1").get(row.sessionId, type, execution.id)?.seq;
        const started = boundary('execution.started'), finished = boundary('execution.finished');
        return { taskId: record.id, state: execution?.state || saved.state,
          execution: pick(execution, ['id', 'state', 'createdAt', 'startedAt', 'finishedAt', 'exitCode']),
          verification: 'not-assessed', output: { source: 'execution-events', executionId: execution?.id || null,
            after: started == null ? null : Number(started) - 1, through: finished == null ? null : Number(finished) },
          ...(saved.code ? { code: saved.code } : {}) };
      }
      case 'session.get': {
        if (getRecord('session-deletion', row.sessionId)) return this.#deletedSessionSnapshot(row);
        const snapshot = await client.session(row.sessionId);
        if (getRecord('session-deletion', row.sessionId)) return this.#deletedSessionSnapshot(row);
        return { session: pick(snapshot.session, ['id', 'alias', 'provider', 'backend', 'model', 'mode', 'cwd', 'createdAt', 'updatedAt', 'turns', 'selectedEffort', 'executionState', 'goal', 'acceptance']),
          execution: pick(snapshot.execution, ['id', 'sessionId', 'state', 'createdAt', 'startedAt', 'finishedAt', 'exitCode']),
          questions: snapshot.questions.filter(question => question.sessionId === row.sessionId).map(question => pick(question, ['id', 'sessionId', 'question', 'text', 'kind', 'options', 'createdAt', 'expiresAt'])),
          inputOwner: pick(snapshot.inputOwner, ['owner', 'sessionId', 'expiresAt']),
          capabilities: { activeSteering: Boolean(snapshot.capabilities.activeSteering && row.permissions.includes('steer')),
            yolo: snapshot.permissions?.yolo === true, yoloControl: this.#yoloAllowed(row), modeControl: Boolean(authorizedOwnPhone(row.relayGrantId || row.id) && terminalSession(snapshot.session)), selectionControl: Boolean(authorizedOwnPhone(row.relayGrantId || row.id) && terminalSession(snapshot.session) && !['parallel', 'besties', 'debate'].includes(snapshot.session.mode)), goalSubmission: true, inputSubmission: true, stalledGoalResume: true,
            inputOwnedByDevice: snapshot.inputOwner?.principal === `grant:${row.coreGrantId}`,
            inputActor: digest(`grant:${row.coreGrantId}`),
            durableEvents: true, historyPaging: true, eventChunks: true, notificationsHostRouting: true, notificationsRelayPush: true, terminalGoalFeedback: true, singleViewSubscription: Boolean(authorizedOwnPhone(row.relayGrantId || row.id)),
            ...(authorizedOwnPhone(row.relayGrantId || row.id) ? { terminalCatalogRevision: terminalCatalogRevision() } : {}),
            permissions: row.permissions, sessionAccess: row.sessionAccess === true, shareAccess: row.shareAccess === true, agentAccess: row.agentAccess === true,
            relay: true, portableSharing: row.shareAccess === true, shareKind: row.kind === 'agent' ? 'AGENT' : 'TERMINAL' } };
      }
      case 'session.usage': return getRecord('session-deletion', row.sessionId)
        ? { sessionId: row.sessionId, usage: null, summary: null, goal: null } : client.usage(row.sessionId);
      case 'events.list': return this.#eventList(row, params, client);
      case 'events.chunk': return this.#eventChunk(row, params);
      case 'events.subscribe': return this.#subscribe(row, opaque(params.consumerId), params);
      case 'events.ack': return this.#ack(row, params);
      case 'events.unsubscribe': {
        const subscription = this.#subscriptionFor(row, opaque(params.subscriptionId));
        this.#stopSubscription(subscription); return { unsubscribed: true };
      }
      case 'input.claim': {
        if (params.takeover !== undefined && typeof params.takeover !== 'boolean') fail('INVALID_REQUEST', 'Takeover must be explicitly boolean.');
        if (params.takeover) this.#authorize(row.id, row.peerId, row.resource, 'claim');
        return pick(await client.claim(row.sessionId, this.#owner(row, params.owner), params.takeover === true), ['owner', 'sessionId', 'expiresAt']);
      }
      case 'input.release': return client.release(row.sessionId, this.#owner(row, params.owner));
      case 'command.status': {
        opaque(params.requestId); const key = this.#commandKey(row, params.requestId), record = getRecord('core.relay.command', key);
        if (!record) return { state: 'unknown' };
        return this.#reconcile(row, record);
      }
      default: fail('OPERATION_DENIED', 'Operation is not exposed.', 403);
    }
  }

  #deletedSessionSnapshot(row) {
    const saved = getRecord('session', row.sessionId);
    return { session: { ...pick(saved, ['id', 'provider', 'backend', 'model', 'cwd', 'createdAt', 'updatedAt']), executionState: 'deleted' },
      execution: null, questions: [], inputOwner: null,
      capabilities: { sessionDeleted: true, activeSteering: false, yolo: false, yoloControl: false, goalSubmission: false, inputSubmission: false,
        stalledGoalResume: false, inputOwnedByDevice: false, durableEvents: true, historyPaging: true, eventChunks: true, notificationsHostRouting: true, notificationsRelayPush: true, terminalGoalFeedback: true,
        singleViewSubscription: Boolean(authorizedOwnPhone(row.relayGrantId || row.id)),
        ...(authorizedOwnPhone(row.relayGrantId || row.id) ? { terminalCatalogRevision: terminalCatalogRevision() } : {}),
        permissions: ['observe'], sessionAccess: row.sessionAccess === true, agentAccess: row.agentAccess === true,
        shareAccess: false, relay: true, portableSharing: false, shareKind: 'TERMINAL' } };
  }

  #assistantContext(row) {
    const session = loadSession(row.sessionId);
    if (session?.purpose !== 'core-assistant') fail('OPERATION_DENIED', 'This resource is not a Core assistant context.', 403);
    return session;
  }

  #reconcile(row, record) {
    this.#authorize(row.id, row.peerId, row.resource);
    if (record.state === 'dispatching' || record.state === 'uncertain') {
      if (['agents.create', 'agents.update', 'agents.archive'].includes(record.op)) {
        const action = record.op.split('.')[1];
        const accepted = database().prepare('SELECT response FROM requests WHERE scope=? AND id=?').get(`core:agent:${action}`, `relay.${record.id}`);
        if (accepted?.response) {
          const saved = JSON.parse(accepted.response), agent = action === 'archive' ? saved : this.#agents.get(saved.agentId);
          record = { ...record, state: 'accepted', result: { agent }, code: undefined, reconciledAt: now() };
          putRecord('core.relay.command', record.id, record);
        }
      }
      const kind = { 'execution.execute': 'execute', 'task.submit': 'execute', 'question.answer': 'answer', 'permissions.set': 'permissions', 'session.configure': 'selection', 'session.mode': 'mode', 'control.request': 'control' }[record.op];
      const intent = getRecord('input-intent', digest({ sessionId: row.sessionId, principal: `grant:${row.coreGrantId}`, requestId: `relay.${record.id}` }));
      if (intent?.state === 'accepted') {
        record = { ...record, state: 'accepted', result: intent.result, reconciledAt: now() };
        putRecord('core.relay.command', record.id, record);
      }
      else if (intent) {
        const receipt = database().prepare('SELECT response FROM requests WHERE scope=? AND id=?')
          .get(`${kind}:${row.sessionId}`, `input.${intent.id}`);
        if (receipt?.response) {
          const result = JSON.parse(receipt.response);
          putRecord('input-intent', intent.id, { ...intent, state: 'accepted', result, reconciledAt: now() });
          record = { ...record, state: 'accepted', result, reconciledAt: now() };
          putRecord('core.relay.command', record.id, record);
        }
      }
      const core = database().prepare('SELECT response FROM requests WHERE scope=? AND id=?').get(`${kind}:${row.sessionId}`, `relay.${record.id}`);
      if (core?.response) {
        record = { ...record, state: 'accepted', result: JSON.parse(core.response), reconciledAt: now() };
        putRecord('core.relay.command', record.id, record);
      }
    }
    return { state: record.state, ...(record.result ? { acceptance: commandAcceptance(record) } : {}), ...(record.code ? { code: record.code } : {}) };
  }

  async #command(row, request) {
    if (request.op === 'settings.configure') return configureRemoteDefaults(row, request.params, request.id);
    if (request.op === 'session.mode') {
      const parent = authorizedOwnPhone(row.relayGrantId || row.id), session = loadSession(row.sessionId);
      if (!parent || parent.peerId !== row.peerId || !terminalSession(session) || !['solo', 'delegate', 'debate', 'parallel', 'besties'].includes(request.params.mode)) fail('FORBIDDEN', 'Mode changes require your fully approved phone and a terminal.', 403);
      if (request.params.coordinateInput !== true) fail('INVALID_REQUEST', 'Use coordinated input for mode changes.');
    }
    if (request.op === 'session.configure') {
      const parent = authorizedOwnPhone(row.relayGrantId || row.id);
      const session = loadSession(row.sessionId);
      if (!parent || parent.peerId !== row.peerId || !terminalSession(session) || ['parallel', 'besties', 'debate'].includes(session.mode)) fail('FORBIDDEN', 'Model changes require your fully approved phone and an individual terminal.', 403);
      if (request.params.coordinateInput !== true) fail('INVALID_REQUEST', 'Use coordinated input for model changes.');
    }
    if (request.op === 'voice.send') return this.#voice.send(row, request.params.text, request.id);
    if (request.op === 'voice.cancel') return this.#voice.cancel(row, request.params.requestId, request.id);
    if (request.op === 'updates.configure') return coreUpdates().configure(row, request.params);
    if (request.op === 'updates.install') return coreUpdates().requestInstall(row, request.params, request.id);
    if (request.op.startsWith('agents.')) return this.#agentCommand(row, request);
    if (request.op === 'sessions.open') return this.#catalogOpen(row, request);
    if (request.op.startsWith('share.')) return this.#shareCommand(row, request);
    const params = request.params, owner = this.#owner(row, params.owner);
    if (request.op === 'task.submit') {
      this.#assistantContext(row);
      if (typeof params.instruction !== 'string' || !params.instruction.trim() || Buffer.byteLength(params.instruction) > LIMITS.promptBytes) fail('INVALID_REQUEST', 'Tasks need bounded nonempty instructions.');
    }
    if (request.op === 'execution.execute') {
      if (typeof params.prompt !== 'string' || !params.prompt.trim() || Buffer.byteLength(params.prompt) > LIMITS.promptBytes) fail('INVALID_REQUEST', 'Execution needs bounded nonempty text.');
      for (const key of ['goal', 'resumeGoal']) if (params[key] !== undefined && typeof params[key] !== 'boolean') fail('INVALID_REQUEST', 'Goal flags must be boolean.');
      if (params.replaceGoalId !== undefined) uuid(params.replaceGoalId);
      if (params.resumeGoalId !== undefined) { uuid(params.resumeGoalId); if (params.resumeGoal !== true) fail('INVALID_REQUEST', 'A stalled resume requires resumeGoal.'); }
      if (params.resumeGoalStatus !== undefined && (params.resumeGoalStatus !== 'paused' || !params.resumeGoalId)) fail('INVALID_REQUEST', 'Use an exact paused goal identity.');
      if (params.resumeGoal === true && params.goal !== true) fail('INVALID_REQUEST', 'Resume requires a goal execution.');
    }
    if (request.op === 'question.answer') { uuid(params.questionId); if (typeof params.answer !== 'string' || Buffer.byteLength(params.answer) > LIMITS.promptBytes) fail('INVALID_REQUEST', 'Question answers must be bounded text.'); }
    if (request.op === 'permissions.set') {
      if (!this.#yoloAllowed(row)) fail('FORBIDDEN', 'YOLO requires the fully approved own phone and an ordinary terminal.', 403);
      if (typeof params.enabled !== 'boolean') fail('INVALID_REQUEST', 'YOLO mode must be boolean.');
      if (params.questionId !== undefined) uuid(params.questionId);
    }
    if (request.op === 'control.request' && (params.text !== undefined && typeof params.text !== 'string' || params.text && Buffer.byteLength(params.text) > LIMITS.promptBytes)) fail('INVALID_REQUEST', 'Control text must be bounded text.');
    const key = this.#commandKey(row, request.id), fingerprint = digest({ op: request.op, params });
    const previous = getRecord('core.relay.command', key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('CONFLICT', 'This request ID belongs to different input.', 409);
      const saved = this.#reconcile(row, previous);
      if (saved.state === 'accepted') return { state: 'accepted', ...saved.acceptance };
      fail(saved.state === 'rejected' ? saved.code : 'UNCERTAIN', 'Inspect saved command state before retrying.', 409);
    }
    const client = await this.#clientFor(row);
    this.#authorize(row.id, row.peerId, row.resource, permissionFor(request));
    // Reserve BEFORE dispatch. A crash/timeout never causes automatic resubmission.
    transaction(db => {
      if (getRecord('core.relay.command', key)) fail('UNCERTAIN', 'This request is already dispatching.', 409);
      putRecord('core.relay.command', key, { id: key, hostId: row.hostId, peerId: row.peerId, resource: row.resource,
        relayUrl: row.relayUrl, sessionId: row.sessionId, op: request.op, fingerprint, state: 'dispatching', createdAt: now() }, db);
    });
    try {
      const requestId = `relay.${key}`;
      let result;
      if (params.coordinateInput === true) {
        const input = request.op === 'session.mode' ? { operation: 'mode', mode: params.mode, expectedUpdatedAt: params.expectedUpdatedAt }
          : request.op === 'session.configure' ? { operation: 'selection', selection: params.selection, expectedUpdatedAt: params.expectedUpdatedAt }
          : request.op === 'task.submit' ? { operation: 'execute', prompt: params.instruction }
          : request.op === 'execution.execute' ? { operation: params.goal === true ? 'goal' : 'execute',
            ...(params.goal === true ? { objective: params.prompt } : { prompt: params.prompt }),
            resumeGoal: params.resumeGoal === true, replaceGoalId: params.replaceGoalId, resumeGoalId: params.resumeGoalId, resumeGoalStatus: params.resumeGoalStatus }
          : request.op === 'question.answer' ? { operation: 'answer', questionId: params.questionId, answer: params.answer }
          : request.op === 'permissions.set' ? { operation: 'permissions', enabled: params.enabled, questionId: params.questionId }
          : { operation: 'control', action: params.action, text: params.text };
        result = await client.submitInput(row.sessionId, { ...input, owner, requestId, clientRequestId: request.id });
      }
      else if (request.op === 'task.submit') result = await client.execute(row.sessionId, { owner, prompt: params.instruction, goal: false, resumeGoal: false, requestId });
      else if (request.op === 'execution.execute') {
        const command = parseGoalCommand(params.prompt);
        if (command?.action && command.action !== 'resume') fail('INVALID_REQUEST', 'Use the goal status and pause/cancel controls; supply an objective or /goal resume.');
        if (command || params.goal === true) {
          const host = await runtime();
          result = await enqueueGoalTurn(row.sessionId, owner, {}, {
            objective: command?.objective ?? params.prompt, resume: command?.action === 'resume' || params.resumeGoal === true,
            replaceGoalId: params.replaceGoalId, resumeGoalId: params.resumeGoalId, resumeGoalStatus: params.resumeGoalStatus, requestId,
            authorize: permission => {
              const current = this.#authorize(row.id, row.peerId, row.resource, permission);
              // Scoped HTTP reads/controls retain their principal. Input owner
              // and live grant authorization are rechecked inside queue commit.
              host.requireOwner(row.sessionId, owner, `grant:${current.coreGrantId}`);
            },
            request: (method, action, body, id) => method === 'GET' ? client.session(row.sessionId) : client.control(row.sessionId, { owner, ...body, requestId: id }),
          });
        } else result = await client.execute(row.sessionId, { owner, prompt: params.prompt, goal: false, resumeGoal: false, requestId });
      }
      else if (request.op === 'question.answer') result = await client.answer(row.sessionId, { owner, questionId: params.questionId, answer: params.answer, requestId });
      else if (request.op === 'permissions.set') {
        const host = await runtime();
        result = setTerminalYolo(row.sessionId, { enabled: params.enabled, questionId: params.questionId }, requestId, { authorize: () => {
          this.#authorize(row.id, row.peerId, row.resource, 'execute');
          if (!this.#yoloAllowed(row)) fail('FORBIDDEN', 'YOLO permission was revoked.', 403);
          host.requireOwner(row.sessionId, owner);
        } });
      }
      else result = await client.control(row.sessionId, { owner, action: params.action, text: params.text, requestId });
      this.#check();
      putRecord('core.relay.command', key, { ...getRecord('core.relay.command', key), state: 'accepted', result, acceptedAt: now() });
      return { state: 'accepted', ...commandAcceptance(getRecord('core.relay.command', key)) };
    } catch (error) {
      this.#check();
      const code = errorCode(error), state = error.status >= 400 && error.status < 500 ? 'rejected' : 'uncertain';
      putRecord('core.relay.command', key, { ...getRecord('core.relay.command', key), state, code, updatedAt: now() });
      fail(state === 'uncertain' ? 'UNCERTAIN' : code, 'Command was rejected or has uncertain acceptance.', 409);
    }
  }

  #chunkTarget(row, params) {
    boundedInteger(params.seq, 1, Number.MAX_SAFE_INTEGER);
    boundedInteger(params.offset, 0, LIMITS.eventBytes - 1);
    boundedInteger(params.limit, 1, LIMITS.chunkBytes);
    const deletion = getRecord('session-deletion', row.sessionId);
    if (deletion && params.seq !== deletion.event.seq) fail('SESSION_DELETED', 'This chat was deleted.', 404);
    const event = database().prepare('SELECT seq FROM events WHERE session_id=? AND seq=?').get(row.sessionId, params.seq);
    if (!event) fail('INVALID_CURSOR', 'The scoped event is unavailable.');
  }
  async #eventChunk(row, params) {
    this.#chunkTarget(row, params);
    const key = digest({ grant: row.id, peer: row.peerId, resource: row.resource, session: row.sessionId, seq: params.seq });
    let transfer = this.#eventTransfers.get(key);
    if (transfer?.expiresAt <= Date.now()) { this.#eventTransfers.delete(key); transfer = null; }
    if (!transfer) {
      const raw = database().prepare('SELECT * FROM events WHERE session_id=? AND seq=?').get(row.sessionId, params.seq);
      const clean = await this.#clean({ version: 1, id: `${row.sessionId}:${raw.seq}`, seq: raw.seq,
      sessionId: row.sessionId, type: raw.type, data: JSON.parse(raw.data), createdAt: raw.created_at });
      this.#eventDescriptor(row, clean); transfer = this.#eventTransfers.get(key);
    }
    const { bytes, sha256 } = transfer;
    this.#chunkTarget(row, params);
    if (bytes.length > LIMITS.eventBytes || params.offset >= bytes.length) fail('RESULT_TOO_LARGE', 'The event exceeds the bounded transfer.');
    const part = bytes.subarray(params.offset, params.offset + params.limit);
    return { seq: params.seq, offset: params.offset, bytes: bytes.length, sha256, data: part.toString('base64'), nextOffset: params.offset + part.length };
  }
  #eventDescriptor(row, event) {
    const bytes = Buffer.from(JSON.stringify(event));
    if (bytes.length > LIMITS.eventBytes) fail('RESULT_TOO_LARGE', 'The event exceeds the bounded transfer.');
    const key = digest({ grant: row.id, peer: row.peerId, resource: row.resource, session: row.sessionId, seq: event.seq });
    const timestamp = Date.now();
    for (const [id, value] of this.#eventTransfers) if (value.expiresAt <= timestamp) this.#eventTransfers.delete(id);
    let used = [...this.#eventTransfers.values()].reduce((total, value) => total + value.bytes.length, 0);
    for (const [id, value] of this.#eventTransfers) {
      if (used + bytes.length <= LIMITS.eventBytes * 2 && this.#eventTransfers.size < 16) break;
      this.#eventTransfers.delete(id); used -= value.bytes.length;
    }
    const sha256 = digest(bytes);
    this.#eventTransfers.set(key, { bytes, sha256, expiresAt: timestamp + LIMITS.chunkAckTimeoutMs });
    return { chunked: true, id: event.id, seq: event.seq, sessionId: event.sessionId, bytes: bytes.length, sha256 };
  }
  async #eventList(row, params, client) {
    if (params.eventChunks !== undefined && typeof params.eventChunks !== 'boolean' || params.latest !== undefined && typeof params.latest !== 'boolean') fail('INVALID_REQUEST', 'History options must be boolean.');
    const backwards = params.latest === true || params.before !== undefined;
    if (backwards && params.after !== undefined || params.latest === true && params.before !== undefined) fail('INVALID_REQUEST', 'Choose a single history direction.');
    if (!backwards) return this.#eventPage(row, params.after ?? 0, params.limit ?? LIMITS.pageLimit, client, params.eventChunks === true);
    const before = boundedInteger(params.before ?? Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(params.limit ?? LIMITS.pageLimit, 1, LIMITS.pageLimit);
    let deletion = getRecord('session-deletion', row.sessionId);
    let page = deletion ? { events: deletion.event.seq < before ? [deletion.event] : [], hasOlder: false }
      : await client.eventHistory(row.sessionId, before, limit);
    deletion = getRecord('session-deletion', row.sessionId);
    if (deletion) page = { events: deletion.event.seq < before ? [deletion.event] : [], hasOlder: false };
    const selected = [];
    let expandedBytes = 0;
    // Select from newest backwards, then restore chronological order. The page
    // boundary always describes a contiguous suffix, including huge envelopes.
    for (const event of [...page.events].reverse()) {
      if (event.sessionId !== row.sessionId || event.version !== 1 || event.id !== `${row.sessionId}:${event.seq}` || !Number.isSafeInteger(event.seq) || event.seq >= (selected[0]?.seq ?? before)) fail('GATEWAY_UNAVAILABLE', 'The Core event envelope was invalid.');
      const clean = await this.#clean(event);
      const bytes = Buffer.byteLength(JSON.stringify(clean));
      if (selected.length && expandedBytes + bytes > LIMITS.eventBytes) break;
      const value = Buffer.byteLength(JSON.stringify(clean)) > LIMITS.payloadBytes - 2048
        ? params.eventChunks === true ? this.#eventDescriptor(row, clean) : fail('RESULT_TOO_LARGE', 'This event requires chunked transfer.') : clean;
      if (Buffer.byteLength(JSON.stringify([value, ...selected])) > LIMITS.payloadBytes - 2048) break;
      selected.unshift(value); expandedBytes += bytes;
    }
    const oldestCursor = selected[0]?.seq ?? 0, nextCursor = selected.at(-1)?.seq ?? 0;
    if (!deletion && getRecord('session-deletion', row.sessionId)) return this.#eventList(row, params, client);
    const result = { events: selected, nextCursor, hasMore: false, oldestCursor, hasOlder: page.hasOlder || selected.length < page.events.length };
    if (params.latest === true) {
      // A scoped short-lived proof that this exact tail was disclosed. A later
      // subscribe commits only the replay baseline after durable client storage.
      const token = randomUUID();
      const key = digest({ host: row.hostId, peer: row.peerId, resource: row.resource });
      putRecord('core.relay.bootstrap', key, { token, grantId: row.id, peerId: row.peerId, resource: row.resource,
        sessionId: row.sessionId, cursor: nextCursor, expiresAt: Date.now() + 300000 });
      result.bootstrapToken = token;
    }
    return result;
  }
  async #eventPage(row, after, limit, client, chunks = false) {
    boundedInteger(after, 0, Number.MAX_SAFE_INTEGER); boundedInteger(limit, 1, LIMITS.pageLimit);
    let deletion = getRecord('session-deletion', row.sessionId);
    let page = deletion ? { events: deletion.event.seq > after ? [deletion.event] : [], hasMore: false }
      : await client.events(row.sessionId, after, limit);
    deletion = getRecord('session-deletion', row.sessionId);
    if (deletion) page = { events: deletion.event.seq > after ? [deletion.event] : [], hasMore: false };
    const selected = [];
    let expandedBytes = 0;
    for (const event of page.events) {
      if (event.sessionId !== row.sessionId || event.version !== 1 || event.id !== `${row.sessionId}:${event.seq}` || !Number.isSafeInteger(event.seq) || event.seq <= (selected.at(-1)?.seq ?? after)) fail('GATEWAY_UNAVAILABLE', 'The Core event envelope was invalid.');
      const clean = await this.#clean(event);
      const bytes = Buffer.byteLength(JSON.stringify(clean));
      if (selected.length && expandedBytes + bytes > LIMITS.eventBytes) break;
      if (!chunks && selected.length && Buffer.byteLength(JSON.stringify(clean)) > LIMITS.payloadBytes - 2048) break;
      const value = Buffer.byteLength(JSON.stringify(clean)) > LIMITS.payloadBytes - 2048
        ? chunks ? this.#eventDescriptor(row, clean) : fail('RESULT_TOO_LARGE', 'This event requires chunked transfer.') : clean;
      if (Buffer.byteLength(JSON.stringify([...selected, value])) > LIMITS.payloadBytes - 2048) break;
      selected.push(value); expandedBytes += bytes;
    }
    if (!deletion && getRecord('session-deletion', row.sessionId)) return this.#eventPage(row, after, limit, client, chunks);
    return { events: selected, nextCursor: selected.at(-1)?.seq ?? after, hasMore: page.hasMore || selected.length < page.events.length };
  }
  #cursorKey(row, consumerId) { return digest({ hostId: row.hostId, peerId: row.peerId, resource: row.resource, sessionId: row.sessionId, consumerId }); }
  #renewSubscriptions(row) {
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.grantId === row.id && subscription.peerId === row.peerId && subscription.resource === row.resource) subscription.expiresAt = Date.now() + this.#subscriptionLeaseMs;
    }
  }
  #retireSubscription(subscription, code) {
    this.#stopSubscription(subscription);
    try {
      const row = this.#authorize(subscription.grantId, subscription.peerId, subscription.resource);
      void this.#send(row, { v: VERSION, protocol: PROTOCOL, type: 'subscription.closed', subscriptionId: subscription.id,
        resource: subscription.resource, code }).catch(() => {});
    } catch { /* Revoked peers cannot receive a final disclosure. */ }
  }
  #subscribe(row, consumerId, params = {}) {
    if (params.singleView !== undefined && typeof params.singleView !== 'boolean') fail('INVALID_REQUEST', 'Single-view support must be boolean.');
    if (params.eventChunks !== undefined && typeof params.eventChunks !== 'boolean') fail('INVALID_REQUEST', 'Chunk support must be boolean.');
    let baseline;
    if (params.bootstrapToken !== undefined) {
      opaque(params.bootstrapToken);
      const proof = getRecord('core.relay.bootstrap', digest({ host: row.hostId, peer: row.peerId, resource: row.resource }));
      if (!proof || proof.token !== params.bootstrapToken || proof.grantId !== row.id || proof.peerId !== row.peerId
        || proof.resource !== row.resource || proof.sessionId !== row.sessionId || proof.expiresAt <= Date.now()) fail('INVALID_CURSOR', 'The history baseline is unavailable.');
      baseline = proof.cursor;
    }
    if (params.singleView === true) {
      const ownPhone = authorizedOwnPhone(row.relayGrantId || row.id);
      if (!ownPhone || ownPhone.peerId !== row.peerId) fail('FORBIDDEN', 'Single-view handoff requires the fully approved phone.', 403);
      for (const subscription of this.#subscriptions.values()) {
        if (subscription.peerId === row.peerId && subscription.grantId === ownPhone.id
          && (subscription.resource !== row.resource || subscription.consumerId !== consumerId)) this.#retireSubscription(subscription, 'SUBSCRIPTION_REPLACED');
      }
    }
    for (const subscription of this.#subscriptions.values()) if (subscription.expiresAt <= Date.now()) this.#retireSubscription(subscription, 'SUBSCRIPTION_EXPIRED');
    const key = this.#cursorKey(row, consumerId), existing = [...this.#subscriptions.values()].find(item => item.key === key);
    if (existing) {
      // Updating the phone can add chunk support while its durable observation
      // consumer remains the same. Upgrade this live subscription in place.
      existing.chunks ||= params.eventChunks === true;
      // A reconnected client may have persisted a frame whose ACK was lost.
      // Replay that exact pending frame instead of waiting for its timeout.
      if (existing.pending) { existing.pending.replay = true; existing.pending.until = Date.now() + (existing.pending.page.events.some(event => event.chunked) ? LIMITS.chunkAckTimeoutMs : LIMITS.ackTimeoutMs); }
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => { void this.#pump(existing); }, this.#pollIntervalMs);
      return { subscriptionId: existing.id, consumerId, processedCursor: existing.cursor };
    }
    if (this.#subscriptions.size >= LIMITS.subscriptions || [...this.#subscriptions.values()].filter(item => item.peerId === row.peerId).length >= LIMITS.subscriptionsPerPeer) fail('CAPACITY', 'Subscription capacity reached.');
    const savedCursor = getRecord('core.relay.cursor', key);
    // Baselines are explicit new-consumer tail views, never acknowledgments of
    // undisclosed older events or a way to advance an existing consumer.
    if (baseline !== undefined && savedCursor && savedCursor.seq !== baseline) fail('INVALID_CURSOR', 'An existing consumer cannot skip events.');
    const cursor = savedCursor?.seq ?? baseline ?? 0;
    if (!savedCursor && baseline !== undefined) putRecord('core.relay.cursor', key, { hostId: row.hostId, peerId: row.peerId,
      resource: row.resource, sessionId: row.sessionId, consumerId, seq: cursor, startCursor: cursor, baseline: 'recent-history', updatedAt: now() });
    const subscription = { id: randomUUID(), key, grantId: row.id, peerId: row.peerId, resource: row.resource, consumerId,
      sessionId: row.sessionId, cursor, expiresAt: Date.now() + this.#subscriptionLeaseMs, chunks: params.eventChunks === true, pending: null, closed: false };
    this.#subscriptions.set(subscription.id, subscription);
    subscription.timer = setTimeout(() => { void this.#pump(subscription); }, this.#pollIntervalMs);
    return { subscriptionId: subscription.id, consumerId, processedCursor: cursor };
  }
  #subscriptionFor(row, id) {
    const sub = this.#subscriptions.get(id);
    if (!sub || sub.grantId !== row.id || sub.peerId !== row.peerId || sub.resource !== row.resource) fail('FORBIDDEN', 'This subscription is outside the grant.', 403);
    return sub;
  }
  #ackTarget(row, params) {
    const subscription = this.#subscriptionFor(row, opaque(params.subscriptionId));
    boundedInteger(params.seq, 0, Number.MAX_SAFE_INTEGER);
    if (params.seq !== subscription.cursor && !subscription.pending?.sequences.includes(params.seq)) fail('INVALID_CURSOR', 'Only a delivered event can be acknowledged.');
    return subscription;
  }
  #ack(row, params) {
    const subscription = this.#ackTarget(row, params);
    if (params.seq === subscription.cursor) return { processedCursor: subscription.cursor };
    transaction(db => {
      this.#authorize(row.id, row.peerId, row.resource);
      const previous = getRecord('core.relay.cursor', subscription.key)?.seq || 0;
      if (previous !== subscription.cursor) fail('CONFLICT', 'This consumer cursor changed.', 409);
      putRecord('core.relay.cursor', subscription.key, { hostId: row.hostId, peerId: row.peerId, resource: row.resource,
        sessionId: row.sessionId, consumerId: subscription.consumerId, seq: params.seq, updatedAt: now() }, db);
    });
    subscription.cursor = params.seq; subscription.pending = null;
    return { processedCursor: params.seq };
  }
  async #pump(subscription) {
    if (subscription.closed || subscription.pumping) return;
    subscription.pumping = true;
    try {
      const row = this.#authorize(subscription.grantId, subscription.peerId, subscription.resource);
      if (subscription.expiresAt <= Date.now()) { this.#retireSubscription(subscription, 'SUBSCRIPTION_EXPIRED'); return; }
      if (getRecord('session-deletion', row.sessionId) && subscription.pending?.page.events.some(event => event.type !== 'session.deleted')) {
        fail('SESSION_DELETED', 'This chat was deleted.', 404);
      }
      if (subscription.pending) {
        if (subscription.pending.until <= Date.now()) fail('INVALID_CURSOR', 'Subscription acknowledgment timed out.');
        if (subscription.pending.replay) {
          subscription.pending.replay = false;
          await this.#send(row, { v: VERSION, protocol: PROTOCOL, type: 'events', subscriptionId: subscription.id,
            resource: row.resource, sessionId: row.sessionId, ...subscription.pending.page });
        }
      } else {
        const page = await this.#eventPage(row, subscription.cursor, LIMITS.pageLimit, await this.#clientFor(row), subscription.chunks);
        if (subscription.closed) return;
        if (page.events.length) {
          subscription.pending = { sequences: page.events.map(event => event.seq), until: Date.now() + (page.events.some(event => event.chunked) ? LIMITS.chunkAckTimeoutMs : LIMITS.ackTimeoutMs), page, replay: false };
          await this.#send(row, { v: VERSION, protocol: PROTOCOL, type: 'events', subscriptionId: subscription.id,
            resource: row.resource, sessionId: row.sessionId, ...page });
        }
      }
    } catch (error) {
      this.#stopSubscription(subscription);
      try {
        const row = this.#authorize(subscription.grantId, subscription.peerId, subscription.resource);
        await this.#send(row, { v: VERSION, protocol: PROTOCOL, type: 'subscription.closed',
          subscriptionId: subscription.id, resource: row.resource, code: errorCode(error) });
      } catch { /* A disconnect/revocation cannot authorize a final disclosure. */ }
    }
    subscription.pumping = false;
    if (!subscription.closed) {
      clearTimeout(subscription.timer);
      subscription.timer = setTimeout(() => { void this.#pump(subscription); }, this.#pollIntervalMs);
    }
  }
  #stopSubscription(subscription) {
    subscription.closed = true; clearTimeout(subscription.timer); this.#subscriptions.delete(subscription.id);
  }
  #stopSubscriptions() { for (const subscription of this.#subscriptions.values()) this.#stopSubscription(subscription); }
  async #maintenance() {
    if (!this.#started || this.#maintenanceBusy) return;
    this.#maintenanceBusy = true;
    try {
      for (const subscription of this.#subscriptions.values()) {
        try { this.#authorize(subscription.grantId, subscription.peerId, subscription.resource); }
        catch { this.#stopSubscription(subscription); }
      }
      if (this.#relay.status !== 'online') return;
      const row = this.#rows('core.relay.revocation').find(item => item.state !== 'complete' && item.nextAttemptAt <= Date.now());
      if (!row) return;
      try {
        await this.#relay.revokeGrant(row.id);
        if (!this.#started || home() !== this.#home) return;
        putRecord('core.relay.revocation', row.id, { ...row, state: 'complete' });
      } catch (error) {
        if (!this.#started || home() !== this.#home) return;
        if (error.code === 'GRANT_UNAVAILABLE') putRecord('core.relay.revocation', row.id, { ...row, state: 'complete' });
        else putRecord('core.relay.revocation', row.id, { ...row, attempts: row.attempts + 1, nextAttemptAt: Date.now() + Math.min(30000, 1000 * 2 ** Math.min(row.attempts, 5)) });
      }
    } catch { this.emit('fault', { code: 'REVOCATION_PENDING' }); }
    finally { this.#maintenanceBusy = false; }
  }
  async close() {
    this.#eventTransfers.clear();
    this.#relayHealth?.close();
    this.#check(); this.#started = false; clearInterval(this.#maintenanceTimer); this.#stopSubscriptions();
    await this.#agentImports.close();
    await this.#transfers.close();
    await this.#relay.close(); this.#unlock?.(); this.#unlock = null;
  }
}
