# BZZY Relay

Small private connectivity service for BZZY. The home host and authorized devices
make outbound WebSocket connections to a TLS proxy. Relay routes authenticated,
end-to-end encrypted messages. It runs no models, agents, shell commands, provider
integrations or Core runtime. All implementation files are in this directory.

Server deployment targets: **Debian 13 and Ubuntu Server 24.04 LTS**, Node >=24.
Live endpoint: `wss://190.114.255.214/v1/socket`; health:
`https://190.114.255.214/healthz`. The Debian deployment and public encrypted
transport were verified, including a full VPS reboot. See
[deployment guide](deploy/README.md) and [platform support](deploy/PLATFORMS.md).
Core automatically registers its authenticated public host certificate before
pairing. Reinstalling with the same private Core state reuses that host record. No permanent credentials are
embedded in this package or these addresses.

## Run and verify

Use Node.js **24 or newer**. This README describes the implemented version, 0.1.0.

```sh
cd BZZY-RELAY
npm ci --ignore-scripts
npm run check
npm test
npm run demo
npm run measure
```

The demo uses disposable identities and an in-memory database on loopback. It
generates an actual QR SVG, pairs two endpoints with explicit fixture identity
confirmation, delivers an encrypted event, and revokes access. It never connects
to the CLI or real accounts. `measure` reports local RSS, CPU and delivery counts;
it does not establish capacity on the intended 2 GB VPS.

## Implemented

- Ed25519 device authentication using fresh, socket-bound challenges.
- Separate signed encryption keys and libsodium authenticated public-key boxes.
- Explicit peer key pinning, signed connection presence, encrypted routing binding,
  message expiration and bounded replay rejection across reconnects.
- Versioned QR payloads, SVG/terminal QR rendering, and 256-bit random
  `BZZY-PAIR-…`, `BZZY-AGENT-…`, `BZZY-TERMINAL-…` and `BZZY-LIBRARY-…` codes.
- Online-sender, single-use atomic claims, confirmation of the exact recipient,
  denial, expiry and revocation. PAIR and portable/live import purposes differ.
- Persistent public device records, hashed code lookups and scoped transport
  grants using SQLite. No application-payload persistence or offline conversation store-and-forward. A separate, bounded goal-alert queue supports background Apple push.
- Heartbeats, connection status, reconnect with capped jittered backoff,
  bounded requests/buffers/queues, delivery receipts and uncertain-delivery states.
- Per-device request limits, bounded handshake rate tracking, connection limits,
  sanitized audit events, graceful shutdown and non-root deployment templates.

The native iOS pairing/import screens, portable package validation/materialization,
Core's local gateway and the guided home installer belong to their respective
products and are **not implemented here**. An encrypted payload is not proof of a
safe portable package. Relay grants are routing records, not Core permissions.
No end-user import or remote execution is claimed complete by this transport.

The native and Node clients share concurrent in-flight grant inspections; they
still validate fresh signed presence rather than caching an old connection epoch.
Transient transport-receipt failures force reconnection and application cursor
recovery. Invalid encrypted content stays rejected. Approved PAIR data traffic
uses a separately bounded 4096/minute per-device/grant budget; administrative
requests retain their 240/minute budget. This accounting never grants access.

## Background goal alerts

Current iOS registers its own APNs token using authenticated `push.register`.
Only hosts with an active PAIR grant can queue an alert for that bound phone;
hosts cannot supply a token or arbitrary destination. Core authorizes the exact
session/Agent scope and sanitizes previews first. Relay rechecks the PAIR grant,
phone preference and token at dispatch. Apple signing credentials belong only
to the service account's private `STATE_DIRECTORY/push/apns.json`; see
[push configuration and delivery limits](../BZZY-CORE/docs/PUSH.md).

The durable queue holds at most 4,096 receipts, with 256 pending alerts per host,
a one-day lifetime and at most eight dispatches per worker pass. Known failures
before any notification POST (including DNS, TLS and connection timeout) and
explicit temporary Apple rejections retry with backoff capped at five minutes,
until the event or grant expires. Restart preserves the same alert identity and
backoff; an eight-attempt cutoff no longer discards a still-valid queued alert.
Immutable request IDs deduplicate Core retries and survive restarts. Relay sees
bounded notification titles/previews and opaque routing hints; encrypted chats,
Core owner keys and model-provider credentials remain outside this service.
Dispatched preview text is removed. An Apple acceptance is distinct from a
confirmed phone display; uncertain dispatch is preserved rather than repeated.
Once a notification POST may have reached Apple, a timeout, lost response or
interrupted dispatch remains uncertain and is never automatically replayed.
Authorization, current device binding and preferences are rechecked before
every eligible attempt. Expiry, revocation and Apple's/iOS delivery behavior
still limit delivery; the service cannot guarantee that the phone displays an alert.
The title allowlist also accepts `Full debug export ready` and
`Full debug export failed`, with an optional safe alias. These alerts require
the existing exact terminal resource/session routing hint; Agent/update routes
and new metadata fields are rejected. Deploy this Relay build before enabling
detached-export alerts in Core. No pairing or encrypted application format changes.
Bounded queue reads prioritize due alerts for the configured Apple environment,
so older entries waiting for backoff or another environment cannot hide ready
alerts for a different computer. A stream ending without an explicit final Apple
response remains uncertain, including HTTP/2 resets that report no stream error.

## Endpoint integration

Generate identities on the endpoints, keeping private identity files there:

```sh
umask 077
node bin/relay.js identity-create --file /private/device.identity.json > /private/device.public.json
```

Core uses `host.register` after signed socket authentication. This bounded
operation registers only the authenticated socket’s own public certificate,
reuses its device ID and rejects revoked identities. It grants no access to other
hosts or Core sessions: QR/code claiming and fingerprint approval remain required.
No endpoint secret, Core token or provider credential is uploaded.

The existing operator provisioning command remains available:

```sh
node bin/relay.js host-add --state /var/lib/bzzy-relay --certificate /private/host.public.json
node bin/relay.js serve --state /var/lib/bzzy-relay --audience wss://YOUR_HOST/v1/socket
```

Run `serve` as the dedicated service user; it refuses root. See
[deployment instructions](deploy/README.md) for TLS and service setup.

```js
import { RelayClient } from './src/client.js';
import { loadIdentity } from './src/identity.js';
import { renderInvitationQR } from './src/invitation.js';

const host = new RelayClient({
  url: 'wss://YOUR_HOST/v1/socket',
  identity: loadIdentity('/private/host.identity.json')
});
await host.connect();
const invitation = await host.createInvitation({
  kind: 'PAIR', resource: 'opaque_resource', actions: ['observe']
});
const svg = await renderInvitationQR({
  relay: host.url, code: invitation.code,
  sender: host.identity.certificate, expiresAt: invitation.expiresAt
});
// Display SVG/code only in the sender's private UI. Do not log either.
```

On the recipient endpoint, decode the QR (or enter the code inside BZZY), confirm
the sender fingerprint from a trusted display, then call `claim(code)`. The
sender receives `invite.requested` with the recipient's public certificate and
requested scope. Compare the recipient fingerprint with its own trusted display;
only after approval call `host.approve(claimId, confirmedRecipientCertificate)`.
The recipient calls `trustPeer(confirmedHostCertificate)`. A certificate delivered
by Relay or present in an unverified QR does not establish trust by itself.

After approval, `send(grantId, payload)` encrypts to the pinned peer. `message`
emits the decrypted payload at that peer. `grant.list`/`grant.inspect` report
online status; `revokeGrant` and `revokePeer` stop future routing. The host must
also revoke the matching local gateway authorization and subscriptions.

Portable shares use `kind: 'AGENT'` or `'TERMINAL'`, `mode: 'portable'` and only
`actions: ['import']`. They do not pair an administrative client. Live shares use
`mode: 'live'`, an identified opaque resource and explicit actions, defaulting to
`['observe']`. Imported behavior stays inactive until the recipient's local
review and authorization; account bindings remain local to that recipient.

Library shares use `kind: 'LIBRARY'`, portable mode and the sole `import` action.
Live mode, pairing and execution actions are rejected for this kind. Updated
Core/CLI use the same encrypted chunk transport to review and install missing
skills, specialist agents, workflows and saved goal text. The deployed Relay
must be updated for Library codes; no owner credential or model execution is
added here. See [Library sharing](../BZZY-CORE/docs/LIBRARY-SHARING.md).

## Existing CLI compatibility

Inspected runtime: `../BZZY-CLI/BZZY-CLI-TERMINAL/src/runtime.js`,
`session-access.js`, `database.js`, `api-client.js` and `docs/INTEGRATION.md`.
The actual runtime already supports session-scoped permissions, revocable grants,
input ownership/takeover, SQLite event cursors and idempotent execution/answer/
control requests. Its capability response currently advertises `relay: false`.
No existing source, API, execution lifetime or capability advertisement is changed.

The home gateway should use that API and scoped grants. Keep its owner credential
on the home host. Never forward arbitrary remote URLs, headers, environment
overrides or owner tokens. Authorize every remote operation using locally saved
device/resource/action grants, independent of Relay-supplied metadata. Preserve
the full event envelope, provenance, session ID and cursor inside the encrypted
payload; maintain separate processed cursors for each session.

Reconnect restores **transport only**. The SDK never resends application messages
or uncertain requests. Replay events from Core by processed cursor. Before any
explicit command retry, inspect Core's durable state and retain the same Core
idempotency key. `forwarded` and `delivery.received` describe transport; neither
means a command ran or a goal was verified.

See [protocol and trust boundaries](docs/PROTOCOL.md) and
[verification record](docs/VALIDATION.md). Security policy is inherited from
`../SECURITY.md`; its reusable generation preprompt is copied verbatim into
`assets/generation-security.txt` for future integration. This service does not
invoke an AI generator or execute imported instructions.

PAIR QR rendering for the configured BZZY Relay also supports the compact
`BZZY:P:` form: canonical unpadded uppercase RFC 4648 Base32 of the 32-byte
invitation token followed by the 32-byte pinned host fingerprint. This form
uses the recipient’s configured Relay, never an invitation URL; normal Relay
expiry, single-use claiming and both fingerprint confirmations still apply.
Full v1 JSON invitations, PNG/SVG rendering and sharing remain compatible.
