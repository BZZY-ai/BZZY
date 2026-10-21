## What bzzy does

bzzy is a local terminal agent that wraps existing model backends with persistent
conversations, durable goals, evidence, verification, multi-agent coordination,
recovery, live activity, traffic views, notifications and an integration API.
The terminal is a client; a managed execution runs in a separate process. A local
service owns execution scheduling and durable events. Other clients can observe
or explicitly take input ownership without starting another model run.

Read this reference as the installed application's behavior. User instructions,
task contracts and authorization still determine what a particular run may do.

`bzzy --update` pulls the installation checkout's tracked branch with a
fast-forward-only Git pull and reruns `install.sh`. It works from any directory
without provider setup. Commit or stash installation changes first. Detached
checkouts and installations without a Git checkout or upstream cannot update.
Start a new bzzy process after updating to use the new code.

## Providers, authentication and model selection

- Codex uses the existing official Codex CLI and its subscription login/history.
- Claude uses the existing official Claude Code CLI and its subscription login.
- DeepSeek and custom API providers run through the Codex engine and require a
  Responses-compatible endpoint. Arbitrary chat-completions-only APIs are not
  automatically compatible. Provider URL, model and context settings live in
  config; API keys live separately in private credentials or environment variables.
- First-run setup checks existing Codex and Claude logins, marks usable sessions
  Validated, offers an optional hidden DeepSeek key prompt, and selects a normal
  chat provider. Enter skips the optional key. bzzy does not install or update
  Codex or Claude for you.
- Model catalogs come from the installed backend or configured provider's models
  endpoint. Catalog discovery does not start inference. A manual model entry is
  available when a catalog cannot be read.
- Each agent has an independent provider, model, effort and available model
  capabilities. Up/down chooses models; left/right chooses supported effort.
  Provider default effort leaves that choice to the backend. Duplicate providers
  are allowed in a combination; the selected agents still have distinct sessions.
- `/models` changes the selected conversation's next turn while keeping its native
  thread. `/providers` retains the bzzy conversation and transfers prior readable
  user/assistant chat into a new backend thread. Historical tool logs and private
  reasoning are not copied into that handoff. Changes require an idle conversation;
  provider changes inside existing group children are restricted in the terminal.

## Modes and their completion logic

Normal chat: `bzzy`, `bzzy --codex`, `bzzy --claude` or `bzzy --deepseek`.
An ordinary message is an ordinary turn. It does not create a persistent goal or
authorize delegated assignments. `bzzy run "task"` is a command-driven ordinary
turn; `bzzy goal "objective"` or `--goal` creates durable goal work.

Parallel: `bzzy --parallel` or `bzzy --parallel 2|3`.
Select 2–3 agents for one objective. Each independently pursues the entire goal
in its own workspace and conversation. Agents can inspect attributed peer status,
but another peer's result is a claim until verified. Continue after selecting two
or configure the third to proceed automatically. Enter the shared goal, then use
Tab/Shift+Tab or `/tab` to switch individual agent chats and the overview. Parent
completion requires every peer's goal plus the original project's deliverables
and acceptance checks. Independent patches are not automatically merged.

Debate: `bzzy --debate`.
Select 2–3 agents total: one main agent and one or two challengers, with their own
models and efforts. Continue with two or configure the third, then enter the goal.
Every selected agent investigates independently first. The main agent then opens
a case from the frozen evidence, challengers critique that exact revision, and the
main agent answers, concedes or revises for at most five rounds. Decisions retain
supported conclusions, rejected claims, corrections,
unresolved objections and next verification steps. Agreement alone is not proof.
At least two evidence-bearing independent reports are required before an opening
case. Fully dispositioned objections with no remaining verification stop the
debate after its first challenge round.
A matching strict majority of complete Phase 1 verdicts backed by recorded
evidence finishes before the opening case. With three agents, two matching votes
are sufficient and a failed or timed-out third agent is an abstention.
`--review-only` skips new investigation and reviews fixed material. `/debate
[focus]` in a chat selects the latest final assistant reply and its user request,
runs a separate debate, and returns its decision to the original conversation.

Delegate: `bzzy --delegate`.
Choose one strong supervisor/brain and one cheaper executor/hands model, then
enter one overall goal. The brain plans, assigns bounded work, inspects evidence,
reviews results, and makes the final judgment. Routine work includes small
lookups and page extraction. Completion requires attempted executor work and a
brain review; a brain-only response cannot silently satisfy a delegated goal.
An inspected executor failure can justify the brain taking over. Assignments
have saved contracts, independent limits, workspaces, rounds and reports. A worker
report does not complete its parent. Accepted patches are applied only after
source-hash conflict checks; concurrent edits must not be overwritten.

Besties: `bzzy --besties`.
Select 2–3 equal collaborators and enter their combined goal. Continue after two
or configure the third. All peers receive the same objective and boundaries,
work in isolated workspaces, exchange bounded messages and selected immutable
evidence, and inspect one another's claims. A message can target another member;
the default recipient is the next peer in the group. Review feedback returns to
the claim's sender. Every peer must finish its acceptance checks, and every peer's
latest decisive evidence-bearing claim needs a supported independent review.
Missing, disputed, inconclusive or stale reviews leave the goal unresolved.
The shared room shows actual peer messages and reviews separately from user chat.
Original-workspace deliverables remain required. No peer supervises another.

Scripted selections use `--agents codex:MODEL,claude:MODEL[,deepseek:MODEL]` for
parallel/besties. Debate uses `--supervisor`, `--supervisor-model` and one or two
`--participant provider:model` flags. Delegate has separate `--supervisor`,
`--executor`, `--supervisor-model` and `--executor-model` flags. `--rounds` limits
debate to 1–5 rounds. `--concurrency` is bounded at 8; besties requires enough
concurrency for all chosen peers.

## Defaults are independent per mode

`/default` saves the current selection in the current mode. Normal chat saves
`defaultProvider` and `defaultSelection`. Multi-agent presets use separate config
keys: `parallelDefault`, `debateDefault`, `bestiesDefault`, `delegateDefault`.
The combinations preserve ordered providers, models, efforts and capabilities.
Saving from a parallel or besties agent tab captures the full group's current
choices. Saving one mode does not overwrite the other modes' presets.

The next interactive launch asks Use saved combo? Yes goes to goal entry; No
opens the selector. Choosing another combination does not replace the stored
preset until `/default` is used again. `--default` skips confirmation and selection:

```bash
bzzy --default
bzzy --parallel --default
bzzy --debate --default
bzzy --besties --default
bzzy --delegate --default --goal "Inspect the supplied project"
```

The normal form uses the normal chat preset. Missing mode presets produce a
clear setup error. `--default` is separate from explicit `--agents` or
`--participant` selections. An explicit parallel count must match a reused
combination. Saved presets contain selections, not API keys.

## Goal lifecycle, context and verification

1. Create a task contract and goal before model execution. The contract records
   the objective, context, scope, constraints, inputs, acceptance criteria,
   required artifacts, verification commands, policy and limits.
2. Run the selected mode. Save native backend thread/session IDs, checkpoints,
   evidence, issues, assignments, reviews, progress and reported usage durably.
3. A model reporting completion enters host verification. Declared requirements,
   evidence integrity, required deliverables and configured verification commands
   must pass. Delegate and collaborating group modes add their own review gates.
4. Failed acceptance can trigger bounded follow-ups. The default allowance is
   two; exhausted follow-ups leave `awaiting_review`, not a successful completion.
5. Goals can be active, verifying, complete, paused, cancelled, blocked,
   awaiting_review, budget_limited or usage_limited. Always distinguish goal
   status from execution state and an individual worker's outcome.

`/goal <new objective>` stops the current execution, archives the old goal with
its replacement linkage, and starts the new goal in the same conversation. In a
parallel/besties group view this replaces the group objective and stops the old
peers, even when entered in an agent tab. `/goal resume` keeps the existing goal.
`/goal status`, `/goal pause`, `/goal cancel` and `/goal clear` control saved work;
pause/cancel a live goal before clearing it. Historical evidence is not automatic
acceptance of a new objective.

Interactive startup and resumed goals keep chat open after completion or a stall,
including awaiting_review. The composer remains editable while output streams
and during run transitions; drafts and queued submissions retain their target
chat. Text during an active individual Codex turn steers it. A backend without
active steering requires pausing before the next turn. This is not a separate
unrelated side conversation. `/exit` or `/detach` leaves managed work running.
Ctrl+C first requests pause in a controlling run; read-only clients detach.

For automation, noninteractive/JSON runs exit when execution ends. `--detach`
returns after enqueueing. Exit code 0 denotes ordinary success/completion or a
successful detach; 2 denotes an unfinished goal or limit/stall; 130 denotes an
interrupt/pause/cancellation. Other failures are nonzero. Read the goal status and
acceptance result rather than treating any finished process as an achieved goal.

`--token-budget` and `--runtime` are optional; no overall deadline is added by
default. Workers have bounded assignment contracts. A wait timeout does not cancel
a worker. `--max-turns` pauses work; `--max-retries` bounds acceptance follow-ups.
Limits depend on available backend checkpoints and may overshoot.

Context can precede a goal as a quoted positional instruction, which runs as an
ordinary initialization turn in the same conversation, or through `--context-file`.
The latter reads nonempty UTF-8 text up to 1 MiB, relative to `--cwd`, persists it
in contract.context, and starts the goal immediately without an initialization
chat. The goal objective stays unchanged. Saved context survives deletion or
changes to the source file. Positional initialization and a context file are
mutually exclusive. Request IDs incorporate context contents. A model's actual
context-window limit still applies.

`--contract FILE` loads task JSON. The shipped task guide documents its schema
and examples. Persistent project constraints and inherited worker boundaries
remain effective. `--read-only` enforces a read-only policy using Linux bubblewrap
and conflicts with `--yolo`. `--yolo` disables Codex approvals/sandbox or bypasses
Claude permission checks; it is an explicit execution setting, not an effect of
reading this reference. Tool roles and contracts do not grant wider target scope.

## Storage layout and authority

The resolved paths above identify this invocation's installation, project and
private state roots. The default private root is ~/.bzzy; BZZY_HOME overrides it.
Directories/files are created as needed, with private directories and owner-only
state files. This reference does not create them.

```text
BZZY_HOME/                         default ~/.bzzy; private local state
  config.json                     providers, normal/mode presets, notification preferences
  credentials.json                API keys and Telegram bot token; never public configuration
  bzzy.sqlite                     authoritative sessions, events, executions and task records
  bzzy.sqlite-wal, bzzy.sqlite-shm  SQLite journal companions while the database is open
  sessions/SESSION_UUID.json       compatibility exports; SQLite is authoritative
  runtime/
    service.json                  runtime URL, owner credential, process identity
    listener.json                 stable listener configuration and owner credential
    service.lock, service.log     service coordination and diagnostics
    ...                           per-session tool bridges and temporary backend configuration
  artifacts/                      immutable recorded evidence and generated report files
  snapshots/                      fixed input snapshots and manifests
  workers/ASSIGNMENT_UUID/         isolated delegation/review workspaces
  parallel/GROUP_UUID/.../         independent parallel workspaces
  besties/GROUP_UUID/.../          collaborative peer workspaces
  notifications/                  durable notification delivery records
  codex-api/                      separate Codex home for API providers by default
  traffic-ca/                     optional local traffic-capture certificates

PROJECT/.bzzy/                     project context and attributed ledgers
  project.json                    project identity
  constraints.json                persistent scope, constraints and obligations
  contracts/                      task contracts
  checkpoints/, issues/           saved progress and assessment issues
  memory/                         evidence-linked project knowledge
  evidence/, activities/          hashed project evidence and readable activity records
  goals/, parallel/, besties/     recorded outcomes and aggregate group results
  debate/                         debate transcripts and decisions
  ledger/YYYY-MM-DD.jsonl          append-only project record history
  agents/NAMESPACE/.../            each peer's attributed project records

INSTALLATION/
  bin/bzzy.js                     executable entry point
  src/cli.js, ui.js, tui.js        argument handling, command flow, terminal client/editor
  src/runtime*.js                 local service, scheduling, durable runners and client control
  src/engines/                    Codex and Claude execution adapters
  src/*-setup.js, mode-presets.js  provider/model/effort rosters and independent presets
  src/goals.js, task.js            persistent goal and contract setup
  src/controller.js               single-conversation execution and host acceptance loop
  src/delegation*.js               assignments, review, accounting and patch application
  src/parallel.js, besties.js      independent and collaborating group coordinators
  src/debate*.js                   investigation, objections, rounds and final decisions
  src/evidence.js, verification.js hashed evidence and host completion checks
  src/database.js, store.js        SQLite state, event log and compatibility exports
  src/tools.js                    role-scoped task tools and local tool bridge
  src/telegram*.js                 pairing, durable chat relay and bot controls
  src/notifications.js            notification delivery and retries
  src/api-client.js               exported JavaScript integration client
  assets/                         web view, event schema, backend instruction assets
  docs/                           WHOAMI.md, INTEGRATION.md, TASKS.md and supporting guides
  references/                     backend protocol/reference material shipped with bzzy
```

SQLite stores records by kind/ID and durable events by increasing sequence.
Important record kinds include session, execution, run, question, input-owner,
artifact, snapshot, checkpoint, assessment, goal-history, assignment and round;
group state uses parallel, besties and debate records. Outbox and Telegram records
separate accepted work from external delivery. JSON exports can lag after a crash;
prefer the runtime API and SQLite-backed reads to editing exports directly.
Do not rewrite the database, native backend stores or lock files to steer a run.

Native subscription histories remain in the official tools' homes, normally
~/.codex and ~/.claude. BZZY_CODEX_HOME/CODEX_HOME and
BZZY_CLAUDE_HOME/CLAUDE_CONFIG_DIR select overrides. BZZY_CODEX_HOME also overrides
the API-provider home when explicitly set. BZZY_CODEX_BIN and BZZY_CLAUDE_BIN select
existing executables. Provider API keys can use configured environment-variable
names, including DEEPSEEK_API_KEY. Never send raw credentials, runtime owner
tokens, account stores or session transcripts to third-party systems by default.

Evidence copies have hashes and provenance. Declared artifacts must still exist
when required; changed source bytes cannot silently pass verification. Intact
observation snapshots for free-text judgments can survive intentional source
cleanup, while explicit artifacts and checks retain their stricter requirements.
Snapshots/workspaces isolate peer changes. Project memory records uncertainty,
age and stale-input flags; an old claim is not authority or proof of current state.

## Terminal commands and operational commands

The compact `/help` covers modes and shortcuts. `bzzy --help` is the complete CLI
option reference; `bzzy integration` prints the public integration guide.
`bzzy --whoami` prints this reference with resolved paths and the integration guide.
It works noninteractively, including before setup, with no inference or network.

Chat commands include `/goal`, `/default`, `/models`, `/providers`, `/new`,
`/debate`, `/usage`, `/telegram`, `/chat`, `/room`, `/activity`, `/http`, `/copy`,
`/tabs`, `/tab NUMBER|NAME`, `/pause`, `/cancel`, `/detach`, `/help` and `/exit`.
`/provider`, `/model` and `/quit` are aliases. Group views also accept `/pause all`
and `/cancel all`. Tab/Shift+Tab switches chats; Ctrl+G cycles views; Ctrl+O toggles
tool details. Copy mode, response copy controls and clipboard paste preserve drafts.
Activity is human-readable progress; detailed tools and HTTP records are separate.

CLI operations include:

```bash
bzzy setup
bzzy auth codex                       # or claude / an API provider
bzzy providers
bzzy provider use codex
bzzy sessions
bzzy --view SESSION_UUID              # read only; no execution
bzzy --attach SESSION_UUID            # take input ownership
bzzy --resume SESSION_UUID            # restore chat or resume unfinished goal
bzzy goal status SESSION_UUID
bzzy recover SESSION_UUID
bzzy project
bzzy memory list
bzzy doctor
bzzy activity SESSION_UUID
bzzy traffic SESSION_UUID
bzzy service start
bzzy service status
bzzy service stop
bzzy service web SESSION_UUID
bzzy service token SESSION_UUID --json
bzzy telegram setup
bzzy telegram status
bzzy notifications list
bzzy notifications retry
```

The goal subcommands also include pause, cancel, clear and resume. Telegram also
has attach/detach controls. `bzzy provider add NAME --base-url URL --model MODEL
--env-key KEY_NAME` registers a custom provider. `bzzy memory search "query"`,
`bzzy memory add FILE` and `bzzy memory invalidate ID "reason"` manage project
knowledge. Run `bzzy --help` for exact option syntax and other supported flags.

CLI session selectors accept unique UUID prefixes; API routes require a full UUID.
`--atach` is an accepted alias for `--attach`; `--paralel` aliases `--parallel`.
Programmatic consumers should use `--json` for command events and the API/SSE
envelopes for live data rather than parsing the animated terminal screen.
`--whoami` itself always prints the text reference, including with `--json`.

## Task contracts and model-side tools

A contract is JSON, at most 128 KiB. A local report task can declare a required
output and a real verification command:

```json
{
  "context": "Use the supplied project files and explain the evidence.",
  "constraints": ["Preserve unrelated user changes"],
  "scope": {"allowedTargets": [], "excludedActions": ["Publish results externally"]},
  "acceptanceCriteria": [{"id": "report", "description": "The report supports its conclusions with inspected evidence"}],
  "artifacts": [{"path": "report.md"}],
  "verification": [{"id": "tests", "argv": ["node", "--test"], "timeoutSeconds": 120}],
  "policy": {"mode": "workspace-write", "writablePaths": ["."], "network": "inherit"},
  "limits": {"maxRetries": 2}
}
```

Use it with `bzzy --goal "Inspect the project and write report.md" --contract
task.json`. `inputs` can name supplied files; artifacts may require JSON schemas;
verification uses argument arrays rather than an implicit shell. Scope can include
allowed/excluded targets and actions, account references and cleanup obligations.
Limits can include runtimeSeconds, tokenBudget, maxTurns, maxRetries, concurrency,
maxAssignments and assignmentSeconds. The CLI's requested objective takes
precedence over an objective in the contract file. Keep context separate from the
goal's success condition.

The backend model receives a role-scoped local tool bridge. These are not public
unauthenticated HTTP routes. Tools include:

- Progress and durable task context: `activity`, `get_task_state`, `checkpoint`.
- Evidence and scoped traffic: `record_evidence`, `read_artifact`, `http_request`.
  `http_request` requires declared allowedTargets and does not follow redirects
  automatically. Evidence reads are bounded and inspection is recorded.
- Project knowledge: `remember`, `recall`, `issue`. Distinguish observations,
  hypotheses, blocked/inconclusive/disproved results and supported conclusions.
- Acceptance and goals: `assess_requirement`, `get_goal`, `update_goal`. The host
  still verifies completion; role and active-goal restrictions remain enforced.
- Delegate coordination: `delegate`, `list_assignments`, `assignment_status`,
  `wait_assignment`, `followup_assignment`, `review_assignment`,
  `apply_assignment`, `cancel_assignment`, and worker `finish_assignment`.
  Status/wait calls read saved work rather than invoking a second worker model.
- Peer collaboration: `peer_status`, `peer_message`, `peer_inbox`, `peer_review`.
  Sharing evidence grants only the explicitly referenced records to the recipient;
  a peer cannot inspect arbitrary private evidence just by knowing an ID.

Task tools are exposed according to role and goal mode. Ordinary chat cannot
launch delegate assignments; executors/reviewers cannot accept parent requirements
or widen their inherited policy. A native thread may retain schemas needed by a
future goal, while the host continues to enforce whether each call is authorized.

## Telegram, notifications, usage and recovery

Telegram setup accepts a bot token privately and discovers the private chat ID
through a pairing phrase. Credentials are stored separately from config.
Notification enablement and chat attachment are independent settings. Saved
autoAttach reconnects new/resumed conversations using the same bot and matching
chat ID; detach disables automatic attachment. Group overviews are not attached
as ordinary chats; an individual agent conversation can be attached.

The relay mirrors new readable chat messages, not old full transcripts. Bot
commands include provider/model/effort menus, `/default`, `/goal`, `/status`,
`/pause`, `/cancel`, `/resume` and `/detach`. A new `/goal` stops and replaces active
work. Replies to questions answer the originating pending question. Messages,
dispatch, polling cursors and delivery state persist; uncertain deliveries are
not automatically treated as safely repeatable. Terminal and Telegram input use
the same one-execution-per-session rule and authorization boundaries.

Completed/stalled summaries show elapsed time as HH:MM:SS and reported tokens.
Delegate output distinguishes BRAIN, HANDS / EXECUTOR, and TOTAL. Zero assignments
are labeled not used; missing telemetry is unavailable, not fabricated as zero.
Group summaries retain per-agent attribution and indicate incomplete totals.
Task token counts, weekly subscription quotas, API balances and dollar cost are
different measurements. `/usage` shows available account information; no exact
subscription invoice or guaranteed savings is inferred from token counts.

Checkpoints, task evidence, native thread IDs, assignment rounds and event cursors
support recovery. Lost UI connections do not replay side effects or start another
worker automatically. Recovery checks process identity before replacing runners,
retains evidence, and marks uncertain actions for review. Observer clients must
not call execute simply to reconnect. Use view/attach/resume according to intent.

## Integration protocol

The following shipped guide is part of this reference. It gives exact public
routes, ownership leases, read-only observer tokens, event envelopes, SSE cursor
rules, idempotency behavior, capture coverage and JavaScript client examples.
There is no public API route that creates an arbitrary new session/contract;
create it through the CLI, then use its UUID. Sending the literal text `/goal ...`
to the generic execute endpoint is not terminal-command parsing. To replace a goal
use the terminal/Telegram command flow, or stop/control and establish the new task
through supported CLI operations. `goal: true` executes an existing saved goal.
