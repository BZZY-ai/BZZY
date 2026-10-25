import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '../src/identity.js';
import { random } from '../src/protocol.js';
import { decodeInvitation, encodeInvitation, decodePairingQR, encodePairingQR, renderInvitationQR } from '../src/invitation.js';
import QRCode from 'qrcode';

test('compact pairing QR preserves code and pinned fingerprint and fits version 4', async () => {
  const invitation = { relay: 'wss://190.114.255.214/v1/socket', code: `BZZY-PAIR-${random()}`,
    sender: createIdentity().certificate, expiresAt: Date.now() + 60000 };
  const compact = encodePairingQR(invitation);
  assert.equal(compact.length, 110); assert.match(compact, /^BZZY:P:[A-Z2-7]+$/);
  assert.deepEqual(decodePairingQR(compact), { relay: invitation.relay, code: invitation.code, fingerprint: invitation.sender.id });
  assert.equal(QRCode.create(compact, { errorCorrectionLevel: 'L' }).modules.size, 33);
  const lines = (await renderInvitationQR(invitation, { terminal: true })).split('\n')
    .map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).filter(Boolean);
  assert.equal(lines.length, 18); assert.equal(Math.max(...lines.map(line => line.length)), 35);
  assert.match(await renderInvitationQR(invitation), /^<svg\s/);
  for (const bad of [compact.toLowerCase(), compact + '=', compact.slice(0, -1), compact.slice(0, -1) + 'B']) {
    assert.throws(() => decodePairingQR(bad), { code: 'INVALID_INVITATION' });
  }
  assert.throws(() => encodePairingQR({ ...invitation, relay: 'wss://custom.example.invalid/v1/socket' }), { code: 'INVALID_INVITATION' });
  assert.throws(() => encodePairingQR({ ...invitation, code: invitation.code.replace('PAIR', 'AGENT') }), { code: 'INVALID_INVITATION' });
});

test('compact pair decoder matches the cross-language bytes 0 through 63 vector', () => {
  assert.deepEqual(decodePairingQR('BZZY:P:AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSAIJCEMSCKJRHFAUSUKZMFUXC6MBRGIZTINJWG44DSOR3HQ6T4PY'), {
    relay: 'wss://190.114.255.214/v1/socket', code: 'BZZY-PAIR-AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    fingerprint: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8' });
});

test('PNG invitations retain the v1 payload and SVG/terminal rendering remains available', async () => {
  const invitation = { relay: 'wss://relay.example.invalid/v1/socket', code: `BZZY-PAIR-${random()}`,
    sender: createIdentity().certificate, expiresAt: Date.now() + 60000 };
  const qr = encodeInvitation(invitation);
  assert.deepEqual(decodeInvitation(qr), { v: 1, ...invitation });
  const png = await renderInvitationQR(invitation, { format: 'png' });
  assert.ok(Buffer.isBuffer(png));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20));
  assert.ok(png.readUInt32BE(16) >= 300, 'The full invitation needs a camera-readable raster.');
  assert.equal(png.readUInt32BE(16) % 6, 0);
  assert.match(await renderInvitationQR(invitation), /^<svg\s/);
  const terminal = await renderInvitationQR(invitation, { terminal: true });
  assert.equal(typeof terminal, 'string'); assert.match(terminal, /\u001b\[/);
  assert.equal(await renderInvitationQR(invitation, { terminal: true, format: 'png' }), terminal);
  assert.equal(encodeInvitation(invitation), qr);
});

test('PNG rendering preserves the invitation transport validation', async () => {
  const invitation = { relay: 'ws://public.example.invalid/v1/socket', code: `BZZY-PAIR-${random()}`,
    sender: createIdentity().certificate, expiresAt: Date.now() + 60000 };
  await assert.rejects(renderInvitationQR(invitation, { format: 'png', allowInsecureLocal: true }), { code: 'TLS_REQUIRED' });
});

test('Library codes retain signed invitation identity and cannot become compact pairing codes', async () => {
  const invitation = { relay: 'wss://relay.example.invalid/v1/socket', code: `BZZY-LIBRARY-${random()}`,
    sender: createIdentity().certificate, expiresAt: Date.now() + 60000 };
  const qr = encodeInvitation(invitation);
  assert.deepEqual(decodeInvitation(qr), { v: 1, ...invitation });
  assert.throws(() => encodePairingQR(invitation), { code: 'INVALID_INVITATION' });
  assert.match(await renderInvitationQR(invitation), /^<svg\s/);
});
