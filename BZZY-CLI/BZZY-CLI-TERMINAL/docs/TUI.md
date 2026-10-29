# Terminal workspace

The existing terminal renderer provides a shared black/neon frame for Chat,
reusable specialist Agents, Skills, Workflows, Goals, Metrics, Settings, native
extensions and their detail/import/export screens. Persistent iPhone Agents
remain owned by Core and managed on iPhone.

At 150 usable columns and 22 rows, navigation, chat and live activity appear
side by side. At 110–149 columns the live column starts hidden. **Live** can
reopen it by collapsing navigation. **Nav / Live** always remain visible in the
workspace header. A green/red dot beside **BZZY Core** reflects a fresh Core
response, independently of Relay. **Working dir** and **Session .bzzy** remain
visible above every ordinary panel and copy their complete paths when clicked;
both use the selected saved session, including its original cwd and legacy memory
binding. Below 18 rows a visible **Paths** menu retains both copy actions while
preserving pairing controls. Smaller terminals and minimal mode keep the compact renderer;
its **Live** navigation opens the same expanded inspectors. Private transfer,
secret-entry and pairing QR screens retain the established full-width renderer,
with matching colors and full QR quiet zones. Terminal-native mouse support,
true color, 256/basic colors and NO_COLOR remain supported.

## Controls

- Click navigation rows to use the existing views. Model work continues while
  changing panels. Chat history and unsent input keep their existing lifecycle.
- Drag the vertical column separators. Drag the last two cells of a live-section
  footer to resize adjacent section heights. Click a section title to collapse
  it or **↗** to inspect it in the center, then **Close** to return to chat.
- Each activity section and the saved-session list scroll independently under
  the mouse. Chat stops following when scrolled up; **↓ Latest** follows again.
  Source has an explicit **Follow ON/OFF** control. Expanded source lines copy
  individually; the filename menu selects recent files or copies all source.
- Click an agent name to filter its feed; **All agents** resets the filter.
  Expanded Agents exposes the existing **Pause session / Cancel session**
  commands while working. These affect the selected session. Existing Core
  permissions and control ownership still apply.
- **HTTP PROBE** rows open redacted headers, status, duration, originating actor
  and a response preview when capture supplies one. Its menu filters by method
  or errors, sorts by status/time, and opens existing HTTP history, which also
  retains backend-reported web visits.
- Click a saved session to reopen the actual chat in its original cwd. Only
  nonblank aliases appear, newest saved activity first. **＋** creates an idle
  chat through `/new`; right-click exposes Open, Rename, Share and Delete.
  Core still confirms deletion and rejects live work. No archive capability is
  invented. Session navigation never replays previous model work.
- **MODEL → configure**, **Provider**, **Model** and **Effort** use Core catalogs
  and existing selectors. **Saved combinations** stores named provider/model/
  effort tuples in Core's locked private configuration. Only saved tuples and
  explicit Save/Configure/Remove actions appear there. Selecting one discovers
  capabilities for that provider, validates supported effort, and uses existing
  ownership/idle checks. Saved tuples contain no account credentials and do not
  change Core's independent assistant model or any mode defaults.
- **USAGE** initially displays the current session's reported tokens. Click it
  for existing Metrics. Available DeepSeek spending remains an estimate, with
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

AGENTS consumes attributed activity, assignment and worker-tool events. Stable
actor identities drive the feed and chat colors; model prose cannot create an
execution identity. The center starts tool trees collapsed when the live column
is present; clicking expands their recorded details. Activity is bounded to 1,500
recent feed rows, and HTTP uses the existing 1,000-record client window. Durable
history remains in Core. A status row never establishes goal completion.

HTTP PROBE includes host-observed `http_request` exchanges and proxy-observed
traffic from the existing opt-in `--capture-network` path. Backend-reported web
visits remain labelled in HTTP history, without invented methods, status codes
or request timings. Proxy coverage is limited to clients honoring its proxy/CA;
direct sockets and excluded provider/model traffic are not captured. The proxy
retains body hashes and counts, not body text. `http_request` can additionally
supply a redacted textual response preview (8 KiB); full evidence retains its
existing access rules. Request bodies are not newly collected by the viewer.

CODE consumes Core's `source.changed` events. Managed Codex native `fileChange`
and Claude `Write/Edit/MultiEdit` metadata identify changed files. Core reads the
actual regular file after completion and emits its resulting source immediately;
there is no typing animation or inference from assistant prose/shell commands.
Started/failed edits carry metadata without proposed source. Uninstrumented shell
writes, external editors and direct diagnostic backend runs do not gain automatic
file attribution. Updating/reopening a frontend cannot recover missing historical
previews or patch an already running runner.

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
