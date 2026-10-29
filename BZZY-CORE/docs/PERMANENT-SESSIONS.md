# Permanent program sessions

A terminal session is the durable home of an investigation. Keep an alias such
as `fake-program-session`, reopen it with `bzzy --attach fake-program-session`,
and continue using its saved directory. Attachment starts no work. Goals,
execution runs, native model threads, scope versions and memory generations have
separate identities. A fresh native context does not create a fresh budget or
erase the session's history.

This implementation extends the existing Core records, event log, work units,
episode observations, checkpoints, knowledge index and session summary tree.
It does not train model weights, make context infinite, or establish that a model
will reliably complete unattended live engagements of a particular duration.

## What reaches the model

`get_task_state` includes a bounded investigation capsule, current program scope
status, and a source-linked knowledge brief. Session-owned records rank before
separately labeled project history. The entire response remains within 8 KiB.
Known revision plus context generation returns `notModified` when unchanged;
after compaction the new generation requires delivery again. Source changes,
expiry, evidence drift and changed dependency fingerprints invalidate relevant
state. Paged section/source readers retain exact revisions and UTF-8 boundaries.

The normal goal handoff also includes current investigation state. Native push
refresh remains capability- and acknowledgment-dependent; unsupported backends
use the existing pull tools and safe prompt boundaries. A delivery receipt is
not proof that the model attended to or acted correctly on that content.

`search_knowledge` uses the existing FTS index for notes, issues, checkpoint
navigation, chat, resolutions, artifact metadata and host-observed attempt
metadata. Attempt results retain session/goal/run/work-unit/dependency references;
raw tool output is not a memory document. Artifact search indexes labels and
hash metadata, never artifact contents. Original evidence still uses the
existing artifact authorization and integrity checks.

Record changes feed bounded dirty-source maintenance. Existing sources migrate
through durable keyset cursors; older records can therefore require several
maintenance passes before discovery. Polling task state is read-only and does
not perform migration. Native writes remain authoritative: search candidates
are checked against live source identity, access and freshness before delivery.
During legacy relationship backfill, notes carry explicit incomplete freshness
coverage until superseding and contradictory records have been accounted for.
Oversized legacy sources are omitted from the bounded task brief with coverage
reported; their original records remain intact.
Optional owner-approved local embeddings use dirty rows and archive backfill,
so older documents are not permanently excluded by a newest-document window.

Owner terminal recall uses canonical indexed records. Legacy file-only notes
must first be registered through the existing memory import/write path; merely
placing a file in a directory does not make it a canonical memory. Restricted
Agents retain their existing file-only compatibility path and access limits.

## Investigation branches and stoppers

`update_investigation` declares/selects a branch using the existing work-unit
store. Core's existing outcome capture attaches command/tool observations to
the selected branch and its recorded dependency fingerprint. This is automatic
capture of outcomes, not an inference that a successful tool verified a finding.
Structured routing units retain their separate specialist gates; ordinary
branches cannot satisfy those gates.

Stable blockers identify the missing prerequisite, affected work, resolver,
and needed change. Dependencies can reference recorded input, execution policy,
artifacts and work units. Resolution requires a changed recorded dependency and
retains an attributed resolution receipt. Changed input permits review; it does
not automatically retry an external action or resume a stopped goal.

One blocked branch leaves other work available. An explicit `blockGoal` claim
must cover every declared current open branch and have no outstanding current
assignments. The controller then stops execution and retains the typed reason.
This checks declared work coverage; it cannot prove that the model has identified
every possible useful branch. Native backend blockers also retain a sanitized
reason, including an explicit unavailable-reason marker when necessary.

`read_investigation` opens revision-pinned historical branches. The current
capsule has a bounded branch/observation window and reports omissions. Earlier
goals and chat runs remain historical, never current completion. Archive search
and source expansion are needed for older attempts outside that window.

## Checkpoints, findings and evidence

Checkpoint `itemOperations` add, update, archive or resolve stable item IDs using
per-item revision checks. Replacement arrays remain compatible. Removed text
stays in the original checkpoint revision; later checkpoints carry bounded archive
pointers. Contract-owned constraints cannot be changed through item operations.
Display grouping combines exact strings only: capitalization, whitespace, target
differences and negation never become a fuzzy merge. Legacy constraint-array
union remains readable; the new protocol directs models to keep the contract's
constraints in the contract and archive obsolete working items explicitly.

`evidenceOperations` add/remove current evidence references. Historical evidence
remains in source revisions and artifacts rather than accumulating forever in
every current checkpoint. `blockerIds` reference canonical investigation blockers
instead of copying a second blocker store into the checkpoint.

Issues retain host `recordedAt` and source revision plus optional `observedAt`
and applicability dates/environment/version. Report lifecycle claims (`draft`,
`saved`, `claimed_submitted`, `acknowledged`, `fixed`) remain agent-reported and
separate from technical truth; non-draft claims need linked evidence. An
acknowledged-report claim does not certify a vulnerability or remediation.
New issues receive bounded likely-duplicate advice. Existing IDs remain separate;
Core never silently merges a resolved record with a contradictory blocked one.

Repeated inferred progress is coalesced in the project ledger. Every call ID and
outcome remains in Core records/events. Observations and evidence-bearing
activities retain their own project records.

## Scope changes in the same session

Versioned program scope is an explicit owner opt-in. Existing sessions keep
their current policy and are not silently enrolled by an update or proposal.
Owner-local `CoreKnowledge` operations are available through:

```sh
bzzy knowledge request scope.status status.json
bzzy knowledge request scope.propose proposal.json
bzzy knowledge request scope.inspect inspect.json
bzzy knowledge request scope.approve approval.json
bzzy knowledge request scope.continue continuation.json
bzzy knowledge request scope.revoke revocation.json
```

`status.json` contains `sessionId`. Mutations also require `reviewed: true`,
the displayed `expectedRevision`, and a stable `requestId`. Proposals provide
the scope, source references with SHA-256, and optional effective/expiry dates.
Scopes use `networkMode: "offline" | "mediated"`, allowed/excluded targets and
HTTP actions plus the existing account-reference and cleanup fields. Model text
or changes on a program website are evidence for a proposal, not approval.

Approval requires affected work and descendants to be stopped. Revocation fences
new mediated operations and queues stops for affected executions; it cannot
undo a request already sent. Scope continuation supplies `approvalId` and
`expectedGoalId`, creates a linked successor goal in the same session, preserves
the pinned workflow and remaining finite budget, and starts no work. Existing
goal history and original contracts remain immutable. Resume still goes through
normal admission. Scope changes never silently widen a stricter task policy.

Enrolled execution currently supports Codex with a verified named permission
profile, strict configuration and no YOLO bypass. Native shell networking,
inherited MCP/apps/plugins/hooks and native network features are disabled.
The effective configuration, listed profile and activated profile must be
acknowledged before a turn starts. `mediated` permits approved requests through
Core `http_request`; raw browser/socket networking is unavailable. Gmail and
extension network actions are not admitted in this mode. Host verification
commands use disabled networking too. Unsupported profiles/backends fail before
execution. Ordinary unenrolled terminal networking retains its previous limits.

Core HTTP mediation currently checks URL, hostname, method and scope binding;
it does not pin DNS answers or guarantee isolation from private addresses after
DNS rebinding. Use a separately enforced network boundary where that guarantee
is required. The enrolled profile is not a replacement for host network controls.

Private approval/binding receipts do not travel in portable projects. Imported
history, copied scope text or a generated MEMORY.md cannot authorize execution.

## Background memory and evaluated improvement

Host extractive summaries provide navigation while paid compaction is deferred,
unconfigured or budget-limited. They retain source headers and selected complete
lines, are labeled incomplete, and never replace original content or mark a paid
summary job completed. Query-aware recall combines relevant nodes with recent
coverage. Later model summaries can improve the same navigation tree.

Paid compaction and learning still use the owner's token/runtime/daily budgets
and foreground opt-in. One paid maintenance request runs at a time across these
processors. Cached local publication requires no additional inference. Queue
capacity is a scheduler deferral; explicit owner/source stops stay durable.
Health shows scheduler and pause reasons separately, including backlog age.

Startup automatically recovers only provably undispatched interrupted work or
already cached results that can be validated and published locally. An uncertain
paid request remains paused for inspection. User pause/cancel/disable, source
pause and operator stop are never inferred to have ended. Repeated maintenance
polls do not rewrite an unchanged compactor control record.

Learned updates retain source packets and exact base versions. Semantic fixture
evaluation and offline continuation evaluation are separate: a continuation
pass cannot replace the security/procedure decision checks required for skill
activation. Continuation fixtures describe bounded state/action worlds; the host
checks the returned action trace against private acceptance criteria without
executing scripts or contacting targets. Candidate and baseline use the same
pinned model and equal token allocations. Runtime is a shared job budget, not
equal per-arm wall time. Improvement requires a measured gain, no regression,
and owner-declared held-out source groups distinct from known authoring sources;
unknown source independence is reported explicitly.

Defaults remain staged. A reviewed evolution policy can opt into automatic
updates of existing project procedures using pinned approved semantic and
continuation datasets. The bounded runner queues evaluations through the existing
learning lifecycle, checks improvement and the exact still-enabled base, and
uses the normal activation gate. Changed/revoked policy or fixtures, unknown
independence, regressions, disabled/deleted bases and active workflow pins stop
automatic activation. New/global procedure publication retains its separate
policy. Existing skill version history, usage/feedback and reviewed rollback
remain available; running workflow pins are not rewritten.

To allow bounded inference during long goals, review the current revisions from
`bzzy knowledge status`, then use `knowledge request learning.settings FILE.json`
and `knowledge request session-memory.settings FILE.json` with `reviewed: true`,
`expectedRevision`, and `settings.duringForeground: true`. Keep explicit daily
budgets and cooldowns. Saving policy does not resume paused jobs or update an
already running installation.

For evaluated automatic updates, `bzzy knowledge request skill.evolution.settings FILE.json`
accepts the following structure after the owner registers and reviews
both datasets. Use the actual current policy revision and dataset IDs:

```json
{
  "reviewed": true,
  "expectedRevision": 0,
  "settings": {
    "updates": "auto",
    "updateEvaluation": {
      "semanticDatasetId": "<approved-semantic-dataset-id>",
      "continuationDatasetId": "<approved-continuation-dataset-id>"
    }
  }
}
```

This policy grants no target permissions and does not enable background paid
work by itself. Active procedure pins leave an update in `review-needed`;
closing those pins does not silently retry the approval.

## Readable view and validation

```sh
bzzy session-memory document fake-program-session
bzzy session-memory export fake-program-session
```

Export writes a bounded generated view to
`.bzzy/sessions/<session-id>/MEMORY.md`. Core remains the source of truth. User
edits are preserved as proposals: a later export refuses to overwrite a changed
view, and no ingestion path treats edits as facts or approval. This file is
navigation, not a complete backup. Preserve Core's private durable store and
project evidence through the existing backup/transfer procedures.

Regression tests cover continuing/new goals, stale completion, scope changes,
blocker resolution, contradictory findings, source updates, compaction,
undispatched/cached/uncertain recovery, provenance and activation boundaries.
`scripts/memory-soak.mjs` uses an isolated temporary home and fictional sources:

```sh
node scripts/memory-soak.mjs --cycles=5000
node scripts/memory-soak.mjs --cycles=5000 --hours=15
```

It verifies bounded delivery, idempotent capture, lifecycle recovery and
transaction rollback with zero model calls or live targets. `--hours` measures
real elapsed time. An accelerated run is not a completed 5/10/15-hour soak, a
database-process crash test, disk-full recovery evidence, or live autonomous
bug-bounty evaluation. Source retention remains finite-storage dependent;
originals are not automatically destructively compressed or expired.

`node scripts/memory-retrieval-benchmark.mjs --documents=100000 --pulls=50`
measures indexed navigation in an isolated temporary home. The local 100,000-row
run used 3.9 MB of source text: warm p95 was 4.04 ms for the rare query and
22.87 ms for the broad query; the cold broad query was 109.87 ms. Briefs stayed
at or below 2,190 bytes and polling made zero SQL writes. This local run overlapped
the regression suite; timings depend on host load. A 5,000-cycle
accelerated lifecycle soak passed in 73.38 seconds. These are reproducible
synthetic checks, not measured token savings or live investigation quality.
