# Architecture assessment and implementation boundary

This assessment describes the shared engine and its boundaries. Read the root
README and `SECURITY.md` alongside the current product documentation. The engine originated in the
terminal repository and now lives in `BZZY-CORE/src/engine/`.
`BZZY-CORE/README.md` describes the current package boundary.

BZZY's central object is a persistent, specialized workspace with independent
conversations, memory, permissions and evidence. A model process is temporary.
A session, goal, run, trigger and assignment have different identities and
lifetimes. CLI/iOS are clients; reconnecting observes existing work. Scheduling
is optional. A completion claim must retain its actual verification provenance.
Reusable behavior must stay separate from private account bindings and results.

## Shared engine: what is actually present

| Concern | Core source, relative to `src/engine/` unless stated | Assessment |
| --- | --- | --- |
| Runtime lifetime | `runtime.js`, `runtime-processes.js` | Loopback service plus detached execution runners; existing queue dispatcher, not an agent trigger scheduler |
| Storage | `database.js`, `store.js` | SQLite WAL, durable records/events and transactional request reservations; JSON session files are compatibility exports |
| Goal lifecycle | `goals.js`, `controller.js`, `lifecycle.js` | Goal reporting transitions to verification; an execution's exit status is a separate field |
| Contracts/evidence | `contracts.js`, `verification.js`, `evidence.js` | Artifact hashes, requirements, checks and acceptance records exist; explicit criteria can fail independently of a model claim |
| Verification limits | `verification.js` | Free-text contracts can use `modelJudgment`; an undeclared contract uses `legacy-model-judgment`. These are not independent proof |
| Providers | `providers.js`, `engines/*` | Codex/Claude adapters and configured API providers; reuse rather than build a new provider loop |
| Public integration | `runtime.js`, `api-client.js`; CLI `docs/INTEGRATION.md` | API v1, SSE, event pages, execute/answer/control, leases and scoped session access |
| Scoped access | `session-access.js`, `runtime.js` | Explicit session actions, expiry, revocation, session/child boundaries and principal-bound input leases |
| Environment | `execution-environment.js`, `process.js` | Explicit environment selection and private per-execution environment files; allowed provider secrets still enter trusted native backends |
| Policies | `policy.js`, `contracts.js`, `agent-execution.js`, `engines/*` | Ordinary native policy parity remains platform-specific; persistent Agents add registry ancestry, bounded broker reads and restricted native provider profiles/tools |
| Recovery | `recovery.js`, `execution-queue.js`, `runtime-processes.js` | Durable queue, runner identities and uncertain-operation records; recovery is not a promise of exactly-once external effects |
| Notifications | `notifications.js`, `notification-registry.js`, `store.js`; Core `src/push/*` | Durable outbox, scoped device registration and private APNs HTTP/2 provider code exist; physical Apple delivery still requires configuration/device evidence |
| Generated instructions | `instructions.js`; Core `assets/generation-security.txt` | Reusable credential-isolation preprompt exists and is reused by Core |

The terminal already had local edits when extraction began. The shared engine
reuses that implementation; these existing behaviors are not claimed as newly
built capabilities. SQLite remains authoritative and `BZZY_HOME` retains its
existing layout. The terminal's npm identity remains `bzzy-cli`.

## Source ownership and process lifetime

Core owns the provider adapters, model discovery, auth storage, tool bridges,
contracts, policies, goals, evidence, memory, persistence, notifications, execution
queue, runners, recovery and versioned local service. `src/engine.js` exports
Core's own modules; it no longer forwards to a sibling terminal repository.
Core's Relay gateway and assistant APIs use this same engine and database.

`bin/bzzy-engine.js` and `src/engine/entry.js` start the private daemon, execution
runner, assignment runner and tool/MCP bridges. They import no terminal frontend.
The daemon starts detached Core runners, so a host does not need the CLI source
or an open terminal to keep managed work running. A CLI update that changes only
presentation does not change the Core runtime fingerprint.

The CLI owns argument/slash-command parsing, pickers, hidden credential entry,
keyboard and mouse interaction, layouts, mascot animation and display. Legacy
CLI module paths re-export Core modules for compatibility. Mixed modules were
split: provider/model and mode pickers stay in CLI, while Core owns validation
and persisted selection changes. `host-commands.js` owns trusted local launch,
resume, task creation and idle/native goal operations; `session-operations.js`
owns shared goal/model/provider mutations. Event/approval sinks may be supplied
by a client, but Core imports no CLI UI implementation.

These host operations are privileged local APIs. Exporting a JavaScript function
does not create an authenticated remote endpoint. Remote commands continue
through the loopback service or the scoped Relay allowlist, which enforce grants,
input leases and supported operations. A new iOS command must use an explicitly
authorized route rather than receive a host object or Core owner token.

A standalone-copy integration test installs only Core source/assets and its
local package dependencies into a temporary directory, executes a fixture via
its actual Core runner, retries the accepted execution, then restarts the daemon.
It checks one execution, unchanged raw rich-message bodies, replay history and
processed cursors. The production-import check rejects relative imports outside
Core and terminal-package references. This verifies package independence on the
current test host; it does not establish every target OS or native isolation mode.

## Core host APIs

`BzzyCore` composes the existing service/client and reuses its owner request path
for execution, including caller-environment handling and request-ID retries.
Owner credentials stay in private fields. Client-safe imports expose only the
existing `BzzyClient`, which requires an explicit token.

Conversation creation uses `reserveRequest` with one SQLite transaction for the
session and initial events. It must write the compatible session shape directly
because the legacy `createSession` starts its own transaction. A replay returns
the current session and refreshes only its JSON compatibility export; it never
resets turns, state or history. No inference starts on creation.

Processed event cursors use `core.cursor` records in the same database. Cursor
updates happen after handler success and compare against the expected cursor.
Delivery is at least once; consumers own deduplication of their own effects.

The scoped broker adds `core.binding`, `core.permission`, `core.session-principal`
and `core.rate` records to the same generic record store. Each private binding
and permission is bound to all three opaque identity dimensions: user, workspace
and agent. Session identity is fixed before a model-facing scope is created.
Runtime checks, not model instructions, select capabilities. Known private paths
are denied independently of project read permission. Errors and audit events
exclude adapter messages and data. Input/output validation additionally rejects
inherited object keys that are not explicit schema fields.

The administration object belongs to a trusted host process. This is a real
deterministic boundary for calls through the scoped API, not a sandbox for an
arbitrary program running as the host user. Registered persistent Agents now
use a verified native provider profile/restricted tool surface and an Agent-only
project/context reader backed by this broker. Their ToolHost call boundary also
enforces the allowlist. Ordinary CLI terminal backends keep their existing native
permissions; a broker grant alone does not confine those programs. See
[Agent execution](AGENT-EXECUTION.md).

## Relay v1 gateway implementation

`CoreAssistant` supplies default-AI configuration and independent background
contexts over these same providers/sessions. Its coordinator selection is
independent of CLI chat and mode defaults; it starts unconfigured. An explicit
one-time CLI selection copy is available, with no subsequent live inheritance.
Contexts are tagged for product views rather than importing terminal history. Scoped Relay task submission/inspection uses the
existing queue and command journal. Configuration is privileged local setup;
session control grants confer no global administration rights. See
[Core's default AI and background tasks](ASSISTANT.md).

`engine/background-model.js` owns the shared Consensus & Compactor selection.
Its default follows Core; an explicit custom override stays independent from
Core and terminal defaults. Host-only revisioned configuration starts no work,
and compaction jobs and consensus requests pin the resolved model and source
revisions. Provider authentication and restricted document execution are unchanged.

`src/relay/` now supplies the outbound home-host gateway using the deployed
Relay SDK as a local package dependency. Host endpoint keys live in a separate
private identity file, never in source or Relay state. Core registers its own public certificate through authenticated `host.register`
on the updated Relay. A candidate connection alone has no enrolled-host rights;
registration adds no Core authorization or access to other hosts.

Explicit confirmation of a recipient fingerprint and a locally saved invitation
intent creates an exact session/resource/action grant. The gateway persists
private device pins and a dedicated existing Core session token with child
inheritance disabled. That token stays on the host. Every operation, route and
subscription rechecks the private local authorization, independently of Relay
metadata. Local-first revocation invalidates the Core token immediately and
queues idempotent transport revocation for reconnect.

Only the [versioned encrypted application allowlist](RELAY-PROTOCOL.md) reaches
the existing loopback API. Command journaling precedes dispatch and reconciles
from Core's own request reservations; uncertain application operations are never
automatically replayed. Event batches retain complete envelopes and provenance,
with known credentials redacted. Cursor storage follows explicit application
processing acknowledgments, never Relay receipts. Explicit host-approved flags
now separately enable terminal discovery, iPhone Agent management and full project
export. Derived resources retain their own session, authorization and cursors;
neither opening nor reconnecting creates a terminal or starts a model.

The local engine's existing capability endpoint remains unchanged. The running
scoped gateway reports its actual Relay support separately. Swift/Node/Core
interoperability and typed complete-context Terminal/Agent ZIP transfer are
tested against a real local Relay and daemon. Agent imports register a fresh
managed workspace/session tree atomically, use explicit recipient provider
selection and preserve historical claims without execution. Real host enrollment,
upgraded public Relay, physical iPhone/APNs behavior, TestFlight distribution and
native Linux/reboot service behavior still need their deployment checks.
See [setup and operation](RELAY.md).

## Specialist subagents

`engine/session-debug.js` supplies an owner-local read-only snapshot/export of
the saved terminal family and its skill/specialist definitions. Client controls
stay in CLI. `session-diagnostics.js` records BZZY's prepared catalogs,
instructions, provider tool exposure/transport outcomes and correlated Core
tool attempts. Diagnostics neither add model work nor grant authority or count
as invocations. Historical gaps and inherited native schemas are explicit; see
[session debugging](SESSION-DEBUG.md).

`session-full-debug.js` extends that local read projection into a separate ZIP
with complete scoped event/record/message streams, memory/compactor/learning
state and individually validated project/execution files. `debug-archive.py`
packages only the private sanitized stage. The full ZIP has its own manifest and
explicit credential/path/capture exclusions, and is not an execution/import
format. The shipped read-first guide is mirrored at the repository root.

`src/engine/subagent-definitions.js` owns revision-checked project/global
specialist definitions and immutable content versions. `subagents.js` resolves a
definition and model selection against the current execution and starts the
existing bounded assignment worker. The shared tools expose discovery,
invocation, status, waits, follow-ups, review and cancellation to ordinary chat
and goal coordinators across providers. Terminal Agents is a frontend for this
library and invocation history, separate from persistent iPhone Agent resources.
Chat workers bind to an exact live run; definition instructions cannot grant
scope or native tools, recursively spawn workers, or complete parent goals.
See [specialist subagents](SUBAGENTS.md).

## Remaining Core work, in dependency order

1. Extend and validate the implemented bounded persistent Agent execution path
   across supported native provider/OS versions before adding broader tools.
   Current Agent reads use a scoped broker, Codex verifies its isolated named
   permission profile, and Claude restricts native tools/MCP/settings. Shell,
   writes, unapproved HTTP/delegation/accounts remain unavailable. Preserve this
   fail-closed boundary and test native Linux behavior; never fall back to ordinary
   owner permissions when an Agent profile is unsupported.
2. Add host-authorized HTTP resources for conversation creation, integration/tool
   discovery and permission review to the existing versioned service. The new
   JavaScript API is not evidence that these HTTP endpoints exist.
3. Add a private credential-provider interface and production adapters with secure
   authorization, refresh, expiry, revocation, rotation and destination policies.
   Broker adapters currently supply an integration point, not a credential vault.
4. Complete production setup of the daemon-managed gateway. Enroll the actual
   host, upgrade the public Relay, pair/revoke a real
   phone, verify background/reconnect behavior and preserve the existing scoped
   authorization and private owner-token boundary.
5. Add trigger infrastructure over the current execution queue, with timezone,
   missed-run, overlap, retry/backoff, limits and recovery policies. Keep on-demand
   agents usable without a schedule. Agent definitions remain Agents ownership.
6. Provision and verify actual background APNs delivery. Device registration,
   private token-auth HTTP/2 delivery, bounded outbox retries and revocation are
   implemented; local HTTP/2 fixtures do not prove Apple accepted a real push.
7. Validate the implemented typed Agent/Terminal package transfer on the upgraded
   public Relay and physical iPhone. Retain full-context integrity, scoped receive
   jobs, fresh local identities, recipient-owned selection, QR/expiring codes and
   inactive imports. Definition-only packages and expanded collaboration remain
   additional proposals, not implicit permissions.
8. Validate the implemented user-level systemd/launchd service installer on native
   Debian/Ubuntu and across macOS logout/reboot. Extend release validation across
   Intel/x86_64 and ARM64/Apple Silicon, with consistent backup/restore/update tooling.
   Preserve SQLite consistency and private account separation throughout. Keep
   native macOS runtime support separate from cross-platform strict policy parity
   and validation of the bounded persistent Agent provider/tool policy. See
   [the platform contract](PLATFORMS.md).

Persistent on-demand Agent CRUD/chat, bounded Agent tools, native Core networking,
mandatory pairing, terminal catalogs/activity, typed full-context Agent/Terminal
sharing and APNs registration/provider-delivery code are implemented. Scheduling,
production account integrations, expanded Agent tools and production/device
validation remain work. Local tests or an archive do not prove hosted rollout,
TestFlight availability or physical APNs delivery.
See VALIDATION.md, PROJECT-SHARING.md, PUSH.md and the iOS full-line evidence.
