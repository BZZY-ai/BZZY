import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RelayClient, createIdentity, verifyCertificate, encodeInvitation, renderInvitationQR } from './sdk.js';
import { decodeInvitation } from '@bzzy/relay/invitation';
import { DEFAULT_RELAY_URL, privateRelayDirectory } from './identity.js';
import { ensureRuntime, runtimeRequest } from '../engine/runtime.js';
import { loadSession } from '../engine.js';
import { canonical } from '../engine/database.js';
import { object, opaque, uuid, fail } from '../validation.js';
import { libraryApproval, createLibraryCode, decodeLibraryCode, libraryCodeProof } from './library-code.js';

const protocol = 'bzzy-project-transfer', version = 1;
export const TRANSFER_LIMITS = Object.freeze({ bytes: 256 * 1024 * 1024, chunkBytes: 16 * 1024,
  activeOffers: 4, retainedOffers: 32, codeSeconds: 600, grantSeconds: 3600, chunkIntervalMs: 64 });
const same = (a, b) => canonical(a) === canonical(b);
const bindingMatches = (a, b) => !b || a?.grantId === b.grantId && a?.resource === b.resource && a?.peerId === b.peerId;
const fingerprint = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const excludedGoals = values => Array.isArray(values) && values.length <= 1024 && new Set(values).size === values.length && values.every(value =>
  typeof value === 'string' && /^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|template:[a-f0-9]{64})$/.test(value));
const libraryKinds = ['skill', 'agent', 'workflow', 'goal', 'extension'];

// Validate and detach the local owner's reviewed selection before any await.
// These fields are inventory pins, never transport or execution permissions.
export function libraryShareSelection(input) {
  const kinds = input.kinds === undefined ? libraryKinds : input.kinds,
    excludeGoalIds = input.excludeGoalIds === undefined ? [] : input.excludeGoalIds,
    excludeEntries = input.excludeEntries === undefined ? [] : input.excludeEntries;
  if (!Array.isArray(kinds) || !kinds.length || kinds.length > libraryKinds.length || new Set(kinds).size !== kinds.length ||
      [...kinds].some(kind => !libraryKinds.includes(kind))) fail('INVALID_REQUEST', 'Choose distinct Library resource types.');
  if (!excludedGoals(excludeGoalIds) || [...excludeGoalIds].some(value => typeof value !== 'string') ||
      excludeGoalIds.length && !kinds.includes('goal')) fail('INVALID_REQUEST', 'Review the exact saved goals excluded from this Library.');
  if (!Array.isArray(excludeEntries) || excludeEntries.length > 1024) fail('INVALID_REQUEST', 'Review the exact entries excluded from this Library.');
  const seen = new Set(), detached = [];
  for (const entry of excludeEntries) {
    object(entry, ['kind', 'scope', 'name', 'id', 'revision', 'version']);
    if (Object.keys(entry).length !== 6 || !['skill', 'agent', 'workflow', 'extension'].includes(entry.kind) || !kinds.includes(entry.kind) || !['project', 'global'].includes(entry.scope) ||
        typeof entry.name !== 'string' || entry.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name) ||
        typeof entry.id !== 'string' || !entry.id.length || entry.id.length > 240 || /[\x00-\x1f\x7f-\x9f]/u.test(entry.id) ||
        !Number.isSafeInteger(entry.revision) || entry.revision < 1 || typeof entry.version !== 'string' || !/^[a-f0-9]{64}$/.test(entry.version)) {
      fail('INVALID_REQUEST', 'Review the exact entries excluded from this Library.');
    }
    const key = canonical([entry.kind, entry.scope, entry.name]);
    if (seen.has(key)) fail('INVALID_REQUEST', 'Exclude each Library entry only once.');
    seen.add(key); detached.push({ ...entry });
  }
  return { kinds: [...kinds].sort(), excludeGoalIds: [...excludeGoalIds], excludeEntries: detached };
}
const hashFile = async file => {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
};

// Client routing only: kind classification grants no trust or import authority.
// The receiver still verifies the signed peer, exact grant and archive kind.
export function classifyProjectShareCode(value, { allowInsecureLocal = false } = {}) {
  if (typeof value !== 'string') fail('INVALID_REQUEST', 'Use a valid Agent, Terminal or Library import code.');
  let code = value.trim();
  const automatic = decodeLibraryCode(code); if (automatic) code = automatic.code;
  if (code.startsWith('BZZY:INVITE:1:')) code = decodeInvitation(code, { allowInsecureLocal }).code;
  const match = /^BZZY-(AGENT|TERMINAL|LIBRARY)-([A-Za-z0-9_-]{43})$/.exec(code);
  if (!match || Buffer.from(match[2], 'base64url').length !== 32 || Buffer.from(match[2], 'base64url').toString('base64url') !== match[2]) fail('INVALID_REQUEST', 'Use a valid Agent, Terminal or Library import code.');
  return match[1];
}

// Host-only source service. It attaches to Core's existing Relay identity/socket;
// invitation/grant ownership is independent of all live session permissions.
export class ProjectTransferService {
  #client; #offers = new Map(); #grants = new Map(); #timer; #closed = false; #export; #creating = 0; #approving = false;
  constructor({ client, exportArchive } = {}) {
    this.#client = client;
    this.#export = exportArchive || (async (session, file) => (await import('../engine/project-bundle.js')).exportSharedProject(session, file));
    this.#timer = setInterval(() => { void this.#expire(); }, 1000); this.#timer.unref();
  }
  #storage() {
    const directory = path.join(privateRelayDirectory(), 'shares');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) fail('FORBIDDEN', 'Project share storage must be private.', 403);
    return directory;
  }
  restore() {
    // Called only after Core owns the exclusive gateway identity lock. A crash
    // cannot restore one-time codes; old private archive caches are discarded.
    const directory = this.#storage();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (/^[a-f0-9-]{36}$/.test(entry.name)) {
      fs.rmSync(path.join(directory, entry.name), { recursive: true, force: true });
    }
  }
  async createShare(input, { binding, authorize, exportArchive } = {}) {
    object(input, ['sessionId', 'ttlSeconds', 'kind', 'cwd', 'expectedDigest', 'excludeGoalIds', 'kinds', 'excludeEntries', 'approval']);
    const kind = input.kind ?? 'TERMINAL';
    if (!['AGENT', 'TERMINAL', 'LIBRARY'].includes(kind)) fail('INVALID_REQUEST', 'Choose an Agent, Terminal or Library share.');
    if (kind === 'LIBRARY') {
      object(input, ['kind', 'cwd', 'expectedDigest', 'ttlSeconds', 'excludeGoalIds', 'kinds', 'excludeEntries', 'approval']);
      if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd) || !/^[a-f0-9]{64}$/.test(input.expectedDigest || '')) fail('INVALID_REQUEST', 'Review the current Library before sharing it.');
      input = { ...input, ...libraryShareSelection(input), approval: libraryApproval(input.approval) };
    } else { object(input, ['sessionId', 'ttlSeconds', 'kind']); uuid(input.sessionId); }
    // Only trusted Core Agent registry code may supply both callbacks. Purpose
    // strings in a session or remote request never authorize an Agent export.
    if (['AGENT', 'LIBRARY'].includes(kind) && (typeof authorize !== 'function' || typeof exportArchive !== 'function')) fail('OPERATION_DENIED', 'This sharing kind requires its trusted host registry.', 403);
    const session = kind === 'LIBRARY' ? { cwd: input.cwd, expectedDigest: input.expectedDigest, ...libraryShareSelection(input) } : loadSession(input.sessionId);
    const checkAuthorization = () => {
      if (this.#closed) fail('GATEWAY_OFFLINE', 'The sharing service stopped.');
      authorize?.();
      if (kind === 'LIBRARY') return;
      const current = loadSession(input.sessionId);
      if (!current || current.parentSessionId || current.cwd !== session?.cwd || (kind === 'AGENT'
        ? current.purpose !== 'agent' || !current.agentId || current.agentId !== session?.agentId
        : current.purpose && current.purpose !== 'terminal')) fail('FORBIDDEN', 'Share an authorized root resource of the selected kind.', 403);
    };
    checkAuthorization();
    if (this.#closed || this.#client.status !== 'online') fail('GATEWAY_OFFLINE', 'Connect Core Relay before sharing.');
    const ttl = input.ttlSeconds ?? TRANSFER_LIMITS.codeSeconds;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > TRANSFER_LIMITS.codeSeconds) fail('INVALID_REQUEST', 'Choose a share-code lifetime of 1–600 seconds.');
    if (this.#creating + [...this.#offers.values()].filter(offer => ['open', 'pending', 'approved'].includes(offer.state)).length >= TRANSFER_LIMITS.activeOffers) fail('CAPACITY', 'Too many active project shares.');
    const shareId = randomUUID(), directory = path.join(this.#storage(), shareId), file = path.join(directory, 'project.zip');
    fs.mkdirSync(directory, { mode: 0o700 });
    let fd, invitation;
    this.#creating++;
    try {
      const receipt = await (exportArchive || this.#export)(session, file); checkAuthorization();
      if (receipt?.missingFiles?.length) fail('SHARE_CONTEXT_INCOMPLETE', 'The complete source context is unavailable.');
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > TRANSFER_LIMITS.bytes || stat.nlink !== 1) fail('RESULT_TOO_LARGE', 'The prepared project ZIP exceeds the sharing limit.');
      const sha256 = await hashFile(file); checkAuthorization();
      const spec = { kind, mode: 'portable', resource: shareId, actions: ['import'], ttlSeconds: ttl,
        grantTtlSeconds: TRANSFER_LIMITS.grantSeconds };
      invitation = await this.#client.createInvitation(spec); checkAuthorization();
      if (!same(invitation.spec, spec)) fail('FORBIDDEN', 'Relay changed the requested project share.', 403);
      const display = { relay: this.#client.url, code: invitation.code, sender: this.#client.identity.certificate, expiresAt: invitation.expiresAt };
      const allowInsecureLocal = this.#client.url.startsWith('ws:');
      const capability = input.approval === 'code' ? createLibraryCode({ code: invitation.code, fingerprint: display.sender.id, sha256 }) : null;
      const offer = { shareId, kind, sessionId: session.id, binding, authorize: checkAuthorization, directory, file, fd, stat, bytes: stat.size, sha256,
        invitationId: invitation.invitationId, code: capability?.code || invitation.code, codeSecret: capability?.secret, codeAuthorized: false,
        approval: capability ? 'code' : 'manual', qr: capability ? capability.code : encodeInvitation(display, { allowInsecureLocal }),
        terminalQR: capability ? '' : await renderInvitationQR(display, { terminal: true, allowInsecureLocal }), expiresAt: invitation.expiresAt,
        state: 'open', pending: [], createdAt: Date.now(), spec };
      this.#offers.set(shareId, offer);
      while (this.#offers.size > TRANSFER_LIMITS.retainedOffers) {
        const old = [...this.#offers.values()].find(value => !['open', 'pending', 'approved'].includes(value.state));
        if (!old) break;
        if (old.grantId) this.#grants.delete(old.grantId);
        this.#offers.delete(old.shareId);
      }
      return this.invitation(shareId, binding);
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(directory, { recursive: true, force: true });
      if (invitation) await this.#client.revokeInvitation(invitation.invitationId).catch(() => {});
      if (kind === 'LIBRARY' && ['INVALID_PURPOSE', 'INVALID_CODE'].includes(error.code)) fail('RELAY_UPGRADE_REQUIRED', 'Update Relay to support Library transfer codes.');
      throw error;
    } finally { this.#creating--; }
  }
  #get(shareId, binding) {
    opaque(shareId); const offer = this.#offers.get(shareId);
    if (!offer || !bindingMatches(offer.binding, binding)) fail('FORBIDDEN', 'This project share is unavailable.', 403);
    offer.authorize(); return offer;
  }
  invitation(shareId, binding) {
    const offer = this.#get(shareId, binding);
    if (!['open', 'pending', 'approved'].includes(offer.state) || offer.expiresAt <= Date.now()) fail('UNCERTAIN', 'Create a new share after the previous code expires.', 409);
    return { shareId, kind: offer.kind, code: offer.code, qr: offer.qr, terminalQR: offer.terminalQR, expiresAt: offer.expiresAt,
      ...(offer.approval === 'code' ? { approval: 'code' } : {}),
      senderFingerprint: this.#client.identity.certificate.id, bytes: offer.bytes, sha256: offer.sha256 };
  }
  status(shareId, binding) {
    const offer = this.#get(shareId, binding);
    return { shareId, state: offer.state, pending: offer.pending.map(item => ({ claimId: item.claimId,
      certificate: item.recipient, fingerprint: item.recipient.id })), bytes: offer.bytes, expiresAt: offer.expiresAt };
  }
  handleClaim(data) {
    const offer = [...this.#offers.values()].find(value => value.invitationId === data.invitationId);
    if (!offer) return false;
    try {
      offer.authorize(); verifyCertificate(data.recipient); opaque(data.claimId);
      if (!same(data.spec, offer.spec) || offer.state !== 'open' || data.expiresAt !== offer.expiresAt || offer.expiresAt <= Date.now()) fail('FORBIDDEN', 'Unexpected project claim.', 403);
      offer.pending = [{ claimId: data.claimId, recipient: structuredClone(data.recipient) }]; offer.state = 'pending';
      if (offer.approval === 'code') void this.#approveCodeOffer(offer);
    } catch { void this.#client.deny(data.claimId).catch(() => {}); }
    return true;
  }
  async #approveCodeOffer(offer) {
    if (this.#closed || offer.state !== 'pending' || !offer.pending.length) return;
    try { await this.approveShare({ shareId: offer.shareId, claimId: offer.pending[0].claimId, confirmedFingerprint: offer.pending[0].recipient.id }); }
    catch (error) { if (error.code !== 'CAPACITY') await this.revokeShare(offer.shareId).catch(() => {}); }
  }
  async approveShare(input, binding) {
    object(input, ['shareId', 'claimId', 'confirmedFingerprint']);
    const offer = this.#get(input.shareId, binding), claim = offer.pending.find(value => value.claimId === input.claimId);
    if (!claim || offer.state !== 'pending' || claim.recipient.id !== input.confirmedFingerprint) fail('CONFIRMATION_REQUIRED', 'Compare the recipient fingerprint before approving.', 403);
    if (this.#approving || [...this.#offers.values()].some(value => value !== offer && value.state === 'approved')) fail('CAPACITY', 'Finish the active project transfer before approving another.');
    this.#approving = true; let grant;
    try {
      grant = (await this.#client.approve(claim.claimId, claim.recipient)).grant; offer.authorize();
      if (this.#closed || offer.state !== 'pending' || offer.expiresAt <= Date.now() || !offer.pending.includes(claim) || !grant || grant.spec.resource !== offer.shareId || !same(grant.spec, offer.spec) || grant.recipientId !== claim.recipient.id || grant.hostId !== this.#client.identity.certificate.id) fail('FORBIDDEN', 'Project grant did not match the approved recipient.', 403);
      offer.grantId = grant.id; offer.recipient = claim.recipient; offer.transferExpiresAt = grant.expiresAt;
      offer.pending = []; offer.state = 'approved'; offer.authorizationExpiresAt = Math.min(offer.expiresAt, Date.now() + 15000); this.#grants.set(grant.id, offer.shareId);
      return { approved: true };
    } catch (error) { if (grant?.id) await this.#client.revokeGrant(grant.id).catch(() => {}); throw error; }
    finally { this.#approving = false; }
  }
  authorizeRoute(grant, peer) {
    const shareId = this.#grants.get(grant.id), offer = shareId && this.#offers.get(shareId);
    if (!offer) return false;
    offer.authorize();
    if (!['approved', 'complete'].includes(offer.state) || grant.expiresAt <= Date.now() || offer.transferExpiresAt <= Date.now() ||
      grant.hostId !== this.#client.identity.certificate.id || grant.recipientId !== offer.recipient.id || peer.id !== offer.recipient.id ||
      !same(grant.spec, offer.spec) || !same(peer, offer.recipient)) fail('FORBIDDEN', 'This transfer is no longer authorized.', 403);
    return true;
  }
  handleRevocation(grantId) {
    const shareId = this.#grants.get(grantId), offer = shareId && this.#offers.get(shareId);
    if (offer) { offer.state = 'revoked'; offer.pending = []; this.#release(offer); this.#grants.delete(grantId); }
  }
  async handleMessage(message) {
    const shareId = this.#grants.get(message.grant.id);
    if (!shareId) return false;
    const offer = this.#offers.get(shareId), request = message.payload;
    let id = 'invalid';
    try {
      this.authorizeRoute(message.grant, offer.recipient);
      object(request, ['v', 'protocol', 'type', 'id', 'op', 'params']); id = opaque(request.id);
      if (request.v !== version || request.protocol !== protocol || request.type !== 'request') fail('PROTOCOL_UNSUPPORTED', 'Unsupported transfer protocol.');
      let result, cancel = false;
      if (offer.approval === 'code' && !offer.codeAuthorized && request.op !== 'authorize-code' && request.op !== 'cancel') fail('FORBIDDEN', 'Library code authorization is required.', 403);
      if (request.op === 'authorize-code') {
        object(request.params, ['proof']);
        const expected = offer.codeSecret && libraryCodeProof(offer.codeSecret, { shareId: offer.shareId, grantId: message.grant.id, recipientId: offer.recipient.id, sha256: offer.sha256 });
        if (offer.approval !== 'code' || offer.codeAuthorized || offer.authorizationExpiresAt <= Date.now() || typeof request.params.proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(request.params.proof) || !expected || !timingSafeEqual(Buffer.from(request.params.proof), Buffer.from(expected))) fail('FORBIDDEN', 'Library code authorization failed.', 403);
        offer.codeAuthorized = true; result = { authorized: true };
      } else if (request.op === 'manifest') {
        object(request.params, []);
        result = { format: 'bzzy-project-zip', version: 1, kind: offer.kind, bytes: offer.bytes, sha256: offer.sha256, chunkBytes: TRANSFER_LIMITS.chunkBytes };
      } else if (request.op === 'chunk') {
        object(request.params, ['offset']); const offset = request.params.offset;
        if (offer.state !== 'approved' || !Number.isSafeInteger(offset) || offset < 0 || offset >= offer.bytes || offset % TRANSFER_LIMITS.chunkBytes !== 0) fail('INVALID_REQUEST', 'Invalid project chunk.');
        if (Date.now() - (offer.lastChunk || 0) < TRANSFER_LIMITS.chunkIntervalMs) fail('RATE_LIMITED', 'Project chunk pacing limit.');
        offer.lastChunk = Date.now();
        const stat = fs.fstatSync(offer.fd);
        if (stat.size !== offer.stat.size || stat.mtimeMs !== offer.stat.mtimeMs || stat.ino !== offer.stat.ino) fail('FORBIDDEN', 'The prepared ZIP changed.', 403);
        const chunk = Buffer.alloc(Math.min(TRANSFER_LIMITS.chunkBytes, offer.bytes - offset));
        if (fs.readSync(offer.fd, chunk, 0, chunk.length, offset) !== chunk.length) fail('FORBIDDEN', 'Project chunk unavailable.', 403);
        result = { offset, data: chunk.toString('base64url') };
      } else if (request.op === 'cancel' && offer.kind === 'LIBRARY') {
        object(request.params, []); cancel = true; result = { cancelled: true };
      } else if (request.op === 'complete') {
        object(request.params, ['sha256']);
        if (request.params.sha256 !== offer.sha256) fail('INVALID_REQUEST', 'Project digest mismatch.');
        offer.state = 'complete'; this.#release(offer); result = { complete: true };
      } else fail('OPERATION_DENIED', 'Transfer operation is unavailable.', 403);
      offer.authorize(); await this.#client.send(message.grant.id, { v: version, protocol, type: 'response', id, ok: true, result });
      if (cancel) await this.revokeShare(offer.shareId);
    } catch (error) {
      const code = ['INVALID_REQUEST', 'FORBIDDEN', 'RATE_LIMITED', 'PROTOCOL_UNSUPPORTED', 'OPERATION_DENIED'].includes(error.code) ? error.code : 'TRANSFER_UNAVAILABLE';
      try { await this.#client.send(message.grant.id, { v: version, protocol, type: 'response', id, ok: false, error: { code } }); } catch {}
    }
    return true;
  }
  #release(offer) {
    if (offer.fd !== undefined) { fs.closeSync(offer.fd); offer.fd = undefined; }
    fs.rmSync(offer.directory, { recursive: true, force: true });
    offer.code = undefined; offer.qr = undefined; offer.terminalQR = undefined;
    offer.codeSecret = undefined;
  }
  async revokeShare(shareId, binding, state = 'revoked') {
    const offer = this.#get(shareId, binding);
    offer.state = state; offer.pending = []; this.#release(offer);
    if (offer.grantId) { this.#grants.delete(offer.grantId); await this.#client.revokeGrant(offer.grantId).catch(() => {}); }
    await this.#client.revokeInvitation(offer.invitationId).catch(() => {});
    return { revoked: true };
  }
  async #expire() {
    for (const offer of this.#offers.values()) if (['open', 'pending', 'approved'].includes(offer.state)) {
      try {
        offer.authorize();
        const deadline = offer.state === 'approved' ? offer.approval === 'code' && !offer.codeAuthorized ? offer.authorizationExpiresAt : offer.transferExpiresAt : offer.expiresAt;
        if (deadline <= Date.now()) await this.revokeShare(offer.shareId, undefined, 'expired');
        else if (offer.approval === 'code' && offer.state === 'pending') await this.#approveCodeOffer(offer);
      } catch {
        offer.state = 'revoked'; offer.pending = []; this.#release(offer);
        if (offer.grantId) { this.#grants.delete(offer.grantId); await this.#client.revokeGrant(offer.grantId).catch(() => {}); }
        await this.#client.revokeInvitation(offer.invitationId).catch(() => {});
      }
    }
  }
  async close() {
    this.#closed = true; clearInterval(this.#timer);
    for (const offer of this.#offers.values()) {
      this.#release(offer);
      if (offer.grantId) await this.#client.revokeGrant(offer.grantId).catch(() => {});
      await this.#client.revokeInvitation(offer.invitationId).catch(() => {});
    }
    this.#offers.clear(); this.#grants.clear();
  }
}

export class CoreTerminalSharing {
  #info;
  async #request(action, body) { this.#info ||= await ensureRuntime(); return runtimeRequest(this.#info, 'POST', `/v1/relay/${action}`, body); }
  async start() { await this.#request('connect', {}); return { ready: true }; }
  async createShare(input) { const result = await this.#request('share-create', input); return { ...result, renderQR: async () => result.terminalQR }; }
  async createLibraryShare(input) {
    object(input, ['cwd', 'expectedDigest', 'ttlSeconds', 'excludeGoalIds', 'kinds', 'excludeEntries', 'approval']);
    libraryApproval(input.approval);
    if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd) || !/^[a-f0-9]{64}$/.test(input.expectedDigest || '')) fail('INVALID_REQUEST', 'Review the current Library before sharing it.');
    if (input.ttlSeconds !== undefined && (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > TRANSFER_LIMITS.codeSeconds)) fail('INVALID_REQUEST', 'Choose a share-code lifetime of 1–600 seconds.');
    const selected = { ...input, ...libraryShareSelection(input) };
    const result = await this.#request('library-share-create', selected);
    return { ...result, renderQR: async () => result.terminalQR };
  }
  status(shareId) { return this.#request('share-status', { shareId }); }
  approveShare(input) { return this.#request('share-approve', input); }
  revokeShare(shareId) { return this.#request('share-revoke', { shareId }); }
  async close() {} // Source work belongs to Core, not the terminal view.
}

async function transferRequest(client, grantId, op, params, signal) {
  signal?.throwIfAborted(); const id = randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); client.removeListener('message', receive); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); reject(Object.assign(new Error('Import cancelled.'), { code: 'CANCELLED' })); };
    const timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error('Project response unavailable.'), { code: 'TRANSFER_UNAVAILABLE' })); }, 15000);
    const receive = message => {
      const frame = message.payload;
      if (message.grant.id !== grantId || frame?.id !== id) return;
      try {
        object(frame, ['v', 'protocol', 'type', 'id', 'ok', 'result', 'error']);
        if (frame.v !== 1 || frame.protocol !== protocol || frame.type !== 'response' || typeof frame.ok !== 'boolean') fail('INVALID_REQUEST', 'Invalid transfer response.');
        cleanup();
        if (frame.ok) resolve(frame.result); else reject(Object.assign(new Error('Project transfer rejected.'), { code: frame.error?.code || 'TRANSFER_UNAVAILABLE' }));
      } catch (error) { cleanup(); reject(error); }
    };
    client.on('message', receive); signal?.addEventListener('abort', cancel, { once: true });
    void client.send(grantId, { v: 1, protocol, type: 'request', id, op, params }).catch(() => { cleanup(); reject(Object.assign(new Error('Project transfer disconnected.'), { code: 'TRANSFER_UNAVAILABLE' })); });
  });
}

export async function importProjectShare({ expectedKind, code, cwd, expectedSenderFingerprint, onIdentity, onProgress, onPhase, signal,
  url = DEFAULT_RELAY_URL, allowInsecureLocal = false, importArchive } = {}) {
  if (!['AGENT', 'TERMINAL', 'LIBRARY'].includes(expectedKind) || ['AGENT', 'LIBRARY'].includes(expectedKind) && typeof importArchive !== 'function') fail('INVALID_REQUEST', 'Choose the matching host importer.');
  const capability = decodeLibraryCode(code);
  if (capability) {
    if (expectedKind !== 'LIBRARY' || expectedSenderFingerprint !== undefined && expectedSenderFingerprint !== capability.fingerprint) fail('FORBIDDEN', 'The Library code sender does not match.', 403);
    code = capability.code; expectedSenderFingerprint = capability.fingerprint;
    onIdentity ||= () => {};
  }
  if (!fingerprint(expectedSenderFingerprint) || typeof onIdentity !== 'function') fail('CONFIRMATION_REQUIRED', 'Compare the source fingerprint before importing.', 403);
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) fail('INVALID_REQUEST', 'Choose the current recipient project directory.');
  let expectedCertificate;
  if (typeof code === 'string' && code.startsWith('BZZY:INVITE:1:')) {
    const invitation = decodeInvitation(code, { allowInsecureLocal });
    if (invitation.sender.id !== expectedSenderFingerprint || invitation.relay !== url) fail('FORBIDDEN', 'The invitation source does not match.', 403);
    expectedCertificate = invitation.sender; code = invitation.code;
  }
  if (typeof code !== 'string' || !new RegExp(`^BZZY-${expectedKind}-[A-Za-z0-9_-]{43}$`).test(code)) fail('INVALID_REQUEST', 'Use an import code of the selected kind.');
  const identity = createIdentity(), client = new RelayClient({ url, identity, allowInsecureLocal, autoReconnect: false });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-terminal-import-')); fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'project.zip'); let fd, approvedGrant, imported = false;
  try {
    await onPhase?.('connecting'); signal?.throwIfAborted();
    await client.connect(); signal?.throwIfAborted(); await onIdentity({ recipientFingerprint: identity.certificate.id });
    const claim = await client.claim(code); // Single-use: never retry this mutation.
    const deadline = Date.now() + TRANSFER_LIMITS.codeSeconds * 1000;
    let decision;
    while (Date.now() < deadline) {
      signal?.throwIfAborted(); decision = await client.claimStatus(claim.claimId);
      if (decision.state !== 'pending') break;
      await delay(300, undefined, { signal });
    }
    const grant = decision?.grant;
    if (decision?.state !== 'approved' || !grant || grant.spec.kind !== expectedKind || grant.spec.mode !== 'portable' || !same(grant.spec.actions, ['import']) ||
      grant.hostId !== expectedSenderFingerprint || grant.recipientId !== identity.certificate.id || grant.peer.id !== expectedSenderFingerprint ||
      expectedCertificate && !same(expectedCertificate, grant.peer)) fail('FORBIDDEN', 'The source did not approve this project import.', 403);
    verifyCertificate(grant.peer); client.trustPeer(grant.peer);
    approvedGrant = grant;
    if (capability) {
      const result = await transferRequest(client, grant.id, 'authorize-code', { proof: libraryCodeProof(capability.secret,
        { shareId: grant.spec.resource, grantId: grant.id, recipientId: identity.certificate.id, sha256: capability.sha256 }) }, signal);
      if (result?.authorized !== true) fail('FORBIDDEN', 'The Library code was not authorized.', 403);
    }
    const manifest = await transferRequest(client, grant.id, 'manifest', {}, signal);
    object(manifest, ['format', 'version', 'kind', 'bytes', 'sha256', 'chunkBytes']);
    if (manifest.format !== 'bzzy-project-zip' || manifest.version !== 1 || manifest.kind !== expectedKind || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > TRANSFER_LIMITS.bytes ||
      manifest.chunkBytes !== TRANSFER_LIMITS.chunkBytes || !/^[a-f0-9]{64}$/.test(manifest.sha256)) fail('INVALID_REQUEST', 'Invalid project manifest.');
    if (capability && manifest.sha256 !== capability.sha256) fail('FORBIDDEN', 'The Library does not match the export code.', 403);
    await onPhase?.('downloading'); signal?.throwIfAborted();
    fd = fs.openSync(file, 'wx', 0o600); const hash = createHash('sha256');
    for (let offset = 0; offset < manifest.bytes; offset += manifest.chunkBytes) {
      signal?.throwIfAborted();
      const chunk = await transferRequest(client, grant.id, 'chunk', { offset }, signal);
      object(chunk, ['offset', 'data']);
      if (chunk.offset !== offset || typeof chunk.data !== 'string' || !/^[A-Za-z0-9_-]+$/.test(chunk.data)) fail('INVALID_REQUEST', 'Invalid project chunk.');
      const bytes = Buffer.from(chunk.data, 'base64url');
      if (bytes.toString('base64url') !== chunk.data || bytes.length !== Math.min(manifest.chunkBytes, manifest.bytes - offset)) fail('INVALID_REQUEST', 'Invalid project chunk length.');
      fs.writeSync(fd, bytes); hash.update(bytes); await onProgress?.({ received: offset + bytes.length, total: manifest.bytes });
      // Pace from the completed response, not the prior request's send time.
      // Variable RPC latency must never move the next arrival ahead of the
      // source's minimum interval (notably under a loaded host/test suite).
      if (offset + bytes.length < manifest.bytes) await delay(TRANSFER_LIMITS.chunkIntervalMs, undefined, { signal });
    }
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (hash.digest('hex') !== manifest.sha256) fail('FORBIDDEN', 'The project ZIP digest did not match.', 403);
    await onPhase?.('checking'); signal?.throwIfAborted();
    const importer = importArchive || (async (archive, directory, context) => (await import('../engine/project-bundle.js')).importSharedProject(archive, directory, undefined, { sourceFingerprint: context.sourceFingerprint, signal: context.signal }));
    if (expectedKind === 'LIBRARY') {
      const result = await importer(file, cwd, { sourceFingerprint: grant.hostId, signal, authorize: async () => {
        signal?.throwIfAborted();
        const current = await transferRequest(client, grant.id, 'manifest', {}, signal);
        if (!same(current, manifest)) fail('FORBIDDEN', 'The Library transfer changed before import.', 403);
      } });
      imported = true;
      // Once the local transaction commits, a missing transport ACK cannot
      // turn success into a retry that creates a second imported Library.
      await transferRequest(client, grant.id, 'complete', { sha256: manifest.sha256 }, AbortSignal.timeout(1500)).catch(() => {});
      return result;
    }
    await transferRequest(client, grant.id, 'complete', { sha256: manifest.sha256 }, signal);
    signal?.throwIfAborted();
    await onPhase?.('installing'); signal?.throwIfAborted();
    return await importer(file, cwd, { sourceFingerprint: grant.hostId, signal });
  } catch (error) {
    if (expectedKind === 'LIBRARY' && approvedGrant && !imported) {
      await transferRequest(client, approvedGrant.id, 'cancel', {}, AbortSignal.timeout(1000)).catch(() => {});
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    await client.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function importTerminalShare(input = {}) {
  return importProjectShare({ ...input, expectedKind: 'TERMINAL' });
}

export function importLibraryShare(input = {}) {
  if (typeof input.onReview !== 'function') fail('CONFIRMATION_REQUIRED', 'Review the received Library before importing.', 403);
  const { onReview, ...options } = input;
  return importProjectShare({ ...options, expectedKind: 'LIBRARY', importArchive: async (file, cwd, { authorize }) => {
    const library = await import('../engine/definition-bundle.js');
    let review;
    try {
      options.signal?.throwIfAborted();
      review = library.previewLibraryImport(file, { cwd });
      const decision = await new Promise((resolve, reject) => {
        const cancel = () => reject(options.signal.reason || Object.assign(new Error('Library import cancelled.'), { code: 'CANCELLED' }));
        const finish = callback => value => { options.signal?.removeEventListener('abort', cancel); callback(value); };
        options.signal?.addEventListener('abort', cancel, { once: true });
        Promise.resolve().then(() => onReview(review)).then(finish(resolve), finish(reject));
      });
      let enable = false, entryIndexes;
      if (decision !== true) {
        if (!decision || typeof decision !== 'object' || decision.approved !== true) fail('CANCELLED', 'Library import cancelled.');
        object(decision, ['approved', 'enable', 'entryIndexes']);
        if (decision.enable !== undefined && typeof decision.enable !== 'boolean') fail('INVALID_REQUEST', 'Choose whether to enable the reviewed Library.');
        enable = decision.enable === true;
        if (decision.entryIndexes !== undefined) entryIndexes = library.libraryImportEntryIndexes(decision.entryIndexes, review.entries.length);
      }
      options.signal?.throwIfAborted();
      await authorize();
      options.signal?.throwIfAborted();
      await options.onPhase?.('installing'); options.signal?.throwIfAborted();
      return library.importLibraryBundle(review, { cwd, enable, reportReceipt: Boolean(decodeLibraryCode(options.code)), ...(entryIndexes ? { entryIndexes } : {}) });
    } finally { if (review) library.discardDefinitionBundleReview(review); }
  } });
}
