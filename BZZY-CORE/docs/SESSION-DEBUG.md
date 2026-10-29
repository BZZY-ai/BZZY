# Session debug exports

For the complete investigation workflow, read
[GUIDE_TO_BZZY_DEBUGGER.txt](GUIDE_TO_BZZY_DEBUGGER.txt). The same detailed guide
is available at the workspace root and ships inside full debug ZIPs.

Use an export to inspect **BZZY's integration and orchestration**: how a skill
reaches provider context, which specialist tools are exposed, what discovery
returns, whether invocation admission succeeds, and what happens to a worker.
This is diagnostic evidence, not a model benchmark or a vulnerability verdict.
Three skill loads and zero agents alone establish neither a defect nor success.

## Export an existing session

From the terminal's **Metrics → Export debug**, press **E**, or use `/debug`.
The complete chat exports regardless of the selected Metrics goal/scope. The
file goes into that terminal session's original project directory:

```text
session-name_debug_ddmmyyyy.md
```

The date uses the exporting computer's local calendar. Filename-unsafe
characters in the alias become hyphens; long multibyte aliases are shortened to
keep the complete filename within filesystem byte limits. An unnamed session uses its short ID.
Existing files are preserved with `_2`, `_3`, etc. before `.md`.

An existing long-running session can also be exported from a second terminal
after updating Core/CLI:

```sh
bzzy debug export "session-name"
bzzy debug export "session-name" investigation_debug.txt
```

The command accepts the normal saved-session alias, exact ID or unambiguous ID
prefix. It writes into the **calling terminal's current directory**, or `--cwd`
if supplied. An explicit new `.md`/`.txt` path is also accepted; existing files
and symlinks are never replaced. This owner-local export does not activate Core,
claim input, pause/replay work, invoke a model or change Library availability.
It works while the service is stopped. It does not add a remote endpoint, model
tool, project import format, sharing code or permission grant.

## Full diagnostic ZIP

`/full_debug_export`, **Metrics → Full debug ZIP**, or **F** creates a separate
`session-name_full_debug_ddmmyyyy.zip`. From another terminal use
`bzzy debug full SESSION [FILE.zip]` or `bzzy full_debug_export SESSION [FILE.zip]`.
Full export defaults to complete capture, including multi-gigabyte projects.
Use `/full_debug_export --bounded` or append `--bounded` to either terminal
command when a size-limited project capture is preferred. The regular Markdown
export remains available independently.

The CLI runs full export in a separate Core worker so history scanning and file
capture do not block terminal repainting. Metrics and the command-line exporter
show the current capture phase, elapsed time and completed record/event/file/byte
counts as available. ZIP packaging reports files and uncompressed bytes processed;
these are not a global completion percentage or an estimate of the final ZIP size.
Progress contains no source filenames, payloads or credentials. Command-line
progress goes to stderr, preserving stdout for the final result or JSON output.
The result shows the capture mode, file count, uncompressed captured size and
compressed ZIP size separately.
Wait for the exported-file success message before treating the ZIP as complete.

To capture a baseline before another goal, export the existing saved session from
a second terminal; no new model run is needed:

```sh
bzzy debug full "session-name" before-next-goal.zip
```

The ZIP includes its read-first guide, the bounded overview, a manifest, complete
scoped saved record/event streams and complete logical conversation text. It adds
session-memory nodes, compactor jobs/outputs/controls, learning jobs/material/
evaluations/publication references and relevant usage/settings. Derived recall
documents are projected only if already present; export builds no memory/index
and starts no learning work. Explicitly related learning/compaction conversations
are included, while unrelated raw terminal histories remain outside scope.

Project context includes `.bzzy` notes, ledgers and compatibility projections.
Project-shared knowledge and ledgers remain labeled shared context. Referenced
safe evidence/snapshot/worker files and checked skill resources,
including safe binary resources, are captured separately. The archive is not a
project-import or execution package and copies no raw runtime database.

The full streams have no overview text/array/family display clipping. Complete
capture has no 512 MiB project budget or 4 GiB staging cap. ZIP64 packaging and
manifest writing stream their data; JSONL source files stream one complete record
at a time. Large archives still require disk space for the redacted staging tree
and output ZIP. File counts and saved record selection also consume memory, so
this is not a promise of unlimited host resources.

Redaction processes each logical value atomically: individual non-JSONL source
files, JSONL records and assembled conversation messages have a 64 MiB processing
limit. An oversized eligible source fails complete capture with a clear size
error and no completed ZIP; it is never silently omitted to make the archive fit.
JSONL files may exceed 64 MiB in total when every record fits. Unavailable,
changing, unsafe and private sources remain explicit manifest exclusions.

Explicit bounded capture retains the 512 MiB optional file budget and 4 GiB
uncompressed staging limit. It writes scoped diagnostic streams, skill metadata
and guides first, then prioritizes `.bzzy`, referenced artifact files and checked
skill resources before bulk project, worker and snapshot trees. Source-size and
post-redaction checks omit whole optional files or subtrees, never truncate them.
An 8 MiB minimum manifest reserve and bounded context metadata preserve diagnostic
headroom. Unenumerated subtrees are marked; their missing-file count is unknown.
Budget omissions produce `contextLimited: true` and `contextCapture` statistics.
An oversized optional source is listed in `manifest.exclusions`; an oversized
logical message, mandatory staging limit or real disk/write failure still fails
the export. Read `captureMode` and the exclusions before comparing exports.
The overview retains
its own earlier cutoff/limits and can be unavailable without preventing full
streams. File capture follows the database cutoff and validates each read;
it cannot claim an atomic snapshot of a live project filesystem.

Metrics shows the number of capture-omission entries after a successful full export;
an entry can cover a subtree rather than one file.
If export fails, it reports a safe cause category and capture phase, distinguishing
missing Python, unavailable paths, access, disk space, packaging and processing
size limits. Raw exception text and subprocess output are not displayed. A full
ZIP retry uses `bzzy debug full NAME FILE.zip` in a writable caller directory;
the Markdown retry uses `bzzy debug export NAME FILE.md`. Neither command changes
the saved chat or starts model work.

Text-event payloads reference complete scrubbed messages, preventing credentials
from escaping across streamed chunks. Native delta metadata is retained while
completed outputs/messages supply text when recorded. Private reasoning, account
bindings, auth stores, environment dumps, links/special files and opaque private
database/archive containers remain excluded. Changed, unreadable, malformed
structured and unsafe files are explicitly listed in `manifest.exclusions`.
Source/exported hashes distinguish redaction from original bytes. A completed
manifest means the operation finished, not that every excluded historical fact
is available. Read the guide and exclusions before interpreting absence.

## What travels in the regular file

The Markdown report has a short review guide and sections of JSON lines. Each
JSON line is one typed record, allowing a reviewer or script to inspect a large
run without loading a ZIP, raw database or native provider transcript.

- Session/model/mode and current goal/contract snapshots, including complete
  recorded workflow context, previous goal objectives and saved acceptance state.
- The visible conversation, recorded tool inputs/results where available,
  activity, lifecycle, context-compaction and model-change events, usage receipts,
  evidence metadata, handoffs, worker reports and review records.
- Explicitly linked assignment workers, Parallel/Besties peers and validation
  conversations using the same ancestry rules as Metrics. Unrelated chats in the
  same project and background learning/document sessions are excluded.
- Current project/global skill and specialist definitions, including OFF
  entries and the effective discoverable catalog after project overrides. Current
  state is labeled **export time**, never substituted for earlier availability.
- Immutable skill versions referenced by recorded loads, run catalogs or
  discovery. Every readable text resource, including scripts and references,
  is included without running it. Resources retain source hashes; redacted text
  offsets are explicitly distinct from original file byte offsets.
- Full specialist instructions/selections/limits from the current Library and
  available historical versions, including definitions pinned to assignments.

For **new work started with this version**, Core additionally records:

| Pipeline stage | Recorded evidence | What it establishes |
| --- | --- | --- |
| Run availability | `diagnostic.run` | Enabled scoped catalogs and Core tool names available at run start; role/policy/limits remain separate. |
| Skill prompt preparation | `diagnostic.catalog` | The exact bounded skill catalog selected for a newly prepared BZZY prompt, including pagination limits. |
| Backend setup | `diagnostic.backend` | BZZY-generated instructions, submitted dynamic/MCP schemas, safe transport policy and backend acknowledgments. |
| Prompt delivery | `diagnostic.prompt` | Prepared BZZY prompt text, inline/file-reference delivery and transport outcome. |
| Tool attempt/outcome | `diagnostic.tool` | Correlated started/returned/failed calls, duration, discovery versions and safe failure details. |
| Worker execution | Existing assignment/round/worker/review records | Accepted assignment, actual worker state, missing context, follow-ups and evidence review. |

Codex API routes such as DeepSeek use the existing Codex app-server adapter.
New native threads record submitted schemas and a separate accepted response.
Resumed threads inherit their original native tool schemas; BZZY records that
they were **not re-enumerated**, with an opaque thread reference for correlation.
It does not relabel the current host catalog as the inherited native catalog.
Long native goals may receive an objective-file reference; the prepared content
and this indirection are recorded separately. A goal resume may reuse its saved
native objective without preparing a fresh skill catalog.

Claude records its configured MCP allowlist and BZZY system instructions, control
initialization and the message written to stdio. Backend-reported tool names
are recorded when supplied. A successful write/control response does not claim
Claude accepted every schema or attended to particular instructions.

The export's final `bzzyPipeline` summary counts observed stages and tool outcomes.
It deliberately does not turn an unattempted specialist path into a pass/failure
or assert that an unused skill should have run.

## Existing-session compatibility and limits

Exports read a consistent SQLite snapshot with a source-sequence cutoff. Core
runners can keep appending in WAL mode; later events require another export.
Older running processes retain their loaded code after an update. Their saved
conversation, receipts, native tool events and current definitions still export,
but new diagnostic records start only with work running the updated code.
Unknown historical availability and missing tool outcomes are explicit gaps.
An export cannot retroactively reconstruct an unrecorded prompt or definition.

Event entries keep the original session ID, sequence and timestamp. Adjacent
assistant text deltas are joined per session/reply, with `seq`/`throughSeq` source
ranges; interleaved worker records can appear before a joined message is emitted.
Unknown events and omitted native envelopes are counted by type. Imported history
retains its provenance and does not acquire present execution or verification
authority. Metrics retains its own exact-use and historical coverage rules.

Large histories stream from their earliest saved event; they are not replaced by
only the most recent messages. The family has Metrics' existing 2,048-session /
32-level bounds. Fields have explicit 64 Ki-character, 2,048-item and nesting
bounds, with omission markers and counts. Assistant accumulation is bounded to
4 Mi-characters per reply. Skill text is scrubbed as a complete resource before
being split into smaller records, preserving the full readable resource rather
than clipping it to a tool page. Binary, changed, unsafe or unavailable resources
and unavailable historical versions are reported. Exports exceeding 512 MiB or
encountering a write failure are removed; a completed file ends with a `summary`
record followed by its closing code fence.

Provider credentials/logins, private account bindings, auth stores, environment
dumps, input leases, executable authority, raw runtime databases and private
provider reasoning are excluded by projection. Known credentials and recognizable
secret/account formats are scrubbed from selected text; paths into private
stores suppress the corresponding native tool result. Project source trees and
evidence binaries are not copied. Full skill resources and task history remain
**private execution data**: automatic redaction cannot prove arbitrary text free
of private detail. Review the report before sending it to another person or AI.
Source hashes describe original records/files, not the redacted export bytes.

Use the report to locate a suspected BZZY defect and design a controlled test.
No recorded spawn attempt cannot prove whether the complete provider/worker
execution path works. A prepared catalog is not proof of model attention; worker
agreement is not verification. Diagnostic instrumentation is best effort and
cannot change tool results, cause mutation retries, grant permissions or count
as additional skill/agent use.

Updated runners add `message.finalized`, `diagnostic.context`, structured
`workflow.routing.*` events and native readiness/input-estimate fields. Both
exports include current health; the full ZIP also retains scoped consultation,
checkpoint, source/index maintenance and compaction dedup records. Unknown legacy
delivery remains unknown. See [long-run reliability](LONG-RUN-RELIABILITY.md) and
the read-first guide's source-generation/routing audit checklist.

## Large-capture regression

From `BZZY-CORE`, run `BZZY_TEST_LARGE_DEBUG=1 node --test test/session-full-debug-large.test.js`
with Node 24+ and Python 3.9+. This opt-in fixture stages over 4 GiB of eligible
project files, exports through the real worker and verifies every payload hash
and ZIP CRC without loading the archive into memory. Allow at least 5 GiB of
temporary disk space. Fixtures are removed afterwards. Repetitive input compresses
well, so this validates over 4 GiB of captured data, not a compressed ZIP over
4 GiB. The result reports captured bytes and ZIP bytes separately.
