# Durable assessment tasks

Run bzzy in the actual project directory. Project knowledge belongs to that
directory; account credentials and process state belong to `BZZY_HOME`.

```text
project_01/
  .bzzy/
    project.json
    constraints.json       scope, exclusions, account references, cleanup requirements
    contracts/             saved task contracts
    issues/                open, investigating, resolved, blocked, inconclusive, disproved
    memory/                observations, hypotheses, experiments, decisions, failed approaches
    checkpoints/           completed work, pending actions, decisions, unresolved questions
    evidence/              hashed evidence copies and metadata
    activities/            short and detailed activity records
    ledger/                dated append-only JSONL records
    goals/                 outcomes, acceptance records, usage and evidence references
    parallel/              aggregate parallel results
    besties/               collaborative goal outcomes and evidence review
    debate/                debate transcripts and decisions
    agents/
      codex-1-GROUP/        each parallel agent gets the same structure
      claude-2-GROUP/
      deepseek-3-GROUP/
```

New conversations read relevant project records. Evidence-dependent memory is
flagged stale when its recorded input hashes change. Observations, inferred
conclusions, failed approaches, inconclusive results and disprovals retain their
own types. Decisions store concise rationales. Credentials, API keys and private
authentication tokens do not belong in project notes or account references.

`constraints.json` is a user-editable project boundary. Initial task constraints
and scope seed it. Later explicit contracts inherit those constraints. Agents
may record additional restrictions and questions; historical notes are not new
authorization. Scope targets are enforced by `http_request`; free-text boundaries
also guide the models. Proxy capture is telemetry, not a universal network ACL.

```bash
bzzy project
bzzy memory search "ownership check"
bzzy recover SESSION_ID
bzzy resume SESSION_ID
```

Recovery inspects saved process identities, workspace changes, existing evidence
and uncertain operations. It expires questions whose original runner disappeared.
It does not automatically repeat a command or external action that might already
have taken effect. Context recovery and compaction are supported by durable
checkpoints, tools and on-disk ledgers; semantic accuracy still depends on the
agent recording and reviewing the relevant facts.

## Acceptance contract

For a long task briefing, start a goal with saved instructions:

```bash
bzzy --context-file bzzy_init.txt --goal "find a new XSS" --yolo
```

`--context-file` reads a nonempty UTF-8 file of up to 1 MiB relative to `--cwd`.
It stores the full text in `session.contract.context` and persists the selected
goal before any model execution. Codex and DeepSeek receive it in developer
instructions; Claude receives it in its appended system instructions. Long
Claude instructions use a private temporary prompt file to avoid command-line
size limits. No preliminary chat runs, and the objective remains exactly the
`--goal` string. The selected model's context window still limits what it can
accept; bzzy never silently shortens the supplied text.

Resume reads the saved contract, including when the source file has changed or
been removed. Existing `--contract` context precedes the file text. Positional
initialization context and `--context-file` cannot be combined. Missing,
unreadable, invalid or oversized files fail before execution. Request-ID
idempotency includes the context digest and rejects changed file contents.
The existing Codex native goals and Claude's Codex-derived continuation policy
remain in use.

For stronger completion checks, save `assessment.json`:

```json
{
  "constraints": [
    "Use only the two approved test accounts",
    "Preserve account isolation controls and record cleanup"
  ],
  "scope": {
    "allowedTargets": ["https://app.example.test/users"],
    "excludedTargets": ["https://app.example.test/users/delete"],
    "allowedActions": ["Read approved account profiles and compare controls"],
    "excludedActions": ["Modify unrelated accounts"],
    "accountReferences": ["test-account-A", "test-account-B"],
    "cleanupObligations": ["Remove temporary local test data"]
  },
  "acceptanceCriteria": [
    {"id": "ownership", "description": "Establish the ownership behavior using approved positive and negative controls"},
    {"id": "report", "description": "Separate observations, inferred impact and unresolved questions"}
  ],
  "artifacts": [
    {"path": "report.json", "schema": {
      "type": "object",
      "required": ["observations", "uncertainties"],
      "properties": {
        "observations": {"type": "array", "items": {"type": "string"}},
        "uncertainties": {"type": "array", "items": {"type": "string"}}
      }
    }}
  ],
  "policy": {"mode": "workspace-write", "writablePaths": ["."], "network": "inherit"},
  "limits": {"runtimeSeconds": 1800, "tokenBudget": 100000, "maxRetries": 2, "concurrency": 1}
}
```

```bash
bzzy goal "Establish and report the authorized ownership behavior" --contract assessment.json
```

Optional `verification` entries have `{id, argv, timeoutSeconds, expectedExitCode}`.
Only declared checks are run by the host acceptance gate, with argv arrays and
the task's permission policy. Commands are never executed just because they
appear in an agent report. A model success report triggers assessment of required
artifacts, schemas, supervisor evidence judgments and declared checks. Failed
acceptance gets bounded follow-ups, then remains awaiting review. Open worker
assignments also prevent parent completion.

Supported output-schema keywords are `type`, `properties`, `required`,
`additionalProperties`, `items`, `enum`, `const`, numeric/string/array bounds,
`description` and `title`. Unsupported keywords fail validation. This is a
deliberately bounded schema validator, not a complete JSON Schema engine.

Without explicit acceptance criteria, a free-text goal retains a clearly labeled
model judgment; bzzy does not invent independent proof. Reaching a goal that
requires a confirmed vulnerability must establish that outcome, not merely finish
a finite scan or obtain agreement from several agents.

For these free-text criteria, an intact saved evidence copy remains usable after
its temporary source file is cleaned up. Changed source contents and corrupt
copies still invalidate evidence. Explicit criteria, required artifacts and
verification commands retain their checks against the current workspace.

Enforced filesystem policies require working Linux bubblewrap/user namespaces
or the verified native sandbox-exec adapter on macOS. The process sandbox keeps the host filesystem read-only except for
declared workspace directories and necessary backend runtime state; descendants
inherit that boundary. Unsupported strict policies fail closed. Claude's adapter
does not claim it can disable tool networking while keeping model networking;
that explicit policy is rejected. macOS supports these
strict delegation/reviewer workflows when the native enforcement probe passes. `--yolo` does not
override a declared read-only task policy.

## Delegation

Start the interactive setup:

```bash
bzzy --delegate
```

Choose **Supervisor → provider → model and effort**, then **Executor → provider →
model and effort**. Both use the existing arrow-key and mouse pickers; ←/→ changes
the focused model's effort. API providers request a hidden key only when needed.
Choose a strong model as the **brain** and a less expensive model as the **hands**.
After both selections, chat normally or start the overall task with `/goal`:

```text
/goal Solve this CTF using the supplied challenge files and approved challenge endpoint.
Verify the proposed solution and preserve the evidence before finishing.
```

Plain messages use the selected primary model without launching workers. `/goal`
starts durable supervised work. The
supervisor decides the plan, which work to delegate, how to verify the results,
and when to finish. You do not create individual assignments. Suitable executor
work includes inventorying supplied files, checking a focused hypothesis, running
bounded tests, reproducing a candidate finding and collecting evidence. The
supervisor retains interpretation, prioritization and final judgment.

Every delegation goal requires a bounded executor assignment and supervisor
review, including brief retrieval or extraction requests. The host rejects
completion when no current-goal executor assignment has been reviewed. A reviewed
executor failure permits the supervisor to take over and verify the remaining
work. Ordinary chat still does not launch workers.

Terminal summaries and goal events list **BRAIN**, **HANDS / EXECUTOR**,
and **TOTAL** tokens separately. No assignments means **not used**, while missing
worker usage means **usage unavailable** rather than zero. Goal events expose
`usage.supervisorTokens`, `usage.delegatedTokens` and `usage.assignmentCount` for
the same breakdown.

Selections are saved with that conversation, including independent effort
settings for worker follow-ups. Reopen it with `bzzy --attach SESSION_ID` or
`bzzy --resume SESSION_ID`; another ordinary message does not replace a saved goal.
Use `/goal status` to inspect it and `/goal resume` to continue paused work.
Escape cancels setup before a session or execution is created.

For a direct command, or scripts that do not use an interactive picker:

```bash
bzzy delegate "Solve this CTF using the supplied challenge files" \
  --supervisor codex --supervisor-model YOUR_CODEX_MODEL \
  --executor deepseek --executor-model deepseek-flash
```

The supervisor owns strategy, assignments, evidence review and the parent goal.
The executor gets a substantial bounded contract, an isolated workspace copy,
inherited constraints, independent limits and its own persisted conversation.
Follow-ups keep that worker conversation and append round history. Reports are
compact; full outputs remain artifacts. Accepting a worker requires recorded
evidence the supervisor opened. Applying an accepted patch checks source hashes
before writing and refuses concurrent workspace conflicts. A failed or blocked
worker returns control without declaring the parent objective satisfied.

The terminal makes handoffs visible as **Supervisor planning**, **Executor
running**, and **Supervisor reviewing**. The Activity panel attributes worker
updates to the hands. Assignment completion means the worker returned; it does
not mean the brain accepted the result or the goal is complete. Independent
brain/hands counters show reported tokens; `—` means unavailable and `≥` marks
a partial total when some provider usage is missing.

An assessment can last hours without one enormous worker prompt: the supervisor
keeps the overall plan and delegates bounded stages, reviews compact reports and
opens decisive evidence as needed. Each worker keeps its own follow-up context;
full artifacts remain available without replaying every tool output into the
supervisor's context. Durable checkpoints, decisions and evidence remain under
the project's `.bzzy/`, with private session and worker state in `~/.bzzy/`.
Detaching leaves active work running; reattachment restores the same goal and
roles. A crash or exhausted limit is a stopping condition, never proof of success.

There is no default overall goal deadline or implicit assignment-count ceiling.
Individual assignments default to 20 minutes, with at most three rounds under
the default `maxRetries: 2`; the supervisor can review their partial evidence,
take over, or create a focused next assignment. Use `--runtime`, `--token-budget`
or a `--contract` with `limits.assignmentSeconds`, `limits.maxAssignments`,
`limits.maxRetries` and `limits.concurrency` to bound a longer assessment.

Execution state, worker claim and supervisor acceptance are separate. Routine
execution can move to a less expensive model, but planning, review, extra context
and retries also consume tokens. Compare supervisor/worker usage and rework
before assuming a monetary saving; bzzy does not estimate subscription-token
prices or promise savings. This design
was informed by the Cerberus reference in 0racle; bzzy has no runtime dependency
on 0racle and does not modify it.

## Debate

```bash
bzzy debate "Challenge whether this finding is supported" --artifact finding.md \
  --supervisor codex --participant claude --participant deepseek --rounds 5
bzzy --codex --debate
# In an existing conversation, including an attached agent chat:
# /debate Validate whether this finding is supported
```

`--artifact` accepts a workspace file or recorded artifact UUID; without it, the
goal and source workspace are the selected material. `/debate [objective]` reviews
the original goal, its achieved claim, requirements and complete goal evidence;
ordinary chat replies retain the focused latest-reply review. An agent roster selects the main agent and one or two challengers, each with its own provider, model and effort;
`--participant` selects them directly. The original chat, thread and permissions
are preserved, and its next turn can read the debate decision.

Debate has three phases:

1. **Independent investigation.** Each selected participant receives the same
   initial source snapshot and selected material in its own workspace. It can
   analyze, run permitted tests and record evidence within the original task's
   scope and permissions. Participants do not receive one another's results.
   Recorded artifacts are checked against their hashes and copied into a common
   evidence bundle, with an index of reports and omissions. At least two agents
   must return a complete or partial conclusion backed by preserved evidence;
   otherwise debate stops here instead of manufacturing an opening case.
   Majority votes describe agreement and never skip challenge. Minority findings,
   uncertainty and failed reports remain in the durable objection ledger.
2. **Opening case.** After all independent work is finished, the main agent reads
   the reports and checked evidence for the first time and publishes a supported
   case that preserves contrary findings and uncertainty.
3. **Challenge and revision.** Challengers review that exact case in enforced
   read-only workspaces. The main agent then answers every objection, concedes it,
   or revises the case. Each following round critiques the latest revision and
   retains assignment history. New tests and changes needed during discussion are
   listed as separate verification work. The main agent records an accepted,
   resolved, rejected or unresolved disposition for every objection.
   Host checks require actual scoped evidence inspection and intact/current
   sources, preserve previous objections and assess the original criteria and
   requested severity separately. All original source evidence needs complete
   read coverage. Declared artifact and verification checks still gate completion.

The default and maximum are **five discussion rounds** (`--rounds 1` through `5`).
Discussion stops after the first challenge round when every objection is resolved
and no verification remains. It also stops when positions stop changing or an
explicit runtime/usage limit is reached. `--concurrency` bounds phase-one workers.
Use `--review-only` to skip independent investigation and perform snapshot review.

The transcript, evidence references and decision record include supported
conclusions, rejected claims, corrections, remaining objections and next checks.
Outstanding objections or verification leave the goal `awaiting_review`; the end
of a discussion does not establish that a vulnerability was proved. Phase-one
test claims are agent-reported and must be checked against their evidence.
Combined token usage and elapsed time include both phases and the main agent.

## Besties

```bash
bzzy --besties
# Choose Bestie 1: provider → model → effort.
# Choose Bestie 2 through the same flow, independently.
# Continue with two agents or select a third to advance automatically.
# Enter the shared goal to begin collaborative work.

# Direct/scripted form; two or three agents, including the same provider twice:
bzzy besties "Assess the approved project and establish a supported finding" \
  --agents codex:MODEL_A,claude:MODEL_B --contract assessment.json
bzzy goal "Solve the supplied challenge" --mode besties \
  --agents codex:MODEL_A,codex:MODEL_B
```

Besties are two or three peers collaborating on one full, durable goal. No peer is a
subordinate worker. All receive the same objective, constraints and initial
workspace snapshot, keep independently selected model and effort, and investigate
in isolated workspaces. They can divide work, exchange hypotheses, challenge
claims and request specific verification. `peer_message` delivers a short message
and selected immutable evidence IDs; `peer_inbox` reads new messages with a saved
cursor. Peer messages never silently grant wider scope or permissions.

Each peer must open the other peer's evidence with `read_artifact` before
`peer_review` can record a supported, inconclusive or disputed judgment. Full
evidence remains available through bounded reads; the chat history and reviews
remain attributed. Completion requires every peer's own acceptance checks and
supported reviews of the latest evidence-bearing messages. Missing controls,
stale evidence or unresolved objections leave work awaiting review. Agreement
alone does not prove a vulnerability; the task's acceptance criteria still apply.
The group also checks required deliverables and verification commands in the
original project directory. A peer completing work in an isolated workspace does
not satisfy a missing deliverable in the original project automatically.

The group overview and all agent chat tabs use the same `--view` / `--attach` session
workflow as parallel mode. Tab/Shift+Tab switches chats; goal state, shared
messages and all providers' known usage remain available to integrations. There
is also a **SHARED ROOM** view (`/room`) containing actual peer messages and
evidence reviews, separate from either peer's user conversation. There
is no default overall goal deadline; explicit runtime and token limits apply to
the group. Saved model choices, peer messages, evidence and reviews survive
detachment and recovery. Source changes are not automatically merged into the
original project.

Parallel mode gives each agent the same goal to pursue independently. Besties
adds direct messages and evidence review between two or three peers. Delegation
keeps a supervisor responsible for bounded executor assignments and final judgment.

## Parallel independent goals and chats

```bash
bzzy --parallel 2
bzzy --parallel 3
# Choose provider, model and effort independently for each agent.
# Continue with two agents, or configure a third to advance automatically.
# Enter the shared goal, then switch between the agents' chat tabs.

bzzy parallel "Assess the authorized surface and establish a supported finding" \
  --agents codex,claude,deepseek --contract assessment.json --capture-network
```

`bzzy --parallel` opens an agent list with **Continue with 2 agents** at the
bottom. A third agent is optional; configuring it advances automatically to goal
setup. Enter the shared goal to start the agents and open the first agent's chat.
Every agent has its own tab; Tab/Shift+Tab and clicks switch chats. Afterward,
ordinary messages chat with the selected agent, and `/goal <objective>` starts
new persistent work. Two or three agents are supported.
`--agents A,B[,C]` selects providers/models directly and skips the wizard.
When an explicit `--parallel 2` or `3` is combined with `--agents`, the counts
must match. Duplicate providers are allowed; their chats and workspaces remain
separate, and each chosen effort is retained independently.

Run `/default` from any parallel agent tab or the group overview to save the
whole combination in bzzy's config. The next interactive `--parallel` shows the
saved providers, models and efforts and asks **Use saved combo?** Choose **Yes**
to go directly to goal entry, or **No** to open the selector. The saved combo
stays in place until another `/default`. Explicit `--agents` selections and
different explicit agent counts take precedence.

Each peer receives the same full goal, constraints and initial source snapshot,
then follows its own strategy in a separate workspace. Agents know their peers
and can read attributed progress and issues with `peer_status`. They write their
own project ledgers under `.bzzy/agents/`. Findings retain their author and
verification status. One agent's completion does not imply another is done.
The group reports completion only after every peer's goal completes its own
acceptance checks; incomplete peers remain visible. Source changes are isolated
and are not automatically merged into the original project.
Required artifacts and verification checks for the parent goal must also pass in
the original project; otherwise the group remains awaiting review.

The group and each agent chat have UUIDs. In the terminal use Tab/Shift+Tab or
`/tabs` and `/tab codex` (or a tab number) to switch between Overview and chats.
Input goes to the selected agent. Use `/pause` or `/cancel` for that selection,
`/pause all` or `/cancel all` for the group, and `/detach` to leave it running.
The footer always displays the group UUID and selected chat UUID.

```bash
bzzy --view GROUP_UUID       # all tabs, read-only
bzzy --attach GROUP_UUID     # all tabs, explicit input takeover
bzzy --view AGENT_CHAT_UUID  # just one agent
bzzy --atach GROUP_UUID      # accepted spelling alias
```

These commands use the same machine's actual stored history and live execution.
The local web view and public API expose the same group/child chat structure.

## Mode presets and interactive input

`/default` saves a separate preset for normal chat, delegation, debate, besties
or parallel. Group presets include all selected providers, models and efforts.
Running it from a peer chat saves that peer’s full group. The next interactive
launch asks whether to reuse that mode’s preset; No opens the selector.

Use `bzzy --parallel --default`, `bzzy --debate --default`,
`bzzy --besties --default` or `bzzy --delegate --default` to skip confirmation
and agent selection and proceed to goal entry. Add `--goal "objective"` to skip
goal entry as well. `bzzy --default` uses the normal chat preset. Missing presets
produce a setup error. `--default` cannot be combined with `--agents` or
`--participant`; those flags choose explicit agents instead.

`/help` is a short guide to the modes and shortcuts. The composer keeps drafts
and submissions through streaming output and run transitions. A new
`/goal <objective>` stops the current execution, archives its goal and starts the
new objective in the same conversation. `/goal resume` retains the existing goal.
