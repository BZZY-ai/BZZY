# Relay protocol v1

## Transport and identity

Connect to `/v1/socket` over WSS using subprotocol `bzzy-relay.v1`. Compression is
disabled. Browser origins, query credentials and invitation URLs are rejected.
The production listener is loopback-only behind TLS. Plain WS is permitted only
when explicitly enabled for loopback tests. Public `/healthz` reveals just health
and protocol version. There is no network administration/provisioning endpoint.

Every frame has `v: 1`. An RPC has an opaque `id`, `op`, and strictly allowlisted
fields. A reply has `id`, `ok` and `result` or a fixed `error.code`. Server events
have `event` and `data`. Unknown versions, operations and extra RPC fields fail.
The reference SDK is Node-based. BZZY-IOS also implements this wire format with
compatible cryptographic operations and device-only Keychain storage; the native
client has local real-protocol integration tests against Core and Relay.

A certificate contains `v`, `id`, `signKey`, `boxKey`, `signature`. Keys are
unpadded canonical base64url. `id` is SHA-256(base64url Ed25519 public key), itself
base64url. A separate Curve25519 encryption key is bound to the Ed25519 identity
with a detached signature over UTF-8:

```text
BZZY-RELAY encryption key v1\n<boxKey>
```

Each socket receives a fresh 256-bit challenge with the configured public WSS
audience. The client checks the exact audience and signs:

```text
BZZY-RELAY authentication v1\n<audience>\n<challenge>\n<epoch>
```

The client creates a new random 256-bit receive epoch per connection and signs
`BZZY-RELAY presence v1\n<deviceId>\n<epoch>`. Auth contains the certificate,
authentication signature and `{epoch, signature}` presence. Only one active
socket per identity is allowed. An unknown identity may authenticate as a
candidate and claim a code, but cannot create invitations or route traffic.
Provisioned hosts can create invitations; candidates become registered clients
only after explicit host approval. Provisioning is an operator action through
local CLI/SSH with public certificates. Revoked identities cannot re-register.

## Invitation and grant operations

| Operation | Fields | Authorization/result |
| --- | --- | --- |
| `invite.create` | `spec` | Provisioned host; returns private code, invitation ID, expiry |
| `invite.claim` | `code` | Authenticated candidate/client; atomically reserves one open code |
| `invite.status` | `claimId` | Claim's host/recipient only; pending/denied/approved/revoked |
| `invite.decide` | `claimId`, `approve`, `recipient` when approving | Host confirms exact recipient certificate before grant creation |
| `invite.revoke` | `invitationId` | Issuing host; prevents redemption, does not recall a portable copy |
| `grant.list` | — | Only grants involving this device |
| `grant.inspect` | `grantId` | Active participant; peer certificate, signed presence and online state |
| `grant.revoke` | `grantId` | Issuing host; future routing denied |
| `peer.revoke` | `peerId` | Revokes this host's grants to that recipient, not other hosts' grants |
| `route.send` | `grantId`, `messageId`, `box` | Active participant, online peer; ciphertext only |
| `delivery.ack` | `deliveryId` | That delivery's active recipient only |

`spec` has `kind` (`PAIR`, `AGENT`, `TERMINAL`), `mode` (`pair`, `portable`,
`live`), opaque `resource`, `actions`, `ttlSeconds`, `grantTtlSeconds`. PAIR must
use pair mode; imports must use portable/live. Portable allows only `import`.
Pair/live defaults to `observe`; control actions require `claim`. These fields
bound Relay routing records; **they are not trusted local runtime permissions**.
An encrypted channel can carry arbitrary text, so a host gateway independently
enforces locally approved scope on every subscription and command.

Portable grant lifetimes are bounded to one hour; their default remains five
minutes. Code expiry and grant expiry are independent. Core project transfer
uses a ten-minute code and a one-hour approved transfer grant. This extended
portable lifetime requires the updated Relay implementation.

Codes contain 32 random bytes (256 bits) and expire in 10 minutes by default,
at most one hour. Claiming consumes the code even if denied. Repeated/racing
claims fail; redemption requires the originating host to be online. Codes are
stored only as SHA-256 lookups. Approval pins the exact recipient before any
grant exists. Denied, used and revoked codes return `INVITE_UNAVAILABLE` on
reclaim; retained expired records return `INVITE_EXPIRED`. Unknown/old pruned
records also return `INVITE_UNAVAILABLE`. No code is placed in errors/audit logs.

QR text is `BZZY:INVITE:1:<base64url JSON>` with `v`, `relay` (service endpoint,
not a redemption URL), `code`, `sender` public certificate, `expiresAt`. No
permanent secret is included. QR renderers produce SVG or terminal output locally
without a third-party QR service. Both endpoints must verify fingerprints using
trusted displays before approving/pinning; code possession alone is insufficient.

The relay cannot authenticate an unknown human on behalf of the sender. A
compromised Relay can misrepresent discovery, grant metadata and delivery
receipts, suppress traffic, or deny service. Pinning both peers outside Relay
and enforcing local gateway grants is essential to this trust model.

## End-to-end payloads and replay

Endpoint encryption uses libsodium `crypto_box_easy`/`crypto_box_open_easy`
(Curve25519, XSalsa20, Poly1305) with random 24-byte nonces and distinct signing/
encryption keys. The service receives only `{nonce, ciphertext}` plus routing
metadata. See [libsodium authenticated encryption](https://libsodium.gitbook.io/doc/public-key_cryptography/authenticated_encryption).
This initial static-key protocol has **no forward secrecy or ratchet**. Rotating
an encryption key requires a new identity and explicit reprovisioning/pairing.
It has functional negative tests, not an independent cryptographic audit.

Plaintext is JSON containing `v`, `from`, `to`, `grantId`, `messageId`,
`receiverEpoch`, `expiresAt`, `payload`. The receiver decrypts using its pinned
sender key, compares every routing field, requires its current receive epoch,
and rejects expired messages or lifetimes exceeding 60 seconds, allowing at most
five seconds of clock skew. Replay records include that allowance. It tracks up to
4096 message IDs until expiration and fails closed at capacity. A fresh endpoint
epoch prevents a captured message from being accepted after reconnect/restart,
even if Relay replays old signed presence. Endpoint clocks need ordinary time
synchronization. Core idempotency still protects explicit command retries that
create new transport messages.

`route.send` returns `forwarded` after enqueueing the receiver's socket frame.
`delivery.received` follows recipient decryption/replay validation and its
transport receipt. No receipt establishes application success. Missing receipts
produce `delivery.uncertain`; disconnects also discard transient deliveries.
The SDK does not queue offline content or resend RPCs after disconnect/timeout.
For trusted execution acknowledgments, send an encrypted application response
containing Core's request/result ID. Preserve evidence and verification status.

## Resource and operational bounds

Defaults: 64 WebSockets, 32 per proxy peer IP, 64 KiB frames, at most 45 KiB
ciphertext, 256 KiB buffered per connection, 8 MiB summed WebSocket send buffers,
1024 pending receipts, 15-second receipt timeout, 10-second authentication timeout,
15-second ping heartbeat, 240 RPC/minute/device and 120 upgrades/minute/peer IP.
Pre-auth IP buckets cap at 256 and refuse overflow. The proxy address is used;
untrusted forwarded-IP headers are ignored. Thus proxied connections share the
handshake quota. Authenticated limits remain per device across reconnects.
The SDK caps pending RPCs at 64 and outbound frames/buffers to the same defaults.

An additional bounded budget of 4,096 RPCs/minute per participant/grant applies
only to active `AGENT`/`portable` or `TERMINAL`/`portable` grants with the sole action `import` or
explicitly approved `PAIR`/`pair` grants, and
only to `grant.inspect`, `route.send`, or acknowledgment of that participant's
actual pending delivery. Guessed/revoked/foreign grants, other kinds/modes,
authentication, invitation creation/claims and enumeration keep the original
budget. This permits paced encrypted ZIP chunks and live Core events/metrics
without raising anonymous or discovery limits. Core separately limits commands,
cached metrics and valid event acknowledgments after decryption. The source Core
additionally permits one approved project
transfer at a time and paces 16 KiB chunks to at most sixteen per second.

Durable limits: 256 devices, 512 invitation records, 32 invitation records/host,
512 grants, 32 MiB SQLite main file at the default 4 KiB page size. Expired
invitations persist at most an extra hour for clear errors; revoked/expired grants
are pruned after a minute. Sweep/checkpoint runs each minute; SQLite reuses freed
pages. Device records are public keys and revocation state, retained within the
device quota. No encrypted payloads, prompts, auth proofs or raw codes are stored.
The 8 MiB bound is for WebSocket send buffers; OS sockets, TLS and process memory
have additional overhead and service-level limits. Monitor all layers on the VPS.

## Native alert transport (additive v1 operations)

`push.register` accepts only the authenticated phone's `enabled`, `deviceToken`
and `environment`, plus the explicit `grantIds` for its saved computers. Disabling removes the Relay token. An active PAIR recipient
is required. `push.status` accepts only an environment and returns provider
configuration readiness to an authenticated host. `push.enqueue` accepts the
host's `grantId`, immutable `notificationId`, environment, occurrence time and a
strict bounded APNs alert/navigation schema. There is no supplied recipient,
token, endpoint, signing credential, arbitrary metadata or execution action.
The active grant binds recipient and host. Core remains responsible for local
session/Agent scope authorization, verified outcomes and preview sanitization.

These native alerts are a documented exception to opaque application routing:
Relay can see the bounded alert preview and opaque navigation hints. It never
reads or persists encrypted conversations. The private SQLite queue rechecks
grants and phone opt-in at dispatch; revoked/rotated bindings fail closed.
Retries of an identical notification return its existing queued/sent/failed/
uncertain state. Reusing an ID with different content is rejected. The queue
expires after one day, removes dispatched preview text and never blindly
retries an uncertain APNs dispatch.
