# BZZY Core API reference

Reference version: 1. Describes the installed Core build, API v1, Node.js 24+.
Run `bzzy --help-api` or `bzzy-core --help-api` again after updating. Redirect
stdout to save the complete reference: `bzzy --help-api > bzzy-api-reference.md`.
`--json` still prints this Markdown. Use this flag alone; execution arguments
and other help-guide flags cannot be combined with it. Printing starts no Core,
model, session or network request and reads no account settings or credentials.

## 1. Integration choices and boundaries

External applications such as bzzy-huntr can launch goals through the CLI and
observe/control the resulting sessions through Core. Core owns execution,
permissions, evidence, goal acceptance, durable history and recovery. Your
application owns its workflow, event consumer, notification UI and retry policy.
The CLI window can close while Core continues an admitted detached execution.

Available interfaces:

- Local authenticated HTTP/JSON API and replayable Server-Sent Events (SSE).
- `BzzyClient`: transport-only JavaScript client, from `@bzzy/core/client`.
- `BzzyCore`: privileged local Node facade, from `@bzzy/core`.
- Owner-local knowledge administration and Relay administration over HTTP.
- Additional trusted local Node facades listed in section 10.
- CLI detached goals and supervised script jobs, shown below.

This is the complete local HTTP route inventory, including administrative
families. Host SDK methods are separately identified: do not invent REST
`/agents`, `/providers`, `/models`, `/workspaces` or session-creation endpoints.
The encrypted Relay/iOS wire protocol is a separate interface, not needed for
same-machine applications. iPhone push delivery is also separate from local SSE.
No generic webhook registration or per-session status.json export is implemented.
The public event schemas describe envelopes, not an OpenAPI request schema.

## 2. Start, discover and authenticate

Use `bzzy-core start` explicitly when Core should run; inspect with
`bzzy-core status`. `bzzy` starts its supervised service when necessary.
`bzzy-core stop` durably pauses work. Polling must never clear that intent.
A new start does not replay paused model work. Check `/v1/health` and
`/v1/capabilities` before using optional features.

The daemon binds HTTP on 127.0.0.1 with a discovered port. Its private connection
record is `$BZZY_HOME/runtime/service.json`; when BZZY_HOME is unset, use
`~/.bzzy/runtime/service.json`. It contains `url`, `token`, process `identity`
and build information. It is private runtime configuration, not a public API
response. Never print, copy into generated code or forward the owner token to a
browser, model, phone or Relay. Keep discovery and authenticated calls in your
trusted backend. After daemon replacement, rediscover the record and reconnect;
a client pinned to an old URL/token cannot rediscover them on its own.

API requests use `Authorization: Bearer TOKEN`. Canonical routes start `/v1`;
unprefixed routes are compatibility aliases. JSON bodies use
`Content-Type: application/json`. Bodies are limited to 256 KiB. Foreign browser
origins are denied; expose your application's own authenticated backend to its
frontend. Do not publish this owner API on a public network interface.

Owner credentials can administer the whole host. A session observer token is
sufficient to monitor one conversation. Provision one via the owner token API
(section 7) or the existing `bzzy service token SESSION_ID` command. Treat the
returned token as private backend configuration. Scoped control grants require
explicit permissions; monitoring never needs input ownership.

### Same-host Linux one-liner: list sessions

Run as the same Linux user that runs Core, with Core already running. This uses
Python 3's standard library and keeps the bearer token out of stdout and command
arguments. The resulting session inventory is private task data.

```sh
python3 -c 'import json,os,pathlib,urllib.request; c=json.loads((pathlib.Path(os.environ.get("BZZY_HOME",str(pathlib.Path.home()/".bzzy")))/"runtime/service.json").read_text()); r=urllib.request.Request(c["url"].rstrip("/")+"/v1/sessions",headers={"Authorization":"Bearer "+c["token"]}); print(json.dumps(json.load(urllib.request.urlopen(r,timeout=10)),indent=2))'
```

### Minimal same-host JSON status reader (owner backend)

Install/use the bundled `@bzzy/core` package from your BZZY distribution or its
local package path; it is not assumed to be a public registry package. The
transport-only import below does not discover storage or start Core itself.
Only your trusted backend reads the connection file.

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BzzyClient } from '@bzzy/core/client';

const home = process.env.BZZY_HOME || path.join(os.homedir(), '.bzzy');
const connection = JSON.parse(fs.readFileSync(path.join(home, 'runtime/service.json'), 'utf8'));
const endpoint = new URL(connection.url);
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
    || endpoint.username || endpoint.password || endpoint.pathname !== '/'
    || endpoint.search || endpoint.hash) throw new Error('Invalid local Core endpoint');
const client = new BzzyClient({ url: connection.url, token: connection.token });
const snapshot = await client.session(process.argv[2]); // Full saved session UUID.
console.log(JSON.stringify({ sessionId: snapshot.session.id,
  goalId: snapshot.session.goal?.id, status: snapshot.session.goal?.status,
  reason: snapshot.session.goal?.reason, executionState: snapshot.session.executionState }));
```

A scoped client instead receives an already provisioned URL/token. Do not use
local owner storage discovery in a browser or distribute service.json.

## 3. Goal launch, identity and state

Create/start a goal through the existing CLI, for example:

```sh
bzzy --cwd /absolute/project --alias huntr-investigation --preprompt /absolute/instructions.txt --goal "Investigate the authorized test case" --detach --request-id huntr-case-001 --json
```

Save the returned `sessionId`, then read its snapshot to obtain `session.goal.id`.
A session can contain many successive goals. Correlate your workflow step using
both sessionId and goalId; aliases, objective strings and process exit codes are
not stable goal identities. Retry a submission with the same request ID and
identical input rather than launching a second goal after an uncertain response.
`--preprompt` (alias `--context-file`) saves the full UTF-8 file in the task
contract before execution: regular file, up to 1 MiB. Resume uses the saved
contract, even if the original file changes. Unattended use must satisfy existing
permissions and approvals; detaching never auto-answers a question.

`GET /v1/sessions/ID` returns `{session, execution, run, observation, questions,
inputOwner, children, capabilities, invocations, permissions, ...}`. Some fields
are owner-only or optional. `session` contains the current saved goal and
executionState; `execution` is the latest queued/started execution record.
`observation` is separately sampled process liveness; an alive process does not
prove meaningful progress. `questions` contains outstanding scoped questions.
The alias-only terminal catalog shown by clients is distinct from `/sessions`,
which can include other root contexts. Do not assume every entry is a terminal.

| Goal status | Integration meaning |
| --- | --- |
| `active` | Goal ongoing; inspect execution/questions/progress separately |
| `verifying` | Acceptance checks underway; unfinished |
| `complete` | Recorded completion after Core's acceptance gate; imported historical claims remain historical |
| `blocked` | Blocked; inspect reason and required dependency |
| `usage_limited` | Provider usage/quota prevented continuation |
| `budget_limited` | A token or runtime allowance stopped continuation |
| `awaiting_review` | Acceptance/recovery requires review |
| `paused` | Paused; reason distinguishes deliberate pause from detected stalls |
| `cancelled` | Cancelled |

Core's stalled classification includes blocked/usage_limited/budget_limited/
awaiting_review, plus paused with `turn_limit`, `recovery_required` or
`context_no_progress`. An ordinary owner pause/cancel has its own lifecycle.
Unknown future statuses must remain unknown until interpreted by your app.
An execution ending, exit 0, an agent saying "done", or a worker report is not
parent-goal completion. A completion receipt also does not independently prove
vulnerability validity beyond the recorded acceptance/evidence checks.

### Read only the goal in a named session, for example nasa

The goal-status API is already session-specific. The HTTP path requires its
UUID: `GET /v1/sessions/SESSION_ID`. To select a human alias, first call
`GET /v1/sessions`, find the exact alias, then fetch that UUID. There is no
`/sessions/nasa` route or separate `goal-status` command. Never create a new
session because an alias lookup failed. Require exactly one match; with a
scoped observer only the granted session is discoverable.

<!-- bzzy-api-example: session-goal-status -->
```js
export async function sessionGoalStatus(client, aliasOrId) {
  let sessionId = aliasOrId;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(aliasOrId)) {
    const matches = (await client.sessions()).filter(session => session.alias === aliasOrId);
    if (matches.length !== 1) {
      throw new Error(matches.length ? 'Ambiguous session alias; use its UUID' : 'Session alias not found');
    }
    sessionId = matches[0].id;
  }
  const { session } = await client.session(sessionId);
  return { sessionId: session.id, alias: session.alias || null,
    goalId: session.goal?.id || null, status: session.goal?.status || null,
    reason: session.goal?.reason || null, executionState: session.executionState };
}
```

Call `await sessionGoalStatus(client, 'nasa')`. A session without a goal returns
null goalId/status; this is not an achieved goal. Save the returned sessionId
and goalId in Huntr. Subsequent polls can use that UUID; a changed goalId means
a different goal now occupies the same permanent session. Events still require
that exact goal ID to distinguish its outcome from earlier goals.

## 4. HTTP monitoring routes

All routes below require at least observe access; session routes also enforce
session/child scope. IDs in URLs are full UUIDs, not aliases or short prefixes.

| Method and path | Result / query |
| --- | --- |
| `GET /v1/health` | `ok`, API/product version, runtime build/process identity and baseline metadata |
| `GET /v1/capabilities` | Execution/events/input/idempotency/scoped-access flags, permissions, actual platform isolation; owner-only job flags |
| `GET /v1/schema` | Session event JSON Schema |
| `GET /v1/metrics` | Host sampler CPU/memory/runtime observations |
| `GET /v1/connections` | Owner only; Core/Relay connectivity with observation time; may initialize the Relay service |
| `GET /v1/sessions` | Root session array for owner, granted session for scoped token |
| `GET /v1/sessions/ID` | Current snapshot described above |
| `GET /v1/sessions/ID/usage` | `{sessionId,usage,summary,goal}`; reported tokens/runtime, not an invented price |
| `GET /v1/sessions/ID/activities` | `after=RECORD_ID&limit=100`; current activity page |
| `GET /v1/sessions/ID/traffic` | `after=RECORD_ID&limit=100`; current observed-traffic page |
| `GET /v1/sessions/ID/events` | `after=SEQ&limit=200`; replayable forward event page |
| `GET /v1/sessions/ID/events` | `before=SEQ&limit=200`; older event history page |
| `GET /v1/sessions/ID/events` | `stream=1&after=SEQ`; live SSE with replay |

Activity/traffic limits: 1–500; pages return `{items,nextCursor,hasMore,liveUpdates}`.
Their record-ID cursor navigates snapshots; changes to existing rows require
events for reliable live updates. Forward event limits: 1–1000; returns
`{events,nextCursor,hasMore}`. Older event limits: 1–1000; returns events in
ascending sequence order plus `oldestCursor,hasOlder,nextCursor,hasMore:false`.
Pass oldestCursor as the next exclusive `before` while hasOlder is true.
Snapshot and event cursors are different types. Do not apply one to the other.

`GET /` and `GET /app.js` are the bundled web UI resources, available before
API authentication; they are not authenticated JSON API routes.

### Local event notifications for Huntr

SSE is a local software notification channel. It does not require Relay, iOS,
APNs or terminal scraping. Read events rather than parsing human console text.

| Event | Meaning |
| --- | --- |
| `goal.completed` | Core recorded achieved after acceptance |
| `goal.stalled` | Explicit stalled outcome; inspect `data.status` and `data.reason` |
| `goal.paused`, `goal.cancelled` | Deliberate pause/cancellation outcome |
| `goal.waiting_for_input` | Goal needs a question/approval answered |
| `question`, `worker.question` | Durable question, including ordinary chat/worker questions |
| `question.answered`, `question.expired`, `worker.question.answered` | Question state changed |
| `execution.queued`, `execution.finished` | Execution queue/result, distinct from goal outcome |
| `lifecycle`, `goal`, `summary`, `error`, `info` | Saved lifecycle, attributed progress and execution results |
| `activity`, `usage.updated`, `account.quota` | Progress/usage/quota observations |
| `artifact`, `checkpoint`, `assessment`, `acceptance` | Evidence/checkpoint/acceptance records |
| `assignment.*`, `worker.progress`, `peer.text`, `peer.message`, `peer.review` | Multi-agent attributed work; worker success does not complete its parent |
| `network.*`, `command.observed`, `tool.action` | Observed native/tool/network activity where supported |
| `input.owner`, `input.accepted`, `control.*`, `access.granted`, `access.revoked` | Input, control and grant changes |
| `model.changed`, `provider.changed` | Selection changes for subsequent work |

The table groups important types; tolerate additional types in the durable log.
Consult `/v1/schema` for the envelope. For a session event:

```json
{"version":1,"id":"SESSION_UUID:123","seq":123,"sessionId":"SESSION_UUID","type":"goal.stalled","createdAt":"2026-10-30T12:00:00.000Z","data":{"goalId":"GOAL_UUID","status":"budget_limited","reason":"token_limit"}}
```

This is a minimal illustrative envelope, not the complete lifecycle payload.
Lifecycle data also carries objective, evidence, attribution and usage. SSE uses
`id: SEQ`, `event: TYPE`, `data: EVENT_JSON`, separated by a blank line.
Resume with exclusive `after` or `Last-Event-ID`; if both exist the query cursor
wins. Heartbeat comments every 10 seconds indicate connectivity, not progress.
Sequences are monotonic SQLite cursors, can have gaps, and must be stored per
session/consumer. Deduplicate by envelope ID or (sessionId,seq). Save the cursor
only after applying an event. Reconnect/replay can redeliver; notification side
effects need their own durable idempotency or an application outbox.

The following reusable function consumes the existing transport API. `handle`
and `saveCursor` are application callbacks supplied by Huntr; make handling
idempotent using event.id. Pass the last successfully stored sequence as after.
It filters by the exact goal, while still advancing over unrelated session events.

<!-- bzzy-api-example: goal-watcher -->
```js
export async function watchGoal(client, sessionId, goalId, {
  after = 0, handle, saveCursor, signal
}) {
  for await (const event of client.stream(sessionId, { after, signal })) {
    if (event.type.startsWith('goal.') && event.data?.goalId === goalId) {
      await handle(event);
    }
    await saveCursor(event.seq);
  }
}
```

Take a current snapshot at attachment and on reconnection, and inspect questions
and execution state even when no terminal goal event exists. Replay alone can
include older goals. Snapshot and subscription are not one atomic read: use the
saved cursor and goal ID, and never discard a raced completion based on timing.
If your handler fails, recreate the subscription using your persisted cursor;
the client's in-memory cursor advanced when the event was parsed. Use one
processor for each cursor. A filtered stream skips unrelated events internally;
use an unfiltered stream if one cursor serves multiple app features.

For the simplest integration, poll `client.session(id)` every 5–10 seconds.
Record a timestamp and compare goal IDs. Polling may miss intermediate
transitions; events preserve them. On connection loss show unavailable/unknown,
not achieved or stalled. Sustained silence may warrant an application watchdog,
but a long reasoning/tool operation can be legitimate. No API promises detection
of every possible hung backend. Inspect state/liveness before any recovery and
never automatically relaunch an uncertain external action.

## 5. Session input, ownership and execution

POSTs use JSON and stable `Idempotency-Key` values (or body requestId where
supported). Reuse a key only for identical operation/input. Different input
with the same key conflicts. A 202 response acknowledges queued/admitted work,
not completion. Permission grants, leases and execution policy all still apply.

| Method and path | Body / result |
| --- | --- |
| `POST /v1/sessions/ID/claim` | `{owner,takeover?:false}` → input lease; renew before expiry |
| `POST /v1/sessions/ID/release` | `{owner}` → `{released:true}` |
| `POST /v1/sessions/ID/input` | Canonical operations below → 202 accepted receipt |
| `POST /v1/sessions/ID/execute` | `{owner,prompt,options?:{},goal?:false,resumeGoal?:false}` → 202 `{executionId,sessionId}` |
| `POST /v1/sessions/ID/answer` | `{owner,questionId,answer}` → `{answered:true}` |
| `POST /v1/sessions/ID/control` | `{owner,action,text?}` → 202 `{controlId}`; actions pause/cancel/steer |
| `POST /v1/sessions/ID/delete` | Owner only, `{}` with idempotency key → saved deletion receipt |

Direct execute/answer/control require the current input owner. Use a stable
opaque owner string (1–128 letters/digits/underscore/hyphen), renew claim every
10–15 seconds (lease lasts 45 seconds), and release when finished. A takeover
requires its own permission and deliberately invalidates the earlier owner.
Observers never claim input. Control acknowledgments are separate from observed
control outcomes. Steering requires nonempty text and an individual Codex chat;
check snapshot capabilities instead of assuming every mode supports it.

Canonical input coordinates admission and claims input itself; taking an existing
lease requires takeover permission. Supported `operation` values and fields:

| operation | Operation-specific fields (in addition to owner) |
| --- | --- |
| `goal` | `objective` for new goal; `resumeGoal:true` for resume; optional `replaceGoalId`, `resumeGoalId`, `resumeGoalStatus:"paused"`, `options` |
| `execute` | `prompt`; goal commands in prompt route through canonical goal admission; optional `options` |
| `answer` | `questionId,answer` (answer ≤16 KiB) |
| `control` | `action` pause/cancel/steer; `text` for steer |
| `selection` | `selection:{provider,model?,effort?},expectedUpdatedAt` |
| `mode` | `mode,expectedUpdatedAt` (Core validates supported mode configuration) |
| `permissions` | `enabled` boolean and optional `questionId`; owner/fully approved own-phone only |

New objectives/non-goal prompts are bounded to 16 KiB. An existing goal may
require exact replaceGoalId confirmation. Resume pins the current saved goal ID;
resumeGoalStatus, when supplied, is only `paused` and requires resumeGoalId.
Imported historical outcomes cannot serve as fresh execution authority.
The full accepted-field set also includes `requestId` (stripped by HTTP),
`clientRequestId`, `environment`, `goal`, `resumeGoal`, `preparedGoalId`.
These compatibility/host fields are not permission grants. External integrations
should normally use canonical `goal`/`execute` and saved host settings. Direct
execute with goal:true requires a goal contract already prepared in Core.

Example new goal on an existing session using canonical input:

```js
await client.submitInput(sessionId, {
  operation: 'goal', owner: 'huntr_backend',
  objective: 'Investigate the next explicitly authorized test case',
  requestId: 'huntr-case-002'
});
```

Do not retry this with a new key after timeout; inspect the receipt/snapshot.
Scoped clients cannot supply environment or nonempty execution option overrides,
prepared goal IDs, or direct execute goal:true through canonical input. Scoped
selection/mode and permission changes require the approved own-phone binding,
not merely an execute grant. Group control also enforces child scope. Owner-local
options use Core's existing execution/task contract; use CLI preparation for full
contracts, workflows, scope and preprompts rather than inventing option fields.

## 6. Supervised script jobs (owner only)

Script jobs are separate from AI sessions. They execute an owner-authorized local
file with literal argv under the host's OS access; they are not an AI tool-policy
sandbox. A job exit code is not an AI goal outcome. No dependencies are installed.

```sh
bzzy --background /absolute/check.py --cwd /absolute/project --timeout 300 --json --request-id huntr-script-001 -- --format json
bzzy background status JOB_ID --json
bzzy background logs JOB_ID --follow
bzzy background cancel JOB_ID --request-id huntr-cancel-001 --json
```

| Method and path | Body / query / result |
| --- | --- |
| `POST /v1/jobs` | `{script,cwd,args?:[],timeoutSeconds?:0,notify?:false}` + key → 202 job |
| `GET /v1/jobs` | `before=SEQ&limit=100&state=running`; `{items,nextCursor,hasMore}` |
| `GET /v1/jobs/JOB_ID` | Job metadata, current state and outcome |
| `GET /v1/jobs/JOB_ID/logs` | `after=SEQ&limit=200`; log-only events; `stream=1` also supported |
| `GET /v1/jobs/JOB_ID/events` | `after=SEQ&limit=200`; all job events; `stream=1` for SSE |
| `POST /v1/jobs/JOB_ID/cancel` | `{}` + stable key → 202 current state |
| `GET /v1/jobs/schema` | Job event JSON Schema |

cwd must be an existing absolute directory; script resolves there. Executable
files use their shebang, otherwise .py uses python3 -u, JS Core's Node and .sh
/bin/sh. Stdin is EOF. Args: ≤1024 strings /128 KiB. Timeout: 0 (unlimited) or
1–604800 seconds. List limits 1–500; log/event limits 1–1000. At most 128 active/
queued jobs and 8 concurrent. Logs are redacted, capped at 8 MiB per job with
logical lines over 64 Ki characters omitted; inspect logsTruncated.

States: queued, launching, running, cancelling; terminal completed, failed,
cancelled, timed_out, interrupted. Outcomes include exitCode/signal when known
and a bounded support code. Event pages return
`{events,nextCursor,hasMore,state,logsTruncated}`. Envelope:
`{version,id,seq,jobId,type,data,createdAt}`. Types: job.queued, job.running,
job.log, job.cancelling, job.completed, job.failed, job.cancelled, job.timed_out,
job.interrupted. The same cursor/SSE/idempotency rules apply. A finished stream
can remain connected; the consumer decides when to stop after the terminal event.

Queued jobs can dispatch after restart; launching/running jobs are never replayed
after an uncertain crash. Ordinary daemon restart preserves supervised workers;
explicit Core stop interrupts scripts and queued jobs, with no automatic replay
on start. Cancellation/timeout cannot undo previous side effects or guarantee
control over deliberately detached/remote work. `notify:true`/`--notif` opts into
iPhone completion/failure alerts; default false. Local event monitoring always
works independently of this preference and phone delivery.

## 7. Session credential administration (owner only)

| Method and path | Body / result |
| --- | --- |
| `POST /v1/tokens` | `{sessionId,recipient?,permissions?:["observe"],expiresInSeconds?:86400,includeChildren?:true}` → 201 grant including token |
| `GET /v1/tokens` | `{items:[grant metadata]}`; no secret token values |
| `DELETE /v1/tokens/GRANT_ID` | Revoke grant durably; active streams/leases lose authorization |

Expiry is an integer 60–2592000 seconds (30 days). Permission names: observe,
claim, takeover, execute, answer, pause, cancel, steer. Every grant includes
observe; controls require claim too. recipient is an opaque label, not proof of
identity or device pairing. includeChildren false denies direct child access;
the parent stream can still carry explicitly mirrored results. The token is
returned only at creation; store it privately. Revoke/expiry closes streams on
subsequent checks and prevents new commands; prior side effects remain.
Session grants cannot submit jobs or administer knowledge, Relay, deletion or
host lifecycle. Use separate owner backend code for those operations.

## 8. Knowledge, memory and learning administration (owner only)

`POST /v1/knowledge/OPERATION` takes a JSON object and returns that operation's
result. `CoreKnowledge.request(operation,input)` is the corresponding host SDK.
Unknown fields are rejected. There is no GET dispatcher, generic write-anything
route, or session-token access. Read operations use POST as well. Revision and
review fields are explicit preconditions; do not auto-fill reviewed:true from a
model assertion. An operation can queue paid work only under saved owner policy.

Context abbreviations in the table:

- C: `sessionId` or `cwd` (existing project directory); use a saved session for
  session-specific retrieval. Prefer sessionId if both would be ambiguous.
- S: `sessionId` required; cwd not accepted.
- H: host-level, no sessionId/cwd. Listed fields are the accepted input fields
  in addition to context. Optionality/defaults depend on the operation. Mutations
  require the displayed expected revision and actual owner review where stated.

| OPERATION | Context and fields | Purpose |
| --- | --- | --- |
| `status` | C | Project identity, automatic brief, settings, usage, facts and current jobs |
| `search` | C; query,limit,offset,types,includeStale | Bounded project knowledge search |
| `source.read` | C; sourceId,sha256,offset,limit | Exact pinned chat/attempt/outcome source pages |
| `episode.status` | S | Current host-observed episode status |
| `episode.read` | S; throughSeq,goalId,runId,maxBytes | Bounded source-linked episode material |
| `resolutions.search` | C; query,signature,limit,includeStale | Related prior resolutions |
| `resolution.inspect` | C; id | One attributed resolution |
| `facts.read` | C; maxBytes,limit | Curated current project-fact projection |
| `facts.configure` | C; settings,expectedRevision,reviewed | Configure projection policy |
| `retrieval.status` | C | Local retrieval coverage/settings |
| `retrieval.configure` | C; settings,expectedRevision,reviewed | Configure optional local retrieval |
| `retrieval.refresh` | C; limit | Bounded local embedding refresh |
| `retrieval.benchmark` | C; cases,k,latencyBudgetMs,minRecall,minPrecision,expandSources | Offline retrieval evaluation |
| `profiles` | H | User/host knowledge profiles |
| `profile.update` | H; target,text,expiresAt,expectedRevision,reviewed | Explicit profile update |
| `profile.proposals` | H; offset,limit | Proposed edits |
| `profile.history` | H; target,offset,limit | Immutable profile revisions |
| `profile.rollback` | H; target,fromRevision,expectedRevision,reviewed | Restore prior content as a new revision |
| `profile.review` | H; id,expectedRevision,action,reviewed | Owner decision on exact proposal |
| `memory.review` | C; id,truth,expectedRevision,rationale,reviewed | Explicit truth review with current evidence checks |
| `memory.invalidate` | C; id,reason,expectedRevision | Invalidate a recorded memory |
| `memory.history` | C; id,offset,limit | Prior memory revisions |
| `memory.rollback` | C; id,fromRevision,expectedRevision,reviewed | Explicit memory restoration |
| `project.relink` | H; cwd,projectId,expectedRoot,reviewed | Review a moved project binding |
| `session-memory.status` | S | Summary tree/compactor health and coverage |
| `session-memory.document` | S | Generated read-only MEMORY.md view |
| `session-memory.export` | S; expectedRevision | Write generated view; refuses owner-edited replacement |
| `session-memory.read` | S; maxBytes,limit,query,recent | Bounded session history map |
| `session-memory.expand` | S; id,offset,limit,sourceOffset,sourceLimit | Expand pinned summary node/originals |
| `session-memory.queue` | S | Queue host maintenance, subject to pause/settings |
| `session-memory.rebuild` | S; expectedGeneration,reviewed | Reviewed generation reset and reindex |
| `session-memory.control` | S; action,expectedRevision | Explicit pause/resume/cancel of compaction |
| `session-memory.settings` | H; settings,expectedRevision,reviewed | Shared paid compaction policy |
| `learning.list` | C; limit | Saved learning jobs |
| `learning.inspect` | C; id | Job state, pins, receipts and diagnostics |
| `learning.packet` | C; id | Restricted review input packet |
| `learning.queue` | C; requestId | Explicit bounded review request |
| `learning.control` | C; id,action,expectedRevision | Control a learning job |
| `learning.settings` | H; settings,expectedRevision,reviewed | Owner learning policy/budgets |
| `candidates` | C; offset,limit,state | Learned skill candidates |
| `candidate.inspect` | C; id | Candidate metadata/evaluation |
| `candidate.read` | C; id,file,offset,limit | Bounded candidate file |
| `candidate.reject` | C; id,expectedRevision | Reject candidate |
| `candidate.accept` | C; id,expectedRevision,expectedSkillRevision,expectedEvaluationId,reviewed,activate | Review/publication with evaluation gates |
| `candidate.evaluate` | C; id,datasetId,expectedRevision,requestId | Queue fixture evaluation |
| `evaluation.inspect` | C; id | Evaluation result/coverage |
| `fixtures.list` | C | Registered evaluation datasets |
| `fixtures.inspect` | C; id,includeCases | Dataset metadata/optional cases |
| `fixtures.revoke` | C; id,expectedRevision | Revoke dataset |
| `fixtures.register` | C; definition,scope,reviewed,requestId | Register reviewed fixtures |
| `skill.evolution` | C; id | Skill evolution provenance/state |
| `skill.evolution.settings` | H; settings,expectedRevision,reviewed | Opt-in evaluated evolution policy |
| `skill.curation.suggest` | C; limit | Advisory curation suggestions |
| `skill.curation` | C; id,action,expectedRevision,requestId,reviewed | Explicit bounded curation |
| `scope.status` | S | Program-scope control/binding status |
| `scope.inspect` | S; proposalId | Inspect a version/approval |
| `scope.propose` | S; scope,sources,effectiveAt,expiresAt,description,reviewed,expectedRevision,requestId | Propose immutable program scope |
| `scope.approve` | S; proposalId,reviewed,expectedRevision,requestId | Explicit owner approval |
| `scope.revoke` | S; approvalId,reason,reviewed,expectedRevision,requestId | Revoke approved scope |
| `scope.continue` | S; approvalId,expectedGoalId,reviewed,expectedRevision,requestId | Prepare a new goal binding; does not start work |

Example read: POST /v1/knowledge/search with
`{"sessionId":"SESSION_UUID","query":"rejected SQLi lead","limit":8}`.
Search results are ≤16 KiB including reserved worker notices; fewer than limit
may fit. Follow nextOffset before the first undelivered candidate. Offsets refer
to the current index, not an immutable snapshot across concurrent changes.
Originals remain unchanged; previews/omissions and freshness are explicit.

Full settings, fixture-definition and scope-definition contracts are versioned
in the installed `docs/KNOWLEDGE.md`, `docs/SESSION-MEMORY.md`,
`docs/PERMANENT-SESSIONS.md` and their named owner APIs. Those definition schemas
are separate from this dispatcher's top-level field lists. Scope approval is
owner authorization, never inferred from remembered scope text. Unknown dispatch
operations/settings fail instead of granting additional capabilities.

## 9. Relay and Core lifecycle administration (owner only)

These routes administer the existing gateway; local Huntr monitoring needs none
of them. They do not make Relay a model runner or transfer owner keys. GET /relay/
status and /connections can initialize the gateway service and its local state;
use /health for a minimal connectivity probe.

| Method and path | Input / result |
| --- | --- |
| `GET /v1/relay/status` | Gateway snapshot, pending pairings and grant metadata |
| `POST /v1/relay/init` | `{}` → local public identity certificate |
| `POST /v1/relay/connect` | `{}` → connect existing gateway |
| `POST /v1/relay/disconnect` | `{}` → disconnect gateway |
| `POST /v1/relay/pair` | sessionId,permissions?,ttlSeconds?,grantTtlSeconds?,sessionAccess?,shareAccess?,agentAccess? → expiring QR/code |
| `POST /v1/relay/approve` | claimId,confirmedCertificate,confirmedFingerprint → approved pairing |
| `POST /v1/relay/deny` | claimId → denied receipt |
| `POST /v1/relay/revoke` | grantId → revoke local/connected grant |
| `POST /v1/relay/share-create` | sessionId,ttlSeconds?,kind?:"TERMINAL" → expiring QR/code; Agent export requires its trusted registry |
| `POST /v1/relay/library-share-create` | cwd,expectedDigest,ttlSeconds?,excludeGoalIds?,kinds?,excludeEntries?,approval? → expiring QR/code |
| `POST /v1/relay/share-status` | shareId → current transfer state |
| `POST /v1/relay/share-approve` | shareId,claimId,confirmedFingerprint → approved transfer |
| `POST /v1/relay/share-revoke` | shareId → revoke transfer |
| `POST /v1/operator-stop` | `{shutdown?:true}` → pause work/scripts, persist operator stop; false quiesces without daemon shutdown |
| `POST /v1/shutdown` | Daemon replacement/connection teardown; runningAgentsContinue:true; not a durable owner pause |

Use `bzzy-core stop` for owner stop, not `/shutdown`. Relay requests do not share
the general execution Idempotency-Key reservation contract; use their own
operation receipts/status and inspect uncertainty before retrying. Pairing
requires explicit fingerprint comparison; codes/QRs remain private. Sharing uses
random expiring codes with reviewed recipient approval, not invitation URLs.
Transfer definition/review contracts: installed `docs/PROJECT-SHARING.md` and
`docs/LIBRARY-SHARING.md`. No UI or imported history can manufacture approvals.

## 10. JavaScript SDK method inventory

`BzzyClient` takes `{url,token,fetch?}`. It normalizes /v1 and never opens storage
or starts Core. Supply an authenticated backend connection. Methods map directly
to the routes above; generic `request(method,path,body?,requestId?)` supports
owner-only dispatchers too. HTTP failures throw an Error with status/code when
available. `stream` retries temporary disconnects, 408/429 and server failures;
malformed/oversized frames and other 4xx surface as errors. A revoked credential
must be reprovisioned, not retried forever. Native fetch failures outside stream
are surfaced to the caller.

| BzzyClient method | Parameters |
| --- | --- |
| `request` | method,endpoint,body?,requestId? |
| `health`, `capabilities`, `schema`, `metrics`, `sessions`, `grants` | none |
| `session`, `usage` | id |
| `activities`, `traffic` | id,{after?,limit?} |
| `events` | id,after=0,limit=200 |
| `eventHistory` | id,before=MAX_SAFE_INTEGER,limit=200 |
| `stream` | id,{after?,signal?,types?,reconnectDelayMs?,resource?} |
| `claim` | id,owner,takeover=false |
| `release` | id,owner |
| `submitInput` | id,{operation,owner,...fields,requestId} |
| `execute` | id,{owner,prompt,options?,goal?,resumeGoal?,requestId} |
| `answer` | id,{owner,questionId,answer,requestId} |
| `control` | id,{owner,action,text?,requestId} |
| `deleteConversation` | id,{requestId} |
| `observerToken` | id,expiresInSeconds=86400 |
| `sessionToken` | id,{permissions?,recipient?,expiresInSeconds?,includeChildren?} |
| `revokeToken` | grantId |
| `submitJob` | {script,cwd,args?,timeoutSeconds?,notify?,requestId} |
| `jobs` | {before?,limit?,state?} |
| `job` | id |
| `jobLogs`, `jobEvents` | id,{after?,limit?} |
| `streamJob` | id,{after?,signal?,types?,reconnectDelayMs?} |
| `cancelJob` | id,{requestId} |

stream resource is sessions (default) or jobs. after is a nonnegative safe integer;
reconnectDelayMs is 0–30000, default 1000. types supports exact names and trailing
wildcards, e.g. goal.*. Filtering is client-side. SSE frames over 1 MiB fail;
stream accepts LF/CRLF, multiline data and split UTF-8. There is no delivery
acknowledgment endpoint: maintain your consumer cursor/outbox yourself.

The following are trusted LOCAL Node APIs, not portable model tools or remote
REST grants. Imports `@bzzy/core` can load state modules; only the transport
entry `@bzzy/core/client` is intended for storage-free clients. Do not hand a
privileged facade to a model, browser or arbitrary scoped-session caller.

| Local facade / import | Methods and use |
| --- | --- |
| `BzzyCore` from @bzzy/core | start(),status(),sessions(),session(id),usage(id),events(id,after,limit),claim(id,owner,takeover),release(id,owner),execute(id,input),answer(id,input),control(id,input),deleteConversation(id,{requestId}) |
| `BzzyCore` creation | createConversation({provider,cwd,model?,effort?,alias?},{requestId}); returns the saved ordinary session without starting execution; cwd is an existing absolute non-private directory |
| `BzzyCore` scripts | submitJob(input),jobs(options),job(id),jobLogs(id,options),jobEvents(id,options),cancelJob(id,options) |
| `BzzyCore` grants/cursors | grantSession(input),revokeSession(id),processedCursor(consumerId,sessionId),processEvents(sessionId,{consumerId,handle,limit?,signal?}) |
| `CoreAssistant` from @bzzy/core | providers(),settings(),configure({source,provider?,model?,effort?},{requestId,expectedRevision}),createContext({cwd},{requestId}); independent Core defaults; source:cli explicitly copies once |
| `CoreAgents` from @bzzy/core | status(),providers(),models(provider,{after?,limit?}),list({after?,limit?}),get(id),forSession(sessionId),create(input,{requestId}),update(input,{requestId}),archive(input,{requestId}),exportArchive(sessionId,filename),importArchive(filename,input,options),imported(importId) |
| `CoreWorkspaces` from @bzzy/core/workspaces | settings(),configure({path,create?},{requestId,expectedRevision}),pin(),assertPin(pin); managed roots only, never move CLI cwd |
| `CoreKnowledge` from @bzzy/core or @bzzy/core/knowledge | context({sessionId?,cwd?}),request(operation,input); operations in section 8 |
| `CoreMetricsClient` from @bzzy/core or @bzzy/core/metrics | read(),close(); observation without starting a stopped daemon |
| `CoreConnectionsClient` from @bzzy/core/connections | read(),close(); observation with checked process/host identity |
| `createToolBroker` from @bzzy/core | Trusted read-only integration registry; admin.integrations/bind/attachBinding/grant/revokeGrant/revokeBinding/scope; model receives only separately scoped client interface |
| `filesystemIntegration` from @bzzy/core | Declared bounded read_file tool for explicitly approved roots; no credential/runtime files, symlinks or arbitrary execution |
| `generationSecurityPolicy` from @bzzy/core | Shared credential-separation instructions for generated behavior |
| Message helpers from @bzzy/core | messageFormatInstructions,parseMessageBody,messageBodyToPlainText,escapeMessageText,MESSAGE_FORMAT_LIMITS; rendering never grants permissions |
| `terminalSession` from @bzzy/core | Existing terminal-eligibility predicate for host catalogs |

BzzyCore.start and connection-backed methods can ensure a daemon but do not clear
an explicit operator stop; BzzyCore.status is observational. Use BzzyClient for a
strict read-only monitor attached to an already running service. processEvents
processes ONE bounded page per call and saves its Core-local cursor after each
successful handle. Loop while hasMore; use only one processor per consumer/session.
Callback side effects still require idempotency because handling and cursor
publication are not one transaction with your external application.

CoreAgents create fields: name,instructions,provider,model,effort; update adds
agentId,expectedRevision and accepts changed definition/selection fields. Archive
uses agentId,expectedRevision. Models/providers are discovered from Core, never
hardcoded into a client. Persistent Agents and specialist workers are distinct;
no scheduling or arbitrary account capability is implied by Agent CRUD. Details
and limits live in installed docs/AGENT-EXECUTION.md and the CLI docs/INTEGRATION.md, and the native reference flags for portable definitions.

## 11. Error handling, recovery and compatibility

Non-success HTTP responses are JSON `{error,code?}`. Typical classes: 400 invalid
fields/operation, 401 invalid/expired auth, 403 missing grant/foreign origin,
404 unknown/deleted source, 405 wrong method, 409 conflict/uncertainty/operator
stop, 429 capacity/rate pressure. Not every legacy error supplies a specialized
code/status; inspect the returned value and endpoint rather than matching raw
error wording. Never log authentication headers, private service records or
credential-bearing input. API snapshots/history remain private task data.

On timeout: preserve request ID/input, inspect current state and accepted
receipts, and retry the same operation/key only where its idempotency contract
allows. UNCERTAIN/CONFLICT is not permission to start a fresh execution. Do not
reset a session or budget to evade a limit. After Core restart rediscover the
local connection, reconnect with the persisted cursor and check the exact saved
goal. After owner stop wait for authorized start/resume. Separate unavailable
transport, process liveness, active execution, goal outcome and model claims.

Prefer API v1 capability checks and tolerate added optional fields/events.
Unsupported operations fail; they never silently authorize broader work.
Use docs/EXECUTION-API.md for script/CLI details, the CLI docs/INTEGRATION.md for
session protocol examples and docs/LONG-RUN-RELIABILITY.md for compaction,
refresh and stalled-state limitations. None of these reads proves model attention,
independent vulnerability verification or exactly-once external side effects.
