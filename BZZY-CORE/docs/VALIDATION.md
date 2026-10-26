# Library removal and named/workflow launch controls (2026-10-26)

Node.js 24/macOS full suites: **773 Core tests passed, 2 skipped** (775 total)
and **749 CLI tests passed, 21 skipped** (770 total), zero failures. Core and CLI
syntax and whitespace checks pass.

Right-click/F10 on an actual skill, agent, workflow or saved-goal row opens its
entry menu. Remove requires default-Cancel confirmation and rechecks the displayed
identity/scope/version plus private host, session, active tab, cwd and panel after
the prompt. Tests exercise all four actual terminal menus, Cancel/Escape, unknown
or reused local requests, same-name scope separation, concurrent revision changes,
removed/recreated goal text, host/session changes, preserved drafts and no model
execution. Native skill/agent/workflow deletion retains existing history and pins;
a removed selected workflow becomes unavailable for future new goals.

Core adds revision-checked saved-goal template removal with tombstones and removal
receipts. Listing/export excludes removed entries; active execution/goal history
and evidence remain separate. Explicit saving restores the same immutable text
with a new revision, invalidating old picker/removal tokens. Damaged tombstones
fail closed. An accepted Library import retry cannot undo the recipient's removal.

`bzzy --attach NAME` resolves existing aliases/IDs/prefixes or creates an idle named
terminal using ordinary chat defaults and the caller's cwd. Existing terminals
retain their original model/cwd/history/goal, and opening never replays work or
claims input. Per-name identity-checked locks cover the resolve/create gap, with
bounded contention waits; concurrent child processes create one alias once.
SQLite's busy timeout is installed before WAL initialization to avoid the cold
startup contention exposed by this check. Ambiguity stays an error. Read-only
views and update handoffs remain strict existing-session lookups.

`--workflow NAME` selects before ordinary chat/new-goal admission and composes
with named attachment; `none` clears future selection. Unknown definitions fail
before new session/task creation. Tests check project/global resolution, direct
and request-ID goal creation, immutable running-goal pins, and accepted retries
after the original definition is removed. Saved-goal resumes reject overrides.
Actual CLI subprocesses create, reopen/replay and select/clear workflows with no
inference, duplicate sessions or goal execution.

New tests use isolated temporary homes and synthetic/offline models. No user
Library entries were removed, target testing performed, or running installation
updated/restarted. User reference folders, private bindings and test artifacts
remain outside product commits.

# Live execution feedback and shared Library buttons (2026-10-26)

Node.js 24/macOS full suites: **763 Core tests passed, 2 skipped** (765 total),
**742 CLI tests passed, 21 skipped** (763 total), zero failures. Final focused
checks cover 49 CLI cases and 13 Core cases after the lifecycle refinements.
Syntax and whitespace checks pass.

Normal and minimal terminal chat now paint an animated action row with a
per-phase timer, last-output/activity age, worker activity and recent process
observations. Polling/animation never become model progress or synthetic history.
Tests cover quiet output, elapsed time, command completion, overlapping tools,
Claude tool lifecycle records, stale/duplicate replay, queued-turn transitions,
new executions and conversation changes, explicit input waits, missing/stale
process observations, disconnects and frozen completion timers. The actual PTY
Validate command still starts independent review and retains missing-source
errors without a false validated badge.

Core session snapshots add only an authenticated read-only observation of the
selected execution: identity-checked runner liveness, execution ID and observation
time. Sampling is cached for two seconds per unchanged identity/state; malformed,
legacy, absent or stopped identities never assert liveness. An isolated child
process test observes its actual exit and rejects a mismatched birth identity.
This detects process presence, not model reasoning progress or verified completion.
No durable heartbeat, permission change or provider call is added.

Skills, Agents, Workflows and Goals share terminal button layout with spaced
Import/Export toolbars, focus backgrounds, narrow-width wrapping, disabled-button
handling and exact clickable cells. Gaps cannot trigger adjacent transfers.
Name/toggle actions, revision/context pins, manual goal saves and existing typed
Relay transfers remain authoritative. Chat drafts are hidden during browsing and
preserved on return. Tests exercise all four real libraries at 40/60/90/120
columns, plus smaller synthetic layouts, keyboard ordering and Unicode switches.
Rendered 100-column previews were also inspected for the four tabs and live chat.

No live model request, target test, running-installation update or service restart
was performed. Preview images and synthetic private homes are outside the repo;
user reference folders and private account bindings are excluded from publication.

# Workflow and Goals tabs; manually saved goal Library (2026-10-26)

Node.js 24/macOS: **760 Core tests passed, 2 skipped** (762 total) and
**734 CLI tests passed, 21 skipped** (755 total), zero failures in the final
full runs. The final picker/context regression run passes all 28 cases;
the final Core template/Library regression passes all 29 cases. Syntax and
whitespace checks pass.

The terminal exposes Workflows and Goals beside Skills and Agents. Compact
headers retain all actions down to 40 columns, wrapping controls and moving
host metrics to another row when needed. Mouse/keyboard checks cover these
sizes, Back/Escape, unsent drafts and nested goal editing. Bare `/workflow`
opens a direct dropdown including None; plural `/workflows` is removed from
slash dispatch/help/completion, while owner `bzzy workflows` commands remain.
Selections pin context and revisions and never start model work.

The Goals tab explicitly saves new/current objectives into Core's existing
immutable template registry. Bare `/goal` lists only saved/imported templates;
`/goal <objective>` executes normally without adding a Library entry. Execution
and replacement history remain durable and separate. Tests cover exact multiline
reuse, status/resume objectives as data, paging, cancellation, stale contexts,
manual deduplication, read-only browsing, normal replacement/permission checks,
and Library export/import excluding execution history. Importing matching text
from an executed goal still installs a missing saved template. Original evidence,
outcomes, models and permissions never become template authority.

The real PTY `/validate` regressions pass with the attached terminal's current
composer labels. One initial concurrent runtime identity-reuse fixture mismatch
passed in its isolated 15-case file and the subsequent full CLI run without
runtime code changes. No live provider request, target testing, service restart
or running-installation update was performed.

# Portable bug bounty workflow and specialist pack (2026-10-26)

Node.js 24/macOS: **756 Core tests passed, 2 skipped** (758 total), zero failures.
Core syntax and whitespace checks pass. The final two pack checks independently
validate the compact workflow and corrected reporter after content review.

The optional asset pack contains 25 self-contained specialists with simple
`-agent` names, shared G1-G8 gates, matching class criteria and evidence/report
handoffs. Complete authoring files are 105–142 lines and instruction bodies fit
the existing 16,000-byte schema limit. Definitions omit provider/model/effort
and permission grants. The compact goal workflow routes bounded hypotheses to
these agents, preserves admitted criteria for independent review, and loads
`vuln-report-writer` only after confirmation, supervisor review and two saved
reproductions. The full methodology remains a separate reference asset.

The pack test uses real Core registries and Library ZIP export/import between
isolated homes. It checks all 25 complete instruction/version pins, enabled
discovery, workflow text, reporting skill, duplicate import and no created
sessions/executions. Embedded criteria remain behavior instructions; this change
does not add a machine vulnerability verifier or claim live-model accuracy.

On the explicitly requested local host, the previous 16 global security
specialists were backed up and replaced through Core's revision-checked owner
APIs. All 25 replacements are enabled and visible through the installed CLI.
The workflow was added globally without selecting it for an existing goal. The
existing reporting skill was corrected to use permitted project output paths,
private bindings instead of published credentials, and current program taxonomy,
then enabled. Native runtime code, running sessions, workflow selections and
Core service installation were unchanged. No target test, provider inference or
external report submission was performed. Private backups, generated install
documents and the user's reference folders remain outside product commits.

# CLI input handoff and approval controls (2026-10-26)

Node.js 24/macOS full suites: **754 Core tests passed, 2 skipped** (756 total)
and **727 CLI tests passed, 21 skipped** (748 total), zero failures. The final
approval/dropdown/chat/layout regression run passes all 58 cases. CLI syntax
and whitespace checks pass.

An expired or released input lease no longer produces a false "another client"
notice or turns an active attached terminal into a locked viewer. A different
current owner still produces the handoff notice. Attached viewers retain Send
and pending Approve/Deny controls through the same UI admission predicate used
by their action handlers. Their explicit response uses existing Core input
coordination; opening, polling and rendering never claim a lease. Read-only
views retain disabled approval controls and cannot send input.

Regression fixtures use the real Core daemon, durable question records and SGR
mouse clicks to answer pending requests with no owner, after lease expiry and
after another client takes control. Core records the exact yes/no answer and
actor, while the draft survives and no model execution is created. Compact,
wide, normal and minimal views are covered, including disabled read-only mouse
and keyboard paths. Existing Core transfer permissions, question expiry,
identity checks and idempotency are unchanged and remain covered by its suite.
All state is synthetic in private temporary homes. No real pending request was
answered, running installation updated or provider inference submitted.

# Experiential manual effort controls (2026-10-26)

Node.js 24/macOS full suites: **754 Core tests passed, 2 skipped** (756 total)
and **725 CLI tests passed, 21 skipped** (746 total), zero failures. Both syntax
checks and whitespace checks pass. The focused provider/model/default-settings
and terminal dropdown checks pass (14 Core and 41 CLI cases).

Experiential effort editing now uses Core-owned manual request levels: None,
Minimal, Low, Medium, High and Max, plus Default. It requires no catalog lookup
or credentials and works with stale disabled, empty or narrow saved capability
metadata. Model selectors retain an explicit manual effort while preserving
actual catalog metadata separately. All six values save through independent
Core and Consensus & Compactor APIs and reach Codex's Responses launch
configuration unchanged. Default adds no implicit effort; saved xhigh remains
compatible. Other providers retain their existing restrictions.

Tests cover an unavailable catalog with zero HTTP requests during effort editing,
an empty private credential store, real terminal mouse selection, cancellation,
invalid levels and unchanged actual context/modality metadata. Full catalog
discovery, credential isolation and sanitized error handling remain covered.
Fixtures use private temporary homes, synthetic keys and local HTTP servers.
No running installation or production account settings changed. No paid inference
was sent; the gateway's effective effort, adjustment or rejection is not verified
by these fixtures.

# Experiential selected-model effort refresh (2026-10-26)

Node.js 24/macOS full suites: **754 Core tests passed, 2 skipped** (756 total)
and **723 CLI tests passed, 21 skipped** (744 total), zero failures. Both syntax
checks and whitespace checks pass. The focused provider/model/default-settings
checks pass with synthetic credentials and isolated local HTTP servers.

The public rich catalog contained 963 models during investigation; an unauthenticated
read using the existing 50-entry paging and eight-second deadline reached only
100 models before timeout. The selected-model endpoint returned its metadata
independently. Public metadata was also replayed through the actual parser in a
private local fixture, without an inference request or real account credentials.

CLI effort selection now asks Core for the selected model's detail, independent
of full-catalog pagination. It refreshes stale saved capability flags, handles
the detail endpoint's default-waterfall deployment IDs, normalizes advertised
levels and preserves the existing common-route restriction. Non-reasoning models
remain default-only. Errors, timeouts, redirects, mismatched slugs and cancellation
cannot silently apply stale choices or leak credentials. The adapter fixture
confirms an advertised max selection reaches Codex's reasoning configuration.
The full model list retains its existing bounded pagination.

Core and shared Consensus & Compactor defaults validate refreshed metadata,
while retaining their configuration APIs' accepted-level constraints. Tests cover
saved stale disabled flags, default-only models, unsupported selections, native
mouse selection and unchanged independent defaults. No provider IDs or effort
lists were added to the TUI. No running installation or production account
settings changed; paid inference behavior was not exercised.

# CLI Goals/Workflows transfer, Cooking status and word deletion (2026-10-26)

Node.js 24/macOS: **751 Core tests passed, 2 skipped** (753 total), and
**721 CLI tests passed, 21 skipped** (742 total), zero failures. Both product
syntax checks and whitespace checks pass. Focused transfer/navigation cases and
51 keyboard/private-screen regressions also pass. Fixtures use canonical private
temporary homes on the internal disk, synthetic data and local Relay servers.
No running user installation, real clipboard, private Library or production Relay
was changed; iOS is unchanged.

Saved goals and Workflows reuse the checkbox Export → EXPORT CODE/Copy and
Import → ENTER CODE → download/check/install flow. An empty saved-goal list still
offers Import. Owner-only goal labels use readable objective text while exact
identity/revision/content pins guard the selection. Unchecked blocked text and
later additions are excluded; stale selected sources cannot publish a code.
Missing-only imports preserve existing goal text, scoped workflow names and the
current workflow selection, without starting goals or model work. Tests inspect
real archives and missing-only/retry imports, alongside encrypted four-kind
transfers into an independent recipient home using the existing Relay contract.

Ordinary chat displays Cooking from admitted running execution state. Queue,
startup, stopping and input waits have separate labels. Completion, failure,
pause and cancellation remove the indicator, while goal runs keep their existing
status treatment. The feedback creates no durable message or invocation receipt.
Rendering is checked in ordinary/minimal layouts at 60, 80 and 140 columns.

Option+Delete/Alt+Backspace, Ctrl+W and reported Ctrl+Backspace delete the preceding
word at the cursor. The decoder handles legacy, CSI-u and modifyOtherKeys packets,
including split input, Unicode, repeats and ignored releases. Alias/model search
and private-prompt checks preserve the chat draft; bracketed composer paste cannot
activate word deletion. Escape, arrows, mouse events, private codes and existing
input routing retain their regressions. These checks drive raw packets through
the real decoder; physical terminal shortcut mappings were not exercised.

# iOS compact footer, recorded invocations and 20-entry history (2026-10-25)

Build **Debug 0.1.0 (22)** passes the **86-test native Swift suite** plus one
new cache-hold regression (**87 distinct cases**), model/message-format checks,
and **7 focused UI cases** across simulator runs. UI results cover the compact
footer and invocation rows, paging through 225 messages and returning to Latest,
normal/accessibility text, offline locking, voice access in Settings, repeated
Back/sheet/gesture transitions, drafts and relaunch. Screenshots were inspected.

Opening chat renders the latest 20 cached entries; older reads reveal batches
of 20 with stable message anchors and bounded rendering. Incoming events remain
saved and acknowledged while the reading window is held. Latest restores the
current tail. The existing protected raw-event cache and authoritative Core
history remain separate; caches never establish connectivity or permissions.

Skill rows require actual Core load receipts. Agent rows use scoped assignment
events, preserve returned report text, keep follow-up/review ordering and dedupe
replay. A missing cached creation event retains the actual result under a generic
worker label; backfill restores the name without changing the row identity.
Loaded instructions and an accepted assignment review do not establish a verified
goal outcome. iOS adds no live token/time counters or generated summaries.

The signed app passes development APNs metadata/entitlement, privacy, signature
and existing app/device identity checks. It was installed in place on the paired
iPhone; CoreDevice confirms **0.1.0 (22)**. Automatic launch was blocked by the
phone lock. No uninstall, app-data reset, pairing
reset or running CLI/Core update was performed. Fixtures use synthetic events and
private internal-disk temporary directories. Real provider work, physical speech
capture and a live phone agent invocation were not exercised by these UI tests.

# Paste-once Library codes, Copy button and import progress (2026-10-25)

Node.js 24/macOS full suites: **748 Core tests passed, 2 skipped** (750 total)
and **710 CLI tests passed, 21 skipped** (731 total), zero failures. Both product
syntax checks and whitespace checks pass. Focused transfer suites passed **39
Core tests** and **55 CLI tests**. Fixtures use private temporary homes on the
internal disk, synthetic identities and local Relay servers. No running user
installation, real clipboard, private Library entry or production share changed.

The source selects names once and receives EXPORT CODE with a clickable Copy
code button and immediate C shortcut. Clipboard failures cannot claim success;
native copy and OSC52 request feedback differ. The recipient pastes into ENTER
CODE and sees authorization, actual-byte download progress, package validation
and installation. No second picker/fingerprint input is needed for new Library
codes. Completion lists only new names; existing entries and availability remain
unchanged. Accepted receipt metadata prevents retries from reporting old entries
as newly installed. Back leaves a code owned by Core until its ten-minute expiry;
explicit Revoke remains available.

New code approval is a Library-only owner option. A Core-generated secret, sender
pin and archive hash travel in the private code, with an encrypted HMAC proof
bound to the exact recipient/grant/archive. Tests deny manifest access to a
Relay-token holder without proof, reject altered secrets/archive pins/wrong
kinds, exercise 15-second provisional expiry, queue concurrent transfers and
revoke late grants during Core shutdown. Secret/code/plaintext bytes do not enter
Relay invitation/grant metadata, audit fixtures or observed host wire frames.
Legacy manual codes and full-session approval retain their existing behavior.

An actual encrypted multichunk transfer through a real local Relay into an
independent recipient process imports the new agent/workflow/goal and skips the
recipient's existing disabled skill unchanged, without manual approval or model
execution. Terminal tests exercise mouse Copy/Revoke, C without Enter, masked
paste, progress stages, new-name-only results, cancellation and draft/cursor
preservation. Deployed cross-host testing of this new code mode remains a user
update check; its Relay wire operations are unchanged.

# Remove obsolete terminal GUI fallbacks (2026-10-25)

Node.js 24/macOS: **705 CLI tests passed, 21 skipped** (726 total), zero
failures. The focused terminal/transfer/settings suites passed **114 tests**;
the CLI syntax and whitespace checks pass. Core/Relay execution code is
unchanged. Fixtures use private temporary homes on the internal disk; no running
installation, user Library entry or live share was changed.

The old persistent dashboard header, model/Save strip, panel-tab row and eye
animation renderer were removed from the TUI. Activity and HTTP use the current
terminal shell. Import, generated-code screens and pairing QR use compact text
headers in ordinary and minimal mode; opening a different screen cannot select
the obsolete layout. Weekly account quotas remain visible in Activity. Actual
checkbox popups now render the name column heading, not just their body fallback.

Tests cover private transfer screens across 50×20, 80×24 and 150×42 terminals,
Back/cancellation, draft/cursor restoration, code exclusion from chat/history/frame
caches, output backpressure and normal panel navigation. Pairing retains every
QR module and its full white quiet zone inside 80×24, with working copy/open/back
controls. No real provider or production Relay call was needed for this frontend
change; physical-device scanning was not repeated.

# Name-only Skills/Agents and Relay checkbox transfers (2026-10-25)

Node.js 24/macOS full suites: **739 Core tests passed, 2 skipped** (741 total)
and **704 CLI tests passed, 21 skipped** (725 total), zero failures. Both syntax
checks and whitespace checks pass. Fixtures use private temporary homes on the
internal disk. No running installation, user Library entry, live model or
production Relay invitation was changed.

Primary Import/Export actions now use Relay with name-only checkbox tables.
Export automatically prepares a code for the exact checked source versions;
unselected broken packages do not block it. Import validates the entire archive
and commits only checked missing names of that tab's type, enabling those entries
without execution. Existing names and ON/OFF states remain untouched. Exact
subset retries preserve owner decisions using separate durable receipts, while
all-entry imports retain legacy receipt identity. Legacy ZIP APIs/routes remain
compatible. Main Library rows omit descriptions and model details; opening an
entry still provides its complete definition and provenance.

Tests cover source pin changes, additions after listing, malformed selections,
subset receipts, duplicate scoped names, wrong-type codes, cancellation, existing
entries and real terminal checkbox/button input with draft retention. A real
encrypted local Relay transfer into a separate recipient process imports one
selected skill from a four-kind archive and creates no other definitions or
executions. Fingerprint approval, expiry, revocation and private code handling
remain enforced. This does not establish deployed Relay or Mac-to-Linux readiness.

# Simple Skills/Agents tabs and type-specific ZIPs (2026-10-25)

Node.js 24/macOS full suites: **734 Core tests passed, 2 skipped** (736 total)
and **697 CLI tests passed, 21 skipped** (718 total), zero failures. Both syntax
checks pass. The final library/navigation changes were rechecked with **57 tests
passed**, including reopening Skills after a Codex-import view. Whitespace checks
pass. Tests use private temporary homes on the internal disk; no running product
installation, private Library entry, model or Relay invitation was changed.

Skills and Agents show plain Import/Export controls and their Library entries.
Workflow, creator, manual-create and Relay shortcuts are hidden from those tabs;
creation uses `/create-skill` and `/create-agent`. Existing command routes remain
compatible. Type-specific export inventories omit the other resource type and
retain that selection through filename changes and source revalidation. Selected
imports validate the complete ZIP before installing only the reviewed type.
Tests cover actual Core export/import, resources/scopes, mixed-file compatibility,
wrong-type/empty selection, malformed selectors, tampered review kinds, corrupt
unselected resources and old backends ignoring the requested type. No scripts,
models or agents execute during these operations.

# Native Core creators and portable skill repairs (2026-10-25)

Final Node.js 24/macOS suites: **732 Core tests passed, 2 skipped** (734 total)
and **695 CLI tests passed, 21 skipped** (716 total), zero failures. Both product
syntax checks and whitespace checks pass. Tests use private temporary homes on
the internal disk and synthetic model/catalog/Relay fixtures; no live model,
email, security target or production share invitation was used.

Native `/create-skill` and `/create-agent` commands ask for a name, preserve the
selected chat provider/model/effort and follow Core's shipped internal Markdown
creator guides. Tests cover immediate global availability, atomic skill enable,
Core tool discovery/reads, complete Library archive/import round trips and no
execution during publication. Existing names cannot be replaced; project
overrides cannot be silently bypassed. The menu creators retain reviewed drafts
and their existing Save behavior.

Source contexts now pin the private Core home and project directory identity in
addition to session/project/model settings. Real terminal tests cover name-entry
rendering, cancellation, command discovery with hyphens, navigation/close while
a result is pending, unsent-draft preservation, rejected private requirements,
duplicate names and model changes. Requirements and generated bodies do not enter
ordinary command history or creation status rows. The document runner retains
its no-tools profile, isolated working directory, budget and cancellation checks.

One shared portability checker now serves definition bundles, specialist text
and creator input/output validation. Ordinary authorization prose and Python
runtime references no longer become literal-credential blockers. Regressions keep
quoted credentials, inline/configuration values, multi-line values, real account
addresses, host paths, recognizable keys and malicious f-string literals blocked.
Python resources survive sender/recipient checks byte-for-byte without execution.
This remains supplementary scanning, not proof that arbitrary code is safe.

Four owner-requested private Library packages were repaired through revision-pinned
Core imports, preserving original immutable versions/history and availability
switches. Fixed account examples/defaults and a host-specific source reference
were parameterized, a public citation title retained its link without an address,
and placeholder header examples replaced literal bindings. The affected helper
now requires a supplied test inbox and does not expand it into help text. All four
packages passed the skill validator and the complete skills/agents sharing
preflight passed without exclusions. Python syntax and three offline email-input
cases passed with a network-client constructor that fails if called. Private
package contents and bindings are not part of the repository changes.

Running product installations and Relay were not updated automatically. Live
provider generation and native Linux execution remain outside this validation.

# Selective Library sharing and Experiential Labs (2026-10-25)

Final Node.js 24/macOS suites: **725 Core tests passed, 2 skipped** (727 total)
and **690 CLI tests passed, 21 skipped** (711 total), zero failures. Core/CLI
syntax and whitespace checks pass. Fixtures use synthetic credentials, private
temporary homes on the internal disk, local HTTP catalogs and isolated Relays.
Running installations, private Library definitions and the deployed Relay were
not changed. No live inference or production share invitation was created.

Library sharing now selects resource types before inspection, including the
direct `bzzy library share agents skills` route. Tests verify unselected types
are not scanned or exported; malformed, empty and sparse selectors fail closed.
Blocked packages expose constant reason text and safe resource file/line metadata
without matched account values, secrets, raw causes or private filenames. Whole
entries require explicit omission with exact identity, scope, revision and version
pins. Changed or missing exclusions and source-digest mismatches fail before an
invitation is created. Encrypted subset-transfer fixtures verify these selections
through the local-owner facade, gateway and archive builder. Portability checks
and v1 ZIP behavior remain intact; unsafe bytes are never silently stripped.

Terminal coverage includes real keyboard type selection, cancellation and stale
context, exact omission forwarding, and complete blocked-entry diagnostic paging
on compact terminals. The multi-choice picker now honors its own description
and hint instead of showing participant-validation instructions for Library types.

Experiential Labs is discovered through Core's provider registry and the existing
API-key submenu, including hidden replacement and environment override handling.
Authenticated catalog fixtures cover model slugs, organization models, bounded
pagination, repeated/incomplete pages, context/modalities, incompatible routes,
reasoning intersections and default-only reasoning when the intersection is empty.
Credential tests verify private storage, sanitized failures, redirect rejection,
subscription/tool environment exclusion and injection only into the selected API
backend. Skills and specialist-agent availability and independent coordinator /
consensus-compactor selections use the existing execution paths.

Launch tests cover the exact documented default, discovered models, non-reasoning
models and unknown manual IDs without inheriting the template ChatGPT model's
capabilities. Installed Codex 0.163.0 additionally accepted the conservative
unknown-model catalog through initialization and model listing in an empty
temporary home, without a thread, turn, inference or real authentication.
Live paid inference/tool-call behavior and native Linux execution remain
unverified. See [Experiential setup](EXPERIENTIAL.md) for upstream contract limits.

# Relay Library sharing and incremental full-session copies (2026-10-25)

Final Node.js 24/macOS suites: **707 Core tests passed, 2 skipped** (709 total),
**677 CLI tests passed, 21 skipped** (698 total), and **39 Relay tests passed**,
zero failures. All three syntax checks and whitespace checks pass. The final
receiver labels/counts were rechecked with all **32 Library, switch, share and
destination UI tests**. Fixtures use private temporary homes on the internal
disk, isolated processes and local Relays, without live model requests or user
session changes. Running installations and the deployed Relay were not updated.

Library v2 manifests include skills/resources, specialist agents, workflows and
objective-only goal templates. Tests verify exact byte inventories, complete
Unicode text, scope remapping, inherited recipient model selection, skipped
existing names/text, preserved owner enable/disable decisions, explicit enable
choice, atomic registry/audit/receipt rollback and fresh-process receipt replay.
Original goal outcomes, evidence, contracts, workflow authority, provider endpoints
and private bindings cannot enter these definitions. v1 ZIP behavior remains
compatible. Rehashed malicious packages with extra authority/model fields, unknown
files and credential/account data in resource bytes or filenames are rejected.
Blocked source goals require explicit, source-digest-pinned omission; their IDs
and private text do not enter the archive.

Real encrypted multi-chunk tests transfer all four kinds to independent recipient
Core homes in child processes, with disabled and explicitly enabled imports and
zero session/model executions. LIBRARY is strictly portable/import-only at the
Relay, grant, transfer and ZIP boundaries. Local-owner route tests reject scoped
session credentials; no phone administration command was added. Tests cover
fingerprint mismatch, cancellation of pending review, revocation before commit,
prepared-source cleanup, commit-before-completion acknowledgment and old-Relay
update errors. Existing Agent/Terminal, pairing, rate-budget and runtime tests pass.

Full-session tests cover accepted retry/restart without duplicate chats, stable
identities after an actual process death between filesystem merge and SQL commit,
missing event/file import, preserved local goal/model/messages, source-history
fork rejection, changed-file conflict rollback, trusted sender separation, deleted
chat handling and cancellation. New source BZZY metadata is versioned privately;
recipient notes/checkpoints remain intact and evidence paths reference the proper
historical copy. Original knowledge revision history remains readable with imported
truth inconclusive. Private import journals/receipts cannot be exported as package
authority or installed through raw archives. New merges require idle chats; an
exact accepted receipt can be read while recipient work is active.

Terminal tests verify private code/QR routing, hidden entry, code redaction on
failure, source/destination context pins, no writes on cancel, explicit review,
reachable long-file text pages, draft/cursor preservation and narrow/normal/wide
Library controls. The destination wizard creates folders only after approval,
rejects links/context changes, and removes only its own still-empty directories.
Difference labels distinguish new entries from existing entries that will be skipped.
Approved large transfers now survive their invitation code's earlier expiry;
a regression reproduced the prior premature cancellation before the fix. Explicit
`/cancel` revokes an unfinished approved transfer, while closing its view retains
Core-owned work. The existing validation-command fixture now uses operator-stop
before deleting its workspace: control-only shutdown intentionally retained its
active review runners and caused an observed ENOTEMPTY teardown race. Its product
assertions remain intact, with an added daemon-exit assertion and bounded removal
retries. The final full CLI run passes with this teardown repair.

A deployed Relay update is required for BZZY-LIBRARY codes. Production Relay
rollout, an actual Mac-to-Linux VPS transfer and native Linux execution were not
performed by this validation. These tests establish local protocol and storage
behavior, not arbitrary secret detection or conflict-free bidirectional file sync.

# Saved-goal picker and fresh reuse (2026-10-25)

Full Node.js 24/macOS suites: **679 Core tests passed, 2 skipped** (681 total)
and **656 CLI tests passed, 21 skipped** (677 total), zero failures. Both source
checks and whitespace checks pass. Tests use isolated private homes and offline
backend fixtures; no live model or running installation update is involved.

Core projects the current goal and replaced/cleared goal history from SQLite in
one read snapshot. Tests verify no writes or executions from listing/resolution,
exact-text deduplication, complete multiline/Unicode objectives, timestamp-based
ordering, deterministic bounded pages and durability across a fresh process.
Deleted chats, imported untrusted history, registered Agents and worker/document
contexts are excluded. An exact displayed source/revision must still exist;
source deletion or edits cannot silently substitute another same-text goal.
Only objective text and display metadata are returned, without old contracts,
evidence, workflow pins, budgets or permissions. This is a private local-owner
module, with no new scoped session endpoint, Relay command or model tool.

Plain CLI `/goal` opens a paginated picker in idle chat and the attached runtime.
Existing `/goal status|pause|cancel|clear|resume` controls remain explicit. Real
private-daemon regressions verify empty/cancelled selection starts no execution,
reused objectives receive a fresh goal identity with the current model/effort and
workflow, source acceptance/evidence/constraints are not inherited, literal
`status` and `resume` objectives remain data, replacement defaults to No, and
read-only views cannot execute. Selection still uses ordinary authenticated goal
admission and the existing exact-goal replacement confirmation.

Actual terminal tests exercise one-Enter `/goal` submission in ordinary/minimal
chat, picker keyboard/mouse behavior, narrow/80-column/wide geometry, Back/Esc,
43-entry pagination and draft/cursor preservation. Host, visible session, target
cwd, pending navigation, deleted target and changed-source checks reject stale
choices. Existing active-goal replacement, pause/resume and watcher-completion
regressions also pass. The Core/iOS goal-command parser and Relay remain unchanged.

# iOS terminal appearance and hidden mascot (2026-10-25)

Debug **0.1.0 (21)** builds for simulator and the connected physical iPhone.
The compact terminal treatment covers home, conversation, settings, connection,
sharing and voice screens: monospaced prompt rows, cyan rectangular controls,
teal user messages and lavender assistant messages. All four in-app mascot
instances are disabled through one appearance flag; artwork, animation and the
app icon remain available. No Core, Relay or execution contract changes.

ModelChecks and ChatChecks pass. The complete native Swift suite passes **86/86**
with zero skips/failures using Node.js 24 for isolated Core fixtures. The synthetic
line-model fixture now matches only the current request's exact sentinel, rather
than triggering hold/approval behavior from markers in recalled test history.
Existing hold, approval, coordinator, pause and revocation assertions remain.
No live provider or user session is used by these tests.

The latest results for **19 distinct Debug presentation/navigation UI cases**
pass across a broad run and a final five-case focused run. Rechecks cover aligned
transcript rows, native Back/edge gestures, sheet transitions, keyboard and draft
isolation, alias-only terminal rows, independent speech-language persistence,
accessibility text and voice-only controls. Broad coverage also includes offline
locking, computer selection, pairing gates, history paging, goal shortcuts,
sharing/import and structured-message rendering. Notification delivery, native
TLS authentication and the Release-only preview gate were outside this UI run.
The Back button has an explicit accessibility identifier so UI tests do not
mistake a system keyboard Back button for chat navigation.

Simulator screenshots were inspected at normal and accessibility text sizes;
scaled decorative row glyphs retain enough width. Sharing QR white backgrounds
and 18-point quiet zones remain unchanged. Plist validation, whitespace checks,
and built-app identity, development APNs, permission-description, privacy-manifest
and strict signature checks pass. Signing identity/team bindings remain local.

The signed app was installed in place on the connected iPhone. CoreDevice
confirms **0.1.0 (21)**; automatic launch was denied by iOS because the device was
locked. No uninstall, app-data reset or pairing reset was performed. Build/test
artifacts and signing metadata stay in a private temporary directory on the
internal disk. The running Core/CLI installation was not updated.

# In-chat skill and specialist invocation status (2026-10-25)

Full Node.js 24/macOS suites: **671 Core tests passed, 2 skipped** (673 total)
and **639 CLI tests passed, 21 skipped** (660 total), zero failures. The final
UI liveness recovery adjustment was rechecked with all **15 invocation UI/chat
tests**, including unknown-to-verified-running recovery and rejection of stale
running snapshots after review. Both syntax checks and whitespace checks pass.
All execution fixtures use isolated private homes; no live model request or
running installation update is part of this validation.

Actual main skill loads produce one receipt row, and validated worker ancestry
mirrors the exact receipt to the root chat atomically. Metrics still counts once;
failed root publication rolls back the receipt and child event together. Tests
cover unrelated sessions and nested review workers. The current session API
adds a read-only, bounded direct-assignment projection, tested through a real
daemon and scoped observer credentials without inference. Process identities,
paused/context/review/stop outcomes, missing records, legacy identities and page
truncation have explicit presentation states; reads never reconcile records.

CLI tests exercise one updating named-agent row, loaded skill rows, distinct
same-model identities/colors, duplicate and old-round replay, silent stop/current
snapshot reconciliation, session changes, hidden tool rows, Unicode and narrow/
80-column/wide ordinary and minimal layouts. Actual response-copy and plaintext
tests preserve complete structured replies across interleaved invocation events;
JSON output retains its original event format. Rows contain names/status rather
than task prompts, arguments or raw worker reports. Generic Delegate and Validate
presentation remains separate, and worker completion never awards goal success.

# Session workflows and pinned goal instructions (2026-10-25)

Final Node.js 24/macOS suites: **661 Core tests passed, 2 skipped** (663 total)
and **624 CLI tests passed, 21 skipped** (645 total), zero failures. Both syntax
checks and `git diff --check` pass. Tests use isolated homes and offline provider
fixtures; the running installation was not updated.

The workflow picker supports direct selection, exactly one checked entry, None,
creation/import, complete previews, revision-pinned edits/deletion and Back/Esc.
Tests cover initial selection before the first goal in the same idle terminal,
loaded-name clicks in ordinary/minimal chat, narrow/80-column/wide geometry,
draft preservation, stopped-Core Back and private command history. Captured row
commands cannot affect another terminal or private host after refresh, including
matching names, IDs and revisions.

Registry/admission tests cover project/global isolation, immutable versions,
stale revisions, deleted selections, invalid files/links/private paths, explicit
None and legacy behavior, replay, atomic rollback, known context limits and
tampered receipts or context. Native adapters for Codex, Claude, DeepSeek,
Abliteration and OrcaRouter receive every line of a long workflow before their
first model action. Delegate, Parallel, Besties and Validate mission paths retain
it across follow-ups, restart, model changes and later definition edits/deletion.

Inert account-reference placeholders and their trailing control instructions
survive worker handoffs unchanged. Configured secrets, actual credential fields,
same-line secrets and malformed/attached reference values remain redacted.
Workflows requiring any mission-text redaction are rejected explicitly. Ordinary
and shared project ZIP tests preserve historical instructions while excluding
private workflow definitions, selections and execution admission authority.

The detached operator-stop fixture now logs inside its existing writable sandbox
root and waits for a real native turn. Its previous external log path caused
EPERM during startup; process-only readiness could mistake that transient launch
for active work. All process-exit, interrupted-round, paused-goal and retained
history assertions remain enforced.

# Library availability switches and goal usage (2026-10-25)

Final Node.js 24/macOS suites: **624 Core tests passed, 2 skipped** (626 total)
and **603 CLI tests passed, 21 skipped** (624 total), zero failures. Both syntax
checks and `git diff --check` pass.

Skills and Agents Library rows expose separate clickable ON/OFF and name
controls, with keyboard selection, Enter and Space. Width checks cover narrow,
80-column and wide layouts while retaining switch and scope labels. Tests cover
stale revisions, host/session changes, draft/cursor preservation, preview actions
and disabled-agent Use controls.

Core tests retain legacy-enabled definitions, immutable content pins and owner
views of disabled entries. Model discovery/reads, new requests, generic follow-ups
and deferred worker admission recheck enabled state. Running workers can finish
their existing reports. Scope shadowing and CAS failures cannot silently select
a global fallback or alter another entry.

A live-goal ToolHost integration exercises enabled skills and named specialists
across Codex, Claude, DeepSeek, Abliteration and OrcaRouter selections, using an
offline dispatch fixture. Goal/chat Metrics count admitted uses once, reject
disabled attempts and duplicate requests, and preserve totals after re-enabling.
Provider models and external targets are not invoked by these tests.

# Validation reports, automatic Library skills and creation alerts (2026-10-25)

Final Node.js 24/macOS suites: **612 Core tests passed, 2 skipped** (614 total),
**598 CLI tests passed, 21 skipped** (619 total), and **37 Relay tests passed**,
zero failures. All three syntax checks and `git diff --check` pass.

Final-review tool schemas, prompts and host parsing now share exact decision
fields and status enums. Native tool-bridge coverage submits two malformed final
reports, receives actionable errors and corrects both in the same worker round.
The complete independent/final acceptance path preserves optional concern-list
semantics, attributed caveats, scoped evidence and the original source badge.
Negative/null claims, stale bindings, unsupported impact and uninspected evidence
retain their existing rejection gates. Saved historical outcomes are not upgraded.

Learning tests exercise actual job publication into enabled project Library
entries, no-clobber naming, immutable history, mandatory security instructions,
source provenance, transactional rollback, scoped/CAS deletion and durable
receipts that cannot replay a deleted or disabled skill. CLI checks cover an
already-open Library, learned labels, source/history views, immediate disable,
Cancel-first deletion, stale/foreign/historical guards and draft-preserving Back.

Background adapter failures retain only fixed startup stages and safe RPC/OS
codes. Tests reject forged zero-usage metadata; only genuine failures before
model dispatch settle at zero. Unknown failures retain conservative accounting.
A separate network-denied probe of the installed native adapter passed startup,
profile checks and ephemeral thread creation without sending a model turn; the
historical discarded failure reason could not be reconstructed.

Creation alerts exercise atomic registry/outbox publication, bounded sanitized
descriptions, current-definition receipts, deleted/recreated generations,
own-phone-only authorization, mute/revoke and durable retry IDs. An authenticated
loopback Core-to-Relay test reaches the real Relay push service and mocked APNs,
covering creation titles and existing iOS navigation fields. No physical iPhone
notification was sent and no public Relay was deployed. Relay-routed creation
alerts require the corresponding Relay update; direct Core APNs remains supported.

# Verified updater handoff and recovery (2026-10-25)

Final Node.js 24/macOS suites: **580 Core tests passed, 2 skipped** (582 total)
and **591 CLI tests passed, 21 skipped** (612 total), zero failures. Both syntax
checks and `git diff --check` pass.

Handoff checks cover healthy and unhealthy engines, loaded waiting jobs without
a PID, missing manifests, supervisor failures and listener removal before the
captured control process exits. Standalone source daemons still require verified
process exit; configured or observed supervisors also require native shutdown.
A real runtime restart preserves its address, observer grants and live runner.

Activation and readiness failures restore retained launchers and exact manifest
bytes, modes and execution paths behind maintenance. Recovery uses the new
stop-aware controller with the old manifest, including a different Node/account
configuration and restrictive umask. Per-attempt automatic failure gates cannot
clear explicit or legacy user Stop. Incomplete pause barriers retain their
supervisor and prevent file replacement. Success follows verified readiness.

Isolated macOS/Linux supervisor fixtures exercise public updater/lifecycle APIs
against durable provider/default settings, synthetic credentials, active/paused/
achieved goals, paired and revoked grants, terminal permissions, execution
identities, history and events. Success and failed-start rollback preserve those
records without replaying work. These are temporary fixtures, not live Linux
service-manager validation; existing platform skips remain explicit.

# Session Metrics, grouped Validate and definition ZIPs (2026-10-25)

Final Node.js 24/macOS suites: **563 Core tests passed, 2 skipped** (565 total)
and **579 CLI tests passed, 21 skipped** (600 total), zero failures. Both syntax
checks and `git diff --check` pass. No running installation was updated.

Usage tests exercise actual provider-independent ToolHost loads, once-per-run
receipts, references/pagination/previews, failed or stale calls and ordinary chat
with an older achieved goal. Real worker shapes without their own goal bind to
Delegate/Validate source goals; named chat workers remain outside goals. Tests
cover follow-up deduplication, replacement goals, linked reviews, same-directory
isolation, rebuilding, imported/legacy gaps, detached snapshots and bounded
backfill/rows. Read-only projections never write counters or start Core/models.

UI checks cover current/earlier goals, chat/outside-goal totals, status reasons,
same-name skill scopes/versions, keyboard/click controls and draft-preserving
Back/Esc. Real terminal checks exercise saved metrics with Core stopped and
80×24/42-column layouts. Validate groups interleaved events into one colored
section per agent while retaining original copy bodies and replay deduplication;
active review phases show Validating. Informational caveats reach a fresh final
review without inventing criteria or triggering unnecessary follow-ups. Required
uncertainty, unresolved objections and missing caveat dispositions still block
acceptance; no existing saved result is rewritten.

Definition ZIP tests round-trip project/global skills, scripts, text and binary
resources plus fixed agent selections between isolated homes/projects. They
check exact manifests, scopes, disabled skills, no automatic model execution,
conflicts/CAS/rollback, historical versions, source corruption, credentials and
private packages, traversal/links, filename collisions, review cleanup and final
output identity/hash races. Publisher tests force hard links unavailable, then
force exclusive rename and directory sync unavailable, while verifying existing
files remain unchanged. All archives and fixture homes stay in temporary
storage. No user drive, partition or filesystem settings are changed.

# Validate startup errors and observer handoff (2026-10-25)

Final Node.js 24/macOS suites: **527 Core tests passed, 1 skipped** (528 total)
and **565 CLI tests passed, 21 skipped** (586 total), zero failures. Both syntax
checks and `git diff --check` pass.

Real default CLI PTY tests submit `/validate` from an achieved attached session.
With intact evidence, the command creates a linked review and execution. With
an intact captured copy but a deleted original file, the recovery error remains
visible after long-history replay, watcher polling and notice dismissal. No
review, execution, new session or validated badge is created by failed preflight;
the original achieved goal and saved artifact bytes remain unchanged.

A separate public managed-execution test delays the final HTTP event response,
submits `/validate` during that wait and verifies the finishing parent observer
cannot close a nested review's reader. The review handler completes exactly once.
Existing pending-input, attach/model, pause, goal replacement and cancellation
coverage also passes. Provider work uses isolated offline fixtures; actual user
sessions, evidence and the running installation are not changed.

# Adaptive Validate, skill scope moves and terminal layout (2026-10-25)

Final Node.js 24/macOS suites: **526 Core tests passed, 1 skipped** (527 total)
and **562 CLI tests passed, 21 skipped** (583 total), zero failures. Both product
syntax checks and `git diff --check` pass. No running installation was updated.

Adaptive validation coverage checks strict internal assessments against the exact
original objective and criteria, any supported false blocking a majority, and
one private follow-up only for each uncertain agent. Unresolved evidence stays
inconclusive; explicit zero retries, context limits, budgets and permissions
remain enforced. Unanimous support requires a fresh final evidence reviewer and
the existing host acceptance gate. Receipt/report tampering, missing workers and
changed source or evidence cannot retain a validated badge.

Native backend fixtures exercise the actual runner through independent checks,
targeted follow-up, final review and linked source-goal validation events. Real
PTY checks cover concise natural-language messages, collapsed/expanded review
blocks, preserved chat drafts and the default terminal layout. The removed
Canvas frontend and its dedicated tests are replaced by terminal regressions;
Core's historical composition records and compatibility APIs remain supported.

Skill move coverage preserves complete portable packages and immutable history,
archives only the local registry entry, starts the global skill disabled and
rejects destination conflicts, stale reviews, foreign projects, changed hosts,
private evidence and credentials. Review, file inspection and Back/cancellation
are covered through the CLI controls. No actual user skill was moved.

All model interactions use offline fixtures. These checks establish protocol
behavior and evidence boundaries, not live-model factual accuracy.

# Default models, Back navigation and goal validation badges (2026-10-25)

Final Node.js 24/macOS suites: **497 Core tests passed, 1 skipped** (498 total)
and **562 CLI tests passed, 21 skipped** (583 total), zero failures. Both syntax
checks and `git diff --check` pass. No running installation was updated.

Default-model coverage verifies all groups in one table, provider/model/effort
separation, counts, inherited/custom shared Consensus & Compactor selection,
current-chat isolation, supported effort changes, cancelled async selectors,
draft retention and conflicting saves. Deterministic interleavings verify that
stale phone saves and project imports cannot restore older GUI defaults.
Existing Core coordinator and own-phone configuration protocols remain compatible.

Real 80×24 PTY checks verify all five Settings cards, aligned table columns,
keyboard/mouse cell selection, parent Back navigation and preserved chat drafts.
Narrow layouts stack labeled cells. Prompt/picker Back cancels approvals and
destructive choices, discards private input, and prioritizes inner popups over
background creator cancellation. Pairing QR coverage remains intact.

Validation badge tests start from host-accepted original-goal reviews, then test
latest-review ordering, pending-to-final revisions, old-goal and delayed events,
missing receipts, wrong sessions/foreign-task evidence, missing proof, changed
criteria/source bytes and imported/legacy goals. Consensus prose and matching
votes cannot award green. Read-only projections never rewrite goal status or
persist as authoritative session fields; central SQLite/JSON, alias and export
boundaries strip supplied projections. The actual execution terminal hook emits
a newer validation revision after the runner settles.

PTY badge frames exercise validated, unsupported, inconclusive and stale states
beside the original achieved goal. These are synthetic offline fixtures, not
claims of live vulnerability accuracy. Semantic and declared-contract limits
remain documented in [goal validation](GOAL-VALIDATION.md).

# Session memory, definition creators and Validate (2026-10-25)

Node.js 24/macOS full suites pass: **470 Core tests passed, 1 skipped**
(471 total), and **534 CLI tests passed, 21 skipped** (555 total), zero failures.
Both product syntax checks and `git diff --check` pass. An unsigned iPhone
simulator Debug build also passes for the renamed mode/default labels.

Session-memory coverage includes session/alias/model/mode identity, same-directory
isolation, immutable event references, streamed messages, Unicode-safe expansion,
tree generations and rebuild races, scope/credential rejection and private-value
redaction across chunks, leaves and streamed events. Oversized logical messages
are safely omitted. Compactor fixtures exercise Core selection, authentication,
idle priority, reservations and actual overage charging, unknown-request recovery,
orphan backend cleanup and real daemon stop/restart without automatic replay.

Creators use offline provider fixtures to verify current-model selection, the
native no-tools profile, ephemeral document contexts, cancellation, draft review,
strict output schemas, unchanged selection and conflict-safe saving. Real PTY
checks verify physical Escape from Settings, preserved drafts/cursors, and the
Validate block's click/Ctrl+B expansion and Escape collapse. Participant colors
stay distinct across same-model slots and supported palettes/layouts.

Validate tests retain original-goal/severity/evidence gates, independence and
minority objections; cover immediate `/validate` and legacy aliases; keep controls
and locks through Core consensus; recheck source freshness afterward; and test
exactly-once mirrored final events during concurrent Canvas observation. Original
bodies, usage and runtime survive replay, and newer parent goals stay unchanged.

These are synthetic offline checks, not live provider billing measurements or
vulnerability-accuracy evaluations. No running installation was updated. See
[session memory](SESSION-MEMORY.md) and [orchestration](ORCHESTRATION.md) for the
implemented bounds, billing limitations and verification responsibilities.

# Reusable specialist subagents (2026-10-25)

Node.js 24/macOS full suites pass: **397 Core tests passed, 1 skipped**
(398 total), and **512 CLI tests passed, 21 skipped** (533 total), with zero
failures. Both product syntax checks and `git diff --check` pass. The publish
candidate was verified separately from unrelated working-tree edits; existing
fixture executability and Relay dependencies were prepared in that checkout.

New coverage includes nine registry tests, twenty-nine runtime tests and ten CLI
Agents tests. They cover project/global discovery and isolation, strict definition
schemas and credentials, revisions/content pins, duplicate/conflicting requests,
provider/model/effort inheritance for Codex/Claude/DeepSeek/Abliteration/OrcaRouter,
isolated workspaces, policy/evidence ownership, bounded concurrency and budget
reservations, cumulative time limits and native recursion restrictions.

Actual offline provider fixtures drive the model tool call, detached assignment
runner, pinned specialist handoff, saved evidence/report and parent cleanup.
Cross-turn context answers/declines start no work; explicit follow-ups preserve
the selected specialist. New user chat directives do not invalidate unrelated
saved-goal context, while changed scope still rejects stale work. Resumed goals
exclude later chat workers from acceptance and usage. Orphans remain interrupted
until an explicit follow-up; worker claims cannot complete a parent goal.

UI coverage checks Agents at 80/120/140 columns, creation/editing/deletion,
project/global availability, inherited/fixed selections, invocation details,
multiline instructions, Esc/draft restoration and draft-only Use in chat while
another run is active. Existing top actions, model/effort/usage and host telemetry
remain visible within the tested layouts.

These checks use synthetic local provider fixtures, not live vulnerability hunts.
They do not measure finding accuracy or establish native execution parity for
every provider/model/OS combination. Existing platform/network capability skips
remain reported. See [subagent behavior and limits](SUBAGENTS.md).

# Debate and Delegate hardening (2026-10-24)

Final full suites on Node.js 24/macOS: **353 Core tests passed, 1 skipped**
(354 total), and **476 CLI tests passed, 21 skipped** (497 total), zero failures.
Both product syntax checks and `git diff --check` passed. Existing platform and
sandbox capability skips remain explicitly reported.

New offline evaluations drive real Core persistence, assignments, reports,
inspection receipts, follow-up controls and parent acceptance using synthetic
actors. Cases cover misleading majority agreement, retained minority evidence,
unread/changed sources, wrong severity despite a claimed supported outcome,
original achieved-goal evidence inventories, later casual replies, source
instruction races, missing deliverables, imported execution authority, pending
and declined context, positive supported completion and legitimate brain takeover.
Declared budgets and the one-to-five challenge-round bounds remain enforced.
Goal IDs bind new artifacts and automatic output/acceptance evidence collection.
A two-goal daemon regression proves old replies do not enter the next goal's
evidence. Completed-goal directive snapshots exclude later casual messages;
unrelated usage summaries cannot invalidate the completed result.

A native provider fixture deliberately ignores interrupt, TERM and input EOF.
The actual assignment runner stops its verified backend, durably settles
`needs_context`, preserves the pending question and leaves the parent active.
The regression exposed duplicate backend-close timers; Codex transport cleanup
is now idempotent per RPC instance. Answering questions alone dispatches no work;
explicit pinned follow-ups reuse the same worker conversation.

The combined CLI/Core package was built and installed in an isolated directory.
Its installed mission context, missing-context tool and Debate acceptance gate
loaded and passed a local no-inference smoke check without sibling source.
The user's running installation and private reference checkout were not updated.
Fixtures do not measure live-provider reasoning accuracy or prove a real
vulnerability/severity; host checks enforce provenance, inspection and declared
acceptance requirements.

Local logs: `/private/tmp/bzzy-publish-robust-core.log`,
`/private/tmp/bzzy-publish-robust-cli.log`,
`/private/tmp/bzzy-complete-robust-compat-corrected.log`,
`/private/tmp/bzzy-robust-core-check.log`,
`/private/tmp/bzzy-robust-cli-check.log`, and
`/private/tmp/bzzy-robust-package-verified.log`.

# Project knowledge and reviewed learning (2026-10-24)

Final full suites on Node.js 24/macOS: **314 Core tests passed, 1 skipped**
(315 total); **476 CLI tests passed, 21 skipped** (497 total), with zero failures.
Both product syntax checks and `git diff --check` passed. Existing platform and
sandbox capability skips remain explicit in the test output.

Coverage includes project identity/nested directories/moves/copies, imported
historical truth, rejection of imported verification authority, scoped public
history and stale-source recall, contradictions, structured legacy checkpoints,
revision history/rollback, worker/Agent boundaries, approved profiles and host
expiration, cross-model skills, disabled candidates and sanitized promotion.
Frontend fixtures exercise review previews, stale revision refusal, draft
retention and conversation changes while an owner decision is open.

The native-protocol fixture drives actual Core scheduling and adapter isolation:
foreground work prevents review, meaningful ToolHost outcomes queue it, host stop
pauses running/pending jobs and terminates the verified backend process, restart
does not replay them, and explicit owner resume permits the pending review.
Other learning cases cover bounded/daily reservations, deduplication, interrupted
publication, orphan recovery, held-out labels, fixture revocation/tamper and
scope-pinned baseline comparison. These use synthetic backends and observations;
they do not establish live model compliance or real vulnerability verdicts.

An isolated combined CLI/Core tarball was built and installed outside the
workspace. It contains the public `@bzzy/core/knowledge` export, CLI views,
learning runtime and docs. Installed-package status/search worked without sibling
source or inference. Source dependency links and the running installation were
not replaced. No private Codex skills or live provider/target accounts were used.

Local logs: `/private/tmp/bzzy-release-core-learning.log`,
`/private/tmp/bzzy-release-cli-learning.log`,
`/private/tmp/bzzy-release-core-check.log`,
`/private/tmp/bzzy-release-cli-check.log`, and
`/private/tmp/bzzy-learning-package.log`.

# Terminal iOS appearance and navigation, build 20 (2026-10-24)

All **86 native Swift tests**, model/chat checks and plist checks passed on
Apple Silicon. All **21 Debug UI cases** have passing latest results across the
broad run and focused rechecks. The final four-case chat/gesture/voice/large-text
run and the separate root-gesture check completed normally with finalized
xcresults. The first broad run's result finalization stalled after XCTest and
was stopped; its per-case logs establish that run's narrower coverage.

Native layouts were rendered and inspected at normal and compact sizes. The
existing color constants remain intact. The alias, uppercase mode and settings
share one header row, including at accessibility text sizes. Home controls move
with their navigation screen rather than reacting to a child preference.
The scoped UIKit adapter restores native edge-back with the custom header;
completed and cancelled swipes, repeated Back, keyboard dismissal, sheet return,
unsent draft isolation and root-level gesture rejection are exercised directly.
The broader cases cover computer/default switching, offline/pairing gates,
history paging, creation/relaunch, sharing/import, speech preferences and voice.

Signed development build **0.1.0 (20)** passed artifact/privacy/signature/APNs
entitlement checks and matches the prior app/Keychain identity. It was installed
in place on the connected iPhone; CoreDevice independently confirms build **20**.
The installation did not reset app data or pairing. This validates installation
and UI behavior, not live locked-phone APNs delivery.

# Codex skill sync across models (2026-10-24)

Node 24 on Apple Silicon: Core **266 passed, 1 platform skip**; CLI **464
passed, 21 skips**. Both syntax checks passed. The existing Skills UI exercises
sync, review and explicit enable without starting inference or changing chats.

Isolated filesystem fixtures cover Linux/macOS discovery roots, project ancestry,
full package/resources, duplicate names, repeat-run enable preservation, managed
updates, independent local edits, source deletion, invalid UTF-8, source changes
after preview, linked folders and credential rejection. Helpers never execute.
Two arbitrary model selections on each of Codex, Claude, DeepSeek, Abliteration
and OrcaRouter read the same enabled instructions/reference through Core tools.
These verify shared library access and request instructions, not live model
compliance or third-party integration availability. Tests use synthetic skill
folders; no real private Codex skills were synced or installed.

# iOS chat layout and five paused modes (2026-10-24)

Node 24 on Apple Silicon: Core **260 passed, 1 platform skip**; CLI **463
passed, 21 skips**. Syntax checks passed. After restoring the legacy group
catalog fallback, the focused CLI/PTY/session-browser checks passed **24 with
3 skips**, followed by the passing full CLI suite. Native model/chat checks and
all **86 Swift tests** passed. Signed iPhone build **19** passed artifact, APNs
entitlement and existing app/Keychain identity checks.

Real encrypted Core/Relay/native fixtures exercise Pause followed by Delegate,
Debate, Parallel, Besties and Solo in the same chat without execution. Core
retains goal identity, history, policy/evidence and consumed budgets, rejects
active workers/stale revisions and uses saved presets. Group generation tests
keep prior usage while preventing old groups from being reused under new models.
Own-phone coordinator admission leaves includeChildren:false and direct worker
reads denied; scoped peers cannot switch modes. Catalog goal feedback is
capability-negotiated so older strict clients keep their original response shape.

Four iOS simulator UI checks passed across the final targeted runs: compact
Set-goal/keyboard and hidden global header, accessibility navigation, Agent
sharing/import through Chat settings, and terminal sharing/import/draft relaunch.
Native layouts were rendered and inspected. Xcode's last UI result-bundle
finalization stalled after its passing XCTest summary and was terminated; the
per-case logs remain the evidence, rather than claiming a finalized xcresult.
The provisioned physical app's installation is verified separately from any
locked-screen Apple push delivery.

# Relay goal alerts and terminal feedback (2026-10-24)

Node 24 on Apple Silicon: Core **256 passed, 1 platform skip**; CLI **463
passed, 21 skips**; Relay **36 passed**. Core/Relay syntax checks passed.
The final Core push subset passed all **16** checks after per-computer Relay
opt-in was added. Native iOS model/chat checks and **84 Swift tests** passed;
the iOS simulator app build succeeded. Normal and large-text terminal previews
were rendered and inspected. These are isolated tests, not a live deployment.

Real socket fixtures cover a closed phone, durable Relay queue recovery, a lost
Core queue receipt with one delivery, per-computer opt-in/removal, expiry,
revocation, token rotation, strict payloads, stable retry IDs and ambiguous Apple
acceptance. Idle pause state and its notification are saved transactionally.
Lifecycle changes update terminal catalog revisions; ordinary response completion
cannot become a green goal-completion indicator. Native fixtures cover two Core
registrations and phone preference/revocation races without model work.

Live Relay Apple configuration, deployment, and a locked physical-iPhone alert
remain unverified. No private credentials were moved and no running installation
was changed by this validation.

# Paused terminal mode switches (2026-10-24)

Node 24 on Apple Silicon macOS: Core **253 passed, 1 platform skip**; CLI
**462 passed, 21 platform skips**. Both syntax checks passed. Native Linux
service verification remains a platform check; these are not VPS deployment results.

Core checks solo/Delegate/Debate switches against confirmed paused execution,
input ownership, the selected revision, queued work and unfinished worker rounds.
They retain the chat/goal IDs, cwd, transcript, contract, policy, evidence and
budget; returning to solo restores the prior selection. Explicit work reads the
persisted mode/agents even when an older client supplies stale launch options.

CLI checks use the real local daemon and a real PTY: an unpaused switch is denied;
`/pause`, `/delegate`, `/debate`, `/solo` remain in one chat and start no inference.
Attached chats support the same commands; read-only views cannot switch, and
picker cancellation/ownership transfer preserve the paused conversation. Local
idle `/goal pause` also confirms a pause without reopening verified completion.
The existing `/debate <focus>` reply-challenge path remains available.

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
