# Project knowledge and reviewed learning

Core keeps investigation knowledge separate from reusable methods and private
account bindings. This is retrieval and reviewed workflow improvement; it does
not train or modify model weights. The same Core memory and skill tools are
available through the existing Codex, Claude and API adapters when switching
provider/model/effort.

## Scope and identity

An engagement has a `.bzzy/project.json` identity and a private Core directory
binding. A fresh owner CLI terminal immediately initializes `.bzzy` in its exact
canonical launch directory and pins that directory as its engagement boundary.
Launching beneath another marked project creates a separate workspace and does
not inherit its constraints or knowledge. `/alias` only names the saved chat;
attachment preserves its saved cwd, project boundary and history. Existing chats
retain their prior boundary. A missing local marker cannot redirect a pinned
chat into an ancestor's engagement.

Generic project lookups and unpinned legacy sessions can still find the nearest
marked ancestor. Read-only execution and workers cannot initialize project
metadata; explicit owner terminal launch creates the initial marker and ignore
file before execution policy is installed, including for a read-only task.
That setup grants no model write permission. Persistent Agents stay within their
registered directory; workers cannot search their supervisor's private history.

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
| Project methods | Learned procedures and corrections stage as candidates by default. Explicit owner policy may allow automatic creation of new project skills; evaluated automatic updates require a separately reviewed fixture policy. |
| General methods | Explicitly enabled global skills. Global promotion creates a new generic text-only candidate, separate from the original case bundle. |
| Profiles | Explicit owner-approved user preferences and expiring host facts. These stay in private Core storage and are excluded from project exports. |

Host facts default to seven days and are omitted when the hashed local host/home
or runtime environment changes. User preferences retain their separate scope.

## Recall, evidence and revision history

`search_knowledge` searches bounded pages of this engagement's indexed memory,
issues, checkpoints, goals and visible user/assistant messages. It excludes raw
tool payloads, backend events and hidden reasoning. Results include source IDs,
session attribution, truth, freshness and match information. Conversation results
use match-centered excerpts; `read_knowledge_source` opens the exact complete,
redacted source using its source ID, SHA-256 and bounded UTF-8 byte pages. A
changed hash requires a fresh search. Index backfill is
incremental and reports when more history remains; search totals describe index
candidates, including records later filtered as stale. Deleted chats are not
reintroduced by old index entries.

Core supplies a bounded relevant brief before ordinary turns, with up to 12 KiB
of knowledge and approved profiles. The current request, active objective and
host-observed typed error context inform recall. Source-linked proposed
resolutions and a small curated project-fact projection share that budget.
It omits the current chat's messages from
that brief because the existing conversation handoff already handles them.
Historical text never grants permission, resumes old work or proves a present
finding. Large histories remain discoverable through explicit paginated search.

Active terminal goals also receive a smaller read-only issue/memory brief through
`get_task_state` and compact context capsules, including resolved findings relevant
to the objective. Source status and truth remain separate; duplicate-looking
records are not merged. This path does not depend on the model calling a knowledge
search or waiting for learning output. Its scope, byte/candidate limits, revision
cache and native-delivery limits are documented in
[long-run reliability](LONG-RUN-RELIABILITY.md#current-state-and-rolling-memory).

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

Significant saved finding outcomes, recorded lessons, explicit user corrections,
Core-verified goal completion, reviewed worker evidence, valid skill feedback,
and host-observed complex or possibly solved work can queue a review. Ordinary
turns do not force a new lesson or skill. Repeated triggers coalesce with durable
request receipts before dispatch. New triggers after dispatch obtain a separate
job; they cannot change a packet already sent to a reviewer.
Opening a chat, memory view or Skills panel does not queue inference. Explicit
`/learn review` queues a bounded review of the selected saved conversation.

Default learning limits are 12,000 tokens and 45 seconds per job, 50,000 tokens
per UTC day, and four pending jobs per project. Core reserves budget before
inference and charges conservatively when usage cannot be recovered. Review
usage counts toward its own bounded ledger. Compatible backend usage reporting
is required; unsupported isolation or missing usage fails closed.

Each queued job pins its event cutoff, source scope, goal/run identity, mutable
record revisions, complete redacted messages, loaded skill bases, and reviewer
provider/model/effort. Changing the conversation or learning settings cannot
retarget an old review. Legacy queued jobs without such a snapshot stop with
`snapshot_required`; request a fresh review rather than guessing their old input.
Packets default to 16,000 bytes of prioritized material, with explicit omissions.
No entire transcript or raw backend reasoning is sent to the reviewer.

Foreground work has priority within the source conversation. Starting new work
defers an undispatched queued review; it does not turn that deferral into an
owner pause. Another busy conversation no longer prevents all learning. Host
capacity defaults to four foreground executions and a source must be idle unless
`duringForeground` is explicitly enabled. Foreground reviews retain a durable
cooldown. Model routing can use the pinned source model, the configured Core
background model, or an explicit installed provider/model/effort. Missing
background configuration visibly defers work; there is no hidden fallback.
Conversation/goal pause or cancel stops associated
reviews and host stop stops all reviews. Daemon recovery can requeue only
provably undispatched shutdown work or cached local publication. Explicit stops
and uncertain dispatched requests remain paused. Opening a chat never resumes
those jobs.
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

The review may return attributed local hypotheses/failed approaches, proposed
resolutions, reusable project procedures, exact-base skill corrections and
pending profile changes. It may also return no change. Core validates the
bounded output. New skills and corrections stage by default; the owner can
choose `newSkills: auto|stage|off` and `updates: auto|stage|off`. Automatic
updates require pinned approved semantic and continuation fixture datasets,
independent measured improvement, no regressions and the unchanged enabled base.
See [permanent sessions](PERMANENT-SESSIONS.md) for policy and limitations. Existing enabled
skills retain their state during migration. Automatic creation requires an
explicit reviewed opt-in and does not claim measured improvement. Profiles
always remain pending owner review.
Credentials and recognizable private bindings are rejected or redacted before
reusable material is stored; generic skill text excludes the private case bundle.
The model cannot administer profiles, mark conclusions verified or broaden scope.

Each published skill retains its learning job and source-session provenance,
immutable version and history. Job/index receipts make recovery idempotent.
Exact duplicate procedures and pending candidates are reused; similarity alone
never authorizes a merge. Conflicting existing project or global names are kept.
Library marks learned entries and offers Disable and Delete.
Deletion retains history and a tombstone, so replaying an old learning result
cannot recreate or re-enable it. Learning results link directly to the saved
Library entry, including its live deleted state. These records have no monthly
expiration; they remain in Core's private storage across terminal restarts.
Publication is not a measured improvement claim or a verification of
the source goal. Model tools still enforce their normal permissions.

## Automatic capture and resolution reuse

Core records completed native command/file-change results and supported Core
tool outcomes without waiting for `remember`, `issue` or `checkpoint`. Codex
command observations include exit status, a bounded output excerpt and reported
file changes. Claude observations include completed text results and tool error
status; an exit code is absent when the protocol did not supply one. A successful
tool call is not necessarily successful task verification.

Complete outputs are scrubbed before excerpts. Known private operations,
oversize complete outputs and hidden reasoning are omitted. Each episode scans
at most 512 recent eligible events, keeps bounded material and discloses its
coverage; old raw tool payloads are not reconstructed or silently treated as
complete observations. Reviewed worker metadata requires the authorized parent,
goal and run; a worker's unrelated history never enters its supervisor's packet.

Host snapshots run during eligible terminal work at most once per 30 seconds
when meaningful observations change, and at run completion. They preserve
observed progress separately from model-authored checkpoints. The source model
still needs to record decisions, constraints, unresolved questions and evidence.
Twelve completed meaningful attempts make an episode eligible for a complex-work
review by default. A failed command followed by the same command succeeding is
only a temporal candidate for a fix. Trigger cooldown defaults to five minutes;
compaction and routine state polls alone do not create a review storm.

A resolution adds typed error context and proposed steps to an existing uncertain
project memory. It retains sources, recorded inputs, evidence and validity checks.
Unknown input/version coverage is explicit; a proposed procedure without known
input fingerprints is not declared validated for the current project. Error
normalization masks private values and transient paths/timestamps while retaining
meaningful codes and versions: HTTP 401 and 403, SQLSTATE and ABI distinctions
are not collapsed. Exact repeated host error signatures can recall the procedure
automatically; `lookup_resolutions` also allows explicit lookup. The explanation
of a cause remains a hypothesis. Changed inputs, stale evidence, contradictions
and deleted source sessions suppress automatic reuse.

The project fact view is a projection of existing attributed memories, not a
second writable truth store. Owner-selected records and current owner-confirmed
facts fit a default 2,500-byte budget (maximum 4,096 bytes). Freshness and
contradictions are checked again on every view. Workers and restricted Agents
receive no owner fact projection. Facts never change runtime scope or permissions.

## Skill feedback, correction and curation

`skill_feedback` requires the exact immutable usage receipt from the live run,
a complete `SKILL.md` read and, when relevant, a complete supporting-file read.
It records wrong/missing steps, outdated guidance, pitfalls, preferences or
helpfulness with bounded rationale and authorized evidence. It cannot edit or
enable a skill. Its validated content becomes source material for a review.

Corrections use a captured version plus registry revision and narrow text
operations. Existing scripts/assets are preserved and cannot be edited by the
learning reviewer. Changed, disabled, deleted or archived bases reject delayed
updates. New versions remain candidates. Activation also refuses an open v2
workflow task pinning the base version, so an update cannot strand consultation.
Owner OFF/delete and current policy win over stale proposals.

Outcome associations are separate records keyed to immutable usage IDs; Metrics
receipts are never rewritten to inflate invocations or efficacy. The Learn
timeline shows feedback, run associations, staged changes and curation receipts.
Success after a skill read does not prove the skill caused it.

Curation produces bounded near-duplicate suggestions only. Reviewed archive and
restore operate on learned project methods with current revisions and no open
pins; restore stays disabled. Rare use is not evidence of poor quality. There is
no archive quota, automatic merging, or cross-project lesson publication. Generic
promotion continues through the existing reviewed text-only global candidate.

## Candidate evaluation and activation

Owner-approved offline fixtures declare a domain contract. Security decisions
use `real`, `false_positive`, `inconclusive`; general procedural guidance uses
`supported`, `unsafe`, `inconclusive`. Each contract needs all its outcome classes.
The evaluator sees observations and candidate instructions; the host
withholds expected labels and compares the returned verdicts itself. Corpus
revision, content hash, candidate digest and evaluation ID are pinned. Revoked or
modified fixtures invalidate activation. A global candidate requires an approved
generic global corpus.
Skill updates require held-out source groups distinct from their authoring
episode. The owner must review that the corpus is independent of the skill-writing
material. Host comparison enforces the labels and revisions; it cannot establish
that an arbitrary supplied corpus is representative or independently held out.

When a prior approved skill version exists, the same bounded evaluation compares
baseline and candidate verdicts, recording accuracy and improved/regressed cases.
Without that baseline it reports no measured improvement. Passing this check
supports semantic guidance on the reviewed offline cases: scripts were not run,
targets were not contacted, and it is not proof of a vulnerability or universal
workflow correctness.

For staged candidates and generic global promotion, activation remains
a separate explicit owner operation pinned to candidate,
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

The panel provides scope selection, model routing, review budgets, memory decisions, profile
proposal approval, fixture preview/registration and optional candidate evaluation
and activation, pinned review packets, observed episodes, project fact pins,
resolution lookup and skill feedback/curation timelines. Published skills open directly in Library. Skill
library history/rollback and sanitized global promotion also
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
candidate evaluation/read/accept/reject and project relinking. Additional owner
operations include `episode.status/read`, `learning.packet`, `source.read`,
`resolutions.search`, `resolution.inspect`, `facts.read/configure`,
`skill.evolution`, `skill.evolution.settings`, `skill.curation.suggest`,
`skill.curation`, and `retrieval.status/configure/refresh/benchmark`. Review operations
require explicit review fields and current revisions. The daemon exposes the
same dispatcher only as owner-authenticated `POST /v1/knowledge/OPERATION`.
Session grants, paired-phone tokens and models cannot administer it. Existing
iOS chats receive the same Core recall and skills during inference; this change
does not add a native iOS learning-administration screen or a Relay protocol.

## Retrieval measurement and optional local embeddings

Full-text search remains the default. A pure offline held-out retrieval harness
measures source precision/recall, reciprocal rank, latency, delivered prompt bytes,
stale hits and scope leaks. It does not establish independence or model efficacy
by counting a few successful sessions. Use separate source groups and inspect
whether the delivered excerpt and exact expansion contain the needed answer.

An optional hybrid path requires a trusted host to register an actual local
embedding capability, then an explicit reviewed project opt-in. No embedding
model is bundled or downloaded and no model-supplied remote endpoint is accepted.
Model/version/dimension and project-generation pins invalidate incompatible
vectors. Maintenance uses batches of at most 16, dirty-source queues and keyset
backfill across the archive, with bounded text and time per call. The scope filter runs before similarity; deleted,
changed or stale sources are checked again. Missing or failed local capability
falls back to scoped full-text search. Prompt recall remains synchronous full-text
search; explicit model search can use the opted-in hybrid path. Measurements and
configuration appear in Learn and the full debug export.

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
