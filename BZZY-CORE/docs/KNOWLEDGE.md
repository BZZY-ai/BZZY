# Project knowledge and reviewed learning

Core keeps investigation knowledge separate from reusable methods and private
account bindings. This is retrieval and reviewed workflow improvement; it does
not train or modify model weights. The same Core memory and skill tools are
available through the existing Codex, Claude and API adapters when switching
provider/model/effort.

## Scope and identity

An engagement has a `.bzzy/project.json` identity and a private Core directory
binding. Opening a subdirectory uses the nearest marked engagement while the
terminal keeps its original cwd. Separate engagement markers remain separate.
Project constraints are inherited. Read-only sessions resolve identity without
creating project metadata. Persistent Agents stay within their registered
directory; workers cannot search their supervisor's private history.

Renaming/moving a directory on the same filesystem retains its identity and
verified path aliases. Copying a marked directory creates a separate identity
on that host. A cross-filesystem move requires an explicit local-owner
`project.relink` operation with the old root and project ID; it refuses adoption
while the original directory still exists. No Git remote or target name merges
engagements. A new Core host has its own private knowledge store; copying a folder
is not automatic cross-machine memory synchronization.

There are four separate kinds of knowledge:

| Kind | Scope and use |
| --- | --- |
| Investigation records | Engagement observations, hypotheses, failed approaches, findings, checkpoints, evidence and public chat history. |
| Project methods | Explicitly enabled project skills; automatic proposals stay inactive. |
| General methods | Explicitly enabled global skills. Global promotion creates a new generic text-only candidate, separate from the original case bundle. |
| Profiles | Explicit owner-approved user preferences and expiring host facts. These stay in private Core storage and are excluded from project exports. |

Host facts default to seven days and are omitted when the hashed local host/home
or runtime environment changes. User preferences retain their separate scope.

## Recall, evidence and revision history

`search_knowledge` searches bounded pages of this engagement's indexed memory,
issues, checkpoints, goals and visible user/assistant messages. It excludes raw
tool payloads, backend events and hidden reasoning. Results include source IDs,
session attribution, truth, freshness and match information. Index backfill is
incremental and reports when more history remains; search totals describe index
candidates, including records later filtered as stale. Deleted chats are not
reintroduced by old index entries.

Core supplies a bounded relevant brief before ordinary turns, with up to 12 KiB
of knowledge and approved profiles. It omits the current chat's messages from
that brief because the existing conversation handoff already handles them.
Historical text never grants permission, resumes old work or proves a present
finding. Large histories remain discoverable through explicit paginated search.

Memory distinguishes hypothesis, observed, confirmed, disproved, inconclusive and
stale. A model's conclusion or agreement cannot confirm a fact. Confirmation
requires current Core verification evidence or an explicitly labeled owner
review with current recorded evidence; these are different authorities.
Changed source hashes, expiration, environment/version conditions, missing proof
and supersession can make knowledge stale. Verification is bounded; unverified
records are treated as stale when its file/hash budget is exhausted.
Contradictions stay visible in both records. Updates, stale decisions, owner
reviews and rollback preserve revision history; rollback creates a new uncertain
revision rather than silently restoring old certainty.

Project imports receive fresh IDs, paused/inactive work and historical truth.
Imported acceptance receipts cannot verify current work. Imported memory needs
current revalidation; profiles, learning jobs, fixture/evaluation control state,
skill activation records and derived indexes do not transfer with projects.
Project ZIP export still includes the selected workspace's files and evidence:
it is a deliberate project transfer, not the sanitized global-skill promotion.

## Automatic reviews and controls

Significant saved finding outcomes, recorded lessons, explicit user corrections
and Core-verified goal completion can queue a review. Ordinary turns do not
force a new skill. Repeated triggers coalesce with durable request receipts.
Opening a chat, memory view or Skills panel does not queue inference. Explicit
`/learn review` queues a bounded review of the selected saved conversation.

Default learning limits are 12,000 tokens and 45 seconds per job, 50,000 tokens
per UTC day, and four pending jobs per project. Core reserves budget before
inference and charges conservatively when usage cannot be recovered. Review
usage counts toward its own bounded ledger. Compatible backend usage reporting
is required; unsupported isolation or missing usage fails closed.

Foreground work has priority. Conversation/goal pause or cancel stops associated
reviews, host stop stops all reviews, and daemon recovery leaves interrupted
jobs paused. Starting Core or opening a chat does not resume those old jobs.
Explicit resume checks the current source and revision. A cached validated result
can finish interrupted publication through idempotent receipts without another
model call or replaying the assessment.

Disabling learning pauses its current jobs. Explicit reviews/evaluations created
while disabled also stay paused; enabling learning alone does not resume them.

The review runs with an empty private cwd, isolated backend configuration and
no native tools, MCP tools, inherited skills, hooks or project/thread access.
It receives only bounded sanitized historical material. Codex verifies its named
permission profile before a turn; Claude uses restricted tools and configuration.
Provider authentication remains private host setup. This is enforced by the
adapter contract, in addition to the prompt. It never runs assessment commands,
contacts targets, or starts a goal. Existing ordinary terminal permissions are
unchanged.

The review may propose attributed local hypotheses/failed approaches, inactive
project skill candidates and pending profile changes. It may also return no
change. It cannot activate skills, approve profiles, mark conclusions verified
or broaden scope. Credentials and recognizable private bindings are rejected or
redacted before reusable material is stored; automatic scanning cannot prove
arbitrary text safe, so explicit review remains required.

## Candidate evaluation and activation

Owner-approved offline fixtures contain held-out observations and expected
`real`, `false_positive` or `inconclusive` verdicts. All three outcomes are
required. The evaluator sees observations and candidate instructions; the host
withholds expected labels and compares the returned verdicts itself. Corpus
revision, content hash, candidate digest and evaluation ID are pinned. Revoked or
modified fixtures invalidate activation. A global candidate requires an approved
generic global corpus.
The owner must review that the corpus is independent of the skill-writing
material. Host comparison enforces the labels and revisions; it cannot establish
that an arbitrary supplied corpus is representative or independently held out.

When a prior approved skill version exists, the same bounded evaluation compares
baseline and candidate verdicts, recording accuracy and improved/regressed cases.
Without that baseline it reports no measured improvement. Passing this check
supports semantic guidance on the reviewed offline cases: scripts were not run,
targets were not contacted, and it is not proof of a vulnerability or universal
workflow correctness.

Activation remains a separate explicit owner operation pinned to candidate,
skill and evaluation revisions. Rejected candidates stay auditable. Version
history and rollback remain available; restored versions start disabled for
review. Project-to-global promotion accepts newly written generic text, not raw
evidence, assets, logs or execution records from the project package.

## CLI and local owner API

Use the existing **Skills** panel; the four-entry Settings menu is unchanged.

```text
/memory [query]        Search project knowledge and visible history
/learn                Open learning, profiles, fixtures and candidates
/learn review         Queue an explicit review
/learn pause JOB_ID    Pause a review
/learn resume JOB_ID   Explicitly resume a paused review
/learn cancel JOB_ID   Cancel a review
```

The panel provides scope selection, review budgets, memory decisions, profile
proposal approval, fixture preview/registration and candidate evaluation and
activation. Skill library history/rollback and sanitized global promotion also
live there. Changes use displayed revisions and require a fresh review after a
concurrent update.

For local automation:

```sh
bzzy knowledge status
bzzy knowledge search ownership baseline
bzzy knowledge learning SESSION_ALIAS
bzzy knowledge review SESSION_ALIAS
bzzy knowledge request OPERATION reviewed-input.json
```

`@bzzy/core/knowledge` exports `CoreKnowledge.request(operation,input)` for trusted
local host code. Its strict operations cover scoped search/status, learning jobs
and settings, memory/profile review/history/rollback, fixture registration/revoke,
candidate evaluation/read/accept/reject and project relinking. Review operations
require explicit review fields and current revisions. The daemon exposes the
same dispatcher only as owner-authenticated `POST /v1/knowledge/OPERATION`.
Session grants, paired-phone tokens and models cannot administer it. Existing
iOS chats receive the same Core recall and skills during inference; this change
does not add a native iOS learning-administration screen or a Relay protocol.

Example reviewed project corpus definition:

```json
{
  "name": "Offline authorization controls",
  "cases": [
    {"id":"held-out-a","observations":"Controlled role tests reproduced unauthorized private-resource access.","expected":"real"},
    {"id":"held-out-b","observations":"The scan matched a public login screen; private data was consistently denied.","expected":"false_positive"},
    {"id":"held-out-c","observations":"Authentication failed before the relevant controls could be compared.","expected":"inconclusive"}
  ]
}
```

Keep actual evaluation observations separate from the reusable skill text, review
their scope before registration, and use cases that were not supplied to the
skill-writing review.
