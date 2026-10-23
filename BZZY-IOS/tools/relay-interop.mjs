// Uses disposable, PUBLIC test seeds only. Never reads device identities or account files.
import sodium from '../../BZZY-RELAY/node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js';
import { verifyCertificate, seal, open } from '../../BZZY-RELAY/src/identity.js';
import { createHash } from 'node:crypto';
await sodium.ready;
const encode = bytes => Buffer.from(bytes).toString('base64url');
const signing = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(17));
const encryption = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(29));
const signKey = encode(signing.publicKey), boxKey = encode(encryption.publicKey);
const identity = { certificate: { v: 1, id: createHash('sha256').update(signKey).digest('base64url'), signKey, boxKey,
  signature: encode(sodium.crypto_sign_detached(`BZZY-RELAY encryption key v1\n${boxKey}`, signing.privateKey)) },
  signingSecret: encode(signing.privateKey), boxSecret: encode(encryption.privateKey) };
let source = '';
for await (const chunk of process.stdin) source += chunk;
const request = JSON.parse(source);
if (request.op === 'certificate') process.stdout.write(JSON.stringify({ certificate: identity.certificate }));
else if (request.op === 'roundtrip') {
  const peer = verifyCertificate(request.certificate);
  process.stdout.write(JSON.stringify({ received: open(identity, peer, request.box), box: seal(identity, peer, {test:'Node to Swift',v:1}) }));
} else process.exit(1);
