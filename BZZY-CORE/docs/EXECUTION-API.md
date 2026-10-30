# External execution API

Core owns execution, durable outcomes and notification delivery. An external
application owns its workflow, UI and retry decisions. These interfaces do not
add a workflow engine or grant imported code access to private accounts.

## Script jobs from the CLI

```sh
bzzy --background /path/check.py --cwd /path/project --timeout 300 --json --request-id check-20261029 -- --mode fast "literal argument"
bzzy background list --json
bzzy background status JOB_ID --json
bzzy background logs JOB_ID --json
bzzy background logs JOB_ID --follow
bzzy background cancel JOB_ID --request-id cancel-check-20261029 --json
```

Submission returns one JSON job object, including `id`, as soon as Core accepts
the durable queue entry. It does not wait for the script, model setup or phone
delivery. Closing the submitting terminal does not cancel the job. Only options
before `--` configure BZZY; every argument after it is passed literally, including
empty strings, spaces and strings resembling flags or shell substitutions. There
is no implicit shell evaluation. Use an absolute `--cwd` when integrating; the
CLI otherwise uses its invocation directory. Relative script paths resolve there.

An executable file uses its own shebang. Non-executable `.py` files use
`python3 -u` on Core's PATH; `.js`/`.mjs`/`.cjs` use Core's Node runtime and `.sh`
uses `/bin/sh`. Other files must be executable. Dependencies/interpreters must
already be installed; Core installs none. Stdin is EOF. The script runs with the
host owner's OS access, outside an AI goal's tool policy; it is not a sandbox for
untrusted code. It receives Core's allowlisted tool environment, with provider
credentials and executable startup hooks excluded. Do not pass secrets in argv.
Use an existing authorized private binding/tool broker for account capabilities.

`--timeout` is a positive integer in seconds, up to 604800 (7 days). Omission
means no timeout. The timer starts when a job enters running, before its process
startup handshake. Timeouts and cancellation send SIGTERM to the verified process
group, then SIGKILL after 1.5 seconds. Supervision supports Linux and macOS.
Ordinary child processes are included; deliberately detached processes and remote
side effects are outside this guarantee. Cancellation cannot undo prior effects.

`--json` submission/status/cancel output is one JSON object; list is
`{items,nextCursor,hasMore}` (latest 100 jobs). Logs output JSONL event envelopes,
with `data.stream` and `data.text`; `--follow` polls until the job finishes or the
reader receives Ctrl+C. Stopping a log reader does not cancel execution. Saved
list/status/logs and cancellation work locally when Core is offline and do not
start it. Submission starts Core through the normal CLI lifecycle.
Background command failures after option parsing use JSON `{error,code}` on
stderr with a nonzero exit status when `--json` is selected.

## Notifications are opt-in

```sh
bzzy --background /path/check.py --notif --json
```

The default is **no script push**. `--notif` (API `notify: true`) queues completion,
failure, timeout or interrupted outcomes through the existing durable Core
outbox → Relay → APNs → approved own iPhone pipeline. Titles are
`Completed check.py` / `Failed check.py`. The basename is sanitized; unsafe names
become `script`. The alert body contains only a job ID and fixed outcome text.
It includes no directory, arguments, credentials, raw logs or failure diagnostics.
Explicit user cancellation saves an outcome without an alert. Existing debug
exports retain their existing notification behavior.

Only a fully approved own-phone registration is eligible. Phone alert permission,
active pairing, Relay/APNs configuration and enabled delivery are still required.
The Relay version must include support for these script alert titles. Existing
iOS notification parsing accepts the host-only Terminal route; tapping opens that
host's Terminal catalog, not a fabricated chat or a new job management screen.
Queued delivery can continue on reconnection; script completion does not prove
Apple acceptance or phone display. Expired/revoked grants cannot receive alerts.

## States, idempotency and recovery

States are `queued`, `launching`, `running`, `cancelling`, then one terminal
state: `completed`, `failed`, `cancelled`, `timed_out` or `interrupted`.
`outcome` saves actual `exitCode`/`signal` when known plus a bounded support code.
Exit 0 means the process completed; it is not verification of a workflow or AI
goal. A supervisor interruption can leave the exit code unknown.

Always reuse the same request ID for retries of the same submission. Core
transactionally reserves it with the normalized specification and returns the
same job ID and its **current** saved state. Different input with that key returns
409 `CONFLICT`. Omitting `--request-id` generates a new one for that invocation;
repeating a whole CLI command without a stable key intentionally creates a new
job. Keys are 1–128 letters/digits/`_ . : -`. Cancel has its own key namespace.

Queued work can be dispatched after restart because it has not been launched.
A launch is durably claimed before spawning; inert startup handshakes publish
verified process identity before allowing the script to execute. Core never
requeues a launching/running job after a crash. A lost supervisor is interrupted,
its connected script group is terminated, and the saved outcome is retained.
A script changed since submission fails before execution with
`JOB_SCRIPT_CHANGED`; this checks file identity/size/mtime, not an immutable
snapshot. Do not modify an input script while it is queued/running.

An ordinary Core **restart** replaces the control daemon while supervised script
workers continue. An explicit Core **stop** interrupts active script jobs and
durably stops queued ones. A later start never resumes/replays these scripts.
Submit a new job/key only after reviewing prior effects. Host reboot or process
loss can make external effects uncertain; request deduplication is not a claim
of exactly-once external effects.

Logs/state/outcomes are private SQLite records in `BZZY_HOME` (0600 database in a
0700 directory), independent of CLI/iPhone connections. Logs are line buffered,
UTF-8 decoded, credential-scrubbed before persistence, and capped at 8 MiB per job.
An individual logical line exceeding 64 Ki characters is omitted; the log includes
an omission marker. `logsTruncated` signals the total cap. Unterminated final
output is saved at exit. Redaction is defensive, not permission to print secrets.
Raw input specs are private and excluded from job API projections and events.
Core admits at most 128 active/queued jobs and dispatches at most 8 concurrently.

## Authenticated HTTP API v1

The existing daemon binds an ephemeral loopback port. A trusted owner backend
can read its URL and private bearer token from
`$BZZY_HOME/runtime/service.json`; keep the token in backend memory and local
private storage. Never send it to a browser, iOS, Relay, model, shared package,
URL query or log. `@bzzy/core`'s local `BzzyCore` adapter discovers it without
returning the token. HTTP requests require `Authorization: Bearer ...`; foreign
browser origins are denied. Do not expose this owner API on a public interface.

Script jobs are **owner-only** host operations. Session-scoped tokens cannot
submit, inspect or cancel them, even if they can execute an AI conversation.
Existing scoped session permissions and Relay grants are unchanged.

| Method/path | Input or result |
| --- | --- |
| `GET /v1/capabilities` | `backgroundJobs`, `jobEvents` reflect owner access |
| `POST /v1/jobs` | `{script,args?,cwd,timeoutSeconds?,notify?}`; 202 job object |
| `GET /v1/jobs?before=SEQ&limit=100&state=running` | Stable descending creation cursor; limit 1–500; optional state |
| `GET /v1/jobs/JOB_ID` | Current job metadata/outcome |
| `GET /v1/jobs/JOB_ID/logs?after=SEQ&limit=200` | Log-only event page |
| `GET /v1/jobs/JOB_ID/events?after=SEQ&limit=200` | All job events |
| `GET /v1/jobs/JOB_ID/events?stream=1&after=SEQ` | Replayable SSE |
| `POST /v1/jobs/JOB_ID/cancel` | Empty object; 202 current state; completion is asynchronous |
| `GET /v1/jobs/schema` | JSON schema for job event envelopes |

POST requires `Idempotency-Key` (or body `requestId`). `cwd` is an absolute
existing directory on Core's host. `args` defaults to `[]` (at most 1024 strings /
128 KiB); `timeoutSeconds` defaults to 0 (no limit), `notify` defaults to false.
Unknown fields are rejected. No arbitrary environment overrides, credentials,
shell strings, workflows or phone routing hints are accepted. Bodies are capped
at 256 KiB. Errors are JSON `{error,code}` with appropriate non-2xx status.

Both event page endpoints return
`{events,nextCursor,hasMore,state,logsTruncated}`. Limits are 1–1000. Event envelopes:

```json
{"version":1,"id":"JOB_ID:123","seq":123,"jobId":"JOB_ID","type":"job.log","data":{"stream":"stdout","text":"finished\n"},"createdAt":"2026-10-29T12:00:00.000Z"}
```

Types: `job.queued`, `job.running`, `job.log`, `job.cancelling`,
`job.completed`, `job.failed`, `job.cancelled`, `job.timed_out`, `job.interrupted`.
Lifecycle events include `state`, optional fixed `reason`, and terminal `outcome`.
SSE uses `id: SEQ`, `event: TYPE`, `data: EVENT_JSON` and heartbeat comments.
Resume with `after` or `Last-Event-ID`. Cursors are exclusive, globally monotonic
SQLite sequences; gaps are normal. Deduplicate by event ID/sequence, persist a
consumer cursor only after handling it, tolerate unknown future types, and query
status after transport loss. Acknowledgment means queued, not successful.

## Local Node integration

```js
import { BzzyCore } from '@bzzy/core';

const core = new BzzyCore();
const job = await core.submitJob({
  script: '/path/check.py', cwd: '/path/project', args: ['--format', 'json'],
  timeoutSeconds: 300, notify: true, requestId: 'external-check-20261029'
});
console.log(job.id);
const page = await core.jobEvents(job.id, { after: 0 });
// Persist your consumer cursor after applying each event.
```

`BzzyCore` also exposes `jobs`, `job`, `jobLogs`, `cancelJob` and its existing
conversation APIs. Its connection discovery never clears an explicit operator
stop. Start Core explicitly before submitting through this adapter if stopped.
For an already authenticated transport use `BzzyClient` from `@bzzy/core/client`:
`submitJob`, `jobs`, `job`, `jobLogs`, `jobEvents`, `cancelJob` and
`streamJob(id,{after,signal,types})`. The transport client never opens owner
storage. `streamJob` reconnects using its last parsed sequence; persist your own
cursor for application/process restarts.

## Existing AI sessions and full preprompts

```sh
bzzy --preprompt instructions.txt --goal "Complete the assigned task" --detach --alias external-task --request-id external-task-20261029 --json
```

`--preprompt` aliases `--context-file`, including its validation: one UTF-8 regular
file, up to 1 MiB, relative to `--cwd`. The exact full content is saved in the
Core task contract **before execution**. It is not an ordinary initialization
chat or a truncated summary. Resume uses that saved contract even if the source
file changes/disappears. Existing context/compaction safeguards fail explicitly
when required instructions cannot fit. Goals, memory, workflow pinning, providers,
permissions, approvals and verified completion remain Core-owned. Detaching
does not auto-answer approvals; unattended callers must use supported existing
permission settings. JSON output includes the actual `sessionId`.

External clients can reuse existing AI session APIs:

| Method/path | Operation |
| --- | --- |
| `GET /v1/sessions`, `GET /v1/sessions/ID` | Inventory/snapshot |
| `GET /v1/sessions/ID/events?after=SEQ&limit=200` | Durable event page; `stream=1` for SSE |
| `GET /v1/sessions/ID/usage` | Saved usage |
| `POST /v1/sessions/ID/claim` | `{owner,takeover?}`; input lease (renew before expiry) |
| `POST /v1/sessions/ID/release` | `{owner}` |
| `POST /v1/sessions/ID/input` | Existing canonical goal/chat/control/answer inputs |
| `POST /v1/sessions/ID/execute` | `{owner,prompt,options?,goal?,resumeGoal?}` |
| `POST /v1/sessions/ID/answer` | `{owner,questionId,answer}` |
| `POST /v1/sessions/ID/control` | `{owner,action,text?}`; supported pause/cancel/steer |
| `GET /v1/schema` | Existing session event envelope schema |

Execute/input/answer/control use stable `Idempotency-Key` values. Existing leases,
revocation, permissions, child-session scope, goal-contract validation and policy
checks still apply. Use the CLI to create a goal with a preprompt, then operate
on that saved session. Local trusted Node apps can also create ordinary chats
with `core.createConversation({provider,cwd,alias},{requestId})`; this is not a
new unauthenticated remote session-creation route. Providers/models remain the
host's configured catalog, separate from Core's coordinator selection.

Session envelopes retain `sessionId`; job envelopes use `jobId`. A script job is
never added to the saved chat catalog. External workflows should correlate their
own task IDs to Core job/session IDs and decide what to do with verified goal
outcomes, ordinary process exits, uncertainty and notification delivery receipts.
