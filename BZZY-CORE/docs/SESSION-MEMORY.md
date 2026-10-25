# Session history memory

Core keeps a bounded hierarchical index of a terminal session's saved visible
conversation. It belongs to the existing session ID: renaming the alias, changing
models or switching Solo, Delegate and Validate preserves it. Two terminals in the
same directory have separate indexes. There is no new project entity.

Original events remain authoritative. Summaries are derived, lossy navigation
records with source sequence references, hashes and a generation ID. They cannot
prove a finding, grant permissions, satisfy a goal or replay completed work.
Indexing never rewrites original history. This is not a promise of an infinite
context window or lossless model recall.

## Index and recall

After a finalized response, Core indexes visible user/assistant messages and
input questions/answers. Tool output, private reasoning, approval answers and
intermediate debate transcripts are excluded. Leaves group eight logical messages
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

Ordinary chat and Delegate supervisors receive a bounded map on first recall,
provider handoff or native context compaction. Models can call
`read_session_memory` and `expand_session_memory` to navigate their own session
and inspect sanitized original excerpts. Tools cannot select another session.
Native provider compaction and recent-message handoffs remain in place.
Independent workers receive explicit mission context, scope and original evidence,
without arbitrary parent-history summary access.

## Background compactor

The compactor uses the **BZZY Core assistant's configured provider, model and
effort**, independently of the terminal's current model. Configure Core with
`bzzy-core assistant set PROVIDER --model MODEL --effort EFFORT`, or the existing
iPhone model settings. Unconfigured Core or missing host authentication waits
without falling back to the terminal model. Jobs pin their selected configuration.
Authentication stays in Core's private backend setup.

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

Session pause/cancel, Core stop, deletion and shutdown stop background work.
An already dispatched summary can finish against immutable sources during an
ordinary foreground turn. Paused compaction requires explicit resume.

## Owner controls

```sh
bzzy session-memory status [SESSION]
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
