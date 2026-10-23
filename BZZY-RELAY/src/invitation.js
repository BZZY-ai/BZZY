import { verifyCertificate } from './identity.js';
import QRCode from 'qrcode';
import { VERSION, b64, fail, importCode, integer, record, relayUrl } from './protocol.js';

const pairRelay = 'wss://190.114.255.214/v1/socket';
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes) {
  let output = '', value = 0, bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; output += base32Alphabet[(value >>> bits) & 31]; }
    value &= (1 << bits) - 1;
  }
  if (bits) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

// A PAIR-only QR for the app's configured Relay. The pinned host fingerprint
// provides the same trust anchor as manual code + fingerprint entry. The Relay
// still supplies/verifies the certificate and enforces expiry and one use.
export function encodePairingQR(invitation) {
  encodeInvitation(invitation);
  if (invitation.relay !== pairRelay || !invitation.code.startsWith('BZZY-PAIR-')) fail('INVALID_INVITATION');
  return 'BZZY:P:' + base32(Buffer.concat([b64(invitation.code.slice(10), 32), b64(invitation.sender.id, 32)]));
}
export function decodePairingQR(text) {
  if (typeof text !== 'string' || !/^BZZY:P:[A-Z2-7]{103}$/.test(text)) fail('INVALID_INVITATION');
  const encoded = text.slice(7), bytes = []; let value = 0, bits = 0;
  for (const char of encoded) {
    value = (value << 5) | base32Alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
    value &= (1 << bits) - 1;
  }
  const decoded = Buffer.from(bytes);
  if (decoded.length !== 64 || value !== 0 || base32(decoded) !== encoded) fail('INVALID_INVITATION');
  return { relay: pairRelay, code: 'BZZY-PAIR-' + decoded.subarray(0, 32).toString('base64url'), fingerprint: decoded.subarray(32).toString('base64url') };
}

// QR content is plain BZZY protocol text. It is never a navigable invitation URL.
export function encodeInvitation({ relay, code, sender, expiresAt }, { allowInsecureLocal = false } = {}) {
  relayUrl(relay, allowInsecureLocal); importCode(code); verifyCertificate(sender); integer(expiresAt, 1, Number.MAX_SAFE_INTEGER);
  return 'BZZY:INVITE:1:' + Buffer.from(JSON.stringify({ v: VERSION, relay, code, sender, expiresAt })).toString('base64url');
}
export function decodeInvitation(qr, { allowInsecureLocal = false, now = Date.now() } = {}) {
  if (typeof qr !== 'string' || qr.length > 4096 || !/^BZZY:INVITE:1:[A-Za-z0-9_-]+$/.test(qr)) fail('INVALID_INVITATION');
  let value; try { value = JSON.parse(Buffer.from(qr.slice(14), 'base64url').toString('utf8')); } catch { fail('INVALID_INVITATION'); }
  record(value, ['v', 'relay', 'code', 'sender', 'expiresAt']);
  if (value.v !== VERSION) fail('VERSION_UNSUPPORTED');
  relayUrl(value.relay, allowInsecureLocal); importCode(value.code); verifyCertificate(value.sender);
  integer(value.expiresAt, 1, Number.MAX_SAFE_INTEGER);
  if (value.expiresAt <= now) fail('INVITE_EXPIRED');
  return value; // Caller still confirms the sender fingerprint; a QR alone is not trust.
}

export async function renderInvitationQR(invitation, { terminal = false, format = 'svg', allowInsecureLocal = false } = {}) {
  const text = encodeInvitation(invitation, { allowInsecureLocal });
  if (!terminal && format === 'png') return QRCode.toBuffer(text, { type: 'png', errorCorrectionLevel: 'M', margin: 4, scale: 6 });
  if (terminal && invitation.relay === pairRelay && invitation.code.startsWith('BZZY-PAIR-')) {
    return QRCode.toString(encodePairingQR(invitation), { type: 'terminal', small: true, errorCorrectionLevel: 'L', margin: 4 });
  }
  return QRCode.toString(text, { type: terminal ? 'terminal' : 'svg', small: terminal, errorCorrectionLevel: 'M', margin: 4 });
}
