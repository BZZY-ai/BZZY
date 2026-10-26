# BZZY Core

Core is BZZY's single source of execution state: persistent conversations, runs,
goals, evidence, permissions and replayable events. Persistent agents can remain
idle between interactions; schedules are optional. Clients attach to this state
without owning an execution's lifetime.

The shared Node engine lives in `src/engine/` in this package. The terminal
depends on Core and retains its commands and presentation; Core can run without
the terminal source tree. Its existing host API and encrypted Relay gateway use
the same engine and private state.

Implemented:

- Read-only execution-process observations on authenticated session snapshots.
  Identity-checked liveness is sampled at most every two seconds per unchanged
  process/state and returned separately from model output. Unknown, legacy or
  stopped processes never assert liveness. This is no progress/completion claim,
  durable heartbeat or new permission. The CLI combines it with actual event
  timestamps and native tool lifecycle events for live feedback.

- An optional [bug bounty pack](assets/bug-bounty/README.md) with 25 self-contained
  specialist authoring definitions, embedded per-class criteria, a compact goal
  workflow and a portable reporting skill. These assets use existing Core Library
  APIs and do not auto-install or authorize testing when Core updates.

- Encrypted Relay Library codes transfer skills, specialist agents, workflows
  and saved goal templates between execution hosts. Source selection, pinned
  single-use code authorization, missing-only installation and durable receipts
  preserve existing definitions and owner choices. See [Library sharing](docs/LIBRARY-SHARING.md).
- Full-session Relay imports retain a trusted-source journal: accepted retries
  do not duplicate chats, and later snapshots append missing immutable history
  without overwriting local sessions/goals. Source metadata versions and scoped
  knowledge revision history remain historical. See [project sharing](docs/PROJECT-SHARING.md).
- Explicitly saved/imported goal templates in Core's Library. The CLI Goals tab
  saves objectives manually; bare `/goal` chooses one and starts a fresh goal
  through normal input admission. `/goal <objective>` does not auto-save a template.
  Library listing and export exclude execution/replacement history, which remains
  durable separately. Templates never reuse outcomes, evidence, workflows or
  permissions as authority. No scoped session endpoint or model tool exposes
  this host-wide Library.
- Durable session/goal usage metrics from model skill-load receipts and accepted
  specialist/worker assignments, with separate follow-up counts and explicit
  coverage limits for older history. Actual worker skill receipts also reach
  the root conversation; bounded read-only invocation snapshots let clients
  restore current agent status. See [metrics](docs/METRICS.md).
- Session-scoped hierarchical history indexes with bounded summary/original
  expansion tools, source references, background compaction, budgets
  and durable stop/recovery. See [session memory](docs/SESSION-MEMORY.md).
- Reusable goal workflows with project/global text definitions and independent
  terminal selections. Core loads and pins the complete workflow before goal
  dispatch, retaining it across resume and model changes. See
  [workflows](docs/WORKFLOWS.md).
- Compactor and Validate consensus share one owner-configured provider/model/effort
  selection, inheriting Core by default with an optional independent override.
  Changing it starts no inference and preserves selections pinned to existing jobs.
- Model-assisted Skill and specialist Agent creators using the current terminal
  model, restricted document generation, reviewed drafts and checked saving.
  Native `/create-skill` and `/create-agent` commands ask for a name and publish
  portable global definitions enabled for use, through Core's internal creator
  guides and validated atomic registration. Creation does not start a task.
- Name-only checkbox Export and paste-once Import in Skills, Agents, Workflows
  and the saved-goal picker using
  expiring Relay codes, exact version pins and missing-entry imports. Resources and
  scopes survive without bindings or execution; goal labels use objective text.
  Imports leave workflow selections and running goals unchanged. Existing ZIP
  APIs stay compatible.
- Background learning publishes reusable project skills directly to Library,
  enabled with source/history, conflict-safe names and Disable/Delete controls.
  Committed skill and agent creations queue concise iOS alerts for the full
  paired own-phone grant using the existing notification delivery controls.

- Reusable named specialist subagents, invoked from ordinary chat or goals across
  Core's supported providers. The CLI Agents library manages project/global
  definitions and displays invocation history; Core owns pinned definitions,
  isolated worker copies, bounded parallelism, budgets, follow-ups, cancellation
  and evidence review. See [specialist subagents](docs/SUBAGENTS.md).

- Hardened Validate and Delegate handoffs: automatic source-pinned mission briefs,
  durable requests for missing context, independent checks and final review, retained
  minority objections, evidence inspection coverage and original-goal/severity
  assessment through Core's acceptance gate. See
  [orchestration](docs/ORCHESTRATION.md).

- Source-bound validation badges for achieved goals. A separate green check
  requires the latest linked review to pass Core's original-goal, evidence and
  acceptance gates. Stale, unsupported, inconclusive and stopped reviews remain
  distinct; consensus text grants no verified state. See
  [goal validation](docs/GOAL-VALIDATION.md).

- Project-scoped knowledge recall and reviewed learning: stable engagement IDs,
  attributed/freshness-aware memory and public-history search, private approved
  profiles, bounded idle lesson reviews, inactive skill proposals, held-out
  fixture comparisons and revision-pinned owner activation. See
  [knowledge and learning](docs/KNOWLEDGE.md).

- Paused terminal conversations can switch between solo, Delegate and Validate through
  Core's owner operations, preserving chat/goal identity, history, policies and
  budgets. CLI `/delegate` and `/validate` use saved mode defaults or setup; `/solo` restores
  the prior solo model. Switching requires a confirmed pause with stopped
  workers and never submits inference or resumes a goal.

- Local-owner deletion of saved terminal chats, shared by the CLI and iPhone
  catalog. Durable tombstones prevent old snapshots from restoring a removed
  conversation; active work must stop first. Project files and private execution/
  evidence audits remain intact. See [chat deletion](docs/SESSION-DELETION.md).


- Scoped newest/older event pages for the iPhone's bounded conversation cache,
  with an explicit persisted-tail bootstrap and delivered-only live ACKs.
  Optional exact-event chunk transfer preserves large messages instead of
  repeatedly closing the stream at the same cursor. See the
  [encrypted protocol](docs/RELAY-PROTOCOL.md).


- Built-in OrcaRouter support with OrcaCyber Zero 1.5 as its provider default,
  authenticated Cyber-first discovery and shared CLI/iPhone model metadata.
  See [OrcaRouter setup](docs/ORCAROUTER.md).

- Built-in Abliteration API support through the existing Responses adapter,
  dynamic model discovery and model-specific effort/context metadata. See
  [Abliteration setup](docs/ABLITERATION.md).

- Built-in Experiential Labs support through the Responses adapter, private
  API-key setup and authenticated model/capability discovery. Its manual effort
  controls are available offline, independent of route metadata. See
  [Experiential setup](docs/EXPERIENTIAL.md).

- Central session input admission for CLI and iOS, with authenticated handoff,
  durable request deduplication and uninterrupted reply observation. Clients
  submit explicit input without preclaiming a lease; see [shared input](docs/SESSION-INPUT.md).

- Own-phone voice conversations use Core's independent default assistant and
  managed folder through encrypted text-only requests, durable acceptance and
  read-only reply recovery. Apple Speech/TTS remain in iOS; see [voice](docs/VOICE.md).

- Location-independent CLI/Core updates retain dirty, detached or customized
  installations and stage the official revision separately. Modified cached
  releases remain intact; standalone Core packages use the same combined update.
  See [combined updates](../BZZY-CLI/BZZY-CLI-TERMINAL/docs/UPDATES.md).

- Core-owned GitHub update discovery, durable update alerts and explicit full-phone remote update jobs. CLI and iOS use the same updater; see [combined updates](../BZZY-CLI/BZZY-CLI-TERMINAL/docs/UPDATES.md).

- One versioned skills library with project and global scopes, explicit enable/disable, folder/ZIP import, Codex skill sync on Linux/macOS, creation, bounded discovery/resource reads and provider-independent tools. Enabled skills stay available across model changes within their approved scope. See [skills](docs/SKILLS.md).

- Sample host CPU/RAM and Core process usage once per second in the daemon.
  CLI and paired iOS display this shared cached telemetry; see
  [host metrics](docs/METRICS.md) for definitions and scoped access.
- Set a managed root with `bzzy-core workspace set /absolute/BZZY` or CLI Settings
  → Default BZZY folder.
  Agents use that root; CLI terminals keep their original project cwd.
- Manage persistent on-demand agents through the iPhone client and Core APIs.
  Agent sessions, providers, tools and history reuse the same execution engine.
- Explicit host-wide terminal discovery with separate resource histories, scoped
  control and independent project-sharing/agent-management pairing permissions.
- Transfer complete terminal and Agent projects/context through Relay as typed
  encrypted ZIP chunks. Terminals import into recipient CLI cwd; iPhone receives
  Agents into fresh recipient Core-managed directories with its own selected
  provider/model/effort. IDs are new and work stays inactive. See
  [project sharing](docs/PROJECT-SHARING.md) for scope, bounds and Relay upgrade needs.
- Enforce the persistent Agent v1 tool boundary: bounded safe project/context
  reads and durable Core tools, with no native shell/write, unapproved HTTP,
  delegation, account tools or schedules. Native provider configuration and
  permissions are restricted separately from ordinary terminal execution; see
  [Agent execution](docs/AGENT-EXECUTION.md).
- Send compact goal alerts with aliased titles and bounded final-reply previews for achieved, stalled, paused, cancelled and waiting goals from the daemon's durable outbox through Relay and APNs after
  private Relay Apple setup and authorized device registration (legacy direct Core APNs remains supported); see [push setup](docs/PUSH.md).
- Mobile `/goal` submissions create a fresh goal and acceptance contract through
  the same operation as CLI, including verified completion and durable alerts.
  Replacing active, verifying or paused work requires confirmation of its exact
  goal ID; stopping a live run also requires cancel permission. Duplicate requests
  reuse their execution. Ordinary Codex chat events cannot mutate a saved goal.
  Startup moves orphaned verification to awaiting review without replaying work
  or claiming completion from an earlier answer.

- Configure Core's independent coordinator provider/model/effort from the host
  API or `bzzy-core assistant`; create independent task contexts.
  CLI chat presets do not automatically select or change Core's coordinator.
- Share a Core-owned terminal YOLO setting between CLI and the fully approved own
  iPhone. Enabling it can atomically answer an exact pending approval; ownership,
  expiry, read-only policies and isolated Agent boundaries remain enforced.
- Own provider authentication/configuration and dynamic model discovery; terminal
  selectors consume the same Core registry without duplicating backend adapters.
- Submit background tasks through scoped Relay resources and inspect their
  durable state without making a terminal chat the primary interface.
- Start/discover the existing daemon, inspect sessions, claim/release input,
  execute, answer, control and manage scoped session grants.
- Create an idle conversation atomically in the existing SQLite database with
  a stable request ID and the terminal's compatible session format.
- Process durable events and save a separate cursor per consumer and session
  only after the handler succeeds.
- Declare integrations and read-only tool schemas; authorize tool calls against
  explicit user/workspace/agent grants with expiry, revocation and rate limits.
- Bind account operations to opaque private IDs and trusted host adapters.
- Read bounded project-file slices with path checks, credential-store exclusions
  and host-recorded hashes and timestamps.
- Connect outbound to deployed Relay v1 using its authenticated encrypted SDK;
  explicitly pair a pinned device to one session and enforce local permissions.
- Bridge bounded session/event/ownership/command messages with durable command
  reconciliation, processed event acknowledgments and local-first revocation.
- Own solo, debate, parallel, delegate and besties execution, including goal
  setup, verification, evidence, recovery and durable session mutations.
- Apply the shared iOS/CLI message-body instructions and bounded safe parser;
  retain original formatted bodies for replay and derive client display views.

The connection boundary is `CLI <-> Core <-> Relay <-> iOS`. Core never imports
the terminal frontend. `bin/bzzy-engine.js` starts its daemon, execution runners,
assignment workers and MCP bridges; these do not load CLI parsing or rendering.
Terminal compatibility modules re-export Core implementations for existing
integrations. They are not a second runtime or database.

Live home-host use automatically registers its public certificate with the updated Relay.
Native iOS integration, on-demand Agent CRUD, typed Agent/Terminal sharing,
Agent receive jobs and APNs registration/provider delivery code are implemented
and tested locally. Scheduled triggers, production email/account connectors,
TestFlight distribution and physical Apple
push/device verification remain separate work. The existing execution dispatcher
is reused. Persistent Agents use a restricted native provider/tool path plus the
scoped filesystem broker; ordinary owner terminal execution retains its existing
permissions and is not automatically confined by a broker grant. See [Core's default AI and tasks](docs/ASSISTANT.md),
[Relay setup](docs/RELAY.md), the
[encrypted application protocol](docs/RELAY-PROTOCOL.md), and
[architecture and gaps](docs/ARCHITECTURE.md).

## Host platforms

Core targets **Debian, Ubuntu and macOS as execution hosts**. A Mac can host the
same background engine and private state as a Linux home server.

| Host target | Initial baseline | CPU targets | User service supervision |
| --- | --- | --- | --- |
| Debian | 12+ | x86_64, ARM64 | systemd |
| Ubuntu | 24.04+ | x86_64, ARM64 | systemd |
| macOS | 13.5+ | Intel, Apple Silicon | launchd |

All targets use Node.js 24+. These are support requirements, not a claim that
every listed release/architecture has been tested. Native macOS Core tests pass;
Debian/Ubuntu and Intel Mac runs still need platform evidence. The terminal
installer prepares Core and CLI together. Explicit user-level systemd/launchd
registration is implemented; native Linux and reboot/logout validation remain
separate checks. See [host installation and supervision](docs/HOST-SERVICE.md).

Ordinary managed execution, storage, replay and broker operations share the same
implementation. The native runtime probes Linux bubblewrap or macOS sandbox-exec
and rejects enforced policies if isolation is unavailable. Core's tests do not
establish strict native policy parity on every target. Persistent Agent v1 has
its own restricted provider/tool boundary, with local fixture and native-profile
evidence; this is not a blanket sandbox guarantee for arbitrary host programs.
See [Agent execution](docs/AGENT-EXECUTION.md) and the
[platform contract and CI matrix](docs/PLATFORMS.md).

## Run

Use **Node.js 24 or newer**. Source development keeps `BZZY-CORE` beside
`BZZY-RELAY`; Core depends on its existing SDK through a locked local package.
Core has no dependency on the terminal source. The tracked `.npmrc` contains
only the non-secret `install-links=true` setting. Distribution packages bundle
the Relay SDK and its dependencies, so an installed package needs no sibling
source directories.

```sh
cd BZZY-CORE
npm ci --ignore-scripts
node bin/bzzy-core.js status
node bin/bzzy-core.js doctor
node bin/bzzy-core.js start
node bin/bzzy-core.js serve
node bin/bzzy-core.js workspace set /absolute/BZZY
```

`status` reports engine and service without starting one. `start` prepares and
starts the user service; `stop` verifies all work is paused and disables it;
`restart` replaces only the control daemon while existing runners continue.
Previously paused goals remain paused. `serve` runs the same engine in the foreground
for a process supervisor; it refuses a duplicate service. The default private
directory is `~/.bzzy`; `BZZY_HOME` selects another private host directory.
Daemon runners are owned by Core. Status output omits owner
credentials. Use the same `BZZY_HOME` for every lifecycle command. Programmatic
`BzzyCore.start()` retains the existing facade; explicit `bzzy-core restart` can
safely migrate a development daemon to supervision.

The CLI installer provides both `bzzy` and `bzzy-core` launchers. Core prepares and registers its public host identity on service activation;
`bzzy-core relay init` remains available to inspect its public certificate. Create
at least one CLI terminal with `bzzy`, then open CLI Settings → Pair iPhone to
display its QR or temporary code automatically, without choosing a terminal, and complete fingerprint
comparison. This own-phone flow automatically requests full session control,
terminal catalog access, project sharing and Agent management, with no access-mode
or scope picker. Fingerprint confirmation, expiry and revocation remain on the
secondary screen. Existing grants gain no new permissions automatically. The
main Settings menu contains API keys, Default BZZY folder, Pair iPhone, Default
models and BZZY Core. The Default models table consolidates all model defaults;
lifecycle/coordinator commands and APIs remain available separately.
The daemon keeps an explicitly enabled gateway connected after CLI closes and
restores it after a daemon restart. Installation prepares a disabled user manifest;
plain `bzzy` or `bzzy-core start` activates it. After explicit stop, background
client polling cannot resurrect Core. macOS login/sleep and Linux lingering limits are
described in [host service setup](docs/HOST-SERVICE.md).

For source development of both products, install Core first, then create the
CLI's local package link with `npm ci --ignore-scripts` in
`BZZY-CLI/BZZY-CLI-TERMINAL`. Core edits are then available to both products.
The CLI's `install.sh` and `npm pack` prepare both dependency trees in that order.
Packaging stages a disposable physical copy and restores the development link.
They do not install or update Codex/Claude backends. A CLI release tarball bundles
Core, the Relay SDK and their locked dependencies; it can be installed without
the source workspace.

To build a standalone Core release, run `npm ci --ignore-scripts` followed by
`npm pack` in this directory. The release includes its Relay SDK and needs no
CLI source. Core's pack hooks temporarily substitute a sanitized dependency
copy and then restore the original directory, preserving original files and
macOS metadata. Source notes, account files, `.npmrc` and AppleDouble files stay
out of the archive. If packaging is interrupted before restoration, run
`npm run postpack` before retrying. The CLI's packaging regression test exercises
this flow in a temporary workspace and installs both releases offline.

On a machine whose default Node is older, a temporary Node 24 environment can
validate the package without changing the system installation:

```sh
npx --yes --package=node@24 -c 'npm ci --ignore-scripts && npm run check && npm test'
```

## Host API

`BzzyCore` is a privileged **local host API**. Keep the instance and its module
away from model tools, imported scripts, Relay and remote clients. Trusted local
integrators can use `BzzyClient` with a narrower session token. Phone/Relay clients
use the encrypted gateway protocol and receive no Core bearer credential. The
local HTTP API remains the existing engine's API v1; the gateway does not publish
that listener or turn the VPS into an HTTP session API.

```js
import { randomUUID } from 'node:crypto';
import { BzzyCore } from './src/index.js';

const core = new BzzyCore();
const session = core.createConversation({
  provider: 'codex',
  cwd: process.cwd(),
  alias: 'Project assistant',
}, { requestId: randomUUID() });

// Creating a conversation does not start inference or grant tool permissions.
const owner = randomUUID();
await core.claim(session.id, owner);
const accepted = await core.execute(session.id, {
  owner,
  prompt: 'Summarize the requested project work.',
  requestId: randomUUID(),
});
await core.release(session.id, owner);
// accepted.executionId identifies queued work. Inspect the eventual result.
```

Ordinary owner terminal execution uses the terminal's existing permissions and
platform limits. A tool-broker grant does not constrain arbitrary native execution.
Persistent registered Agents and their validated descendants use the separate
[bounded Agent policy](docs/AGENT-EXECUTION.md); an imported purpose tag or request
cannot convert ordinary owner execution into a safe Agent sandbox.

| Method | Behavior |
| --- | --- |
| `start()` / `status()` | Start/discover or inspect the shared engine |
| `createConversation(input, { requestId })` | Persist an idle session; retry with identical input/key |
| `sessions()` / `session(id)` / `usage(id)` | Observe the existing runtime |
| `deleteConversation(id, { requestId })` | Local owner removes an inactive terminal chat and its descendants; stable retry identity |
| `events(id, after, limit)` | Read an event page using a per-session sequence cursor |
| `claim(id, owner, takeover)` / `release(id, owner)` | Existing input-ownership leases |
| `execute(id, input)` | Existing execution queue; requires a stable `requestId` |
| `answer(id, input)` / `control(id, input)` | Existing answers/controls with stable request IDs |
| `grantSession(input)` / `revokeSession(grantId)` | Existing scoped session credentials and revocation |
| `processedCursor(consumerId, sessionId)` | Last successfully processed event sequence |
| `processEvents(sessionId, options)` | Handle a page and durably acknowledge each successful callback |

`createConversation` accepts `provider`, an absolute `cwd`, and optional `model`,
`alias` and `effort`. It rejects unknown fields and private Core directories.
Reasoning effort is validated against the actual model by the existing runner.
It does not configure agents, attach accounts, create goals or start schedules.
Goal contracts are still created using the existing terminal workflow; executing
an unconfigured goal remains rejected by the engine.

```js
await core.processEvents(session.id, {
  consumerId: 'paired-phone',
  async handle(event) {
    await saveEventIdempotently(event.id, event);
  },
});
```

Use one active processor per consumer/session. A failed handler leaves its event
unacknowledged. A crash after a handler's side effect but before cursor storage
can deliver that event again; the consumer must deduplicate by event ID. A
concurrent cursor update is rejected rather than overwritten. Unknown event
types retain their envelope and may be ignored by the handler. This method
processes one page; call again while `hasMore`, then wait or use the existing SSE
client to observe new work. No model call is made by replay.

## Scoped tool broker

The host owns `admin`. A model-facing transport receives only the result of
`admin.scope(...)`. It cannot change identity, register integrations, grant
permissions, attach accounts or revoke another principal's resources.

```js
import { createToolBroker } from './src/index.js';

const { admin } = createToolBroker();
const principal = {
  userId: 'local-owner',
  workspaceId: 'project-workspace',
  agentId: 'project-assistant',
};

// Call only after the host has obtained the user's explicit authorization.
admin.grant({
  principal,
  integrationId: 'filesystem',
  capabilities: ['filesystem.read'],
  roots: [{ id: 'project', path: process.cwd() }],
  expiresAt: Date.now() + 60 * 60 * 1000,
});

const tools = admin.scope({ principal, sessionId: session.id });
const result = await tools.invoke('filesystem.read_file', {
  root: 'project', path: 'README.md', limit: 4096,
});
```

`tools.catalog()` returns currently authorized, allowlisted schemas. `tools.instructions`
contains the exact reusable security preprompt from `SECURITY.md`, reused from
Core's instruction asset. Include it in effective generated workflow and
agent instructions. A preprompt does not authorize access.

Private-account integrations declare an ID, description, capabilities,
authentication/scopes, rate limit, error behavior and read-only tools with strict
input/output schemas. The host calls `admin.bind(definition, adapter)` after
secure account setup. The definition contains only `principal`, `integrationId`,
`capabilities` and `expiresAt`; an opaque binding ID is generated. A later grant
must name that binding and cannot exceed its identity, capabilities or expiry.

The trusted adapter performs the account operation; it can close over a secure
host credential provider. The broker never requests raw credentials or exposes a
credential lookup method. Bindings persist only private scope metadata. Adapters
are deliberately not serialized: after restart the host must securely reconnect
with `admin.attachBinding(id, adapter)`. No OAuth login, token vault, refresh
worker or production email integration is claimed by this implementation.

Tool calls revalidate grants and bindings before execution and before releasing
results. A caller abort or 30-second deadline stops waiting for an adapter; trusted
adapters must honor the supplied cancellation signal to stop their underlying I/O.
Audit events record declared tool ID, decision and safe error code, without
arguments, account contents, adapter errors or results. Only schema-allowed
results reach the caller. Adapters are trusted host code and must return only
the intended account data; schemas cannot prove arbitrary text free of secrets.

## Security and platform limits

The filesystem tool rejects traversal, absolute paths, symbolic links, hardlinks,
changed roots, known authentication paths, private Core storage and runtime
databases. Reads are limited to regular files of 1 MiB and slices of 16 KiB.
The hash covers the returned **byte slice**, not the whole file. File contents
remain private execution data. They can enter an explicitly reviewed full-context
copy only through the strict sharing policy; account credentials and bindings are
never included.

On Linux, reads pin directory descriptors and traverse via `/proc/self/fd` with
`O_NOFOLLOW`. Other supported hosts use synchronous ancestry/inode revalidation;
this does not establish confinement against adversarial concurrent directory
swaps. The broker is not an OS sandbox. Run untrusted code only after a restricted
process/container boundary prevents access to host storage, broker administration
and unauthorized networks. Persistent Agent v1 supplies a separate restricted
provider/tool path; ordinary terminal native permissions are broader. See
[Agent execution](docs/AGENT-EXECUTION.md) and [the assessment](docs/ARCHITECTURE.md).

The scoped broker supplies no shell or generic network tool. Registration accepts only tools
declaring read effects; trusted adapters must uphold that declaration. It cannot
validate the behavior of arbitrary imported code. Side-effecting tools require
enforceable isolation, destination policies and durable uncertain-operation
handling before exposure.

## Validation

Run `npm run check` and `npm test` with Node 24+. Tests use temporary private data
and an offline backend fixture, never production provider accounts. They exercise
the actual shared daemon, execution queue, scoped tokens, restart/replay and
the deterministic broker boundaries. [VALIDATION.md](docs/VALIDATION.md) records
the checks performed for this implementation.

## Confirmed connection status

The local-owner `GET /v1/connections` endpoint reports the serving Core identity
and separate Relay liveness. Relay requires a matching ping/pong challenge on the
authenticated current socket, with a six-second freshness bound; an open socket
or old status file is insufficient. This probes no model or application command.
The `@bzzy/core/connections` facade validates the Core identity and returns only
safe state to the CLI. Connection and metrics polling never start a stopped Core.

The full paired iPhone can switch an existing paused terminal between Solo,
Delegate, Validate, Parallel and Besties using the mode dropdown. Core reads that
mode's preset and preserves the conversation, goal, permissions and remaining
budget. Workers must finish stopping first; a switch never resumes work. See
[session admission](docs/SESSION-INPUT.md).
