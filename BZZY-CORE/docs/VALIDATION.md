# Current integrated platform validation

Validated across 2026-10-22/23 with Node.js 24.22.1 on Apple Silicon macOS. Automated
Core, CLI and Relay checks use private temporary state, offline provider fixtures
and loopback networking. Native checks use the actual Swift encrypted client
against a local Relay and the same Core daemon used by CLI.

| Check | Current result |
| --- | --- |
| Core suite, including managed stop/restart and metrics recovery | 161 passed, 0 failed, 0 skipped |
| Complete CLI suite | 349 passed, 0 failed, 21 platform-specific skips |
| Relay transport/security | 24 passed, 0 failed |
| Swift package, including real full-line integration | 38 passed, 0 failed, 0 skipped |
| Core / CLI syntax checks | Passed |
| Latest iOS UI checks | 3 focused offline checks, 1 signed offline smoke, 1 Release pairing-gate check passed; earlier full 12 retained |
| Final iOS Debug build and signed distribution archive/IPA | Passed |

The four runtime suites total 572 passes and 21 platform skips. The CLI suite
includes self-contained packaging and fresh/repeated installation with both
launchers, ordinary goal/multi-agent compatibility and private share UI.

Current coverage includes mandatory first-run Pair; original-cwd terminal
history/interaction; independent Core coordinator settings; persistent on-demand
Agent CRUD/native execution; source-side iOS terminal sharing and actual encrypted
multi-chunk ZIP transfer/strict recipient-cwd import; durable history,
per-resource replay, idempotency/reconciliation and local-first revoke; and
socket-independent goal APNs registration/outbox delivery with local HTTP/2 JWT
fixtures. Imported completion claims remain historical until explicit local
goal execution. Sensitive/system import destinations, startup files, escaping
links, hardlinks, credentials and injected host authorization are rejected or
excluded; source traversal uses pinned directory descriptors.

Host CPU/RAM are sampled once per second by Core and displayed by CLI and iOS.
Tests exercise read-only authorization, revoked access, separate bounded polling
and event-acknowledgment budgets, actual encrypted streaming, CPU warmup and
strict decoding. A real daemon stop/restart test verifies that the metrics client
recovers on its next poll without starting inference or changing private hosts.
Telemetry stays outside durable chat and sharing context.

Owner lifecycle commands use the Core facade. The historical Settings lifecycle
checks below predate the current three-entry menu. Explicit
stop rejects new work, pauses queued/running jobs and verifies parent/child,
native backend and detached-assignment processes have exited. Unknown legacy
identities remain blocked across repeated stop attempts. Paused goals/history
survive restart without automatic replay. Prepared services cannot spawn a
separate detached daemon during restart gaps; authenticated Core identity must
match the native manager PID before startup can report managed success.

Paired iOS locks Agents, Terminal, existing chats, Activity and sharing while
Core is unavailable. Authenticated scoped heartbeats confirm readiness; Relay
presence alone cannot unlock it. Binding/history remain saved, and reconnect
performs reads without submitting work.

A broad CLI run exposed stale scheduler writes resurrecting cancelled queued
parallel peers. Atomic launch reservation, stop-aware runner acquisition and
transactional metadata updates fixed that race. Three deterministic regressions
and four concurrent runs of the original replacement case passed without
weakening its expectation. Variable transfer latency and certificate key ordering
also have actual encrypted-transfer regressions.

One native full-line run failed intermittently before operation-stage diagnostics
were added. Its cause remains unconfirmed; assertions/timeouts were preserved.
Ten subsequent serial native-line runs and a complete fresh 32-test Swift check
passed. The original failure and follow-up evidence are retained in the iOS
[full-line record](../../BZZY-IOS/docs/full-line-validation.md).

Current automated logs:
`/private/tmp/bzzy-core-managed-release-final.log`,
`/private/tmp/bzzy-final-cli-managed-readiness-tests.log`,
`/private/tmp/bzzy-relay-metrics-full.log`; native evidence is under
`BZZY-IOS/.build/core-offline-final-checks.log` and `BZZY-IOS/.build/TestFlight/`.

# Actual Mac setup and remaining deployment checks

Core and CLI are installed on this Mac in an internal-disk bundled release with
a checksum-verified private Node 24.22.1 runtime. Installation doctor checks pass.
The private context is `~/.bzzy`, managed project root is `~/BZZY`, and the public
host certificate is `~/BZZY/Setup/mac-host.public.json`. Private keys remain in
Core's owned private context. Existing Codex and Claude subscription adapters
both authenticated and returned real short model replies through their native
connection checks. These live checks consume subscription tokens and are separate
from the isolated automated test totals above.

The final installed release was exercised in a real PTY: plain `bzzy settings`
activated the service and displayed live metrics; Settings Stop, a 2.5-second
polling interval without resurrection, Start, Restart and clean CLI exit all
passed. Core remained supervised after CLI exit. Separate top-level stop,
status, start and restart commands passed on this Mac, with matching authenticated
engine/native-service PIDs.

An actual Codex goal ran through installed CLI -> Core -> subscription backend
in `~/BZZY/First-Run-Test`. Its read-only marker check and acceptance passed;
project files stayed unchanged. After stop/start/restart, its 112 durable events,
one execution start and one completion remained intact, with no second model
execution. Live CPU/RAM samples advanced on the restarted daemon. Core is left
running under the user service. Local evidence:
`/private/tmp/bzzy-installed-mac-execution.jsonl`,
`/private/tmp/bzzy-final-installed-mac-check.json`.

The first real Settings restart test exposed a poller spawning an unsupervised
daemon before launchd completed startup. The prepared-service guard and strict
PID readiness fix above resolved it. A later harness timeout was caused by an
unchanged status line omitted from incremental terminal output; the harness now
checks actual host status and the clean real-PTY flow passes.

On 2026-10-23 the authorized operator upgraded the actual public Relay to the
validated self-contained release, running as `bzzy-relay`. A consistent stopped
state backup and verification preserved revoked devices/grants and consumed
invitations; the Mac's public host certificate is enrolled. Ordinary public TLS,
local/public health, scoped PAIR streaming and typed Agent/Terminal transport
are in the deployed release. Caddy, firewall, SSH, Node and the service unit were
unchanged. The first staging attempt exited before stopping Relay because its
nonroot tests inherited an inaccessible admin cwd; the wrapper fix and regression
passed before the successful apply.

The actual native Swift client then paired through the public Relay with this
installed Mac Core using a disposable observe-only identity. `session.get`,
`host.metrics` and `events.list` passed with verified TLS and encrypted application
messages, 50 history events and typed real host CPU/RAM. The temporary grant was
revoked immediately. A separate actual public Terminal ZIP transfer restored the
First-Run-Test project and .bzzy context into the recipient test cwd with a fresh
session ID, 118 preserved events and one historical execution. It has zero active
executions, bindings or live grants. The completed source goal correctly remains
historical complete and idle; the initial probe's expectation of paused for every
historical goal was corrected by inspecting the already imported durable copy,
without another transfer or model run.

The final installed Mac release is
`~/.local/share/bzzy/releases/0.2.0-20261023-agent/package`, using its private
Node 24.22.1. The real Settings stop/poll/start/restart/exit flow passed again in
9.8 seconds. Actual Codex and Claude subscription-backed persistent Agent runs
read a marker through the scoped Core project tool. The actual Codex named-profile
command probe read its workspace file and denied an outside private canary.
Private-file/hardlink memory fingerprints are also denied; a regression spies
on actual reads so recall cannot conceal a private read behind its error fallback.

Additional local evidence: `/private/tmp/bzzy-final-core-agent-memory-tests.log`,
`/private/tmp/bzzy-cli-agent-memory-final.log`,
`/private/tmp/bzzy-public-native-observer.log`,
`/private/tmp/bzzy-public-terminal-transfer-verified.json`, and
`/private/tmp/bzzy-installed-agent-settings-lifecycle.log`.

The signed production iOS archive and IPA include APNs metadata, production push
entitlements and required-reason privacy declarations. They have not been uploaded
to TestFlight. The user chose direct Xcode development testing instead of publication.
A separate Debug 0.1.0 (2) build was successfully signed, installed and launched on
the connected physical iPhone 15 Pro Max, and the user confirmed seeing the app.
Its development profile includes that device; signature/privacy validation passed;
launch arguments were empty, with no demo/test flags. Installation preserved app
data and Keychain. Evidence is under `BZZY-IOS/.build/DeviceTest/`, especially
`result-summary.json`, `signing-validation.log`, `install.json` and `launch.json`.

The user owns the next manual QR pairing and approval. No invitation or grant was
created for this physical-device step by the agent. Physical phone-to-Core behavior,
camera pairing and background delivery are not established by installation alone.
Debug uses APNs sandbox; Release/TestFlight uses production. The actual Mac currently
has no APNs configuration, enabled device registration or Apple-accepted delivery;
private owner configuration and actual phone verification remain required.

Typed complete-context Agent packages and iPhone-controlled receipt on Core are
implemented, alongside Terminal receipt into receiving CLI cwd. Agent imports use
fresh managed identities, explicit recipient provider selection and inactive work.
Persistent Agent v1 adds bounded safe project/context reads and durable Core tools;
native shell/write, unapproved HTTP/delegation/accounts and scheduling are not
exposed. See AGENT-EXECUTION.md and PROJECT-SHARING.md. Scheduling and production
account connectors remain proposals. TestFlight is deferred by the user. The earlier
CLI provider lookup failed, while a later Organizer attempt resolved the account
and reached app-record creation. The App Store name BZZY was unavailable; subsequent
record creation failed, and the visible App Store Connect account requires the
Account Holder to review an updated Developer Program agreement. No agreement was
accepted and no successful upload is claimed. These publication prerequisites are
separate from the completed development install and pending physical phone testing.

macOS user launchd and Linux user systemd supervision reuse the existing daemon;
native Linux installation/reboot recovery remains untested. Ordinary terminal
native-backend read limits are distinct from the bounded persistent Agent policy;
prompt policy or a broker grant alone is not an OS vault.

# Earlier Core / CLI extraction validation

Validated on macOS with Node.js 24.22.1. All execution tests use isolated
private BZZY_HOME directories, offline model fixtures and loopback networking.
No production model account, email account, deployed Relay enrollment, or real
iPhone session was used for this refactor.

| Check | Result |
| --- | --- |
| Core suite | 84 passed, 0 failed |
| CLI suite through scripts/test.mjs | 334 passed, 0 failed, 21 platform-specific skips |
| Relay transport/security suite | 19 passed, 0 failed |
| Core and CLI JavaScript syntax checks | Passed |
| Self-contained CLI and Core packaging/install regression | Passed in the CLI suite |

Total: 437 passing tests, 21 skipped tests, no failures. The skipped cases are
predominantly Linux-only PTY integration scenarios; the unsupported-sandbox case
also skips when the native macOS sandbox is available. Other platforms have not
been exercised by this run.

The checks exercise these extraction requirements:

- Core's production imports and process entry points stay inside its package.
  An isolated physical Core copy with no CLI folder starts its real daemon,
  executes an offline provider turn, and restarts/replays without duplicate work.
- CLI legacy imports reuse Core's engine; ordinary chat, goals, model/provider
  switches, recovered context, request idempotency, pause/cancel, and all existing
  multi-agent strategies retain their integration tests.
- Core's coordinator is independently configured. CLI chat/mode defaults do not
  change it; explicit copies are snapshots; old live-CLI bindings require setup.
  Core's configuration API/commands retain provider/model/effort selection using
  the shared live catalog outside the minimal CLI Settings menu.
- Canonical rich bodies survive execution, durable events, cursor replay and
  restart. CLI renders validated blocks/styles without rewriting the original
  body or JSON. The TUI's actual frame contains the expected emphasis and colors;
  plain clipboard text, NO_COLOR, narrow layouts, malformed input and streaming
  boundaries have regressions. All conversational roles receive the shared
  format instructions; document artifacts retain their requested format.
- Existing encrypted Relay gateway behavior, exact grant scopes, revocation,
  replay cursors, local-first denial, uncertain commands and transport reconnects
  remain covered. Relay source/protocol behavior was not replaced.
- Temporary release workspaces pack both products, remove the source trees, and
  install/run the bundles offline. Private notes, credential fixtures, .npmrc,
  AppleDouble metadata and archive traversal paths are excluded. Original source
  and dependency metadata are retained after package staging.

Commands used with the Node 24 executable:

    BZZY-CORE: node scripts/check.mjs
    BZZY-CORE: node --test test/*.test.js
    BZZY-CLI/BZZY-CLI-TERMINAL: node scripts/check.mjs
    BZZY-CLI/BZZY-CLI-TERMINAL: node scripts/test.mjs
    BZZY-RELAY: node --test test/relay.test.js test/security.test.js

Existing provider/sandbox limitations and unimplemented agent CRUD, scheduling,
APNs and portable sharing are not removed by an ownership refactor. See
ARCHITECTURE.md for the actual boundaries. Native iOS rendering was not changed;
the canonical contract is BZZY-IOS/message_format.txt.

# Historical facade validation (before engine extraction)

The package is tested with a temporary Node.js 24 runtime. All automated tests
use isolated temporary `BZZY_HOME` directories and offline model fixtures, plus
an actual loopback Relay. No live model account, cloud email account or iOS client
is used. A separate opt-in production transport probe is recorded below.

Recorded result on macOS, Node.js 24.22.1:

| Check | Result |
| --- | --- |
| Core JavaScript syntax | Passed |
| Core unit, actual-daemon and encrypted loopback Relay tests | 60 passed, 0 failed |
| Deployed Relay health, normal TLS and signed disposable candidate connection | Passed; no host enrollment or pairing |
| Workflow template YAML and shell syntax | Passed; matrix jobs not run |
| npm production dependency advisory check | 0 reported advisories; not a security audit |
| Selected existing CLI tests | 25 passed, 9 fixture failures, detailed below |

Linux descriptor traversal still requires validation on a Linux host; the macOS
run does not establish that platform's behavior. The current local Docker CLI
has no running daemon, so no Linux container execution is claimed. The prepared
[platform workflow](ci-platforms.yml) covers Debian, Ubuntu and native macOS;
its presence is not evidence of a completed CI run. See [PLATFORMS.md](PLATFORMS.md).

Commands from `BZZY-CORE`:

```sh
npm run check
npm test
# Optional live transport-only check:
npm run relay:smoke
```

Coverage:

- Existing session format, SQLite authority, JSON compatibility export and no
  inference on conversation creation.
- Concurrent conversation retry, conflicting idempotency input, and preserving
  later state when a creation acknowledgment is retried.
- Separate processed cursors per session/consumer; handler failure, abort and
  concurrent processor conflict.
- Existing explicit acceptance checks rejecting unsupported completion claims.
- Exact reuse of the mandatory generation security policy.
- Broker default denial, fixed model-facing API and principal isolation across
  user, workspace and agent dimensions.
- Binding capability/expiry limits, secure adapter reattachment after restart,
  revocation before and during a call, and per-principal rate limiting.
- Rejection of writes, unexpected input/output fields and inherited schema keys.
- Filesystem traversal, absolute paths, symlinks, hardlinks, replaced directory
  roots, known credential files and private runtime data.
- Bounded read results with host observation provenance and slice hashes;
  independent authorizations for multiple project roots.
- Audit/error minimization without persisting arguments, results or raw adapter
  error messages.
- Actual shared daemon discovery, offline model execution, duplicate request
  suppression, continued execution after release, scoped observer denial,
  cross-session denial, SSE replay, grant revocation and service restart.
- CLI default inheritance, independent Core selection, stale settings conflicts,
  idempotent edits, fresh internal contexts and snapshot stability after default
  changes. Neither setup nor context creation starts inference or copies accounts.
- Real Relay SDK cryptography, host enrollment denial, independent fingerprint
  confirmation, exact locally authorized scope, principal-bound input ownership,
  bounded protocol allowlists, credential redaction and metadata tampering denial.
- Background tasks using the configured AI on the same existing execution queue,
  scoped receipts/status, conflict rejection, uncertain acceptance reconciliation
  and denial of global administration through session grants.
- Explicit processed event acknowledgments across gateway restarts, transport
  receipts not advancing cursors, cross-resource denial, oversized event closure,
  live subscription revocation and offline revocation outbox recovery.

These tests establish the listed local boundaries. They do not establish real
OAuth interoperability, independent correctness of model conclusions, adversarial
macOS directory-race confinement, Linux container behavior, real Node/Swift
interoperability, production email workflows/scheduling, APNs delivery or import
safety. The actual home host has not been enrolled/paired by this work, and no
CLI/iOS setup screens were modified. Restricted native execution through the new
tool broker remains unimplemented.

The live `relay:smoke` probe returned health success, `tls: "verified"` and
`authenticatedCandidate: true`, with `hostEnrollment: false`. Its identity was
disposable and in memory. It did not provision a host, register a client, issue or
claim invitations, change server configuration or write a private identity file.
Transport success alone is not evidence of a linked home host or iPhone.

Earlier engine compatibility tests were run separately from the sibling terminal
repository with `TMPDIR=/tmp` to fit macOS Unix socket limits:

```sh
node --test test/core.test.js test/notifications.test.js test/platform-auth.test.js
node --test --test-name-pattern='runtime survives client detachment|execution requests are idempotent|observer tokens cannot' test/runtime.test.js
```

The first command passed 23 tests and failed 8 existing platform-auth fixture
tests. The fixture's `BZZY_TEST_KEYCHAIN` variable is absent after the existing
environment filter, causing `claude-keychain.mjs` to call `path.join(undefined, ...)`.
The focused runtime command passed 2 tests and failed its detachment test because
`BZZY_TEST_LOG` is filtered, so the fixture never creates `backend.jsonl`.
These test files do not import the new Core package. No CLI source or tests were
changed to bypass those failures. Core's own offline runtime test explicitly
allowlists its non-secret fixture log variable in temporary configuration.
These sibling results are a historical snapshot, not a claim about later CLI
changes. The separate CLI test harness has since acquired explicit fixture
environment handling; rerun that harness for its current status.

## Own-phone defaults, paused model changes and automatic registration (2026-10-24)

- All 244 Core tests pass with test concurrency 2. The new encrypted fixtures
  cover independent defaults, exact revision/idempotency checks, scoped-grant
  denial, catalogs without a managed folder, pause/model-change/resume of one
  goal, retained history/budget, and same-identity registration without inference.
- Relay's 31 tests pass locally and on the Debian production host before rollout.
  Only the intended server change was deployed; its baseline matched the repo.
  Health/TLS and loopback-only port 8787 were verified after restart. A disposable
  external WSS host registered twice and reconnected with the same ID; the single
  public test record was then removed. No endpoint private keys were uploaded.
- CLI's full suite passes (440 pass, 21 platform/optional skips), with subsequent
  Settings tests covering whole-card hover and both additional masked key stores.
  Real macOS PTY launches of each mode flag reached goal entry with its saved
  models/count, without a selector or execution, then cancelled cleanly.
- The iOS simulator build succeeds. All 84 native Swift model/transport tests
  pass, exercising the existing encrypted Core line; added tests validate default
  settings/session selection responses and exact paused-goal request fields.
  A physical phone interaction with the new screens remains a manual check.

Normal reinstalls retain one identity only while the same private BZZY_HOME is
preserved. Full private-state deletion creates a fresh identity deliberately.
The installed user CLI/Core and physical iPhone were not automatically updated.

## Updater installation-location recovery (2026-10-24)

All 244 Core tests and the CLI suite (444 pass, 21 platform/optional skips) pass.
The updater cases use disposable local Git remotes and verify that source edits,
untracked projects, detached/local-only history, custom paths and old dependencies
remain byte-for-byte intact while launchers activate a separately staged official
revision. Cached dirty/incomplete releases are retained and bypassed. Standalone
Core packages use the same release installer. Two additional Python-bootstrap
fixtures pass for managed-launcher discovery and explicit custom paths from an
unrelated cwd, with whitespace/apostrophes in installation paths. They verify
exact revision selection and preservation of the original source. No real
installation is updated by these tests.

## Linux root host supervision (2026-10-24)

All 247 Core tests and the CLI suite (454 pass, 21 platform/optional skips) pass.
Three new cases verify root-owned system-unit plans, exact system-manager
arguments, lifecycle stop barriers/restart behavior and retained private state.
Regular-user manager scope and macOS non-root behavior retain their existing
checks. On Debian 13 under actual UID 0, the same three isolated lifecycle tests
pass and two disposable Core/Relay identity/registration cases pass with no model
execution. These checks use temporary state and a fake lifecycle manager; no
production Core service or user installation was changed. Native boot/reboot
supervision of the new root system unit remains a deployment check.
