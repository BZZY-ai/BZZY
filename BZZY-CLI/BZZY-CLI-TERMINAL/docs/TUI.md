# Terminal workspace

The existing terminal renderer provides a shared black/neon frame for Chat,
reusable specialist Agents, Skills, Workflows, Goals, Metrics, Settings, native
extensions and their detail/import/export screens. Persistent iPhone Agents
remain owned by Core and managed on iPhone.

Navigation is visible from 78 usable columns and 22 rows. The live column
starts open from 116 columns and 26 rows, when chat retains at least 46 columns.
The center **≡** and sidebar **⋯** menus expose navigation and panel controls; small terminals use
visible menus and expanded inspectors. Every size, minimal mode, restored-chat
loading screen and submenu uses the same modern frame. Private transfer,
secret-entry and pairing QR screens use its full-width variant and preserve
complete QR quiet zones. Terminal-native mouse support, true color, 256/basic
colors and NO_COLOR remain supported.

A green/red dot beside **BZZY Core** reflects a fresh Core response,
independently of Relay. The header’s **dir** and **.bzzy** fields copy their complete
paths when clicked; both use the selected saved session, including its original
cwd and legacy memory binding. **Session folders** in the navigation/actions
menus retains both copy actions. The single-row header contains branding, both
paths, connection dots and an HH:MM clock using the CLI host timezone. This
keeps a VPS clock consistent with its invocation timestamps. Navigation controls
live inside the workspace. Model/effort, session/compactor tokens and host
measurements stay in their dedicated sidebar sections. A compact **HOST USAGE**
footer below Sessions shows Core's real CPU/RAM sample, independently of the
session list's scroll. Compact/minimal terminals retain model controls and
**Usage / host** through the visible **≡** menu.

## Controls

- Click navigation rows to use the existing views. Model work continues while
  changing panels. Chat history and unsent input keep their existing lifecycle.
- Drag the vertical column separators. Drag the last two cells of a live-section
  footer to resize adjacent section heights. Click a section title to collapse
  it or **↗** to inspect it in the center, then **Close** to return to chat.
- The composer has no permanent shortcut toolbar beneath its input. Goal state
  and the selected Workflow remain there as colored text on the normal black
  surface. Enabled **YOLO** appears at the right of goal status; the actions
  menu can enable it when off. Paste, models, tools and pause/cancel remain in visible menus.
- Each activity section and the saved-session list scroll independently under
  the mouse. Chat stops following when scrolled up; **↓ Latest** in the composer
  caption follows again.
  CODE lists commands newest first; click a row for the full redacted command
  in the center, with soft wrapping, Copy and Start/End controls. Its menu also
  opens actual source/file previews; those retain Follow and copy controls.
- **AGENTS / SKILLS** shows only invocation time and name, newest first. Click
  a row for its recorded status/details; ongoing tool logs stay in their existing
  chat trees. Expanded Agents exposes the existing **Pause session / Cancel session**
  commands while working. These affect the selected session. Existing Core
  permissions and control ownership still apply.
- **HTTP PROBE** remains a request table when a row is selected. Selection opens
  REQUEST above RESPONSE in the center, each independently scrollable. Headers,
  method/status and captured JSON have semantic colors; Copy uses the redacted
  view. Missing bodies stay explicitly uncaptured. The center updates a pending
  response as real telemetry arrives. Esc, Back or Close returns to session chat
  for both HTTP and command inspectors, preserving the draft and sidebar tables.
  Its menu filters by method
  or errors, sorts by status/time, and opens existing HTTP history, which also
  retains backend-reported web visits. Shell capture is enabled automatically for
  new executions in both new and existing chats, including workers. The filter
  menu can disable/re-enable subsequent capture. The control does not alter an
  already running process. Empty HTTP/CODE bodies stay blank.
- Click a saved session, then explicitly choose **Open** or **Cancel** before
  history loads. Cancel preserves the active reader, transcript, draft and scroll.
  Opening returns to the actual chat in its original cwd. Only
  nonblank aliases appear, newest saved activity first. **＋** creates an idle
  chat through `/new`; right-click exposes Rename, Share and Delete.
  Core still confirms deletion and rejects live work. No archive capability is
  invented. Session navigation never replays previous model work.
- **MODEL → configure**, **Provider**, **Model** and **Effort** use Core catalogs
  and existing selectors. **Saved combinations** stores named provider/model/
  effort tuples in Core's locked private configuration. The compact dropdown
  contains saved tuples only and requires an idle response. The adjacent **+**
  prompts for a name immediately, including while working; an existing tuple
  opens **Combination already exists** instead of creating a duplicate. Context
  and input/output pricing rows are omitted from MODEL. Selecting one discovers
  capabilities for that provider, validates supported effort, and uses existing
  ownership/idle checks. Saved tuples contain no account credentials and do not
  change Core's independent assistant model or any mode defaults. Naming/removing
  presets stays available while working, preserving the live reader and draft;
  switching a provider/model/effort still requires the response to be idle.
- **USAGE** separates session tokens from measured background **Compactor**
  input/output tokens. `≥` means known partial usage; `—` means unavailable.
  Both cumulative total-only and detailed backend counters are supported,
  including final document usage. These counters update when the background
  compactor reports usage, not on every chat token. Older Core snapshots missing
  the field fall back to the shared owner-local ledger. Conservative reservations
  never count as measured tokens. Click for Metrics,
  which includes the whole-chat compactor count. Available DeepSeek spending remains an estimate, with
  provider-reported account balance identified separately. Missing accounting,
  prices or context metadata appear unavailable; the UI invents no billing data.
- The response **[ ⋯ ]** menu copies replies or code blocks and opens HTTP(S)
  links through the host browser. Complete visible URLs also respond to clicks.
  Opening occurs only on an owner click, with argument-based process launch and
  no shell. Original assistant bodies remain unchanged in history.

Main Settings stays at four entries: **DeepSeek API key**, **Default BZZY folder**,
**Pair iPhone**, **BZZY Core**. The API-key screen discovers Core's configured
providers. Default models, Extensions, lifecycle, email, worker budgets, Library
transfer and updater controls remain available inside BZZY Core. Sharing still
uses encrypted Relay QR/expiring codes and its existing authorization flow.

## Real execution telemetry

AGENTS / SKILLS consumes actual specialist-assignment and confirmed skill-load
receipts. Updating an existing invocation changes its details without creating
another row. Stable identities drive feed/chat colors; model prose cannot create
an execution identity. The center starts tool trees collapsed when the live column
is present; clicking expands their recorded details. Activity is bounded to 1,500
recent feed rows, and HTTP uses the existing 1,000-record client window. Durable
history remains in Core. A status row never establishes goal completion.

HTTP PROBE includes host-observed `http_request` exchanges and proxy-observed
traffic from the existing shell recorder, requested automatically by CLI
executions. `--no-capture-network` or the filter menu opts out; the legacy
`--capture-network` flag remains supported. The policy survives ordinary chat
follow-ups and reopening existing saved sessions. Optional recorder setup
failure reports capture unavailable without blocking the authorized model run. Backend-reported web
visits remain labelled in HTTP history, without invented methods, status codes
or request timings. Proxy coverage is limited to clients honoring its proxy/CA;
direct sockets and excluded provider/model traffic are not captured. The proxy
retains body hashes and counts, not body text. `http_request` can additionally
supply a redacted textual response preview (8 KiB); full evidence retains its
existing access rules. Request bodies are not newly collected by the viewer.

CODE lists Core's actual `command.observed` native invocations. Start and
completion update the same row, with actor/run/call identity and recorded status.
The client retains up to 500 commands within an 8 MiB text budget. Opening a row
shows its full redacted input in the center, independently of the live command
list. There is no permanent raw-command dump in the narrow sidebar.

Source/file inspectors consume Core's `source.changed` and revisioned
`source.delta` events.
Managed Codex native `fileChange` and Claude `Write/Edit/MultiEdit` metadata
identify changed files. Core reads the actual regular file after completion and
emits its resulting source immediately. Actual shell command inputs also appear,
including source passed in interpreter heredocs, labelled **shell input** rather
than inventing a file path. Claude's native tool-input chunks update the preview
as received, with **preparing / prepared** distinguishing proposed tool input
from a completed file. Codex currently supplies whole command inputs, so these
arrive as complete snapshots; stdout is never mistaken for source. Direct
interpreter launches such as `python3 recon/probe.py` also load that actual
project file at command start and completion. Native argv, simple shell wrappers
and explicit working directories are supported; dynamic expansions and unknown
interpreter flags do not establish a source path.

The center gives complete command/source snapshots a fast 650 ms reveal with
a cursor. The reveal starts at first visible paint, so history/event loading
cannot consume it off screen; a live cursor remains while the command is active.
This is a visual presentation of already captured content: the full
source stays available for copying, and no typing events or execution progress
are added to history. Real input deltas display as they arrive. Manual source
scrolling disables the reveal. Uninstrumented shell file writes, external
editors and direct diagnostic backend runs do not gain automatic file attribution.
On restore, an owner-local compatibility projection reads at most 48 recent
native command/edit records per actor across at most 17 related sessions when
exact source events are absent. Older native logs also recover command rows
without file reads or execution, preserving their recorded timestamps. Recorded shell input is labelled **recorded**;
current files read from a recorded launch/edit are labelled **observed**, never
claimed as historical bytes. Live native events from older runners use the same
Core source observer. Private/persistent/unrelated actors stay excluded. This
starts no model work and writes no additional history. HTTP requests that were
never captured cannot be recovered; already-running processes retain their
launch environment. Reuse the same saved chat for subsequent instrumented work.

Core bounds previews to 256 KiB, 16 files per native edit event and recognized
source/text extensions; the client retains 24 recent files and 5,000 lines per
file. Paths must remain under the executing session's canonical cwd. Private
credential stores, `.env` files, `.git`, escaping symlinks, hardlinks and binary/nonregular
files are excluded. Known secrets and binding patterns are scrubbed before
preview persistence/parent mirroring. Scanning cannot prove arbitrary source is
free of private data. Persistent Agent and untrusted-import sessions do not
publish these owner-terminal previews. Prior captures provide modified-line
markers; the file menu can inspect a backend-exposed diff with added/removed-line
colors. A preview shows the file observed at that event, not verified acceptance
of an edit or permission to execute it.

The shared renderer composites existing views into the center, translates mouse
hit regions, and paints changed rows with backpressure handling. Side panels
consume existing state; they do not dispatch model work, change permissions,
start polling stopped Core back on, or change Relay/iPhone protocols.
