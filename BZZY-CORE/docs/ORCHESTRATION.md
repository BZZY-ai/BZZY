# Validate and Delegate: original context and evidence

Both modes use Core's existing provider adapters, permissions, durable sessions,
budgets and pause/recovery controls. API-key models receive context through the
same adapters. Credentials remain private host configuration.

## Automatic mission context

Core creates an immutable brief before assigning work: original objective, full
applicable task instructions, constraints, scope, acceptance criteria,
deliverables, declared verification, current user directives and selected
evidence references. Delegate includes relevant current-goal checkpoint
decisions/questions. Independent Validate investigations exclude prior checkpoint
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

## Validate verifies the original goal and its achieved claim

`/validate` on an achieved goal immediately starts a linked review of the
original `/goal` input, every acceptance condition and all recorded goal evidence.
It reuses selected reviewers or the saved Validate preset. Without a preset,
separate independent conversations use the current model; additional provider
subscriptions are not required. This action does not enable automatic reviews
after every ordinary goal. `/debate` and `--debate` remain compatibility aliases;
stored `debate` mode, presets and event names remain readable.

For **“Find a real High vulnerability”**, a linked review carries the exact
original objective, instructions, criteria, achieved claim, previous acceptance
and all recorded goal evidence, including current-goal worker evidence. The
evidence inventory is copied with provenance and remains accessible through
bounded artifact reads. Missing, changed or excessive evidence fails explicitly.
The original chat/goal and completion record remain retained; the new assessment
is linked through its own result.
The immutable source mission includes original user directives with source event
references, bounded to 256 directives and the existing 2 MiB mission limit.
Independent workers receive those constraints, rather than arbitrary historical
assistant verdicts or parent-session summary access.
New artifacts carry a goal ID. Automatic output and acceptance collections use
that binding instead of replaying prior goals' replies. Completed-goal context
ends at its completion event, keeping later casual user messages out of the
review. Explicitly reused historical evidence keeps its original provenance.
Imported achieved goals remain historical: start a locally scoped goal with
reviewed verification before requesting a linked achieved-claim check. Imported
history cannot authorize new commands or target access.

1. Two or three participants independently investigate the same material and
   original mission. Re-tests stay within the declared scope and policy. Each
   report contains a natural-language explanation plus an internal assessment
   of the exact objective and every original criterion: `true`, `false` or
   `null`, with its own recorded evidence. Invalid, stale or incomplete reports
   remain unknown; a legacy verdict is never coerced into a boolean.
2. Any valid, evidence-backed `false` stops the review as **Not validated**.
   Other participants cannot outvote it. This policy records disagreement;
   disagreement alone does not prove the original goal false. If there is no
   false assessment, only uncertain participants may receive one private
   follow-up in their existing worker conversation. They see their own missing
   evidence and report, without the other participants' conclusions. Original
   permissions, token/runtime limits, context limits and retry limits still
   apply; zero retries prevents this additional work. Unresolved uncertainty
   ends with a human-readable inconclusive result.
3. Only when every selected participant supports every criterion does Core
   create one fresh, read-only final evidence reviewer. It checks the original
   objective, evidence and requested severity in a separate conversation. It
   does not repeat an opening, mandatory challenge and main response. Core
   records this as a direct review with zero challenge rounds, binding the
   independent assignments and final reviewer to their actual reports.

The internal assessments control this routing; clients display the explanations,
not raw boolean payloads. Agreement is provisional and cannot award a validation
badge. An append-only objection ledger preserves minority findings, uncertainty
and changed claims.
Every objection needs one exact disposition with rationale and scoped, intact,
current evidence actually opened by the main reviewer. Unknown/duplicate
dispositions, missing reports and unsupported resolutions remain unresolved.
Explicit snapshot-only reviews and legacy saved investigation protocols retain
their bounded challenge/response path.

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
The final review must also return a consistent structured assessment of every
original criterion. A supported natural-language decision cannot override its
false or unknown assessment. Oversized review or private follow-up context is
rejected before dispatch instead of silently truncating evidence or overrunning
the selected model's context window and remaining token allowance.

After those checks, the shared **Consensus & Compactor** model writes a bounded
consensus explanation through the verified no-tools document runner. This
selection inherits Core by default and permits an independent owner override
through CLI Settings → Default models. It is the same setting used by session
history compaction; each request snapshots its source and settings revisions. Chosen
reviewer models remain unchanged. The explanation cannot upgrade a host-checked
status, grant permission or establish evidence. An unconfigured or unavailable
shared model leaves the checked review intact, without falling back to a different
provider. The synthesis shares the review's remaining token/runtime budget; its
usage is recorded before the final goal summary and notification. Consensus is
bounded to 20,000 tokens and 45 seconds, further limited by the goal's remaining
budget. Input that exceeds the conservative dispatch estimate fails explicitly
without truncating the checked decision or dissent. The run lock,
pause/cancel handling and timeout controls remain active until synthesis ends.

One durable validation ID groups phase, participant and final-result events.
Participants have separate IDs even when they use the same provider and model.
Linked review events also enter the original session's stream for replay; saving
the linked result again does not append a duplicate final result.

Host checks establish attribution, scope, inspection, integrity and declared
contract compliance. Whether an observation proves a vulnerability or severity
still involves model/supervisor judgment unless independently specified tests
establish it. Multiple models agreeing is not independent ground truth.

## Validation

Offline fixtures exercise direct review after unanimous supported checks, a
single negative against a majority, private uncertainty follow-ups, zero retries,
bounded dispatch, malformed claims and changed report/receipt bindings. They
also cover minority counterexamples, uninspected/changed evidence, wrong
severity, source-instruction changes, missing context, paused follow-ups, missing
parent deliverables and supported completion.
They drive real Core persistence, assignment/report/read/acceptance protocols with
synthetic actors; they do not measure live-model accuracy. Native backend fixtures
also exercise worker stop and durable recovery. See [validation](VALIDATION.md).
