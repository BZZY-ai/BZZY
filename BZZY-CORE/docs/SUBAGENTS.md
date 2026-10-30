# Reusable specialist subagents

Core delivers a bounded enabled specialist index with descriptions, immutable
versions and optional `capabilities: {"version":1,"tags":["web-api"]}` metadata.
Tags aid scoped discovery and never grant permissions or select targets.
`list_subagents` searches names, descriptions and tags; complete definitions
remain behind `read_subagent`. A project OFF/deleted override continues to shadow
the same global name. A bounded index explicitly advertises omitted entries.

Version 2 workflows may require exact specialists for declared work units.
Pass the returned `workUnitId` to `spawn_subagent`; Core checks that the admitted
definition was read, pins it into one assignment, and links later supervisor
review to that unit. A changed or unavailable definition is an explicit blocker,
not authority to substitute another worker. Stable retries retain the assignment;
new request IDs cannot multiply workers for one unit. Existing chat calls and
legacy workflow goals remain compatible without `workUnitId`. See
[workflow routing](WORKFLOWS.md#version-2-structured-consultation) for closure and
completion requirements and their semantic limits.

Specialist definitions belong to Core. CLI **Agents** in the top bar (or
`/agents`) opens the library and definition editor, with plain Import and Export
actions for specialists only. `/agents runs` opens this conversation's invocation
history. These are reusable worker definitions, separate from persistent iPhone
Agents. Manual editing, inspecting or choosing **Use in chat** starts no model
work; Use in chat fills an editable draft.

Each definition has an owner-controlled ON/OFF state in Library. Existing and
new definitions start ON. OFF definitions remain visible to the owner but are
excluded from model discovery and cannot start a new invocation or follow-up.
A disabled project override continues to shadow a same-name global definition;
turning one off cannot silently select different instructions. Toggle writes
check the displayed revision and scope. Availability is separate from immutable
instruction versions, so it does not rewrite saved evidence or worker pins.
Already admitted running work can finish and report its evidence; turning OFF
does not issue cancellation. Queued work rechecks availability before admission
and remains paused until an explicit follow-up after the owner turns it ON.

A specialist can inherit the current provider, model and effort, or use an
explicit selection from Core's catalog. The same library and Core tools are
available to Codex, Claude and Core's supported API providers. This does not rely
on a provider's native subagent tools. A provider must still be authenticated and
support its requested model and enforced execution policy; unsupported isolation
fails rather than falling back to unrestricted execution.

## Define and invoke

`/create-agent <requirements>` asks for a name and generates a global specialist
using the current chat provider/model/effort. Core follows its internal
[agent creator guide](../assets/bzzy-agent-creator.md), checks the definition with
the same portability policy used by sharing, and publishes it ON without starting
an assignment. It inherits the invoking model and can immediately be discovered
and shared through Library. Creation cannot replace an existing name or override
a local definition; cancellation or changed host/chat/project/model prevents saving.
Creation stays in this command, outside the library tab's Import/Export controls.

Use `/create-agent` to describe a specialist, then name it
`http-response-analyzer`. Its requirements might be:

> Inspect the supplied HTTP evidence. Distinguish observed behavior from hypotheses.
> Identify authorization and input-handling questions worth checking. Return evidence
> references, uncertainty and a focused next check. Do not call a vulnerability
> verified merely because a response looks suspicious.

Leave model selection on **Inherit current model** to reuse it across CLI models.
Choose a project definition for one project or a global definition for reuse in
other projects. Then send a normal chat request or goal, for example:

> Use http-response-analyzer to inspect these recorded responses. Ask the xss-tester
> and idor-tester specialists to investigate relevant hypotheses independently, then
> review their evidence.

XSS/IDOR names have no built-in privileges or hardcoded exploit behavior. The
owner supplies their instructions. Target/action scope and privately authorized
account operations still come from the parent execution; a specialist cannot
grant them through its definition or task text.

Definitions can also be managed without the TUI:

```sh
bzzy subagents create ./http-response-analyzer.json
bzzy subagents list
bzzy subagents show http-response-analyzer
bzzy subagents update ./http-response-analyzer.json --revision 1
bzzy subagents disable http-response-analyzer --revision 2
bzzy subagents enable http-response-analyzer --revision 3
bzzy subagents delete http-response-analyzer --revision 4
```

Use `--global` to manage global definitions. An example JSON definition is:

```json
{
  "name": "http-response-analyzer",
  "description": "Analyze HTTP evidence and propose focused verification.",
  "instructions": "Inspect supplied responses and recorded evidence. Separate observations from hypotheses, preserve uncertainty and return evidence references. Never claim the parent goal is complete.",
  "policy": { "mode": "read-only" },
  "limits": { "runtimeSeconds": 300, "tokenBudget": 20000 }
}
```

Optional `provider`, `model` and `effort` pin a selection. Omitted settings inherit
the parent's compatible selection. Optional policy fields can only narrow the
parent policy. Definitions have strict schemas and size/count limits, revision
checks and immutable content versions. They reject private bindings, recognizable
credentials and private account addresses; scanning is supplementary and cannot
prove arbitrary instructions contain no private information. Store behavior in
definitions and project evidence/account bindings separately.

## Portable definition ZIP

CLI Agents shows names and ON/OFF controls. Its Export button opens name
checkboxes and generates an expiring Relay code with a Copy code button. Import
accepts one paste and installs/enables missing agents with progress. Existing names and availability
stay unchanged. Open an entry for full details. See [Library sharing](LIBRARY-SHARING.md).

Core retains combined ZIP APIs and legacy CLI routes. The reviewed
archive contains current-project and global portable skills and specialist
definitions, including optional provider/model/effort and narrower runtime
limits. It excludes private bindings, sessions, run history and case/evidence
packages. Project scope maps to the receiving current directory; existing names
are never overwritten. Imported skills stay disabled. Explicitly reviewed agent
definitions become discoverable, with no invocation, model call or schedule
started by import. See [skills ZIP](SKILLS.md#skills-and-agents-zip).

## Execution and review

Models discover definitions with `list_subagents`/`read_subagent` and invoke a
named specialist with `spawn_subagent`. The invocation requires a stable
`requestId`, objective and optionally bounded context and recorded evidence IDs.
Use `waitSeconds: 0` to start independent workers, then `wait_assignment` to
collect results. `list_subagent_runs` exposes earlier invocation history.

An invocation pins the definition version and selection. Editing a definition
affects new invocations, not an existing worker's pinned instructions. Starting
a follow-up still requires the pinned definition to be ON in the current host
catalog. Repeating the same
request reuses its saved invocation; conflicting reuse is rejected. Each
invocation receives a separate workspace snapshot and durable conversation. Raw
parent conversation, unrelated projects, private credentials and account grants
are not copied into the definition. The task handoff contains current instructions,
scope and explicitly selected evidence. Ordinary chat uses the current request
without resuming or charging an older saved goal.

Workers cannot recursively spawn agents. Core and native backend tools enforce
that boundary. Subagent defaults are three concurrent workers per parent, up to
four when the parent explicitly allows it, with a host cap of sixteen active
assignment rounds and sixty-four new assignments per parent objective/chat scope.
Parent contracts may lower these limits. New owner goals pin the worker policy
from **CLI Settings → BZZY Core → Agent execution**. Its initial allocation is
300 seconds and 20,000 tokens. **Adaptive** permits the supervisor to extend an
allocation after inspecting new progress evidence; **Fixed** keeps the admitted
initial allowance. Settings can set a host maximum or remove that host ceiling.
The parent's overall budget and explicit definition/invocation limits still
apply. Definitions/invocations can configure initial values up to 3,600 seconds
and 200,000 tokens. Parent accounting reserves concurrent worker allocations
and adaptive review headroom before admitting or extending work.

Settings changes apply to new goals and chat executions. Old goals keep their
saved policy (legacy goals remain fixed). The owner can explicitly apply saved
settings to future workers of a paused goal; this neither rewrites an existing
worker's allowance nor resumes execution. Imported host allocation policy is
discarded. Account, tool, scope, workflow and acceptance permissions never come
from an allocation policy.

`get_execution_budget` returns live measured/charged usage and accounting
completeness. A near-limit warning asks the worker to save evidence and return a
partial handoff before the hard allocation ends. An adaptive partial handoff
stops that round for supervisor review. Warning delivery and timely reports
depend on backend support and available usage signals; the hard stop remains.
The warning reserves the latest observed request input plus report headroom,
when that telemetry is available, instead of assuming only a small output
reserve. This is an estimate: Core can reject an already exhausted allowance
before an exposed dispatch, but cannot gate each backend-internal request.
One native request can overshoot the ceiling before usage is reported. That
consumption remains charged; neither a handoff nor a follow-up resets it.
The parent alone can call `extend_assignment_budget`, using an idempotent
request, the current allocation revision, bounded token/time increments and
intact progress evidence it actually inspected. Extensions recheck the live
parent, pinned/enabled specialist, routing, owner ceilings and available parent
budget. They do not start another worker. A later explicit `followup_assignment`
continues the same conversation and evidence within its updated allocation.
Reusing already-consumed progress cannot justify another extension.

`Budget reached` means the admitted token allocation ended; `Timed out` means
its runtime ended. Saved partial text, artifacts and workspace changes remain
available, but a structured worker report may be missing. Neither status proves
the task succeeded or the tested behavior is safe. The parent reviews and
replans; it does not reset spent usage or blindly retry an exhausted worker.
If a report is missing or partial, Core also saves a host receipt bounded to
8 KiB with assignment/round IDs, observed completed tool calls, checkpoint
progress, evidence references and remaining checks. Exception paths retain the
receipt and any saved evidence too, even if workspace inspection failed. The
receipt is explicitly incomplete: it is neither a worker-authored report nor
verification, and missing checks remain unknown. Worker-session artifacts may
come from earlier rounds; the supervisor inspects their original provenance.

Existing assignment operations provide status, bounded waits, cancellation,
missing-context questions, explicit follow-ups, evidence inspection and review.
Specialist progress and lifecycle events appear in the parent conversation and
remain durable for replay. Compact typed receipts also enter session memory,
including limit stops, missing reports, allocation changes and review references;
raw worker/tool payloads stay outside compaction material. The Agents library shows invocation details. Active
workers stop when their parent execution ends or pauses. Core's operator stop
and recovery cover the same assignment records; recovery never automatically
replays an orphaned worker. A later explicit follow-up can continue a stopped
worker with its pinned definition, within current scope and remaining limits.

Worker findings remain claims. `read_artifact` records supervisor evidence
inspection; `review_assignment` requires inspected, intact evidence before
acceptance. Workspace edits stay isolated until explicit, conflict-checked
`apply_assignment`. Specialist reports cannot complete a parent goal or bypass
Core's acceptance checks. Ordinary native terminal/backend read isolation has
the platform limits documented in [architecture](ARCHITECTURE.md); workspace
copies are not a blanket confidentiality guarantee for arbitrary host programs.

Local offline tests cover registry isolation, immutable versions, duplicate
requests, policy/evidence ownership, budget reservations, concurrency, saved-goal
preservation, native worker execution, parent cancellation and orphan recovery.
They do not establish live vulnerability accuracy or prove every provider/model
and operating system combination.
