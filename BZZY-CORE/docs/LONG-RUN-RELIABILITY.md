# Long-running goals and workflow consultation

Core retains the session, goal, workflow version, evidence and remaining budgets
independently of a native model process. These repairs apply to updated execution
runners. Updating source does not hot-patch an already-running runner.

## Updating an existing investigation

Pause at a safe boundary, update CLI and Core, then explicitly resume the saved
goal. Resume preserves its identity, original workflow, evidence and accumulated
usage. Tool-schema protocol 7 and exact dynamic-schema fingerprints create a
fresh native thread when its inherited tools differ from the current execution,
including chat-to-structured-goal transitions. The BZZY conversation, goal and
remaining budget survive. A host catalog listing a tool does not prove that an
old native thread received it. Metrics reports known missing routing tools.
Rotation never authorizes replay of uncertain actions.

A saved native thread can be absent after a backend restart, including when an
empty thread was created but never persisted before an admission failure. A
read-only goal lookup miss first gets one normal resume attempt. Only an exact
backend missing-thread/rollout rejection for that saved ID, before any turn in
startup, permits one replacement thread. BZZY rebuilds the saved context and
original objective without changing the goal, workflow, permissions or consumed
goal/session/delegation budgets. An existing thread with a confirmed absent
native goal receives the original objective again while retaining prior goal
usage. Pause/clear do not create or activate a missing native goal. Authentication,
transport and ambiguous failures, accepted resumes with failed later reads, and
failed active-goal/turn requests do not trigger this recovery or automatic replay.
Diagnostics distinguish a rejected resume from the accepted replacement start.

Generated diagnostic files can remain in the project directory. Content-validated
BZZY regular reports and full-debug ZIPs are excluded from execution snapshots,
worker copies and workspace comparisons with explicit omission metadata. This
prevents an older large export from blocking future snapshot size checks.
Ordinary archives and files with suggestive names retain normal inclusion and
limits. Recovery inspection errors describe their recorded time; opening task
state does not perform a fresh full workspace scan.

An older text-only workflow remains advisory on resume. For the structured
bug-bounty consultation gate, create/update the Library definition from
`assets/bug-bounty/bug-bounty-methodology.json`, select it, then start a new goal.
Keep previous observations as historical references; old completion/consultation
receipts cannot satisfy the new goal. Importing only the Markdown file creates a
text-only workflow. Source assets never install/enable definitions automatically.

`bzzy workflows create FILE.json --global` creates a missing definition. For an
existing name, inspect `bzzy workflows show NAME --global`, then use
`bzzy workflows update FILE.json --revision N --global` with the revision inspected.
Editing a definition affects future admissions; running goal pins stay intact.

## Current state and rolling memory

`get_task_state` supplies a structural revision, context generation and a current
task capsule of at most 8 KiB. Large diffs, the complete contract/workflow, mission,
memory and routing details remain available through `read_task_state_details`.
Keep structural and source revisions when paging; offsets are UTF-8 bytes. The
full pinned workflow still enters execution instructions without clipping.

For active ordinary terminal goals, the capsule includes a project knowledge
brief of at most 2,200 UTF-8 bytes inside the existing 8 KiB limit. It selects
goal-related Core issue and memory records, including resolved findings, without
requiring a separate knowledge search. Distinct records retain separate source
IDs, revisions, status and truth even when their titles overlap. Current decisions
and questions stay in the goal-scoped checkpoint; older completion claims never
become current progress. Workers, restricted Agents, ordinary chat and inactive
goals receive no project brief.

Selection ranks lexical matches against the current objective and considers at
most 32 matching records for the brief. Coverage/omissions are explicit; this is
not an exhaustive project search or semantic relevance guarantee. Project-file-only
notes and oversized records remain available through explicit knowledge search.
Reads do not index conversations or create memory, learning or model jobs. Evidence
freshness checks share a 4 MiB/16-file budget; unavailable or unchecked proof is
marked stale, never upgraded. `read_task_state_details` with `knowledgeBrief`
opens bounded pages of the selected sanitized source fields.

The brief and its source/freshness changes participate in the task-state revision.
Supplying both `knownRevision` and `contextGeneration` returns `notModified` when
unchanged; a new context generation receives the brief again. Compact prepared
prompts and supported refresh capsules use the same projection. For a native
backend without acknowledged host refresh, delivery during an ongoing goal still
depends on `get_task_state`; saved knowledge is not proof of model attention.

Checkpoints carry trusted goal/chat/assignment-round ownership. Identical goal
text does not establish identity. Legacy/imported checkpoints are historical,
unattributed references. Optional revision checks and request IDs protect saves.
Worker follow-ups retain their conversation and prior reports while receiving a
fresh current checkpoint scope for the new assignment round.

Native text carries run/thread/turn/item identity; host `message.finalized` events
seal logical messages. A bounded scanner stores unfinished identities separately
and advances a contiguous cursor through interleaving and reused item IDs. The
execution owner indexes completed sources during a continuing native goal, without
waiting for the entire goal to end. Deterministic indexing submits no inference.
Backfill rotates among sessions and yields after bounded parts/bytes/time.

Masking joins the complete logical message before slicing excerpts. Unsealed
native tails are excluded. Messages exceeding 128 KiB or 4,096 deltas receive an
explicit derived omission marker; original history remains intact. Older
derived maps are withheld and rebuilt into a new version 4 source generation;
old nodes remain historical and stale summary jobs retire. Search retains ranges,
hashes and completion provenance. Summaries never establish permissions or proof.

The version 4 memory source merges conversation excerpts with allowlisted host
assignment receipts by source event sequence. Specialist identities and versions,
rounds, allocation warnings/extensions, limit stops, missing reports and review/
evidence references survive as navigable historical data. Parent-assigned task
previews retain which check was assigned and the focused objective of each
follow-up. Complete original objectives are credential/email-masked before
bounded exposure; raw context and worker prose stay excluded. Receipt IDs deduplicate
replay; expanding a receipt rechecks its projection version, source hash and
parent scope. Worker instructions, transcripts, raw tool results and account
bindings are not copied into these receipts. A bounded current assignment view
is rebuilt from Core after compaction separately from generated summaries. It
cannot inherit a stale historical running state, reactivate imported work or
replace current execution checks. Volatile accounting belongs to the live budget
view rather than the structural task-state revision.

New goals can use owner-configured adaptive worker allocations with partial
handoffs, inspected progress and explicit supervisor extensions inside the parent
budget. Existing goal/worker contracts remain pinned until an authorized owner
action applies a future-worker policy or an admitted adaptive extension changes
only its allocation. An update does not silently enlarge old fixed assignments.
Source-local memory trees, compactor jobs, usage ledgers and extension-progress
receipts do not cross project imports; historical messages and saved outcomes
remain available for recipient-side indexing without automatic execution.

## Retention and learning

Short sanitized retention material can publish verbatim during foreground work
without inference. Paid retention and learning preserve independent Core-owned
model selection, restricted no-tool backends, reservations, daily/job budgets,
stop handling and explicit recovery after uncertain requests.

Both owner settings APIs accept `duringForeground` (default false) and
`foregroundCooldownSeconds`. Retention defaults to 60 seconds (10–3,600 allowed);
learning defaults to 300 seconds (60–3,600 allowed). The existing owner-only
`CoreKnowledge` settings operation requires `reviewed:true` and the displayed
revision. Configuration starts no work and does not resume paused jobs.

Learning queues meaningful outcomes, recorded lessons and corrections. Reviews
use complete masked messages inside their pinned cutoff. Empty validated output
is valid. Queued jobs expose foreground-priority/cooldown reasons. Parent pause,
Core stop, deletion, budget reservations and uncertain-request rules remain in
force under either policy. Candidate publication never verifies a finding.

## Native context and workflow health

Modern compaction items and legacy signals produce durable deduplicated receipts,
refresh epochs and bounded rolling metrics. Lifecycle wall time and its union
duty ratio are distinct from CPU, billing or model attention. Effective planning
limits record provenance: exact capability/configuration, conservative fallback,
or an unreported native window. Input token estimates are approximate.

Admission includes instructions, schemas, the prepared prompt and output reserve.
When exact metadata declares separate input/output limits, admission uses the
smaller of the input limit and total window minus the bounded output reserve.
The original total window remains recorded. For API-backed Codex, the supported
`model_auto_compact_token_limit` also bounds growing native history to the
smaller of 90% of the declared input limit and total window minus that reserve.
This is a conservative planning threshold, not a tokenization or upstream
acceptance guarantee; it does not reserve output twice against an independent
input allowance.
Before native thread start/resume, Core can replace bulky derived recovery maps,
historical project records and reports in the execution preprompt with a bounded
current-state map and authorized detail references. The complete original
contract/workflow, mission, runtime policy, project constraints and pending
directives remain in those instructions. A later check also compacts derived
chat/handoff context before rejecting insufficient applied API budgets. A large
workspace diff is historical navigation, not mandatory instruction text.
Mandatory source is never clipped. Admission records distinguish preprompt
compaction from conversation compaction and disclose original/selected sizes.

For an API session without usable saved/configured capacity metadata, startup
performs a bounded exact-model catalog lookup. Recognized Experiential catalogs
use the selected slug's same-origin public detail route, without an API key,
cookies or redirects, instead of waiting for the entire paginated catalog.
Responses are limited to 256 KiB. An unavailable/private detail route can fall
back to the existing authenticated organization catalog within the same default
eight-second deadline; redirects, oversized responses and timeouts cannot start
another lookup budget. Successful metadata is cached for five minutes;
unavailable metadata has a 60-second retry cooldown. Discovered fields retain
provider/model/dispatch provenance across startup and `/new`, so expired or
changed-source values can be refreshed without overwriting owner selections.
Lookup cannot change provider, model, effort, goal or authorization, and does not
run inference. Endpoint/selection changes or cancellation prevent applying a
stale response. Restricted learning/document jobs retain their pinned metadata.
Catalog failure retains the conservative 32,768-token fallback; it does not
establish an upstream capacity or justify guessing a larger window. Startup
visibly identifies that value as an assumed local planning window. Context
window metadata describes total capacity, not independent verification of every
route's maximum input. Model selection retains same-model saved capabilities
when a catalog is unavailable, without lending them to another provider/model.

An explicitly configured trusted
pressure policy can pause at a completed-turn boundary after repeated breaches
with hysteresis; it creates no automatic restart loop or achieved outcome.

A separate host loop safeguard covers ordinary root terminal goals while a
native turn is still active. Within ten minutes it pauses after either six
distinct completed native compactions, twelve repeated coordination reads and
three minutes without host-observed work, or thirty-six repeated coordination
reads and five minutes without that work. Changing model plans, activity prose,
call IDs, usage counters, inspection headings or already-covered source ranges
cannot reset these observations. New source bytes/explicit line pages, worker
round/report receipts, reviews, closed work units, successful native edits and
other actual tool work do reset them. Failed work does not. Bounded observation
capacity defers uncertain novel inspections rather than inferring a stall.

Core waits for in-flight host calls, native external tools, pending questions,
user steering and identity-verified live assignment processes to reach a safe
boundary. A stale saved running label alone does not prove live work. The
decision is a conservative host churn heuristic, not proof about a model's
reasoning or the truth of its findings. Its durable status is `paused` with
`context_no_progress`, displayed as stalled; it never establishes achievement.
The existing goal, original objective, evidence, history and owner budget limit
remain intact. An unresponsive pause/interrupt gets a three-second local
transport-close grace, including when an interrupt ACK arrives without turn
completion. Unacknowledged final usage remains uncertain for reconciliation;
this does not establish the provider's final billing. No automatic replay,
replacement thread or new model invocation follows this pause.

Pending refreshes insert a bounded current-state capsule at a safe prepared prompt.
Automatic mid-goal steering additionally requires the backend's explicit
acknowledged-refresh capability. Unadvertised backends remain visibly pending.
Accepted delivery consumes its prepared epoch; uncertain delivery is journaled
and never blindly replayed. Fixture support does not prove live backend support.
Explicit resume rebuilds execution instructions/current assignment state, but
an ordinary same-thread native goal retains its existing native objective.
Without a supported acknowledged delivery path, its versioned mid-goal refresh
capsule remains pending; this repair does not rewrite that objective or reset
native goal counters merely to acknowledge a refresh.

Version 2 [workflow routing](WORKFLOWS.md) pins relevant specialist/skill versions
per declared hypothesis and checks actual full reads, matching assignments and
supervisor evidence review. Permitted exclusions retain rationale; unresolved
blocked units prevent achievement. This governs declared Core work units. It
cannot infer every action hidden in native shell commands, verify a model's class
selection or prove vulnerability truth. Original acceptance checks still apply.

Metrics and both debug formats show routing, tool delivery, context planning,
compaction/refresh state, indexing, repeated task-state payloads and review
scheduling. Requested/acknowledged delivery, content reads, invocations and review
are distinct. Invocation counters retain their original semantics. Opening these
views starts no work. See the bundled read-first debugger guide for audit steps.

Offline regression tests include the exact bug-bounty workflow and a continuing
1,200-message goal, interleaved secrets, reused IDs, compactions, bounded backfill,
migration, stop, import and deletion. They validate BZZY contracts without making
live target requests or grading model vulnerability-finding performance.
