# Connect Core to deployed Relay v1

Core supplies the encrypted home-host gateway. It reuses
`@bzzy/relay` from the sibling Relay package, including its certificate/signature,
peer pinning, libsodium encryption, QR format and reconnect behavior. It does not
run another Relay server or LLM engine.

Production transport: `wss://190.114.255.214/v1/socket`, subprotocol
`bzzy-relay.v1`. TLS certificate and IP-address validation remain enabled. Device
identity pins are independent of the rotating TLS leaf certificate. All home
connections are outbound; Core's HTTP listener remains on loopback.

## Initial host setup

With Node 24+ and the current Core/CLI/Relay folders together:

```sh
cd BZZY-CORE
npm ci --ignore-scripts
node bin/bzzy-core.js relay init
```

`init` creates `$BZZY_HOME/relay/host.identity.json` (default `~/.bzzy/relay/`)
with mode 0600 inside private 0700 directories. It refuses permissive/symlinked
storage, never replaces an existing identity, and prints **only its public
certificate**. Send that public certificate to the independently authorized Relay
operator for `host-add`, following the [Relay deployment guide](../../BZZY-RELAY/deploy/README.md). Keep the private file on the
home host. There is no public enrollment API or permanent enrollment token.

Host enrollment is still an operator step in Relay v1. Core cannot turn a new
candidate identity into an enrolled host. `HOST_ENROLLMENT_REQUIRED` means that
step remains outstanding, even if TLS authentication succeeded.

For normal use after enrollment, open CLI Settings → Pair iPhone and create the
pairing QR/code there. That path uses the shared daemon's gateway; closing the
CLI view does not disconnect it. This own-phone flow requests full session
control, terminal discovery, on-demand Agent management and project sharing
without scope/permission pickers. Fingerprint confirmation, expiry and revocation
remain on its secondary screen. Programmatic scoped grants remain supported.
Existing grants do not gain those capabilities automatically.

The command-line examples below are an alternative foreground administrative
path. Use them only when the managed gateway is disconnected; one host identity
cannot run two gateways concurrently. Choose an existing session UUID
from the terminal.

For background Core work, first choose the default AI and create an idle context
with `bzzy-core assistant context WORKSPACE`; use its `contextId` in place of the
terminal session UUID below. See [Core assistant setup](ASSISTANT.md). This grants
no new project/account access by itself. Pair the chosen session/context with:

```sh
node bin/bzzy-core.js relay pair SESSION_UUID
```

Run this in a private interactive terminal and keep it open while using this
foreground gateway. The command starts the shared Core execution daemon if
needed, connects its own foreground gateway, and displays a versioned PAIR QR
plus an expiring code. It defaults to observing exactly that session, with child-session
inheritance disabled. Codes are returned to the private setup UI and are never
saved in Core records, routine status files or audit events.

The recipient generates its own identity, confirms the host fingerprint, claims
the code and displays its fingerprint. The host terminal shows the exact session
and permissions and asks for the fingerprint displayed on the actual phone.
Only a matching, explicit confirmation approves the recipient. A code, incoming
certificate, socket connection or Relay record cannot approve itself.

For an explicitly reviewed control grant, the host can specify exact actions:

```sh
node bin/bzzy-core.js relay pair SESSION_UUID --permissions observe,claim,execute,answer,pause,cancel
```

`takeover` and `steer` are separate optional permissions. Controls require `claim`;
steering additionally requires actual runtime/provider support. The native iOS
client implements the [encrypted Core protocol](RELAY-PROTOCOL.md), including
scoped sessions, durable replay and explicit controls. Real-device setup still
requires an enrolled host and an approved pairing; see the current
[full-line validation](../../BZZY-IOS/docs/full-line-validation.md).

## Normal operation and revocation

For the normal Settings connection, the shared Core daemon owns the gateway.
Closing the CLI view detaches that view; saved enabled connectivity is restored
when the daemon restarts. The alternative `relay pair` and `relay run` commands
own a foreground gateway until stopped. Local owner commands remain available
for administration:

```sh
node bin/bzzy-core.js relay run
node bin/bzzy-core.js relay status
node bin/bzzy-core.js relay revoke LOCAL_GRANT_ID
```

`run` is an optional foreground administrative gateway and requires the managed
gateway to be stopped first. It restores trusted private pins and local grants.
Neither gateway restores rights from Relay's grant list, subscribes on behalf of
a device, resumes a goal or
replays a command. Clients explicitly resubscribe/reconcile. Explicitly stopping
the gateway stops transport/subscriptions while managed Core work continues.

Stopping Core itself with `bzzy-core stop` has different lifecycle semantics:
the local owner first pauses and verifies the exit of managed execution and
detached assignment processes, then stops supervision. Goals, chats and partial
evidence remain resumable. Existing CLI/iOS views cannot restart Core by polling;
an explicit start or a new CLI launch is required. Paused work is not executed
automatically on restart. While Core is quiesced, even an independently running
foreground Relay gateway returns `CORE_STOPPED` for application operations.

`status` reads the local gateway process/status record and checks process
identity. It returns no owner/session credential. `revoke` first denies the local
grant and revokes its Core token, even while Relay is unavailable. A durable
revocation outbox lets the running gateway revoke the matching transport grant
with bounded backoff. Revocation retries narrow access; application commands are
never retried by this mechanism. `RelayGateway.revokeDevice` also revokes that
device's local pin and all its local grants.

The gateway is an administrative host component. Keep its object, module access,
private key file, SQLite database and narrow bearer tokens outside model tools,
imported code and shared workspaces. Those private session tokens never go to
the phone or Relay. Existing native execution security limits remain unchanged;
an authorized remote controller has only the existing session's tool policy.

## Application behavior

The gateway creates a dedicated existing Core session grant for each locally
confirmed device/resource, then uses that narrower credential for loopback API
calls. It does not proxy arbitrary HTTP, token management, shutdown, files,
environment overrides or runtime options. Session responses omit private host
configuration and unrelated child sessions. Known owner/session/key values and
credential-shaped fields are redacted before transport; arbitrary text is not
proven secret-free by redaction.

Every delivered event preserves its complete envelope and provenance, with
credential values redacted as necessary. Each subscription has one bounded batch
awaiting the device's application acknowledgment. Relay delivery receipts do not
advance processed cursors. A failed/unacknowledged batch replays after explicit
resubscription; the client deduplicates by event ID.

Mutations reserve a private durable command record before dispatch. Replies mean
Core accepted the command, not that execution or a goal succeeded. A retry with
the same ID/input returns an already recorded acceptance. A conflict is rejected.
After a crash, `command.status` can reconcile the Core request reservation; an
uncertain command without durable acceptance is never redispatched automatically.

`session.get.capabilities.goalSubmission` advertises canonical goal handling.
`execution.execute` with `goal: true` creates a fresh goal/contract from `prompt`;
`resumeGoal: true` resumes its saved checkpoint instead. Legacy `/goal objective`
prompts use the same path. Replacing active/verifying/paused work requires
`replaceGoalId` matching the goal the user confirmed, otherwise Core returns
`CONFIRMATION_REQUIRED`. A changed goal ID is rejected. Cancelling an existing
execution also requires the grant's cancel permission. Grant validity and the
scoped input lease are checked again before queue commit. Clients cannot supply
host execution options, environment or a weaker policy through this operation.

The local runtime's `/v1/capabilities` describes the loopback session API.
Gateway `session.get` reports its actual remote capabilities and exact granted
permissions. Explicit host flags independently authorize terminal catalogs,
iPhone Agent management and source project export; old grants gain nothing
automatically. The gateway supports terminal ZIP sharing, not Agent packages.
See [project sharing](PROJECT-SHARING.md), [push](PUSH.md) and current validation.

Core assistant contexts additionally expose `assistant.status`, `task.submit`
and `task.get` through the same scoped authorization. These operations use the
existing queue and credentials rather than another model runtime. Persistent
on-demand Agent CRUD/open uses separate `agents.*` operations under explicit
`agentAccess`. Global Core settings, provider accounts and host administration
remain local-owner-only.

## Verification

```sh
npm run check
npm test
npm run relay:smoke
```

The last command is opt-in and contacts the deployed endpoint. It checks normal
TLS and authenticates a disposable in-memory candidate, then disconnects. It
does not enroll a host, redeem a code, create a session, authorize a device or
persist a candidate private key. Local tests use an actual loopback Relay and
the actual Core daemon with offline backend fixtures. See
[the validation record](VALIDATION.md) for what was actually observed.

Relay v1 uses static authenticated public-key boxes, with no forward secrecy or
ratchet and no independent protocol audit. This gateway reuses that protocol;
passing tests do not establish production-complete private communication.
