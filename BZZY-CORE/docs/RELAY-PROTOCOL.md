# Encrypted Core application protocol v1

This defines the JSON **inside** RelayClient's encrypted `payload`. Relay's own
wire version/subprotocol is unchanged. The native iOS RelayKit client implements
this contract; `/v1/sessions` is never a public HTTP route on the VPS.

All frames use `v: 1`, `protocol: "bzzy-core"` and `type`. The payload limit is
28 KiB after UTF-8 JSON encoding, leaving room for authenticated-encryption,
routing and base64 overhead under Relay's 45 KiB ciphertext/64 KiB frame limits.
There is no event/evidence chunk transfer in this version. Portable project ZIP
transfer is a separate authenticated `bzzy-project-transfer` protocol, not an
arbitrary Core RPC attachment mechanism. Oversized Core results fail
explicitly rather than silently truncating evidence or advancing a cursor.

## Requests and responses

```json
{
  "v": 1,
  "protocol": "bzzy-core",
  "type": "request",
  "id": "stable_opaque_request_id",
  "resource": "host_approved_opaque_resource",
  "op": "session.get",
  "params": {}
}
```

`id`, `resource`, `owner`, `consumerId` and subscription IDs are opaque strings of
1–80 letters, digits, `_` or `-`. Generate fresh unpredictable request IDs and
reuse the **same ID and exact parameters** for an explicit mutation retry. The
resource comes from the locally approved pairing or a specifically authorized
catalog/agent attachment. Each resource maps immutably to exactly one session
UUID on the host. A normal pairing cannot choose another session/path/URL.

Unknown versions, types, operations and fields are rejected. Requests cannot
contain arbitrary URLs, headers, credentials, environment variables, runtime
options or shell commands. Pairing/permission administration has no remote RPC.

Success:

```json
{"v":1,"protocol":"bzzy-core","type":"response","id":"same_id","ok":true,"result":{}}
```

Failure:

```json
{"v":1,"protocol":"bzzy-core","type":"response","id":"same_id","ok":false,"error":{"code":"FORBIDDEN"}}
```

Only fixed error codes are exposed; host/API exception text is not forwarded.
Unknown or revoked local grants may be dropped before application dispatch.
An authenticated transport receipt alone is never an application response.

## Operation allowlist

| Operation | Parameters | Local capability and result |
| --- | --- | --- |
| `session.get` | `{}` | `observe`; projected session including actual `cwd`, latest execution, same-session questions, lease and actual steering capability |
| `session.usage` | `{}` | `observe`; existing usage/summary, preserving missing/partial telemetry |
| `host.metrics` | `{}` | `observe`; versioned cached host CPU/RAM and Core process CPU/RSS, without machine identity or process details; see [metrics](METRICS.md) |
| `sessions.list` | Optional `after` (session UUID), `limit` (1–25) | Explicit host `sessionAccess`; ordinary top-level CLI terminal metadata/history locations, no filesystem browser or session creation |
| `sessions.open` | `sessionId` | Explicit host `sessionAccess`; journaled attachment to an existing terminal, returning a distinct stable resource; never starts a model or claims input |
| `share.create` | `{}` | Explicit host `shareAccess`, plus `agentAccess` for Agent contexts; complete typed ZIP, expiring TERMINAL/AGENT QR/code, no account/host credentials |
| `share.status` | `shareId` | Same share-bound resource; status and signed pending-recipient identities |
| `share.approve` | `shareId`, `claimId`, `confirmedFingerprint` | Explicit independent recipient fingerprint confirmation; does not grant live execution |
| `share.revoke` | `shareId` | Revokes future redemption/transfer; cannot recall an already received copy |
| `notifications.register` | `deviceToken`, `environment`, `enabled`, optional `scope` | Private APNs binding to this device/resource, as described in [PUSH.md](PUSH.md); no arbitrary topic, destination or message |
| `notifications.update` | `enabled` | Changes only this resource's saved notification preference |
| `notifications.revoke` | `{}` | Removes only this resource's private device notification binding |
| `assistant.status` | `{}` | `observe`; this Core assistant context's provider/model/effort, with no global configuration rights |
| `task.submit` | `owner`, `instruction` | `execute` plus valid input ownership; Core assistant context only, instruction up to 16 KiB; returns `state: "accepted"` and opaque `taskId` |
| `task.get` | `taskId` | `observe`; this device/resource's task state, execution reference, output event range and `verification: "not-assessed"` |
| `events.list` | Optional `after` (default 0), `limit` (1–50, default 50) | `observe`; full sanitized envelopes, `nextCursor`, `hasMore`; no cursor acknowledgment |
| `events.subscribe` | `consumerId` | `observe`; returns `subscriptionId`, `consumerId`, saved `processedCursor` |
| `events.ack` | `subscriptionId`, `seq` | `observe`; saves a processed cursor only for an event sent in that subscription |
| `events.unsubscribe` | `subscriptionId` | `observe`; closes only this grant's subscription |
| `input.claim` | `owner`, optional boolean `takeover` | `claim`; `takeover: true` separately requires `takeover`; existing 45-second Core lease |
| `input.release` | `owner` | `claim`; releases only the namespaced device/client owner |
| `execution.execute` | `owner`, `prompt`, optional boolean `goal`, `resumeGoal` | `execute`; existing configured session/goal only, no overrides; prompt up to 16 KiB |
| `question.answer` | `owner`, `questionId`, `answer` | `answer`; existing pending same-session question, bounded answer text |
| `control.request` | `owner`, `action`, optional `text` | Matching `pause`, `cancel` or `steer`; owner required; active steering checked by Core |
| `command.status` | `requestId` | `observe`; reconciles this device/resource's saved mutation acceptance |

All operations also require an active local `observe` grant, exact pinned peer,
resource mapping, expiry and active narrower Core token. Ordinary session grants
never inherit children. A Relay grant's action list cannot widen
local permissions. Device owner IDs are deterministically namespaced on the host,
and the narrower Core principal remains bound to its input lease. Use a stable
`owner` per app input client, renew claims every 10–15 seconds, and request
takeover only after an explicit user action. Observation does not claim input.

## Explicit terminal and agent discovery

`sessionAccess`, `shareAccess` and `agentAccess` are separate local host approvals,
defaulting to false. They are not inferred from `observe`/`execute` or restored
from Relay metadata. Host approval screens identify the additional scope.

A terminal catalog includes current and past top-level CLI sessions with their
actual original directories, including projects outside the managed BZZY root.
It excludes provider/authentication storage and internal coordinator/worker/agent
contexts. `sessions.list` returns `{ sessions, nextCursor, hasMore }`; each entry
contains `id`, optional `alias`/`mode`, `provider`, `model`, `cwd`, `executionState`,
`createdAt`, `updatedAt`, and optional `existingResource` for prior attachments.
There is no folder browser or remote terminal-creation operation.

`sessions.open` returns `{ state: "accepted", resource, sessionId, cwd, provider,
model, effort }`. The same parent/device/session reuses the same durable resource,
including after a daemon restart. Each derived resource has its own private
narrow Core token, exact session, cursor and input-owner namespace; it cannot
list/open further resources. Revoking/expiring the parent or device pin stops
all derived access. A client creates a distinct immutable client/projection per
resource and revalidates saved selection through read-only discovery on return.
Responses route by pending request ID; event/closure frames route by resource.

Agent CRUD/model discovery uses a separately approved `agentAccess` family:
`agents.status`, `agents.providers`, `agents.models`, `agents.list`, `agents.get`,
`agents.create`, `agents.update`, `agents.archive`, and `agents.open`. Agents are
Core-owned persistent on-demand definitions with pinned directories beneath the
host-configured root; iOS is their frontend. Scheduling is not advertised as
implemented. Agent attachment uses a distinct exact-session child resource and
the parent's action limits. A terminal catalog flag does not imply agent access.

Portable Agent receipt is base-resource-only under that explicit `agentAccess`:
`agents.import {code, expectedSenderFingerprint, provider, model, effort, name?}`
returns `{state:'accepted', importId, sourceFingerprint, expiresAt}`. Model and
effort keys must be explicit; the recipient uses its own locally configured
provider, never a sender endpoint/account. The code/QR must be AGENT.
`agents.import.status {importId}` returns `{importId, state, sourceFingerprint,
recipientFingerprint, received, total, expiresAt, agent?, errorCode?}`. State is
`connecting`, `awaitingApproval`, `receiving`, `importing`, `complete`, `cancelled`
or `failed`; fingerprint/total are initially null. Only complete includes full
Agent detail. `agents.import.cancel {importId}` returns `{state:'accepted',
importId,cancelled:true}` and refuses an already committed copy. Import/start
and cancel use stable command IDs; status polling never reclaims a code. Jobs
are ephemeral and exact device/grant/resource scoped. Missing jobs after restart
report `UNCERTAIN`; completed copies expose optional `importId` through Agent
discovery. No model, dependency install, schedule or original permission resumes
on import. See [complete-context sharing](PROJECT-SHARING.md).

Portable sharing is another distinct approval. Codes, QR payloads and ZIP bytes
never enter durable chat/events/command journal responses. Sender approval checks
the recipient identity; recipient import independently confirms the sender,
validates the strict archive and receives a fresh paused copy using its own
accounts. Transport receipts do not establish successful import or verified work.
See the CLI `/share`, `/import`, and `--import CODE` flow; local `FILE.zip` owner
backup/restore remains a separate compatibility operation.
`share.create` returns authoritative uppercase `kind:'TERMINAL'|'AGENT'` beside
its transient invitation fields. `session.get.capabilities.shareKind` identifies
the immutable resource kind. An Agent child can share only when its parent
independently approves both `agentAccess` and `shareAccess`; terminals require
`shareAccess`. Sharing never implies execution or input ownership. Agent source
and receive interfaces are in iPhone; CLI remains terminal-only.

`goal`/`resumeGoal` default to false. Goals must already have been configured by
the existing host workflow. Resume is an execution request, not a generic control
action. Unsupported steering is rejected rather than simulated.

Background tasks run in a host-created Core assistant context, using its saved
provider selection and existing native tool policy. They cannot create contexts,
choose host paths, alter the global AI setting or grant capabilities. See
[the Core assistant contract](ASSISTANT.md). `task.get.output.after` is the cursor
immediately before `execution.started`; `through` is `execution.finished`'s
sequence. Either is null until that marker exists. Read/subscribe to the existing
events and render output only within those bounds; later tasks in the same
context must not be attributed to an earlier task. Task acceptance does not
require displaying the internal provider transcript in the main UI.

## Commands, uncertainty and reconnect

The gateway records a hash of the device/resource/request ID and input before
dispatch. It derives the stable existing Core idempotency key from that scope.
It stores no new copy of prompt/answer/control text in its command journal.

An accepted mutation returns, for example:

```json
{"state":"accepted","sessionId":"SESSION_UUID","executionId":"EXECUTION_UUID"}
```

Answers also return `answered`; controls return `controlId`. `accepted` means
durable command acceptance. Inspect execution state and goal/evidence events for
the eventual outcome. `execution.finished` never by itself establishes verified
goal completion. Usage remains provider-reported with its existing coverage.

`command.status` returns `unknown`, `dispatching`, `uncertain`, `rejected` or
`accepted`. Accepted state includes `acceptance` with the saved Core response.
After a gateway restart, outstanding dispatches become uncertain until reconciled
against Core's durable request table. A saved Core acceptance restores the
receipt without invoking the command again. No receipt means no automatic retry.
`CONFLICT` rejects changed input under an existing request ID. Application
commands are never replayed by the Relay reconnect path.

## Event subscriptions and application acknowledgments

An event batch is:

```json
{
  "v":1,"protocol":"bzzy-core","type":"events",
  "subscriptionId":"SUBSCRIPTION_ID","resource":"RESOURCE_ID","sessionId":"SESSION_UUID",
  "events":[{"version":1,"id":"SESSION_UUID:123","seq":123,"sessionId":"SESSION_UUID","type":"future.event","createdAt":"TIMESTAMP","data":{"provenance":"host-observed"}}],
  "nextCursor":123,"hasMore":false
}
```

Keep `version`, `id`, `seq`, `sessionId`, `type`, `createdAt` and evidence
provenance. Unknown event types may be ignored after their cursor has been
processed; do not reinterpret model reports as host-verified facts. Credential
redaction can replace sensitive values but never changes the event identity.

Persist each processed event/projection and cursor together on the device,
deduplicating by event ID, then send `events.ack` for the last processed sequence.
Only a sequence from the outstanding delivered batch can advance the host cursor.
A repeated acknowledgment of the current cursor is harmless. Partial batches
can be acknowledged; their unprocessed tails replay. Cross-session/subscription
acknowledgments fail. Relay `forwarded` and `delivery.received` never advance it.

The host saves cursors separately by host identity, pinned device, resource,
session and `consumerId`. Use one stable consumer ID per durable client
projection. If that projection is deleted, choose a new consumer ID to rebuild
from zero. Subscribing twice to an active consumer returns the same subscription.
Disconnect/restart drops active subscriptions, not their processed cursors; the
client must explicitly resubscribe. No draft/goal is submitted on reconnect.

There is one unacknowledged batch per subscription, at most 16 subscriptions
globally and 4 per device. A batch acknowledgment deadline is 30 seconds. A
disconnect, expiry, revocation, unavailable peer, oversized event or timed-out
acknowledgment closes the subscription without acknowledging it. On recovery,
resubscribe from the saved cursor. Default local polling is 500 ms; there is no
continuous model loop. Request concurrency caps at 16 globally and 4 per device,
with 60 ordinary application requests per minute per device in addition to Relay
limits. Cached `host.metrics` reads have a separate 30/minute budget. Only valid
delivered/current-cursor `events.ack` requests have a separate 240/minute budget;
invalid acknowledgments retain the ordinary limit. Each budget is bounded and
applied after exact active-grant authorization.

If the grant and transport still permit sending, a failed subscription emits
`type: "subscription.closed"` with `subscriptionId`, `resource` and a fixed
`code` such as `RESULT_TOO_LARGE` or `INVALID_CURSOR`. No cursor is advanced.
Disconnect/revocation may prevent that final notice. An oversized event needs a
future chunked transfer; repeatedly resubscribing cannot make it fit this version.

## Security boundary

Locally saved intent plus independent fingerprint confirmation creates the local
grant. Restoring metadata from Relay does not. Revoking locally denies future
commands, stops authorized subscriptions and revokes the narrower Core token
before any transport revocation attempt. Private keys, Core owner/session bearer
credentials, identity files and private account bindings are never protocol
resources. Agent/terminal portable transport grants do not become device grants.

This version uses the deployed static-key Relay encryption and its limitations.
Native Node/Swift interoperability, scoped command/event behavior and disposable
local Relay/Core integration are tested. Normal TLS/IP trust, Keychain protected
data lifecycle, physical iPhone pairing and Apple-provisioned APNs delivery still
require their respective real-device checks before those deployments are called
verified. A local notification or Relay connection alone proves neither.
