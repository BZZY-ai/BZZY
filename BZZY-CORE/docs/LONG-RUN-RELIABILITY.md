# Long-running goals and workflow consultation

Core retains the session, goal, workflow version, evidence and remaining budgets
independently of a native model process. These repairs apply to updated execution
runners. Updating source does not hot-patch an already-running runner.

## Updating an existing investigation

Pause at a safe boundary, update CLI and Core, then explicitly resume the saved
goal. Resume preserves its identity, original workflow, evidence and accumulated
usage. Tool-schema protocol 6 may create a fresh native thread while retaining the
BZZY conversation and goal. It never authorizes replay of uncertain actions.

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
explicit derived omission marker; original history remains intact. Version 1
derived maps are withheld and rebuilt into a new version 2 source generation;
old nodes remain historical and stale summary jobs retire. Search retains ranges,
hashes and completion provenance. Summaries never establish permissions or proof.

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
Core retries with compact derived context before rejecting insufficient applied
API budgets. Mandatory source is never clipped. An explicitly configured trusted
pressure policy can pause at a completed-turn boundary after repeated breaches
with hysteresis; it creates no automatic restart loop or achieved outcome.

Pending refreshes insert a bounded current-state capsule at a safe prepared prompt.
Automatic mid-goal steering additionally requires the backend's explicit
acknowledged-refresh capability. Unadvertised backends remain visibly pending.
Accepted delivery consumes its prepared epoch; uncertain delivery is journaled
and never blindly replayed. Fixture support does not prove live backend support.

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
