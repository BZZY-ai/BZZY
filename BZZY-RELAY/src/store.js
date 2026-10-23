import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, fail, hash, importCode, inviteSpec, opaque, random } from './protocol.js';
import { verifyCertificate } from './identity.js';

const parse = row => row ? JSON.parse(row.data) : null;
export class RelayStore {
  constructor({ directory, now = Date.now, limits = LIMITS } = {}) {
    Object.assign(this, { now, limits });
    let file = ':memory:';
    if (directory) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) fail('PRIVATE_DIRECTORY_REQUIRED');
      fs.chmodSync(directory, 0o700);
      file = path.join(directory, 'relay.sqlite');
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
      fs.closeSync(fd); fs.chmodSync(file, 0o600);
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      PRAGMA max_page_count=8192; PRAGMA journal_size_limit=1048576;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES ('schema', '1');
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, code_hash TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    if (this.db.prepare("SELECT value FROM metadata WHERE key='schema'").get().value !== '1') fail('SCHEMA_UNSUPPORTED');
    this.sweep();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  device(id) { return parse(this.db.prepare('SELECT data FROM devices WHERE id=?').get(id)); }
  certificate(cert) {
    verifyCertificate(cert);
    const known = this.device(cert.id);
    if (known?.revokedAt) fail('DEVICE_REVOKED');
    if (known && known.certificate.boxKey !== cert.boxKey) fail('IDENTITY_CHANGED');
    return known;
  }
  host(id) { const row = this.device(id); if (!row || row.revokedAt || row.role !== 'host') fail('HOST_REQUIRED'); return row; }
  provisionHost(cert) {
    verifyCertificate(cert);
    return this.transaction(() => {
      const known = this.certificate(cert);
      if (!known && this.count('devices') >= this.limits.devices) fail('DEVICE_CAPACITY');
      this.putDevice({ id: cert.id, certificate: cert, role: 'host', revokedAt: null });
      return { id: cert.id, role: 'host' };
    });
  }
  putDevice(row) { this.db.prepare('INSERT INTO devices VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(row.id, JSON.stringify(row)); }
  count(table) { return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count); }
  createInvitation(hostId, input) {
    const spec = inviteSpec(input, this.limits);
    return this.transaction(() => {
      this.host(hostId);
      if (this.count('invitations') >= this.limits.invitations || this.db.prepare("SELECT COUNT(*) AS count FROM invitations WHERE json_extract(data,'$.hostId')=?").get(hostId).count >= 32) fail('INVITE_CAPACITY');
      const code = `BZZY-${spec.kind}-${random()}`;
      const row = { id: random(), hostId, spec, expiresAt: this.now() + spec.ttlSeconds * 1000, state: 'open', claimId: null, recipient: null };
      this.db.prepare('INSERT INTO invitations VALUES (?,?,?)').run(row.id, hash(code), JSON.stringify(row));
      return { code, invitationId: row.id, expiresAt: row.expiresAt, spec };
    });
  }
  invitation(id) { return parse(this.db.prepare('SELECT data FROM invitations WHERE id=?').get(id)); }
  saveInvitation(row) { this.db.prepare('UPDATE invitations SET data=? WHERE id=?').run(JSON.stringify(row), row.id); }
  claim(code, cert, isOnline) {
    importCode(code); this.certificate(cert);
    return this.transaction(() => {
      const row = parse(this.db.prepare('SELECT data FROM invitations WHERE code_hash=?').get(hash(code)));
      if (!row) fail('INVITE_UNAVAILABLE');
      if (row.expiresAt <= this.now()) fail('INVITE_EXPIRED');
      if (row.state !== 'open') fail('INVITE_UNAVAILABLE');
      this.host(row.hostId);
      if (row.hostId === cert.id) fail('INVALID_RECIPIENT');
      if (!isOnline(row.hostId)) fail('HOST_OFFLINE');
      row.state = 'pending'; row.claimId = random(); row.recipient = cert;
      this.saveInvitation(row);
      return row;
    });
  }
  claimStatus(claimId, deviceId) {
    opaque(claimId);
    const row = parse(this.db.prepare("SELECT data FROM invitations WHERE json_extract(data,'$.claimId')=?").get(claimId));
    if (!row || ![row.hostId, row.recipient?.id].includes(deviceId)) fail('CLAIM_UNAVAILABLE');
    if (row.expiresAt <= this.now() && row.state !== 'approved') fail('INVITE_EXPIRED');
    return row;
  }
  decide(hostId, claimId, approve, confirmedRecipient) {
    return this.transaction(() => {
      this.host(hostId);
      const row = this.claimStatus(claimId, hostId);
      if (row.hostId !== hostId || row.state !== 'pending') fail('CLAIM_UNAVAILABLE');
      if (!approve) { row.state = 'denied'; this.saveInvitation(row); return { invitation: row }; }
      verifyCertificate(confirmedRecipient);
      if (confirmedRecipient.id !== row.recipient.id || confirmedRecipient.boxKey !== row.recipient.boxKey) fail('RECIPIENT_MISMATCH');
      const known = this.certificate(row.recipient);
      if (!known && this.count('devices') >= this.limits.devices) fail('DEVICE_CAPACITY');
      if (this.count('grants') >= this.limits.grants) fail('GRANT_CAPACITY');
      if (!known) this.putDevice({ id: row.recipient.id, certificate: row.recipient, role: 'client', revokedAt: null });
      const grant = { id: random(), hostId, recipientId: row.recipient.id, spec: row.spec,
        expiresAt: this.now() + row.spec.grantTtlSeconds * 1000, revokedAt: null };
      this.db.prepare('INSERT INTO grants VALUES (?,?)').run(grant.id, JSON.stringify(grant));
      row.state = 'approved'; row.grantId = grant.id; this.saveInvitation(row);
      return { invitation: row, grant };
    });
  }
  activeGrant(id, deviceId) {
    opaque(id);
    const grant = parse(this.db.prepare('SELECT data FROM grants WHERE id=?').get(id));
    if (!grant || ![grant.hostId, grant.recipientId].includes(deviceId) || grant.revokedAt || grant.expiresAt <= this.now()) fail('GRANT_UNAVAILABLE');
    for (const peer of [grant.hostId, grant.recipientId]) if (!this.device(peer) || this.device(peer).revokedAt) fail('GRANT_UNAVAILABLE');
    return grant;
  }
  grantsFor(deviceId) {
    return this.db.prepare("SELECT data FROM grants WHERE json_extract(data,'$.hostId')=? OR json_extract(data,'$.recipientId')=?").all(deviceId, deviceId)
      .map(parse).filter(g => !g.revokedAt && g.expiresAt > this.now() && !this.device(g.hostId)?.revokedAt && !this.device(g.recipientId)?.revokedAt);
  }
  revokeGrant(hostId, id) {
    const grant = this.activeGrant(id, hostId);
    if (grant.hostId !== hostId) fail('HOST_REQUIRED');
    grant.revokedAt = this.now();
    this.db.prepare('UPDATE grants SET data=? WHERE id=?').run(JSON.stringify(grant), id);
    return grant;
  }
  revokePeer(hostId, peerId) {
    this.host(hostId); opaque(peerId);
    return this.transaction(() => this.grantsFor(hostId).filter(g => g.hostId === hostId && g.recipientId === peerId).map(g => this.revokeGrant(hostId, g.id)));
  }
  revokeDevice(id) {
    opaque(id); const row = this.device(id); if (!row) fail('DEVICE_UNAVAILABLE');
    row.revokedAt = this.now(); this.putDevice(row); return { id, revoked: true };
  }
  sweep() {
    const now = this.now();
    this.db.prepare("DELETE FROM invitations WHERE json_extract(data,'$.expiresAt')<?").run(now - 3600000);
    this.db.prepare("DELETE FROM grants WHERE json_extract(data,'$.expiresAt')<? OR (json_extract(data,'$.revokedAt') IS NOT NULL AND json_extract(data,'$.revokedAt')<?)").run(now - 60000, now - 60000);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  close() { this.db.close(); }
}
