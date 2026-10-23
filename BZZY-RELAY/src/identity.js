import sodium from 'libsodium-wrappers';
import fs from 'node:fs';
import { b64, fail, hash, record, VERSION } from './protocol.js';

await sodium.ready;
const encode = bytes => Buffer.from(bytes).toString('base64url');
const binding = boxKey => `BZZY-RELAY encryption key v1\n${boxKey}`;
export function createIdentity() {
  const signing = sodium.crypto_sign_keypair(), encryption = sodium.crypto_box_keypair();
  const signKey = encode(signing.publicKey), boxKey = encode(encryption.publicKey);
  return { certificate: { v: VERSION, id: hash(signKey), signKey, boxKey,
    signature: encode(sodium.crypto_sign_detached(binding(boxKey), signing.privateKey)) },
    signingSecret: encode(signing.privateKey), boxSecret: encode(encryption.privateKey) };
}
export function verifyCertificate(cert) {
  record(cert, ['v', 'id', 'signKey', 'boxKey', 'signature']);
  if (cert.v !== VERSION || cert.id !== hash(cert.signKey)) fail('INVALID_IDENTITY');
  b64(cert.boxKey, 32);
  if (!sodium.crypto_sign_verify_detached(b64(cert.signature, 64), binding(cert.boxKey), b64(cert.signKey, 32))) fail('INVALID_IDENTITY');
  return cert;
}
export function sign(identity, text) { return encode(sodium.crypto_sign_detached(text, b64(identity.signingSecret, 64))); }
export function verify(cert, text, signature) { return sodium.crypto_sign_verify_detached(b64(signature, 64), text, b64(cert.signKey, 32)); }
export const authText = (audience, challenge, epoch) => `BZZY-RELAY authentication v1\n${audience}\n${challenge}\n${epoch}`;
export const presenceText = (device, epoch) => `BZZY-RELAY presence v1\n${device}\n${epoch}`;
export function verifyPresence(cert, presence) {
  record(presence, ['epoch', 'signature']); b64(presence.epoch, 32);
  if (!verify(cert, presenceText(cert.id, presence.epoch), presence.signature)) fail('INVALID_PRESENCE');
  return presence;
}
export function saveIdentity(file, identity) {
  // Never overwrite an existing device key or follow a link.
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(identity) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function loadIdentity(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) fail('PRIVATE_FILE_REQUIRED');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  verifyCertificate(value.certificate);
  const signing = sodium.crypto_sign_seed_keypair(b64(value.signingSecret, 64).subarray(0, 32));
  if (encode(signing.publicKey) !== value.certificate.signKey || encode(signing.privateKey) !== value.signingSecret ||
    encode(sodium.crypto_scalarmult_base(b64(value.boxSecret, 32))) !== value.certificate.boxKey) fail('INVALID_IDENTITY');
  return value;
}

export function seal(identity, peer, envelope) {
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  return { nonce: encode(nonce), ciphertext: encode(sodium.crypto_box_easy(JSON.stringify(envelope), nonce, b64(peer.boxKey, 32), b64(identity.boxSecret, 32))) };
}
export function open(identity, peer, box) {
  try {
    return JSON.parse(sodium.to_string(sodium.crypto_box_open_easy(b64(box.ciphertext), b64(box.nonce, 24), b64(peer.boxKey, 32), b64(identity.boxSecret, 32))));
  } catch { fail('DECRYPTION_FAILED'); }
}

// A new endpoint-generated epoch on every socket prevents replay across reconnects.
// Entries are not evicted while valid: capacity fails closed.
export class ReplayGuard {
  constructor({ maxEntries = 4096, now = Date.now } = {}) { this.entries = new Map(); this.maxEntries = maxEntries; this.now = now; }
  accept(key, expiresAt) {
    const now = this.now();
    for (const [id, expiry] of this.entries) if (expiry <= now) this.entries.delete(id);
    if (this.entries.has(key)) fail('REPLAY');
    if (this.entries.size >= this.maxEntries) fail('REPLAY_CAPACITY');
    this.entries.set(key, expiresAt);
  }
}
