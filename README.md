# BZZY

Self-hosted AI workspaces with a terminal client and a native iPhone app.
Core owns execution and durable state; clients supervise the same sessions.

```text
BZZY CLI ↔ BZZY Core ↔ BZZY Relay ↔ BZZY iOS
```

| Product | Implementation |
| --- | --- |
| [Core](BZZY-CORE/README.md) | Sessions, providers/auth, tools, goals, persistent Agents, sharing and the host Relay gateway. |
| [CLI](BZZY-CLI/BZZY-CLI-TERMINAL/README.md) | Terminal chat, model goals, aliased sessions, Settings, pairing and local Core controls. |
| [Relay](BZZY-RELAY/README.md) | Authenticated encrypted transport and expiring QR/import codes; no model execution or provider credentials. |
| [iOS](BZZY-IOS/README.md) | Pairing, Agent management, terminal chat/history, activity, on-device dictation and voice chat. |

Keep this directory layout when cloning: the Node packages use sibling file
dependencies. Agent and sharing implementations live in Core and their clients.
There is no separate Agent or sharing daemon.

CLI **Agents** manages [reusable specialist subagents](BZZY-CORE/docs/SUBAGENTS.md),
such as HTTP analysts or finding reviewers. Core invokes them from normal chats
and goals across supported models, with separate contexts, bounded parallelism
and evidence review. Persistent iPhone Agents remain a separate resource type.

Core also owns [project knowledge and reviewed learning](BZZY-CORE/docs/KNOWLEDGE.md):
attributed recall, evidence freshness, scoped skills, private approved profiles
and bounded idle reviews with explicit candidate evaluation and activation.
CLI `/memory` and `/learn` open its review controls in the existing Skills panel.

Reusable [workflows](BZZY-CORE/docs/WORKFLOWS.md) supply a goal's operating
instructions. Create or load one from the **Workflows** top tab. `/workflow`
opens a quick picker with **None** and the available workflows for this terminal.
Core pins its full text before the next `/goal` starts;
existing goals retain their original workflow across resume and model changes.
`bzzy --workflow NAME` selects it at launch, including with `--attach NAME`;
`--workflow none` clears it without starting work.

[Session history memory](BZZY-CORE/docs/SESSION-MEMORY.md) adds a bounded index of
each terminal's own conversation across model and mode changes. Its background
compactor shares one configurable model with validation consensus, inheriting the
BZZY Core model by default. `/create-skill` and `/create-agent` use the terminal's
current model and publish validated global definitions enabled for use. The
Skills and Agents tabs show names and ON/OFF controls, with plain Import and
Export actions. Select names once and copy the generated code. On another BZZY,
Import asks **ENTER CODE**, then downloads, checks and installs missing entries
with visible progress. Completion lists only newly installed names.
The **Goals** top tab saves reusable objectives manually, including the current
goal when explicitly chosen. Running `/goal <objective>` never adds it to this
Library; execution history stays available for recovery and metrics. Bare `/goal`
opens the saved-objective quick picker. Goals and Workflows provide the same
Import/Export flow. Goal exports show readable objective text; imports save
templates without starting goals or changing the selected workflow.

CLI chat shows the current action with an animated indicator, its own timer,
last-output age and a recent Core process observation. Quiet periods, approval
waits and lost connections remain explicit; process liveness does not claim
model progress. Skills, Agents, Workflows and Goals share spaced button toolbars
and visible keyboard focus. Right-click an entry or press F10 for confirmed
removal from Library, preserving chat history, evidence and pinned running work.

Achieved goals can carry a separate [validation badge](BZZY-CORE/docs/GOAL-VALIDATION.md)
after `/validate` checks the original requirements and recorded evidence. The
consensus explanation cannot change the host-checked outcome.

CLI **Metrics** shows recorded skill and specialist-agent use for the current
goal, earlier goals and the whole chat, including its workers and linked reviews.
Counts persist in Core; reopening a chat does not count as another invocation.
See [usage metrics](BZZY-CORE/docs/METRICS.md).

Transfer the [BZZY Library](BZZY-CORE/docs/LIBRARY-SHARING.md) between Mac and
Linux with `bzzy library share` and `bzzy library import`. Expiring Relay codes
carry skills, specialist agents, workflows and saved goal text; the receiver
validates and installs only missing entries. `/share` separately transfers a full
terminal project and its saved context/history; later imports preserve existing chats.

## Install Core and CLI

On macOS or Linux, run the bundled installer from the terminal package:

```sh
cd BZZY-CLI/BZZY-CLI-TERMINAL
./install.sh
bzzy
```

The installer prepares Node 24+ if needed and requires Python 3.9+ for project
ZIP sharing. Core runs as a user service. Use `bzzy-core start|status|stop|restart`
or **CLI Settings → BZZY Core**. Stop pauses work durably; Start/Restart do not
automatically replay paused goals.

CLI **Settings → Default models** brings Solo, Core, Validate, Delegate,
Parallel, Besties and the shared Consensus & Compactor selection into one table.
Settings also contains API keys, the default BZZY folder, Pair iPhone and BZZY Core.
iPhone Settings → Models and defaults edits independent solo CLI, Core assistant,
Besties, Parallel, Validate and Delegate presets. Mode flags reuse their saved setup
automatically; a missing preset opens setup. Terminal projects keep their original working directory. Use `/alias NAME` to
show a session in CLI/iOS; both lists put the most recent activity first.
History saves automatically. `bzzy --attach NAME` opens that saved chat, or creates
an idle named chat here when no match exists. Existing chats keep their original
directory, model, history and goal; attachment starts no model work.

## iPhone and Relay

Open `BZZY-IOS/BZZY.xcodeproj` in Xcode, choose your development team and iPhone,
then build/run. First use requires Pair; compare fingerprints and approve on the
host. The app holds device-scoped authorization, never Core's owner credentials.
See the [iOS guide](BZZY-IOS/README.md) and [Core Relay setup](BZZY-CORE/docs/RELAY.md).

For a Relay you operate, use the [deployment guide](BZZY-RELAY/deploy/README.md).
Core registers its public host identity automatically with the updated Relay. Normal reinstalls reuse the private identity in `~/.bzzy/relay/host.identity.json`; keep that directory to retain the same computer and pairing. Keep private deployment configuration,
keys, account bindings and notification credentials outside this repository.

## Development

Use Node 24+ and install the locked workspace dependencies:

```sh
cd BZZY-RELAY && npm ci --ignore-scripts
cd ../BZZY-CORE && npm ci --ignore-scripts --install-links=true
cd ../BZZY-CLI/BZZY-CLI-TERMINAL && npm ci --ignore-scripts --install-links=false
```

Each Node product provides `npm run check` and `npm test`. CLI fixtures run
through `scripts/test.mjs`. On macOS, run `BZZY-IOS/tools/check.sh` from the iOS
directory for model, formatting and native Swift checks. Product validation
records describe test scope and outstanding device/platform limitations.

Read [AGENTS.md](AGENTS.md) and [SECURITY.md](SECURITY.md) before changing the
workspace. The canonical assistant presentation contract is
[message_format.txt](BZZY-IOS/message_format.txt), used by CLI and iOS. Formatting
does not grant permissions or prove completion. Optional scheduling and production
account connectors remain future work; see the product implementation guides.
