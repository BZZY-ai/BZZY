# Core's default AI and background tasks

Core runs on the home host. Its coordinator is the model selected to interpret
Core requests; the daemon is the deterministic execution and storage service.
The coordinator's provider/model/effort are independent of normal terminal chat
and every CLI `--default` mode preset. A terminal chat can use one model while
Core is configured to use another.

Codex, Claude, DeepSeek and registered providers use Core's shared adapters in
`src/engine/engines/`. The CLI reads the same provider registry and model catalogs,
then keeps its own selected defaults. Provider login, private credentials, model
discovery and execution belong to Core. Changing the coordinator does not install
another runtime, start inference or import terminal chat history.

The intended experience is: choose the default AI once, then ask for work from
iOS or CLI. “Read the files in this project” becomes a task with progress,
questions, output and evidence. Its provider conversation is internal execution
data. The main interface need not display that transcript as a terminal chat.
Retain the audit trail for inspection and recovery; hiding a transcript is not
deleting execution evidence or hiding approval requests.

## Implemented in Core

`CoreAssistant` is a trusted local configuration API. Core starts unconfigured,
even if terminal defaults already exist. Choose its provider/model/effort using
the host commands below or Core's configuration API. It is not a main CLI
Settings entry of its own; CLI Settings → Default models includes its Core row.
Provider/model discovery still uses Core's installed adapters
and catalogs without a second client-side model list. Saving checks the
Core settings revision and never changes CLI defaults or starts a model turn.

The iPhone's text-free **Talk to BZZY** surface now uses these independent Core
defaults through the own-phone voice protocol. Readiness checks do not start
inference; a deliberately released voice recording creates/reuses a private Core context in the managed
folder. Apple Speech/TTS and the live spectrum run on iPhone. See [voice](VOICE.md)
for permissions, acceptance, questions and recovery.

Authentication continues through Core's existing private provider setup on the
host; configuration never copies credentials into contexts, prompts or Relay
messages. Shared provider availability does not give a context another agent's
account bindings or permissions.

```sh
node bin/bzzy-core.js assistant providers
node bin/bzzy-core.js assistant status
node bin/bzzy-core.js assistant set codex
node bin/bzzy-core.js assistant set claude --model YOUR_MODEL --effort default
node bin/bzzy-core.js assistant copy-cli  # optional explicit one-time selection copy
node bin/bzzy-core.js assistant context /absolute/path/to/project
```

These are Core host commands. The terminal consumes this same engine and retains
the `bzzy auth PROVIDER` authorization interface when a provider needs login.
Its hidden input is handled by the terminal; credential storage and native
provider authentication belong to Core. No account secret is accepted by the
assistant setup commands above, and the fully approved own phone can now edit independent defaults through Settings → Models and defaults.

```js
import { randomUUID } from 'node:crypto';
import { CoreAssistant } from './src/index.js';

const assistant = new CoreAssistant();
const shown = assistant.settings();
assistant.configure({ source: 'core', provider: 'codex' }, {
  expectedRevision: shown.revision,
  requestId: randomUUID(),
});
const context = assistant.createContext({ cwd: '/absolute/path/to/project' }, {
  requestId: randomUUID(),
});
```

`copy-cli` explicitly copies the current normal-chat provider/model/effort into
Core once. The old `inherit` command and `configure({ source: "cli" }, ...)` API
remain compatibility aliases for this copy. They store `source: "core"` with the
resolved selection. Later terminal defaults and mode presets never update Core.
A repeated request ID returns the original snapshot without recopying anything.

Legacy persisted `source: "cli"` settings represented live inheritance. They now
report `configured: false`, `source: "core"` at their existing revision until a
user explicitly chooses `set` or `copy-cli`. Reads do not migrate a model choice
or rewrite the record. Already-created contexts keep their original selection
and history. Reconfiguration uses the displayed revision as usual.

Settings writes use revision checks and durable idempotency. Context creation
snapshots the selected provider/model/effort into a fresh, idle Core-engine
session tagged `purpose: "core-assistant"`. Different contexts share no native
thread or chat history. An explicitly reused context retains its conversation.
Changing the default affects newly created contexts; it never switches an
existing one. Retrying creation with its original key returns the original
context even after a default change, preserving subsequent state.

The `contextId` is the underlying session UUID for host-side integration. Create
one context per authorized project/assistant rather than one global conversation
mixing unrelated agents. Context creation starts no execution, grants no tools
or account bindings, creates no agent definition and installs no schedule.

## Shared compactor and consensus model

Session history compaction and Validate's final consensus explanation share a
separate Core-owned selection. CLI Settings → Default models shows one
**Consensus & Compactor** row. Its initial `source: "core"` inherits the live Core
assistant selection; `source: "custom"` stores an explicit provider/model/effort
override. This override works even before Core's assistant is configured and
changes neither Core assistant defaults, ordinary chat nor reviewer models.

The trusted local API lives in `engine/background-model.js`:

```js
import { backgroundModelSettings, configureBackgroundModel } from '@bzzy/core/engine/background-model.js';

const shown = backgroundModelSettings();
configureBackgroundModel({ source: 'custom', provider: 'codex', effort: 'default' }, {
  expectedRevision: shown.revision,
  requestId: crypto.randomUUID(),
});
```

Send `{ source: 'core' }` to resume live inheritance. Reads return
`{ source, revision, configured, selection, coordinatorRevision }`; custom choices
have no coordinator revision. Saves require exact revision checks and optionally
support durable idempotency. They validate Core's provider registry, never accept
credentials or start inference, and grant no model tools or remote administration
rights. Existing compaction jobs retain their pinned choice; new jobs and future
consensus requests capture the effective shared selection and both relevant
revisions. Compactor token/time/day limits remain separate budget settings.

## Background task transport

After host review, pair exactly the context's UUID through the existing
[Relay setup](RELAY.md). Grant only the needed session actions. Observation
does not authorize task submission. Claim input with the usual device-bound
lease, then use these additional encrypted operations:

| Operation | Parameters | Behavior |
| --- | --- | --- |
| `assistant.status` | `{}` | Observe this context's snapshotted selection; no global configuration |
| `task.submit` | `owner`, `instruction` | Requires `execute` and a valid input lease; returns durable acceptance and an opaque `taskId` |
| `task.get` | `taskId` | Observe this device/resource's task state and execution reference |

These operations require a Core assistant context. They cannot turn an ordinary
terminal resource into an assistant or grant access to another session. The
device cannot override provider, model, host path, environment, permissions,
accounts, goal contracts or runtime options. They reuse the same narrower Core
token, execution queue, command journal and replay rules as terminal control.
The daemon and detached runners now start from Core's own `bin/bzzy-engine.js`;
this transport does not require the terminal package or an open terminal.

Use existing event subscriptions for task activity, questions and output. A UI
can render those as progress/results while keeping the internal conversation in
an optional diagnostic view. `task.get.output.after` and `through` delimit that
execution's event range, excluding subsequent tasks. They are null before the
start/finish markers exist. The output reference is not a second transcript copy
or a downloadable host file. `finished` means
the execution ended. These ordinary tasks report `verification: "not-assessed"`;
neither exit code zero nor the model's answer proves the requested outcome.

Receipts are recoverable using `command.status` and never automatically replay
uncertain work. Task IDs are device/resource scoped. Other explicitly authorized
observers of the same context still have their existing event-observation rights.

## Authorization and remaining product work

Task transport inherits the existing approved session's native tool policy. It
does **not** establish project-only read confinement or broker all native tools.
The existing engine reports `backendReadConfidentiality: false`. Do not use this
native coordinator execution path as the sandbox for an imported/scoped Agent.
Persistent Agents are separately registered resources and now use the bounded
filesystem broker plus restricted native provider/tool configuration, described
in [Agent execution](AGENT-EXECUTION.md). This task API does not confer those
identities or add account connectors. A request to read files cannot itself authorize
writes, shell access or reading other projects.

“Create an agent that reads my emails daily” also needs a reviewed persistent
definition, email-read authorization through a private connector, and optional
schedule approval. A model's proposal cannot create grants or activate a schedule.
Those workflows, production email adapters and scheduling are not implemented
by these configuration/task APIs.

Core's coordinator configuration commands/API and scoped task protocol remain
implemented outside the minimal CLI Settings menu. The coordinator's task protocol remains independent of persistent Agent CRUD
and portable imports, which now have separately scoped iPhone/Core operations.
Natural-language coordinator-driven account setup, global settings RPCs and
production account automation are not supplied by these task operations.
An existing session observer/controller must never acquire global configuration
rights. Remote setup needs a separately reviewed host-administration capability,
revision handling and secure host-side provider authorization. Keep secrets out
of chat and use a local authorization UI when login is needed.

A local model may later be selected through a registered provider supported by
Core. The current custom API adapter runs through Codex and requires the
Responses protocol plus its declared API-key setup. Merely exposing some
OpenAI-style HTTP endpoints does not establish compatibility. No local inference
server, model download, arbitrary-protocol backend or separate coordinator loop
is installed by these settings APIs.

The underlying session listing remains compatible and can include these internal
contexts. New product views should use the `purpose` tag to separate terminal
chats from background assistant activity. All clients observe the same durable
session/event history.

Conversational instructions include the shared native message-body contract from
`assets/message-format.txt`, synchronized with `BZZY-IOS/message_format.txt`.
Plain text remains valid; supported `<message version="1">` bodies can express
native headings, tables, emphasis and code. Core preserves the original response
string in durable text events and artifacts. Terminal display projection does not
rewrite that history. This presentation contract does not add iOS networking,
change authorization or turn a formatted success label into verified evidence.

## Own-phone defaults and paused terminal model changes

The fully approved own-phone base grant can read `settings.get`,
`settings.providers`, paged `settings.models` and save `settings.configure`.
Scoped friends and Agent/terminal derived resources cannot administer defaults.
Saves require the displayed revision and an idempotency ID. CLI, Core, Besties,
Parallel, Validate and Delegate selections remain independent; Delegate has two
roles, and the other multi-agent modes allow two or three agents. Model discovery
uses Core's provider catalog and does not require an Agents folder.

An individual own-phone terminal supports `session.configure` through coordinated input,
with the displayed session timestamp and provider/model/effort selection. Core
checks ownership, live permission, idle state and revision at commit. Editing
preserves the goal, budget, evidence and chat. Pause stops work; Resume with
`resumeGoalId` and `resumeGoalStatus: "paused"` checks the exact manually paused
goal at admission and queue commit. Stalled-only resume keeps its original guard.
Reconnect and settings edits start no work. Keys continue to use private host
authorization and are absent from these settings RPCs.
