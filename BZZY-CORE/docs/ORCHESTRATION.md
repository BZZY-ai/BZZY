# Debate and Delegate: original context and evidence

Both modes use Core's existing provider adapters, permissions, durable sessions,
budgets and pause/recovery controls. API-key models receive context through the
same adapters. Credentials remain private host configuration.

## Automatic mission context

Core creates an immutable brief before assigning work: original objective, full
applicable task instructions, constraints, scope, acceptance criteria,
deliverables, declared verification, current user directives and selected
evidence references. Delegate includes relevant current-goal checkpoint
decisions/questions. Independent Debate investigations exclude prior checkpoint
opinions. Unrelated parent ledgers and other projects are not replayed.

Briefs pin the source session/goal, instruction revision and content hash.
Counters, runtime status and usage do not invalidate them; changed instructions,
scope, criteria, source evidence or artifact bytes do. Follow-ups and acceptance
recheck the source. Known credential values, nested credential fields and private
backend bindings are removed/redacted before publication.

Mandatory context is not silently truncated: a brief over 2 MiB, more than 256
current-goal user directives or more than 4,096 evidence references fails with an
explicit context error. Integrity verification is bounded to 256 MiB and 8,192
artifact/source files per check. An exceeded bound cannot establish a verified
outcome. Actual model context windows still apply; stored history does not mean
every past conversation fits into one request.

## Delegate

BRAIN retains strategy and final judgment. HANDS receives the mission brief plus
its bounded assignment, inherited permissions, selected evidence and isolated
workspace. Follow-ups keep the same worker conversation.

HANDS can report `finish_assignment` with `status: needs_context` and explicit
questions. Core records an idempotent request pinned to assignment, round and
source instruction revision; the worker stops. The supervisor sees it in compact
status, waits and recovery context. `answer_assignment_context` saves answers or
explicitly declines unavailable context with a rationale. Saving an answer starts
no execution: an explicit `followup_assignment` continues the same worker, using
the current request revision. A paused source cannot be resumed by an answer.

Unanswered requests block completion. Declining a question cannot make the
worker task accepted; the parent still needs current evidence-backed assessments
for its requirements. Changed instructions require a fresh assignment. Stale
answers and claims cannot become verified work.

BRAIN must open decisive worker evidence before acceptance. Reads record hash,
byte range, assignment and round even for an actor's own artifacts. Review
rechecks hashes. Workspace changes remain isolated and require the existing
explicit conflict-checked application operation.

## Debate verifies the supplied goal and its achieved claim

For **“Find a real High vulnerability”**, a linked review carries the exact
original objective, instructions, criteria, achieved claim, previous acceptance
and all recorded goal evidence, including current-goal worker evidence. The
evidence inventory is copied with provenance and remains accessible through
bounded artifact reads. Missing, changed or excessive evidence fails explicitly.
The original chat/goal and completion record remain retained; the new assessment
is linked through its own result.
New artifacts carry a goal ID. Automatic output and acceptance collections use
that binding instead of replaying prior goals' replies. Completed-goal context
ends at its completion event, keeping later casual user messages out of the
review. Explicitly reused historical evidence keeps its original provenance.
Imported achieved goals remain historical: start a locally scoped goal with
reviewed verification before requesting a linked achieved-claim check. Imported
history cannot authorize new commands or target access.

1. Participants independently investigate the same material and mission.
   Re-tests stay within the original declared scope and policy.
2. The main reviewer opens a case from the reports and evidence.
3. Challengers raise specific objections. The main reviewer responds, revises or
   concedes, for at least one and at most five challenge/response rounds.

Majority agreement is descriptive and cannot skip challenge. An append-only
objection ledger preserves minority findings, uncertainty and changed claims.
Every objection needs one exact disposition with rationale and scoped, intact,
current evidence actually opened by the main reviewer. Unknown/duplicate
dispositions, missing reports and unsupported resolutions remain unresolved.

The final reviewer must completely inspect all original evidence bytes, with
paginated read coverage. A one-byte read cannot claim full review of a large
artifact. Time/token limits still apply: unfinished coverage ends awaiting review
instead of being silently omitted.

The decision separately assesses the exact original objective, every acceptance
criterion and any explicitly requested severity. A real lower-impact issue cannot
satisfy High merely because several models call it real. Core rechecks reviewer
identity, source revisions, objection/evidence coverage, required deliverables
and declared verification before completion. Unsatisfied checks downgrade the
result to `awaiting_review`/`inconclusive`, retaining the reported claim for audit.

Host checks establish attribution, scope, inspection, integrity and declared
contract compliance. Whether an observation proves a vulnerability or severity
still involves model/supervisor judgment unless independently specified tests
establish it. Multiple models agreeing is not independent ground truth.

## Validation

Offline fixtures exercise misleading majorities, minority counterexamples,
uninspected/changed evidence, wrong severity, source-instruction changes, missing
context, paused follow-ups, missing parent deliverables and supported completion.
They drive real Core persistence, assignment/report/read/acceptance protocols with
synthetic actors; they do not measure live-model accuracy. Native backend fixtures
also exercise worker stop and durable recovery. See [validation](VALIDATION.md).

The proposed character canvas remains a separate CLI frontend design.
