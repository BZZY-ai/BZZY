# bzzy 🐝

Consecutive replies from the same assistant share one heading and a plain tree
rail, without filled user/assistant message backgrounds. User turns and changes
of specialist start a fresh heading. Original reply boundaries, copy targets and
saved history stay intact. Pair iPhone now explicitly requests 30-day access;
updates retain private host state but cannot renew an already expired pairing.

Metrics includes current-session BZZY health: workflow consultation coverage and
blockers, native tool delivery/context planning, compaction/refresh state, memory
indexing and background review reasons. These are read-only saved observations.
See [long-run reliability](../../BZZY-CORE/docs/LONG-RUN-RELIABILITY.md) before
updating/resuming an existing goal or adopting the structured bug-bounty workflow.

Supported targets: **Debian 12/13, Ubuntu 24.04+, and macOS 15+** on x64 or
ARM64 with Node.js 24+. The installer uses a compatible existing Node or installs
a private Node 24 runtime. Existing Codex/Claude executables remain separate.

| Platform | Enforced task policies and multi-agent modes |
| --- | --- |
| Debian / Ubuntu | bubblewrap with working user namespaces |
| macOS | native `sandbox-exec`, verified by write/network enforcement probes |

If enforcement is unavailable, strict modes stop before starting a backend.
Ordinary chat and solo goals remain available. Linux dependencies include Git,
Python 3.9+ for project ZIPs, OpenSSL for optional HTTPS capture, and bubblewrap for
strict modes (`sudo apt-get install git python3 openssl bubblewrap`). macOS needs
working Git and Python 3.9+ installations; the OS supplies `sandbox-exec`.
The installer checks Python before making changes and never installs OS packages.

Ubuntu's AppArmor policy can restrict user namespaces. If the enforcement probe
fails, check the distribution's application profile and namespace configuration;
BZZY does not disable host security settings. See [Ubuntu's AppArmor documentation](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/).

From the complete BZZY source workspace:

```bash
cd BZZY-CLI/BZZY-CLI-TERMINAL
./install.sh
bzzy
```

Keep `BZZY-CORE` and `BZZY-RELAY` beside `BZZY-CLI`. The installer prepares
the existing locked Relay SDK and links the CLI to Core without installing or
invoking Codex/Claude backends. Core source edits take effect through that local
package link. Rerun setup after changing dependencies: `npm ci --ignore-scripts`
in Core followed by the same command in this CLI.

Release maintainers can run `npm pack` here to prepare a self-contained CLI
tarball. It bundles Core, Relay and their dependencies from the current source;
packaging stages a sanitized physical copy and then restores the local source
link. No second maintained copy of the engine is needed. Install the tarball
with `npm install -g ./bzzy-cli-0.2.0.tgz`, or extract it and run `./install.sh`.
A bundled release needs no sibling directories and its installer does not invoke
npm. A terminal-only source checkout is no longer a complete installation.

The top-bar **Agents** option lists reusable specialist subagents with plain
**Import** and **Export** actions. Create one with `/create-agent`, inspect or edit
an existing entry, and choose **Use in chat** to fill an editable invocation draft. Models
can invoke these specialists from normal chats and goals, with independent worker
contexts, progress, follow-ups and evidence review. `/agents` opens the same
library; `bzzy subagents list|show|create|update|delete` provides JSON management.
See [subagent instructions and limits](../../BZZY-CORE/docs/SUBAGENTS.md). These
definitions are separate from persistent iPhone Agents.

From chat, `/create-skill <requirements>` and `/create-agent <requirements>` ask
for a lowercase hyphenated name and use that chat's current provider, model and
effort. These explicit creation commands publish validated definitions globally
in **BZZY Core**, enabled for immediate discovery and later authorized use:

```text
/create-skill quiero una skill que valida los headers http
/create-agent quiero un agente especializado en pruebas Android autorizadas
```

Core uses its internal [skill](../../BZZY-CORE/assets/bzzy-skill-creator.md) and
[specialist](../../BZZY-CORE/assets/bzzy-agent-creator.md) creator guides, validates
portability before saving, and never overwrites existing names. New entries are
available in Library sharing. Creation starts no workflow or specialist task.
Esc cancels; changing chats, projects or the selected model invalidates the result.

Background learning saves reusable project skills directly into Core's Library,
enabled and marked **learned**, with their source and version history. Open an
entry to inspect, disable or delete it. An old learning job cannot recreate a
deleted entry. `/learn` shows review jobs and links to the skills they created;
manually staged candidates and global promotion keep their separate workflow.

Every skill and specialist-agent Library row has a visible **ON/OFF** switch.
Click the switch to change availability or click its name to inspect it. Arrows
and Tab select a control; Space toggles the selected entry, and Enter activates
the selected switch or opens the name. OFF entries remain visible in Library
and are unavailable for new model invocations; changing a switch starts no work.

Actual skill loads and named-agent calls appear directly in the chat as compact
colored rows, including in minimal mode. Skills show **Loaded**; agents update
the same row through starting, running, needs context, awaiting review and their
final review or stop state. Different agents retain separate colors even when
they use the same model. Reopening restores the rows and checks current Core
state, while worker skill loads also appear in the main session. These rows show
names and status, without copying task prompts or reports. Loading a skill or
finishing a worker does not establish goal completion.

Both libraries show names and ON/OFF controls, with plain **Import** and
**Export**. Export opens a name-only checkbox table for that tab's project and
Core entries. Space toggles names; Enter or **Export** automatically creates an
expiring Relay code. The **EXPORT CODE** screen has a clickable **Copy code**
button; `C` copies immediately. On the other BZZY, **Import → ENTER CODE** accepts
one paste, then shows connecting, download progress, integrity checking and
installation. Missing entries install enabled, and completion lists only newly
installed names. No second selection or manual fingerprint entry is needed for
new Library codes. Matching names never overwrite existing definitions or their ON/OFF
state. Duplicate project/Core names have a scope suffix. Complete skill resources
and scopes are preserved; private bindings, history and case/evidence packages
are excluded. Unsafe selected packages block export. Neither operation starts
agents, models or scripts. Open an entry to read its full details.

For combined transfers, use `/library`. It includes skills, specialist agents,
workflows and saved goal text. `bzzy library share` generates an expiring
`BZZY-LIBRARY-…` code; `bzzy library import` asks for hidden code entry on the
receiving host. New codes pin the sender and selected archive internally, and
install only missing entries. Existing names and availability are never overwritten.
Choose Library types before review, or run `bzzy library share agents skills`
to share only those types. A blocked entry shows its safe reason and file/line,
with an explicit option to omit that whole entry and share the rest. No content
is silently stripped, and unselected types are not scanned.
The Relay must also be updated for Library codes. See
[Library sharing](../../BZZY-CORE/docs/LIBRARY-SHARING.md).

New Library codes stay valid in Core for up to ten minutes after leaving the
export screen; **Revoke code** cancels them. Both BZZYs need the current Core/CLI.
Native clipboard success shows **Code copied**. SSH terminal clipboard requests
and failures have distinct feedback. Full-session transfers retain their separate
review and fingerprint approval, and legacy codes remain available via `/library import`.

**Goals** and **Workflows** in the top bar have the same plain
**Import** and **Export** actions. Check names once to export, then copy the
generated code. On the receiving BZZY, paste into **ENTER CODE** and follow the
download/check/install progress. Only new entries appear in the result; existing
goal text and scoped workflow names are skipped. Goals use readable objective
text in the checkbox list and installation result. Import remains available when
there are no saved goals. Imports neither start goals nor change the terminal's
selected workflow. **Load workflow from a text file** remains a separate action.

Right-click a skill, agent, workflow or saved goal for **Open details** and
**Remove…**. Keyboard users can highlight an entry and press **F10**. Removal
requires confirmation with Cancel selected, and pins the displayed scope/version
and terminal context. It removes the reusable Library entry; existing chats,
evidence, loaded instructions and pinned running work are retained. Goals also
has a **Remove saved goal** button in its detail view. A removed selected workflow
becomes unavailable: choose None or another workflow for future goals. Explicitly
saving removed goal text again creates a fresh revision; old open pickers cannot
remove that replacement. Accepted import retries retain the recipient's removal.

Use `/workflow` to choose one reusable goal pre-prompt, like the model picker.
Choose **None** to turn it off; chat shows the selected workflow's name. Create,
load, inspect and edit definitions from the **Workflows** top tab. `/workflows`
is no longer a slash command; administrative `bzzy workflows` commands remain
available. Selection belongs to the current terminal session. A new `/goal` loads
the complete workflow before model work and keeps that version when resumed;
later selection changes affect future goals. Loading or selecting starts no
model work. See [goal workflows](../../BZZY-CORE/docs/WORKFLOWS.md).

You can select the workflow at launch:

```sh
bzzy --workflow bug-bounty-methodology
bzzy --attach my-project --workflow bug-bounty-methodology
bzzy --workflow bug-bounty-methodology --goal "Review the supplied HTTP responses"
bzzy --attach my-project --workflow none
```

A named attachment opens an existing alias/ID/prefix or creates a new idle named
chat in the current directory when no match exists. Creation uses the ordinary
chat defaults and is serialized per name to avoid duplicate concurrent opens.
Existing chats keep their original cwd, model, history and goal state; opening
starts no inference, replayed work or input takeover. Ambiguous matches fail
instead of creating another chat. Read-only views and update-restoration handoffs
remain strict existing-session lookups.

`bzzy --attach NAME --yolo` explicitly keeps Core-owned YOLO on for the parent
terminal. Historical or current read-only review children do not block that
attachment, and their policies remain read-only. Reattaching to an already-YOLO
live parent is idempotent and starts no new execution. An idle ordinary parent
saved with read-only execution can be explicitly upgraded to workspace writes
by this owner flag; Core retains its previous policy in a private audit receipt.
Network restrictions, scope, objective, evidence and pinned workflow remain.
Protected worker, persistent Agent and read-only validation contexts cannot be
upgraded this way. A currently running non-YOLO parent must be paused before its
native execution settings can change. Read-only `--view` and goal-resume behavior
are unchanged; attachment does not automatically resume a paused goal.

Chat history saves automatically. Use `/alias my-project` to rename a chat,
then reopen it with `bzzy --attach my-project` or Sessions. A fresh plain `bzzy`
chat in the same directory has its own session history and compaction index;
project knowledge and learned skills remain separately scoped.

`--workflow NAME` resolves against that terminal's project/global Library.
It selects instructions for future new goals and starts no work by itself;
`none` clears the selection. Unknown workflows fail before creating a new chat
or goal. Existing goals keep their admitted workflow across selection changes
and retries. A goal resume cannot replace its workflow: use attachment for
future-goal selection or start a new goal.

Core also maintains a bounded [session history index](../../BZZY-CORE/docs/SESSION-MEMORY.md)
across alias, model and mode changes. Its compactor uses the shared **Consensus &
Compactor** default, which inherits BZZY Core unless explicitly changed. Inspect
with `bzzy session-memory status [SESSION]`, index older history
with `build`, and control background work with `pause`, `resume` or `cancel`.

Core owns execution, provider/authentication configuration, model discovery,
conversations, goals, recovery and all debate/parallel/delegate/besties logic.
This package owns the terminal frontend; legacy backend modules forward to Core
for compatibility. Core's daemon and workers run without this CLI installed.

`bzzy` opens a Codex-style terminal chat with three fixed sections: a responsive
top bar for Open Sessions, New Session, Skills, Agents, Workflows, Goals, Metrics
and Settings, with host CPU/RAM on a compact second row when necessary; the live chat transcript; and a compact composer with the current model, effort, token count,
`HH:MM:SS` runtime and color-coded goal state. User turns and agent replies use
separate labeled rails, and the latest user request stays pinned directly below
the top bar while a long reply streams. Open Sessions deploys an anchored
dropdown of aliased terminals. A green or red Relay dot is always available in
the status treatment. The gear opens a full-screen Settings view in place of the
transcript and composer, while preserving the chat draft. Esc returns from any
Settings page to chat. Esc also closes other menu screens; when a prompt,
picker or skill preview is open, it cancels that view first and preserves the
unsent chat draft.

Chat keeps its **Cooking…**, Pursuing, Verifying and Validating badges and adds
an animated activity row beside the current action: waiting for model output,
receiving text, running a tool or receiving worker activity. A per-action timer
and last-output/activity age advance independently from Core polling. Native
tool completion clears the active command; the response's completed/paused/stopped
label freezes its elapsed time. These rows do not add synthetic chat messages or
invocation counts and preserve drafts in normal and minimal layouts.

Core supplies a recent, identity-checked execution-process observation, sampled
at most once every two seconds for the same process/state. **Process alive**
means that process was observed; it does not prove the model is advancing.
Quiet periods show their actual age, approval waits say **Waiting for your input**,
and missing processes, stale checks or connection loss cannot keep a healthy
process label. No tokens or progress percentages are invented.

Skills, Agents, Workflows and Goals share spaced Import/Export button toolbars,
visible keyboard focus and separate name/ON-OFF actions. Controls wrap in narrow
terminals; disabled controls cannot be clicked or selected. Library browsing
hides the chat draft and restores it when returning. Save/create/load actions use
the same button styling. Import/export authorization and manual-only goal saving
retain their existing behavior.

**Option+Delete** on Mac (**Alt+Backspace**) and **Ctrl+W** delete the previous
word at the cursor, preserving text to its right. **Ctrl+Backspace** also works
when the terminal reports that chord. Composer, text/private prompts, alias
editing and model search accept the shortcuts. Legacy keys and extended
[Kitty](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) and
[xterm](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) Backspace packets
are decoded without inserting packet characters. Key release does not delete
another word; repeating the key does. Bracketed paste into the composer cannot
activate word deletion.

**Skills** opens the existing project/global skills library, including **Sync
skills from Codex into BZZY**. **Metrics**, also available with `/metrics`, shows
the current goal's objective/status and recorded skill and agent use. Switch to
**Chat totals**, **Outside goals**, or choose an earlier goal. Skill loads,
specialist invocations, worker tasks and their follow-ups have separate counts;
same-named skill scopes and versions remain distinguishable. Counts survive
reopening and replay. Missing historical attribution is marked partial instead
of guessed. Back or Esc returns to chat with its unsent draft intact. See
[counting rules](../../BZZY-CORE/docs/METRICS.md).

Choose **Metrics → Export debug**, press **E** there, or type `/debug` to save
`session-name_debug_ddmmyyyy.md` in this terminal session's original project
folder. It contains the saved conversation/worker timeline, goal/workflow
context, full skill text resources and specialist definitions. New runs also
record BZZY's prepared instructions/catalogs, provider tool exposure, transport
acknowledgments, discovery and invocation failures. This helps debug BZZY's
delivery and orchestration across providers. Current definitions and missing
historical context are labeled explicitly; low invocation counts alone are not
a failure verdict.

For a session already running, use a second terminal after updating:

```sh
bzzy debug export "session-name"
```

This saves into the calling terminal's **current folder** without stopping,
replaying or attaching to the session. Existing files get a numbered suffix.
Pass a new `.md`/`.txt` path as the last argument to choose another name.
The file contains private task content with automatic redaction; review it
before sharing. See [debug contents and limits](../../BZZY-CORE/docs/SESSION-DEBUG.md).

For the full archive, use `/full_debug_export`, **Metrics → Full debug ZIP**,
or **F** in Metrics. From another terminal, run `bzzy debug full "session-name"`
or `bzzy full_debug_export "session-name"`. This creates
`session-name_full_debug_ddmmyyyy.zip` in the same current-directory flow.
It includes the regular overview plus complete scoped event/record/message
streams, memory/compaction/learning history, project notes and ledgers, source
files, referenced evidence/snapshots and skill resources. Secrets/private stores
remain excluded, and manifest.json lists missing/changing/unsafe files.
Every ZIP includes the detailed [read-first guide](../../GUIDE_TO_BZZY_DEBUGGER.txt)
for future debugging sessions; exporting neither executes its contents nor
replays the investigation.

When the active terminal model uses the DeepSeek API key, the top bar also shows
the current USD balance; click it for freshness/source details. Subscription
providers do not show an account balance control.

`bzzy` opens terminal chat. The character workspace, graph links and drawers have
been removed from the CLI. Saved chats remain available through Sessions;
Delegate, Validate, Besties and Parallel retain their terminal commands and
default-model settings. `bzzy --minimal` keeps the ultra-compact transcript.

In a minimal solo, Delegate or Validate chat, pause with `/pause` or `/goal pause`,
then use `/delegate`, `/validate` or `/solo` (`/singular` is an alias). Delegate and
Validate use their saved agent presets, or open setup if none exists. Solo restores
the model and effort used before either mode; chats launched in these modes use the saved
solo default, or their current primary model if none exists. Both switches keep
the same chat, working directory, history and goal. Work stays paused until you
send a message or explicitly run `/goal resume`. Wait for active replies and
workers to finish stopping before switching; idle alone is not a pause.
On an achieved goal, bare `/validate` starts the review immediately, reading the
original `/goal`, requirements and recorded evidence. It reuses the saved agents
or creates independent reviewers using the current model. `/validate <focus>`
also supports focused reply review. `/debate` and `--debate` remain compatibility
aliases for existing workflows; saved setups stay intact.
Validate appears in a compact block: click its header or press Ctrl+B to expand
the latest discussion, and Esc to collapse it. The expanded block groups each
agent's checks and follow-ups together under one identity/model heading. Each
participant keeps a distinct color even when providers and models match; the
fresh final reviewer has a separate section. The bottom status says
**Validating…** during review. The consensus and any unresolved
objections remain visible below the collapsed discussion.
The original chat then shows **Goal achieved ✓ · Validated ✓** only when Core's
checks support the exact original goal. Unsuccessful reviews show **Not validated
✗** or an explicit inconclusive/stale/stopped state. An older review or a positive
consensus paragraph cannot award the check. Changed goals or evidence invalidate
it. See [validation gates](../../BZZY-CORE/docs/GOAL-VALIDATION.md).

`/validate` announces startup. If original evidence files are missing or changed,
it keeps a visible recovery error beside the chat and leaves the achieved goal
unchanged. Preserve captured source files after recording them; an intact saved
copy alone does not satisfy source freshness checks.

Validate collects independent structured assessments while displaying short
natural-language explanations. Any supported rejection prevents validation;
an uncertain agent gets one focused follow-up within its limits. Only unanimous
support proceeds to a fresh final evidence reviewer. Core still checks every
original criterion, requested severity, scoped evidence and unresolved objection.
The legacy review-only mode retains its bounded challenge/response flow.
Delegate automatically passes a pinned
mission brief and can request missing context without guessing or silently
resuming. See [orchestration](../../BZZY-CORE/docs/ORCHESTRATION.md).
Delegate keeps **BRAIN · model · effort** and **HANDS · model · effort** pinned
above the conversation, including minimal mode. These labels show the current
models and their independent efforts without provider names, stay visible while
scrolling or paused, and disappear when switching out of Delegate.

Core's coordinator has its own provider/model/effort configuration, editable with
`bzzy-core assistant set`. `/default` and
`--default` select terminal chat presets independently. New providers/model
catalog entries are registered/discovered in Core and appear in the existing
CLI selectors without hardcoded model lists. Current custom API providers must
support the execution adapter's actual protocol; an arbitrary local LLM server
is not automatically compatible.

Abliteration is built in: run `bzzy auth abliteration` for hidden API-key entry,
then choose it from the model dropdown or use
`bzzy --provider abliteration --model abliterated-model`. Model discovery and
per-model reasoning choices come from Core. It uses the installed Codex CLI
with the provider's Responses API. See [setup and model support](../../BZZY-CORE/docs/ABLITERATION.md).

OrcaRouter is built in with Cyber models prioritized. Run `bzzy auth orcarouter`,
then choose it from the model dropdown or use
`bzzy --provider orcarouter --model orca/orcacyber-zero-1.5`.
Cyber models appear when the key's workspace has the upstream access grant;
see [OrcaRouter setup](../../BZZY-CORE/docs/ORCAROUTER.md).

Experiential Labs is built in. Run `bzzy auth experiential`, then choose it in
`/providers` or launch `bzzy --provider experiential`. Its default is
`gpt-5.6-sol`; Core discovers other chat models and their capabilities from the
authenticated catalog. `EXPLABS_API_KEY` is the alternative host environment
setting. See [Experiential setup](../../BZZY-CORE/docs/EXPERIENTIAL.md).
For Experiential only, `/effort` and the Effort dropdown immediately offer
Default, None, Minimal, Low, Medium, High and Max without a catalog request or
key check. These are requested levels: the gateway may lower, drop or reject
them. Saved non-reasoning metadata cannot hide these manual controls.

CLI stays terminal-oriented; persistent Agent management lives in iPhone.
The terminal header shows Core host CPU and used/total RAM, refreshed roughly
once per second. Wider terminals also show Core's own resident memory. These
readings come from Core and stay outside chat/history.
Running `bzzy` in `/projects/nasa` keeps that session tied to `/projects/nasa`.
Name a chat with `/alias NAME`, then open **Sessions**, use `/sessions`, or run
`bzzy sessions`. The list contains named terminal chats, newest saved activity
first. Use ↑/↓ and Enter to open the existing chat and history in its original
directory; Esc returns without changing it. Rows show the alias, with a directory
hint only when names repeat. Opening a session never resumes a paused goal or
starts another execution.
An open terminal keeps streaming when iPhone submits input; it becomes a viewer
without closing the chat. Sending the next message routes through Core's shared
input coordinator using the host's existing authorization. Opening/restoring a
chat does not claim input, and background lease renewals cannot compete with the
phone. Read-only `--view` remains read-only. See
[Core's input contract](../../BZZY-CORE/docs/SESSION-INPUT.md).
Right-click a named terminal in **Sessions** or **Recent sessions**, or right-click
the current alias, for **Open terminal**, **Share full context**, and **Delete chat**. **F10**
(or Shift+F10) opens the same menu for the focused session. Sharing uses the
existing complete-project Relay flow: typed confirmation, QR/expiring code and
recipient fingerprint approval. It never attaches to the source or replays work.
The copy includes saved chats, project files, notes, memory and execution/evidence
context; credentials and live permissions remain excluded. Escape or an outside
click closes the menu. Terminals that reserve right-click can use F10 instead.

**Delete chat** opens a confirmation naming the alias, with Cancel selected first.
Core removes the confirmed terminal and its child conversations from saved chats
and accessible history. Project files stay in place; internal execution/evidence
audits remain private, so this is not secure erasure. Active work must be stopped
or paused first. Deleting another chat keeps the current conversation and unsent
draft. Deleting the current chat opens a fresh unnamed idle chat in the same
project, retaining its model and effort without replaying work.

Chat distinguishes **YOU** in teal cards from **AGENT** replies with lavender
rails. Right-click anywhere on an agent reply for **Copy response**, including
replies in the shared room; no Copy button occupies the conversation. Hovering
a reply and pressing F10 opens its menu too. Copy uses the complete reply’s
readable body, including content outside the viewport. Labels and borders remain readable without color.
The composer shows **YOLO OFF** in gray and **YOLO ON** in pink. Click it or use
`/yolo` to change this terminal's Core-owned permission mode. Enabling it while
an approval is pending atomically accepts that exact request; subsequent native
approval requests in the current run use the enabled mode. The full native
launch/sandbox mode applies to the next execution. Pause active work before
turning it off; an already launched backend cannot have its native permissions
retroactively tightened. Read-only and isolated Agent boundaries remain enforced.
Pending approvals use expandable action cards and green **✔ Approve once** / red
**✕ Deny** controls; Alt+Y/Alt+N answer the visible request without sending chat.
Core rechecks the owner, exact pending question and expiry. Drafts remain intact.
An attached terminal can answer directly after input moves to another client;
the explicit Approve/Deny action coordinates control through Core. An expired
input lease alone does not indicate another client. Read-only `--view` terminals
keep these actions disabled, and opening or polling a chat never claims input.
Attached viewers retain Send and a continuation prompt while another client
controls input; their next submitted action coordinates the handoff.
Alongside YOLO, a blue **Pursuing goal...** badge animates with rotating dots;
verified achievement turns green and stalled outcomes turn red. Paused/cancelled
goals keep their own labels. Status comes from Core lifecycle state, never reply text.
Sending another `/goal <objective>` while a goal is active, verifying or paused
opens **Replace current goal?** with **No** selected initially. Yes stops the
previous run before queueing the new goal; No or Escape keeps it. Core checks the
confirmed goal ID again, so a goal changed by another client needs a fresh review.
An intentional backend shutdown during replacement or pause finishes as a stop,
including when its final notification precedes the stop response. Unexpected
backend exits and RPC errors remain visible; a stopped run is never achievement.
Use `/goal resume` to continue a paused or stalled goal from its saved checkpoint.
It keeps the same goal and objective, resets the recurring-blocker audit and
retains spent tokens. A completed goal cannot resume; an exhausted token budget
requires an explicitly increased total.

Plain `/goal` opens a quick list of **manually saved goals**. `/goal <objective>`
executes that objective and never auto-saves it to the Library. Open the **Goals**
top tab and choose **Save new goal** or **Save current goal** to save explicitly;
Escape cancels the edit. Imports also add saved templates. Execution and replacement
history remain durable for recovery and metrics but are excluded from this list
and goal exports. Choosing a saved objective starts a fresh goal with this
terminal's current model, workflow and permissions, including the existing
replacement confirmation. Original outcomes, evidence and constraints are not reused.

Settings now includes **Default models** alongside API keys, the default folder,
Pair iPhone and BZZY Core. Open it to edit a table of **Role | Provider | Model |
Effort**: Solo, BZZY Core, Validate, Delegate Brain/Executor, Parallel, Besties,
and one shared **Consensus & Compactor** row. `/settings default-models` opens it
directly; `/settings modes` remains an alias. Delegate has two roles; Validate,
Parallel and Besties support two or three agents. Each group has Save and
Reload/Discard controls. Model and effort choices use Core's provider catalogs.
Editing starts no work; Save applies to the next
mode launch, and `bzzy --MODE` reuses its saved combination directly. `--default` remains an
explicit requirement that a matching preset exists. Explicit agent/participant
selections override the saved combination.
Terminal mode presets stay independent from the normal chat and Core assistant
defaults. Consensus & Compactor can inherit BZZY Core or use a custom shared
selection. Unsaved edits survive Back; Reload/Discard explicitly discards them.
See [default models](docs/DEFAULT-MODELS.md). Nested screens and pickers include
a clickable **← Back** control; Escape retains its existing cancellation behavior.

Set Core's default home for agents/managed imports with
`bzzy-core workspace set /absolute/BZZY` or **Settings > Default BZZY folder**; this never moves or links
existing projects. The installer provides both `bzzy` and `bzzy-core` launchers.
Run `bzzy-core doctor` to check installation prerequisites. The installer
prepares a disabled user service; plain `bzzy` starts it automatically. Use
`bzzy-core start`, `status`, `stop` or `restart` for simple controls. Stop verifies
all work is paused; existing client polling cannot resurrect Core. A new `bzzy`
invocation or explicit start reactivates it without resuming paused models. See
[host setup](../../BZZY-CORE/docs/HOST-SERVICE.md) for Linux and macOS login limits.
Core lifecycle commands remain available outside the minimal Settings menu.

Use `/share` inside an attached terminal for a QR or temporary
`BZZY-TERMINAL-...` code. On the receiving host, `bzzy --import CODE` or `/import`
downloads and restores the complete project/context into that CLI's current
directory. Compare fingerprints; credentials/host authority are excluded,
conflicting files are protected and imported work stays inactive. Codes remain
outside BZZY chat/history/logs. Source Core must stay online and Relay must run
the updated transfer limits. See Core's `docs/PROJECT-SHARING.md` for bounds.

Create at least one CLI terminal with `bzzy` before pairing. **Settings > Pair
iPhone** automatically displays a QR/code and pairs the user's phone with full session control,
terminal catalog access, project sharing and Agent management, after fingerprint
comparison and approval. No access-mode or scope picker is required. Core keeps
Relay connected when CLI closes.
The compact pairing QR fits directly in an **80×24 TUI** with its scanning border.
On the Mac, choose **Compare and approve iPhone…**, compare the displayed
fingerprint with **This iPhone**, then choose **Fingerprints match · Pair iPhone**.
Approval uses a visible confirmation screen and never a command/text-entry prompt.
Reopening Pair resumes an existing pending phone instead of creating another code.
For smaller terminals, press **O** or select **Open QR image** to view the same
QR in Preview on Mac; press **C** for **Copy code** and enter it in BZZY on iPhone.
Terminal resizing is optional. The image uses a private temporary PNG, removed
when the invitation expires/is cleared or the CLI closes; it stays outside chat,
history and project exports.
First-run iPhone pairing is required; current/history terminals open on the same
Core engine with actual chat and quick activity. Real background goal alerts
require the private APNs setup in Core's `docs/PUSH.md`.

CLI and iOS use the same canonical BZZY message-body format. The TUI and stdout
render valid blocks, tables, lists, code, inherited emphasis and named colors;
NO_COLOR and terminal-capability fallbacks retain readable structure. Font-size
hints map to terminal emphasis/dim. Raw history/JSON events remain unchanged and
clipboard copies are readable text. Invalid or incomplete markup falls back to
literal safe text; markup never executes actions or grants permissions.

Run `bzzy --minimal` for the ultra-compact conversation and message input, with
a small connection strip, at any terminal size. It keeps the same sessions,
mouse input, command picker and approval controls. Use `/models`, `/settings`,
`/sessions` or `/update` when needed. The layout and unsent draft survive an
update.

Use `/color blue`, `/color black` or `/color white` to switch the full palette
instantly: chat roles, surfaces, buttons, selections, borders and status colors.
Black uses a pitch-black background with neutral controls; white uses a white background
with dark text and readable accents. Blue is the default on every new launch.
The selection belongs to this CLI only, works in minimal mode, and is retained
when that same terminal reloads after an update. No provider request is sent.

The normal TUI uses the same restrained one-column shell at every interactive
size instead of switching to a separate dashboard. The top bar contains named
session access, New Session, Core-reported CPU/RAM and the Settings gear. Activity,
Network, Skills and the shared room remain available through their commands and
Ctrl+G. Settings and the complete pairing QR use the full content area beneath
the top bar and never leave the chat composer underneath. Sky-blue controls have
hover and pressed feedback; sessions, Settings actions, Back, Send, Copy and the
update checker accept mouse clicks. The composer preserves unsent drafts across
local controls. The obsolete dashboard/eyes header has no rendering route in any
panel. Import, generated share codes and pairing QR screens use a compact text
header with connection state and model/usage context. Codes stay outside chat,
history and frame caches; the complete pairing QR and quiet zone still fit 80×24.

The model control at the bottom opens a floating searchable dropdown over the
current chat. Click a model once to apply it; use the mouse wheel or arrows to
browse, type to filter, and click outside or press Esc to cancel. The adjacent
effort dropdown lists the selected model's supported reasoning levels, with the
manual requested levels described above for Experiential. Defaults
for normal chat, Core and every mode are under Settings → Default models.
Other selectors use floating dialogs with explicit
Confirm/Cancel controls, preserving approval confirmations. Double-click the
project alias in the top bar to rename it inline; Enter/Save name confirms and
Esc/Cancel returns. Core's own provider, model and effort remain independent in
its Default models row.

Open **Skills** from the top bar or type `/skills` to view project and
Core/global skills. Use `/create-skill` to create one, or the tab's Import/Export
actions to transfer selected names through Relay. `/skills import` still accepts
one skill folder/ZIP; local folder imports stay disabled for review. A skill uses
the same package shape as Codex: one
directory per skill with a required `SKILL.md` plus optional `scripts/`,
`references/`, `assets/`, and `agents/openai.yaml`, per the
[official skill-building guide](https://learn.chatgpt.com/docs/build-skills).

Open a project skill and choose **Move to BZZY Core** to review its exact files
and move the portable package into the global library. Existing global skills
are never overwritten, and the moved skill stays disabled until you enable it.
Packages containing private project evidence need a separate generic candidate.

Choose **Sync skills from Codex into BZZY**, type `/skills sync`, or run `bzzy
skills sync` in a terminal to enter a Codex skills directory. BZZY lists every
immediate skill package, then Space toggles checkboxes and Enter imports the
selected packages. Imported skills remain disabled for review. Noninteractive
`bzzy skills sync --json` scans project `.agents/skills`,
user `.agents/skills`, `$CODEX_HOME/skills`, `$BZZY_CODEX_HOME/skills`,
`~/.codex/skills`, and the admin skill directory.

The whole package is copied inactively; project discoveries stay
project-scoped, while user and machine discoveries become Core/global skills.
Scripts and hooks never execute during import or enable. Codex folders whose
metadata name uses underscores are displayed with that name and normalized to
BZZY’s hyphenated format (for example, `read_emails` imports as `read-emails`).
New/changed versions require review and enable; repeat syncs preserve unchanged
enable decisions and independent BZZY edits. See
[Core skills](../../BZZY-CORE/docs/SKILLS.md).

Use `/memory [query]` for attributed project history and `/learn` for bounded lesson reviews, pinned input packets, automatic progress observations, project fact pins, proposed resolutions and skill feedback/curation. Closed complex work, possible fixes, reviewed worker evidence and meaningful saved outcomes can queue reviews. Each job pins its source and reviewer selection; queued work defers during its own conversation's activity without blocking every other idle session. New skills and corrections stage by default; reviewed policy can opt into automatic new project skills. Pauses and recovery retain interrupted reviews until explicit resume. Candidates need domain-appropriate reviewed offline evaluation and explicit activation; open workflow pins protect existing versions. Opening these views never starts inference. See [knowledge and learning](../../BZZY-CORE/docs/KNOWLEDGE.md) for scope, defaults, owner commands and validation limits.

Use **Check for updates** or `/update` to update CLI and Core together. The TUI stays open during installation, then reloads the new frontend in the same terminal with its saved chat and unsent draft. Core control briefly restarts; active runners keep running and paused work stays paused and another client's input lease is respected. Older already-running CLIs need one final reopen to load this updater. See [update behavior and limits](docs/UPDATES.md). The existing command remains:

```bash
bzzy --update
```

Check your Claude and Codex connections:

```bash
bzzy doctor
bzzy doctor --live
bzzy doctor --live --provider codex --model gpt-5.6-sol --effort high
```

`doctor` checks the installed CLI, subscription login and backend connection separately. `--live` also requests a short reply and reports token usage when the backend supplies it. Live checks use subscription tokens, disable tools and time out after 45 seconds waiting for a reply. Run `/doctor` inside chat to test its current subscription model, including while a reply is stuck. A plain first launch opens chat without model selection or authentication prompts. Sending is rejected until a model is selected from the header. Explicit `bzzy setup` still offers guided authentication and default setup.

Claude login, model discovery, chat and diagnostics preserve the same credential settings on macOS and Linux. On macOS, leaving `CLAUDE_CONFIG_DIR` unset is significant: explicitly setting it to `~/.claude` can select a different Keychain entry ([upstream report](https://github.com/anthropics/claude-code/issues/92252)).

Ordinary chat does not snapshot the workspace. Explicit goals create a source snapshot excluding private credential paths and identify any file exceeding the snapshot limit. Enforced task policies use the platform's verified sandbox.

`/pause` stops the current response, including an unresponsive runner or backend, and keeps the conversation available for another message. The runtime refreshes after source updates. Runner startup failures appear in chat and include a private execution-log path. Claude's model picker reads the installed CLI's catalog, and chat displays the model reported by the backend.

Each execution receives allowlisted caller configuration and locally declared provider keys; unrelated host variables are excluded. Opening terminals with different PATHs or API keys does not restart the shared runtime. Runtime source updates still refresh it. Transient local API disconnections retry automatically. Additional non-secret environment names can be declared in `executionEnvironment.allow` in the private config.

The existing runtime supports expiring session credentials with explicit control permissions and revocation. `bzzy service token SESSION` remains read-only; `bzzy service grants` lists grants and `bzzy service revoke GRANT_ID` revokes one. See the [integration guide](docs/INTEGRATION.md) for scoped clients and reconnect semantics. Full-project `/export` bundles remain private owner backups and can contain secrets; `/share` uses the separate credential-filtered portable policy.

Open **Settings** from the top-right gear, use `/settings`, run `bzzy settings`,
or launch `bzzy --settings` directly. It includes hidden API-key save/replacement
for Core's API-key providers, including Experiential Labs, and device
pairing using the bundled Core Relay gateway. The main menu has four entries:
**API keys**, **Default BZZY folder**, **Pair iPhone**, and **BZZY Core**.
Open BZZY Core for status, Start, Stop, Restart and its independent model/effort
default. Stop leaves Settings usable. The BZZY Core page also provides **Update
BZZY CLI + Core**, which uses the same checked updater and reloads this terminal
with chat and draft retained. Start/Restart preserve paused work. Leaving
Settings reconnects an existing chat
without replaying a goal; leaving while Core is stopped closes the CLI.
Pair iPhone offers a QR and a random code for the same expiring request, then
requires phone-fingerprint confirmation on the host. It requests all session
permissions (observe, claim, takeover, execute, answer, pause, cancel, steer),
terminal catalog access, project sharing and Agent management. Its secondary
screen retains fingerprint confirmation, access expiry and grant revocation;
there are no observe-only/control or scope-selection choices. Core service
commands remain available directly; Core's independent model/effort/Save controls live inside the BZZY Core secondary screen.
Core and its Relay dependencies are packaged with this CLI, and Core automatically registers its public identity on the updated Relay.
The daemon keeps the gateway connected after CLI closes. Native local full-line
tests validate iOS interoperability; public host enrollment, real-device checks
and unattended boot/logout behavior remain deployment checks.

The terminal uses the same sky-blue/celeste accent and dark surfaces as BZZY iOS.
True-color terminals show the exact palette, with 256/basic-color fallbacks and
`NO_COLOR` support. QR display keeps black/white contrast and its quiet zone;
small terminals show the required dimensions and retain the manual-code option.
Environment API keys take priority until you explicitly choose the saved key
for new requests from this terminal. Keys never appear in chat/history.

Multi-agent modes (`--delegate`, `--besties`, `--parallel`, `--validate`) use Linux bubblewrap or macOS sandbox-exec. Policies constrain filesystem writes and tool networking; they do not establish complete host-read confidentiality. Claude's adapter still rejects disabled tool networking when it cannot preserve model connectivity safely.

The former Telegram integration has been removed. No bot setup, chat attachment,
background polling or Telegram notification transport remains. Startup retires
an existing bridge and removes its saved token/settings without deleting
conversation history or provider credentials. The shared session API, event
stream and generic notification outbox remain available for platform integration.

Run `npm run check` and `npm test` with Node 24 after preparing Core and CLI
dependencies. The [platform workflow template](.github/workflows/platforms.yml)
targets Debian 12/13, Ubuntu 24.04 and macOS on Intel/Apple Silicon, with a
mandatory enforcement preflight. It requires the complete BZZY workspace and
must be placed at that repository's root to run. A terminal-only checkout and
remote CI results are not implied by this template.

Optional settings in `~/.bzzy/config.json` (or `$BZZY_HOME/config.json`):

```json
{
  "inputTimeoutSeconds": 600,
  "bestiesMaxExchanges": 6,
  "snapshotLimits": {
    "maxFileMiB": 20,
    "maxTotalMiB": 100,
    "maxFiles": 10000
  }
}
```

Merge these keys into your existing configuration. Unanswered approvals expire denied. Besties pauses after the feedback exchange limit; `/goal resume` starts another bounded exchange. Snapshot limits can be raised without omitting files; evidence artifacts retain their separate 20 MiB limit. Snapshot and worker copies use filesystem copy-on-write when available. History and evidence remain saved without automatic pruning.

Peer edits stay in their private workspaces until integrated. A group with unapplied changes remains awaiting review and reports each workspace path and changed files. `/providers` changes the conversation; `/default` saves the launch default. Switching providers carries recent bounded context; the full history remains saved.

For runtime troubleshooting, run `BZZY_DIRECT=1 bzzy run "Reply only BZZY_OK without using tools" --claude --runtime 30 --json` to test the backend without the managed runtime. Replace `--claude` with `--codex` or `--deepseek` as needed.

The [review assessment](docs/REVIEW-2026-10.md) records which external recommendations were implemented, qualified or deferred.

The top status cluster shows a green or red **BZZY Relay** dot, and the bottom
status row spells out separate **Core** and **Relay** states. Green requires a
fresh Core response and, for Relay, a verified heartbeat on Core's authenticated
socket. Stale or failed checks turn red; busy model work and cached state do not
establish connectivity. The compact pairing header retains both indicators
without reducing the QR quiet zone.
