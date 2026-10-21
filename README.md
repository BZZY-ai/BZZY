# bzzy 🐝

A terminal coding agent with a bug-eyed fly mascot and persistent goals.
The adapter uses an existing Codex CLI **0.162.0 or newer** as its main engine,
with goal behavior based on the **0.162.0** reference. Claude subscription sessions run through the official,
unmodified Claude Code CLI. DeepSeek and custom Responses API providers use Codex's engine.

Version **0.2** adds durable recovery, project assessment ledgers, evidence-based
acceptance checks, a background runtime, conversation views, delegation, debate,
parallel agent chats, live activity and HTTP/HTTPS traffic recording.

```bash
bzzy goal "Assess the approved surface" --contract assessment.json --capture-network
bzzy delegate "Solve this CTF using the supplied challenge files" --supervisor codex --executor deepseek
bzzy debate "Challenge this finding" --artifact finding.md --participant claude --participant deepseek
bzzy parallel "Assess the approved surface" --agents codex,claude,deepseek
bzzy --codex
bzzy --claude
bzzy --deepseek
bzzy --delegate
bzzy --besties
bzzy --parallel 2
bzzy --parallel 3
bzzy --parallel --agents codex,claude,deepseek
bzzy --debate --rounds 5
bzzy --view SESSION_ID
bzzy --attach SESSION_ID
bzzy --resume SESSION_ID
bzzy integration
```

You can send one quoted instruction or piece of context before starting a durable
goal in the same conversation:

```bash
bzzy "Read README.md first and follow the project conventions" --goal "Implement the requested change and verify the tests"
```

bzzy completes the first message as an ordinary chat turn, then starts `--goal`
on that same backend conversation. The durable goal objective is exactly the
`--goal` value. The first message is also saved in the task contract as context,
so recovery and configured Parallel or Besties workers can read it.

Read [task contracts, project memory and modes](docs/TASKS.md) and
[the API, events and website integration guide](docs/INTEGRATION.md).

`bzzy --delegate` opens the supervisor provider picker, then its model and effort
picker. Next, choose the executor through the same two screens. Use ←/→ on a model
to set effort independently for each role. Choose a strong model as the **brain**
and a less expensive model as the **hands**, then describe one overall task:

```text
/goal Solve this CTF using the supplied challenge files. Verify the solution before finishing.
```

Plain messages remain ordinary chat with the selected primary model. Use
`/goal <objective>` to start persistent work. The brain plans the investigation, assigns bounded inspections and
tests, opens the resulting evidence, and decides whether to accept, refine or
take over the work. You do not need to write worker assignments. The terminal
shows when the supervisor is planning or reviewing and when the executor is
running, with separate brain/hands token counts where the providers report them.
Escape cancels setup before work starts.

Delegation supports long assessments: there is no default deadline for the parent
goal, while assignments have limits and saved follow-up history. Plans, evidence,
decisions and model selections survive reattachment. Input during execution can
steer the selected agent; ordinary idle chat does not replace the goal. Use `/goal resume` to continue paused
work, or `bzzy --attach SESSION_ID` from another terminal. Review and retries also
consume tokens, so a cheaper executor does not guarantee a lower total cost.
See [delegation contracts and limits](docs/TASKS.md#delegation).

`bzzy --besties` uses the same provider → model → effort picker twice, for
**Bestie 1** and **Bestie 2**. Choose two strong models, including two models from
the same provider if you prefer. Chat normally, then use `/goal <objective>` for
one durable collaborative goal. Each peer investigates in its own workspace,
shares findings and evidence with the other, and reviews the other peer's
decisive evidence. Both must finish their acceptance checks and support the
current cross-reviews; unresolved disagreement remains visible. Independent
provider/model/effort choices, messages, evidence and reviews survive reattachment.
Open **SHARED ROOM** or type `/room` to read the actual messages and evidence
reviews exchanged by the peers, alongside the overview and their individual chats.
See [besties workflow](docs/TASKS.md#besties).

`bzzy --parallel 2` or `bzzy --parallel 3` opens the provider → model → effort
picker for each independent agent. Bare `--parallel` chooses three agents.
Each gets its own chat and workspace when you start `/goal <objective>`; use
Tab/Shift+Tab to switch chats. The scripted `--agents A,B[,C]` form remains
available. Parallel mode accepts two or three agents.

## Install

```bash
git clone https://github.com/m4ke-a-wish/bzzy-cli.git
cd bzzy-cli
./install.sh
bzzy
```

The Linux/macOS installer installs **bzzy only** and creates `~/.local/bin/bzzy`.
It does not install, reinstall, upgrade or print Codex/Claude backends. If Node 24+
is missing, it prepares a private runtime and verifies its download checksum.
No npm dependencies, sudo or Rust build are needed. If that directory is
missing from the current shell's PATH, the installer prints the one command to
enable it immediately and updates supported shell profiles for future terminals.
Keep the checkout: the launcher points into it. Rerun `./install.sh` after pulling updates.

With Node 24+ already installed, `npm install -g .` is another installation route.
The package also has no backend dependencies, so this installs only bzzy.
Windows users can use WSL and `./install.sh`; native Windows installation is not yet verified.
Strict read-only, worker and review sandboxes require Linux bubblewrap and working
user namespaces. `bzzy doctor` reports availability; unsupported strict tasks fail closed.

At runtime, bzzy uses existing executables from `PATH`. `BZZY_CODEX_BIN` and
`BZZY_CLAUDE_BIN` can point to specific existing installations. The Codex adapter
requires version **0.162.0 or newer**, including for DeepSeek/custom API execution.
The native adapter has been verified with **0.162.0** and **0.163.0**. Missing
or incompatible backends produce an error when used; nothing is installed automatically.

## First launch

Run `bzzy` to choose a provider and authenticate:

- **Codex subscription:** bzzy opens the official Codex browser login. No API key is needed.
- **Claude subscription:** bzzy runs official `claude auth login`. The backend owns its credentials.
- **DeepSeek:** enter an API key in a hidden prompt, or set `DEEPSEEK_API_KEY`.

Authentication can also be run explicitly:

```bash
bzzy auth codex
bzzy auth codex --device
bzzy auth claude
bzzy auth deepseek
bzzy provider use deepseek
```

bzzy keeps its own configuration, sessions, outbox, and private API credentials in
`~/.bzzy` (override with `BZZY_HOME`). Existing subscription logins are reused:

- **Codex:** the official backend reads `~/.codex/auth.json` and manages refresh itself.
  `BZZY_CODEX_HOME` takes precedence over `CODEX_HOME`, then the default `~/.codex`.
- **Claude:** official Claude Code reads its own store, including
  `~/.claude/.credentials.json` or its supported OS credential store.
  `BZZY_CLAUDE_HOME` takes precedence over `CLAUDE_CONFIG_DIR` when set.

First-time setup checks the official CLI's subscription login status before opening
browser sign-in. bzzy does not parse, copy or print OAuth tokens. Explicit
`bzzy auth codex` / `bzzy auth claude` still opens the official login flow when you
want to authenticate again. API-provider runs use a separate Codex runtime store
at `~/.bzzy/codex-api` by default. Existing conversations retain their original
backend store so their native history remains resumable. Subscription runs clear
inherited API-key and provider-routing environment variables; other settings in
the official backend still apply.
Subscription backends also check login status before execution and require their
subscription login; an API-key-only login does not silently switch billing modes.
Subscriptions retain their normal usage limits. bzzy is an independent project.

## Work toward an outcome

```bash
bzzy
bzzy run "Explain the failing tests"
bzzy goal "Fix the failing tests, preserve public APIs, and verify the full suite"
bzzy --provider deepseek goal "Complete the migration and verify every requirement"
bzzy --provider claude goal "Find and fix the regression, with a reproduction"
```

Inside chat:

```text
/goal Finish the migration and verify the tests and documentation
/goal status
/goal pause
/goal resume
/goal clear
/debate Validate whether the finding is supported
/providers
/providers deepseek
/models
/models deepseek-v4-pro
/models default
/default
/usage
/new
/exit
```

Interactive sessions open a full-screen chat with animated fly eyes, distinct
speaker colors, a pinned latest user message, and fixed model, time, token and
session indicators. The cyan compound-eye pattern is sampled from `bzzy_img.jpeg`,
with animated gaze and blinking in terminal pixels, displayed only in the top-left
header. The larger eyes have their own padding and a six-column gap before the
header text. Animation targets **60 FPS**, uses elapsed time, paints only changed
mascot cells and skips frames when terminal output is backed up. The header scales
down in short terminals to keep the prompt, session ID and pickers visible.
Provider, model and selected effort stay together beside the eyes. The composer
has its own fixed background and border; multiline tool status is flattened before
rendering so it cannot spill into the message input.
The fixed header also shows **Codex 7d remaining**, **Claude 7d remaining** and
**DeepSeek balance**. `/usage` shows the source, last check and unavailable-state
explanation. Codex uses the official
[account rate-limits RPC](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).
DeepSeek uses the authenticated
[balance endpoint](https://api-docs.deepseek.com/api/get-user-balance/); USD is
shown as dollars and CNY stays in yuan. These lookups do not send model prompts.
Codex and DeepSeek refresh in the background about once a minute. Claude updates
from the official CLI's weekly rate-limit events or its existing usage cache,
checked every 15 seconds. If neither exposes weekly usage, its value remains `—`;
opening `/usage` in official Claude Code can refresh that native cache. `~` marks
old cached values or a failed refresh, and an expired quota window shows `—`
until fresh data arrives. No OAuth tokens are copied or parsed for quota lookup.
Ordinary chat uses medium effort, or low for models that lack medium,
unless an effort is selected in `/models` or with `--effort`.
Without an explicit selection, persistent goals retain the backend's configured
effort. Greetings answer directly without asking the agent to create
investigation records.

Previews: [animated-eye design](docs/terminal-preview.png),
[provider picker](docs/provider-picker.png), [model picker](docs/model-picker.png).

Type **/** to browse command suggestions, then type to filter. **↑/↓** highlights,
**Tab** completes, **Enter** confirms, and **Esc** dismisses the suggestions.
Suggestions include `/debate`, `/models`, `/providers` and `/telegram`.

Use **Ctrl+G** to cycle chat, detailed activity and HTTP traffic, or open them
directly with `/chat`, `/activity`, `/http`. Click view labels or agent tabs to
switch, use the mouse wheel or **PgUp/PgDn** to scroll, and drag the scrollbar on
the right to navigate long histories. Picker rows, effort arrows, Confirm/Cancel
buttons, command suggestions and the composer also accept clicks. **Ctrl+O** shows
tool entries. **Alt+Enter** or **Ctrl+J** inserts a newline. Agent tabs preserve
their own message drafts; Tab completes a visible command suggestion before it
switches agent tabs.

Drag across a phrase in the chat, Activity or HTTP panel, then press **Ctrl+C**
to copy just that selection. The display stays still while you select; agent
execution continues, and copying or **Esc** restores live updates. Each assistant
response also has a small **[c]** beside its name: click it to copy the full current
response, including original Markdown and text outside the visible scroll area.
Copying also works in a read-only `--view`.

**Ctrl+V** reads the available system clipboard into the composer at its cursor;
it never sends the message automatically. Over SSH, copying can use a terminal
clipboard request (OSC 52), which needs support enabled in your terminal. If bzzy
cannot read the system clipboard, Ctrl+V can paste your last bzzy copy and says
when it uses that fallback. Your terminal's own Paste shortcut (**Cmd+V** on Mac
or **Ctrl+Shift+V** on Linux) still works.

For native terminal selection instead, press **Ctrl+S** or enter `/copy`, then
drag and use **Cmd+C** on Mac or your terminal's Copy shortcut. **Esc** or
**Ctrl+S** restores live updates. Secrets cannot enter Copy mode.
**Option+Delete** or **Ctrl+W** deletes the previous word;
**Option+Left/Right** moves by words and **Option+Forward Delete** deletes the next
word. These editing shortcuts also work with Unicode text.

`/providers` opens a provider picker (Codex, Claude, DeepSeek), then immediately
opens the selected provider's model-and-effort picker. Selecting the current
provider keeps the conversation and lets you change its model or effort. A missing DeepSeek
key is requested in a hidden prompt and saved privately. Existing keys are reused.
Changing providers keeps the same conversation and session ID. On its first
reply, the new backend receives the preceding user and assistant messages as
context. Tool output, reasoning, notes, issues and ledgers are not copied into
that chat handoff; project records stay in the project's `.bzzy/` directory.
Switching models within a provider resumes its existing native thread. Use
`/new` when you want a fresh conversation. Cancelling the model picker leaves the original
conversation and default provider selected.
Use `/default` to save the current provider, model and reasoning effort as the
launch preset. A later plain `bzzy` opens with that exact selection. Explicit
`--provider`, `--model` and `--effort` flags take precedence.
`/models` lists models from the selected provider: the installed Codex/Claude
catalogs for subscriptions, and the provider's authenticated `/models` endpoint
for API keys. No model prompt is sent to discover models. **↑/↓** selects a model;
**←/→** cycles its supported reasoning efforts. **Enter** saves both settings,
**Esc** cancels. Each model retains its pending effort while browsing the picker.
`default` leaves effort to the backend; models without reported effort support
offer no effort controls. An interactive effort choice overrides `--effort` for
later turns, including goals, and survives reattachment. `/provider` and `/model`
remain aliases.

`/models MODEL_ID` selects directly; `/models default` resets the provider default.
Changes apply to the next message while preserving the current chat, native thread
and goal. Selecting a model by typing its ID resets the previous model's effort
override. In parallel mode, select an agent tab first to change that agent's model.
Pause or finish an active reply before switching. If a catalog is unavailable,
the picker still offers the current model, default and manual entry.

`/debate [objective]` freezes the latest reply and opens an agent checklist:
arrows move, Space toggles, Enter starts, Esc cancels. Selected agents investigate
independently in isolated workspaces, then debate the shared evidence with the
main agent for up to **five rounds**. The result returns to the original chat.
`bzzy --debate` applies this to the next reply. With `bzzy --parallel`, plain
messages stay ordinary chat; `/goal <objective>` starts independent agent chats
on that same objective. Use `--review-only` to skip
investigation and review a fixed snapshot. See [debate details](docs/TASKS.md#debate).

Codex/DeepSeek sessions use Codex's **actual native goal controller**, including
its continuation policy and lifecycle state. Claude sessions use a bzzy supervisor
adapted from that policy: preserve scope, inspect current evidence, distinguish
work from status narration, and perform a requirement-by-requirement completion
audit. A local MCP tool reports completion or blockers to the supervisor. A recurring
blocker must be reported in three consecutive turns; three turns without work tools
also stop continuation. These policies improve persistence; they do not independently
prove a model's claims or guarantee identical quality across models.

Ctrl+C pauses active goal work and preserves the session. A second invocation can resume it:

```bash
bzzy sessions
bzzy resume                      # latest session in the current directory
bzzy resume <session-id-prefix>
bzzy --resume <session-id-prefix> # same saved session and recovery behavior
bzzy goal status <session-id-prefix>
bzzy goal clear <session-id-prefix>
```

Goals have no arbitrary turn cap by default. Optional limits are explicit:

```bash
bzzy goal "Verify the refactor" --token-budget 100000
bzzy goal "Investigate this failure" --max-turns 20
bzzy resume <id> --token-budget 200000
```

The resumed token budget is a **total**, not an additional allowance. Codex enforces
its native accounting checkpoints; Claude token limits are evaluated between turns.
Limits can overshoot and never count as success. Switching providers with
`/providers` retains the session and passes its chat history to the new backend.
A local runtime owns execution independently
of the terminal. `/detach` or `--detach` leaves work running. `--view ID` restores
history as a live read-only viewer; `--attach ID` transfers input and restores
pending questions. `--resume ID` also restores a saved conversation and continues
its unfinished goal, if any. These commands run on the same machine as the session.
The session UUID remains visible in the terminal footer. Parallel conversations
have Overview and per-agent chat tabs, all accessible through the group UUID.

Project knowledge lives in the current directory's `.bzzy/`: constraints, scope,
issues, hypotheses, decisions, checkpoints, evidence, activities and dated ledgers.
Parallel peers have attributed subdirectories under `.bzzy/agents/`. New conversations
load relevant history and flag observations whose input files changed. Private
credentials, SQLite session state and runner identities remain in `~/.bzzy`.

Every completed or stalled goal prints active elapsed time, known token usage,
stopping reason and session UUID. Multi-agent results include per-agent totals;
unavailable usage is labeled. Optional `--runtime`, `--token-budget`, `--max-turns`
and contract limits stop incomplete work without labeling it successful.

## `--yolo`

```bash
bzzy --yolo
bzzy --yolo goal "Implement and verify the feature"
bzzy --provider claude --yolo goal "Fix the regression"
```

For Codex this disables approval prompts **and the Codex sandbox**, matching its
`--yolo` behavior. For Claude it passes `--dangerously-skip-permissions`; Claude's
own sandbox configuration remains separate. The flag is never remembered as a
default: resuming without `--yolo` restores normal permission settings. In ordinary
interactive use bzzy forwards approval questions. Without a terminal, unanswered
approvals are denied. `--json` produces machine-readable JSONL without the mascot.

## Add API providers

DeepSeek is built in. Other providers can be registered without editing source:

```bash
bzzy provider add my-provider \
  --base-url https://example.com/v1 \
  --model my-model \
  --env-key MY_PROVIDER_API_KEY
bzzy auth my-provider
bzzy provider use my-provider
```

This version supports the **Responses API protocol**, not every service described
as "OpenAI-compatible". Chat Completions-only providers need a future adapter.
The model catalog and provider interface are separate so those adapters can be added.
DeepSeek defaults to `deepseek-flash`; use `--model deepseek-v4-pro` to select Pro.
Its verified base URL is `https://api.deepseek.com`: model discovery uses
[`GET /models`](https://api-docs.deepseek.com/api/list-models/) and inference uses
[`POST /responses`](https://api-docs.deepseek.com/guides/responses_api/).
Model metadata supplies supported effort levels, context size and input modalities.
API keys are passed through child environments, not command arguments or model catalogs.

## Telegram chat and goal notifications

Open the **TELEGRAM** tab by clicking it, cycling with Ctrl+G, or typing `/telegram`.
It has separate checkboxes for **Goal notifications** and **Attach Telegram to this
conversation**, plus a bot setup button. Use clicks or ↑/↓ and Space/Enter.

Setup asks for the bot token in a hidden prompt, then displays a one-time message
such as **BZZY 7K2M9Q**. Open the bot in Telegram and send that exact message.
bzzy detects your private chat ID and saves it with the token; there is no manual
chat-ID lookup. Pairing expires after three minutes and can be cancelled with Esc.
Tokens are excluded from chat history and saved with owner-only permissions in
`~/.bzzy/credentials.json`. The chat ID and notification preference are saved in
`~/.bzzy/config.json`; attachment, queue and reconnect state use the private SQLite
store. These credentials do not go in the project's `.bzzy/` directory.

**Chat attachment mirrors only new messages.** It never sends earlier conversation
history to Telegram. Once attached, new terminal messages and assistant replies
also appear in Telegram, and Telegram messages enter the same conversation. Both
interfaces can chat; the terminal observes work started through Telegram even
while it was sitting idle. Messages queue while the agent is busy. Disabling
attachment stops forwarding further messages and revokes queued Telegram input;
the notification checkbox retains its own setting.

In the bot, `/providers` and `/models` open inline menus; model selection includes
effort and retains conversation context. `/model MODEL_ID` also works. API keys
must be configured in the terminal. Other bot commands are `/goal <objective>`,
`/status`, `/pause`, `/cancel`, `/resume`, `/detach` and `/help`. When the agent asks
a question or requests an approval, reply directly to that bot message. Unrelated
chat text cannot approve a permission request.

The relay uses Telegram's [outbound polling API](https://core.telegram.org/bots/api#getupdates),
so no public webhook/server is needed. It accepts messages only from the paired
private sender. Use a dedicated bot for chat: an existing webhook is left unchanged.
The local relay and agent service continue after the terminal detaches; the
machine must remain running. Incoming updates and execution requests are durable
and deduplicated. Replies split at Telegram's text limit. Ambiguous chat-delivery
failures are shown as `uncertain`, without an automatic resend that might duplicate
the message. Telegram connection and message status appear in the tab.

`/telegram on` and `/telegram off` control goal notifications independently of
chat attachment. `/telegram status` shows settings; `/telegram test` explicitly
sends a test notification. Setup and pairing send no test goal alert. Settings
apply across sessions and are read again when notifications are delivered.

```bash
bzzy telegram setup
bzzy telegram attach SESSION_ID
bzzy telegram detach
bzzy telegram test
bzzy telegram status
bzzy telegram off
bzzy telegram on
```

Create the bot with BotFather and use its token for pairing. For a known chat ID,
`bzzy telegram manual` retains manual configuration; groups and channels can
receive goal notifications. Environment-only configuration is also supported:

```bash
export BZZY_TELEGRAM_BOT_TOKEN='your-bot-token'
export BZZY_TELEGRAM_CHAT_ID='your-chat-id'
```

Notifications are sent for `goal.completed` and `goal.stalled`. Stalled includes
blocked goals, usage/token limits, and an explicit turn limit; a user-requested pause
or Ctrl+C does not send a stalled alert. Messages include the objective, provider,
usage, workspace, and session ID. Only enable delivery to a chat where you want
that task information to appear.

Goal events are versioned and backend-independent. The notification hub persists
each event and per-transport delivery receipts in `~/.bzzy/notifications`. A failed
delivery leaves the goal result intact and can be retried:

```bash
bzzy notifications list
bzzy notifications retry
```

Successful deliveries are not resent during ordinary retries. As with other
network outboxes, an ambiguous timeout or crash after remote acceptance can cause
a duplicate. Resuming a stalled goal begins a new notification epoch. New transports
do not receive old events retroactively. **Telegram is the only implemented transport.**
To add another later, register an adapter with `enabled(config)` and `send(event, context)`;
goal execution and event schemas need no transport-specific changes. Lifecycle
transitions and the outbox are committed together in SQLite before delivery.

## Live activity, traffic and external apps

The HTTP panel automatically includes Claude WebFetch and supported backend browser
visits, including visits restored from older session history. These are labelled
**backend-reported** because their HTTP status is not exposed. For measured shell
HTTP/HTTPS traffic, add `--capture-network`; the `http_request` tool always records
its observed requests. Request and response events update a single panel row.

```bash
bzzy activity SESSION_ID --detailed
bzzy traffic SESSION_ID
bzzy service web SESSION_ID
bzzy service token SESSION_ID --json
bzzy integration
```

The local `/v1` API exposes goal state, usage, activities, traffic, child chats,
pending questions and durable Server-Sent Events with reconnect cursors. The
package exports a browser/Node `BzzyClient`. A session-scoped observer token lets
your website read a whole parallel group without permission to control it.
Chat/control clients use explicit input ownership and idempotency keys.

Activity entries use plain-language `summary` and `details`, for example
**Checking the footer on paypal.com** and **I’m opening paypal.com to locate its
footer and extract its text.** Agents are instructed to publish these before
substantial work, as their approach changes, and during long tasks. The host
supplies a coarse fallback from tool activity when the agent has not reported
progress, marked `provenance: host-inferred`. These entries contain no raw shell
commands; tool logs remain available in Chat with Ctrl+O. The terminal, bundled
web view and external integrations receive the same durable `activity` records.
`http_request` records actual in-scope requests and response evidence.
`--capture-network` adds a local HTTP/HTTPS proxy for compatible child tools,
using a private CA supplied only to those processes. Model traffic is excluded,
credential metadata is redacted, and capture coverage is explicitly reported.
Clients bypassing the proxy are not claimed as observed.

## Development

The reference baseline is `rust-v0.162.0`, commit
`c1382380de69521303b416720a52f42d51af6248`. The unmodified goal-controller source,
policy, and selected agent instructions are preserved under `references/codex-0.162.0/`,
with a SHA-256 manifest. Full upstream repository checkouts are not required to
install or run bzzy. To download the full pinned source for development, run
`./scripts/fetch-codex-reference.sh`; it creates the ignored `codex-0.162.0/`
directory. Backend upgrades are managed separately; bzzy never installs or updates them.

```bash
npm install
npm run check
npm test
npm run smoke
```

The test suite uses subprocess protocol fixtures, not paid model requests or live
Telegram messages. `smoke` exercises the real installed backends, with a local mock
Responses server for Codex and an initialization-only Claude handshake. Browser
sign-in, live inference, and real Telegram delivery require your own accounts.
`bzzy doctor` reports backend versions. `BZZY_CODEX_BIN` and `BZZY_CLAUDE_BIN` can
select an installed backend explicitly.

OpenAI Codex-derived prompts and metadata are attributed in [NOTICE](NOTICE).
bzzy code is Apache-2.0; upstream backend packages retain their own licenses and terms.
