# Session history memory

Core keeps a bounded hierarchical index of a terminal session's saved visible
conversation and typed host assignment receipts. It belongs to the existing session ID: renaming the alias, changing
models or switching Solo, Delegate and Validate preserves it. Two terminals in the
same directory have separate indexes. There is no new project entity.

Original events remain authoritative. Summaries are derived, lossy navigation
records with source sequence references, hashes and a generation ID. They cannot
prove a finding, grant permissions, satisfy a goal or replay completed work.
Indexing never rewrites original history. This is not a promise of an infinite
context window or lossless model recall.

## Index and recall

During a continuing native goal and after finalized responses, Core indexes visible user/assistant messages and
input questions/answers. A separate allowlisted projection adds specialist
creation, execution, allocation warnings/extensions, stopped rounds and supervisor
reviews. Receipts retain assignment/round identities, immutable specialist pins,
stop reasons, missing-report flags and report/evidence references. Creation and
follow-up receipts also retain a bounded, sanitized preview of the parent-assigned
objective, so a generic or missing report does not erase which check was assigned.
The focused objective for a later round stays distinct from the original task. Worker claims
and supervisor review outcomes stay distinct; an accepted review is not proof of
a vulnerability. Replayed copies of the same transition count once.

Raw tool output, worker transcripts, account bindings, private reasoning, approval
answers and intermediate debate transcripts are excluded. Leaves group eight logical source messages/receipts
or about 12 KB of source text, reading bounded Unicode slices. Ready sibling
summaries form a binary tree. Source hashes are checked before publishing or
expanding; maps validate node integrity without rereading the entire original
history on every turn. Corrupt indexes require a rebuild; summaries cannot repair
originals.

Credential redaction runs across each complete logical message, including
streamed assistant deltas, before source excerpts are sliced. Logical messages
larger than 128 KiB or 4,096 deltas are safely omitted from derived material and
memory expansion, with an explicit omission marker. Their original saved history
remains intact for local inspection; no partial secret fragments are exposed.
Task previews expose at most 600 UTF-8 bytes. Credential and private email-alias
masking processes the complete original task before bounding it; originals above
128 KiB receive an omission marker. Raw task text is not copied into a derived
record. Its source hash remains independent of current credentials, and the
complete original is used only as ephemeral redaction context. Receipt masking
likewise processes the complete projected receipt before slices.
Projection versions and hashes are checked when original receipts are reopened.

Ordinary chat and Delegate supervisors receive a bounded map on first recall,
provider handoff or native context compaction. Models can call
`read_session_memory` and `expand_session_memory` to navigate their own session
and inspect sanitized original excerpts. Tools cannot select another session.
Native provider compaction and recent-message handoffs remain in place.
Independent workers receive explicit mission context, scope and original evidence,
without arbitrary parent-history summary access. After context refresh, a bounded
current assignment capsule comes from live Core records separately from history.
An old summary saying a worker was running cannot restart it, override a newer
round, enable a disabled specialist or supply budget/account permissions. Live
usage has its own budget view; polling counters does not invalidate structural
task-state revisions on every tick.

## Background compactor

The compactor and Validate's consensus explanation share one provider/model/effort
selection. It **inherits BZZY Core by default**, independently of the terminal's
current model. CLI Settings → Default models → Consensus & Compactor can choose
an independent custom selection or return to Core inheritance. Core itself remains
configurable with `bzzy-core assistant set PROVIDER --model MODEL --effort EFFORT`
and its existing settings APIs.

Inherited selection follows later Core changes; a custom selection remains
independent. Unconfigured inheritance or missing host authentication waits without
falling back to another provider. Jobs pin their selection, the shared settings
revision and, when inherited, Core's revision. Changing defaults affects fresh
jobs, while existing jobs keep their original selection through retries and
explicit resume. Authentication stays in Core's private backend setup.

The optional worker gives foreground work scheduling priority. Indexing never
waits for model output; short material may be retained verbatim without inference.
Model jobs use the verified restricted document profile, an empty private working
directory and no tools, native commands, account operations or network tool access.

Defaults: 20,000 tokens and 45 seconds per job, 100,000 tokens per UTC day, one
compaction request at a time, and 2,048 UTF-8 bytes per summary. Requests reserve
daily usage before dispatch. Host limits bound scheduling, wall time and accepted
output; native backends cannot guarantee an exact billing ceiling. Reported
overages are charged. Unknown usage conservatively consumes the reservation;
uncertain dispatched failures require explicit resume. Restart never blindly
replays an uncertain paid request.

### Compactor cost estimate

CLI **Metrics → DeepSeek spending · whole chat** separates Compactor from Chat
and their Total in eligible direct-DeepSeek Solo/Delegate selections. See
[session spending](SESSION-COST.md). The owner-local
`bzzy session-memory cost [SESSION]` command reads the same lifetime estimate;
`status` includes it as `cost`. Reading either view starts no inference or
maintenance. Existing saved sessions work without creating a new chat.

New restricted compactor executions retain one private cost receipt per document
attempt, with the original session/job identity, selected provider/model, reported
input/cached-input/output totals and a pinned price snapshot. Repeated cumulative
telemetry updates that receipt; retries use separate receipts. Chat model changes,
renaming, reopening and memory-index rebuilds do not reset or reprice them. This
first version prices supported DeepSeek Flash and V4 Pro calls using published
rates verified on 2026-10-28. Rates remain labelled estimates, not provider invoices.
Possible peak/Chinese-holiday boundaries and missing cache counters produce ranges.
Other providers and unrecognized model versions remain explicitly unpriced.

Older attempts without receipts remain visible as historical gaps. Conservative
token reservations cannot recover an input/output/cache split and never become
measured dollars. Interrupted requests with reported usage contribute only a
partial known estimate; missing usage is not zero. Only an adapter-proven failure
before any inference establishes zero. Receipts include counts/model/cost metadata,
never summary bodies, credentials or private reasoning, and stay out of portable
project imports. The estimate covers direct background summary generation only;
native backend context compaction and foreground chat/worker costs belong to the
separate Chat subtotal. Hypothetical future savings are not estimated. Updating does not replace code in active runners or
replay old work; new compactions must run through the updated Core implementation.

Session pause/cancel, Core stop, deletion and shutdown stop background work.
An already dispatched summary can finish against immutable sources during an
ordinary foreground turn. Paused compaction requires explicit resume.

Health diagnostics expose `scheduleReason` and `reasonPaused` separately; their
compatibility `reason` prefers the actual pause reason for stopped jobs. A daemon
shutdown preserves an existing compactor pause/cancellation reason, including
owner/session stops and uncertain requests. Repeated queue and backfill calls
do not revise unchanged control fields. These repairs do not resume old jobs or
enable foreground inference automatically.

Completed native messages now advance deterministic indexing while the overall
goal continues. Source generation 4 retains whole-message masking and the
unfinished-tail boundary, adds typed assignment receipts and keeps task previews
separate from worker prose and private bindings. Older
derived maps rebuild in bounded batches without rewriting original events or
active goal contracts. Source-local memory/compactor cursors, nodes, jobs and
accounting receipts are excluded from project transfer; recipients rebuild their
own indexes from historical originals and never resume imported compactor jobs. Owner-only
settings can allow budgeted inference during foreground work, with a cooldown;
the default retains foreground priority. See [long-run reliability](LONG-RUN-RELIABILITY.md)
for update/resume behavior, source boundaries and scheduling controls.

## Owner controls

```sh
bzzy session-memory status [SESSION]
bzzy session-memory cost [SESSION]
bzzy session-memory read [SESSION]
bzzy session-memory build [SESSION]
bzzy session-memory pause [SESSION]
bzzy session-memory resume [SESSION]
bzzy session-memory cancel [SESSION]
```

`build` indexes older saved history including a short index tail, without replaying
the chat. Lookup uses existing alias/ID/current-directory rules. Status/read never
queue inference.

Privileged `CoreKnowledge.request` and owner-only `/knowledge/` operations expose
`session-memory.status`, `.read`, `.expand`, `.queue`, `.control`, `.settings`
and `.rebuild`. Editable settings are enabled state and token/time/day budgets,
requiring `expectedRevision` and `reviewed:true`. Rebuild requires the exact
`expectedGeneration` and `reviewed:true`: old queued summaries cannot overwrite
the replacement generation. Control requires the displayed control revision.
These administration operations are not model tools or remote session grants.

The trusted local `backgroundModelSettings()` / `configureBackgroundModel()` API
owns the shared model choice separately from compactor budgets. Configuration
requires the displayed revision and optionally an idempotency request ID. It
validates Core's installed provider/model/effort selection, stores no credentials
and starts no inference. See [Core model settings](ASSISTANT.md).
