# Integrating bzzy

bzzy runs a local service and durable execution runners. Terminal clients,
the bundled web view, and your application observe the same sessions. Closing
a terminal or losing a stream does not stop the agent.

## Start and discover

```bash
bzzy service start
bzzy service status
bzzy sessions
bzzy service web                 # local conversation/activity/traffic UI
bzzy service web SESSION_ID
bzzy service token SESSION_ID --json
bzzy integration                # this guide, also shipped with the package
```

The service binds to **127.0.0.1**, using a port chosen on first start and kept
across restarts. `~/.bzzy/runtime/service.json` contains its URL, owner token and
process identity. `BZZY_HOME` overrides that directory. These files have private
permissions. Full owner credentials remain stable in `runtime/listener.json`.

`service token` creates a read-only token for one conversation, including its
child chats, expiring in 24 hours. Observer tokens cannot claim input, execute,
answer questions or control agents. `POST /v1/tokens` can select an expiry up to
30 days. Owner tokens grant control over the local runtime.

For your website, connect **your backend** to the local service and forward
events through your existing authenticated website connection. Browser clients
on another origin are not granted CORS access automatically. Keep owner tokens
on your backend; use scoped observer tokens for displays.

## Public API v1

Every request needs `Authorization: Bearer TOKEN`. Bodies and responses are JSON,
except the event stream. The unprefixed endpoints are compatibility aliases.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/v1/health` | Runtime/API version and pinned Codex baseline |
| GET | `/v1/schema` | Public event-envelope JSON Schema |
| GET | `/v1/sessions` | List root conversations visible to the token |
| GET | `/v1/sessions/ID` | Goal, state, latest execution, questions, input owner, capabilities and child chats |
| GET | `/v1/sessions/ID/usage` | Reported usage and terminal totals |
| GET | `/v1/sessions/ID/activities` | Current activity records |
| GET | `/v1/sessions/ID/traffic` | Observed request/response records |
| GET | `/v1/sessions/ID/events?after=0&limit=200` | Durable event replay and next cursor |
| GET | `/v1/sessions/ID/events?stream=1&after=0` | Live Server-Sent Events, with replay |
| POST | `/v1/sessions/ID/claim` | Acquire/renew input ownership; `{owner,takeover}` |
| POST | `/v1/sessions/ID/release` | Release this client's ownership; `{owner}` |
| POST | `/v1/sessions/ID/execute` | Queue a turn or resume; `{owner,prompt,options,goal,resumeGoal}` |
| POST | `/v1/sessions/ID/answer` | Answer an existing question; `{owner,questionId,answer}` |
| POST | `/v1/sessions/ID/control` | Request `pause`, `cancel` or supported `steer`; `{owner,action,text}` |
| POST | `/v1/tokens` | Create an observer credential; `{sessionId,expiresInSeconds}` |

Sessions are created by bzzy's terminal commands. Use the returned UUID to connect
your application. API routes require the full UUID; terminal commands also accept
unique prefixes. No model call is made to read a session, history, report or usage.

The session response separates `session.goal.status`, `session.executionState`
and the latest execution result. For example, a successful status request does
not mean a goal succeeded. A worker report never completes its parent's goal.

Snapshot endpoints support `?limit=100&after=LAST_RECORD_ID` (maximum 500).
They provide current records; **use event sequence cursors for reliable live
updates**, including updates to existing activity and traffic records.

## Events and reconnects

```json
{
  "version": 1,
  "id": "SESSION_UUID:123",
  "seq": 123,
  "sessionId": "SESSION_UUID",
  "type": "activity",
  "createdAt": "2026-10-21T12:00:00.000Z",
  "data": {
    "id": "ACTIVITY_UUID",
    "agent": "codex-1-example",
    "summary": "Testing IDOR candidates at /users/getProfile",
    "details": "The user_id parameter is present; ownership enforcement still needs an approved account-control comparison.",
    "observation": "Parameter is present",
    "inference": "Potential ownership issue",
    "nextCheck": "Compare approved account controls",
    "status": "running",
    "provenance": "agent-reported"
  }
}
```

| Event | Useful data |
| --- | --- |
| `goal.completed` | Objective, provider/model, status, evidence, elapsed seconds and usage |
| `goal.stalled` | Same envelope, plus stopping reason; includes blockers, limits and unmet acceptance checks |
| `summary` | Terminal result, session ID, active elapsed seconds, combined usage and per-agent breakdown |
| `usage.updated` | Live backend-reported tokens, provider/model and available detail |
| `account.quota` | Weekly quota reported by the native backend: provider, used/remaining percentage, reset time and `checkedAt`; separate from task token usage |
| `activity` | Short summary, details, observation, inference, next check, evidence, target and attribution |
| `network.capture` | Capture coverage and whether HTTPS interception is enabled |
| `network.request` | Request ID, method, redacted URL/headers, time and provenance |
| `network.response` | Same request ID, status, duration, byte counts and available evidence/body hashes |
| `network.error` | Observed transport failure; never interpreted as a vulnerability |
| `network.backend` | Backend-reported WebFetch/browser visit, tool state and redacted URL; `status: null`, `localRequestObserved: false` |
| `question` / `worker.question` | Durable outstanding question and originating chat |
| `question.answered` | Accepted answer and question ID |
| `input.owner` | Ownership changes |
| `model.changed` | Provider, previous model, selected model, selected effort and `appliesTo: next_turn`; session and native thread stay the same |
| `provider.changed` | Previous and selected provider/model, selected effort and `conversationThrough` cursor; same session ID, with prior chat supplied to the new native thread |
| `telegram.attachment` | Chat relay attached/detached; does not alter goal notification settings |
| `telegram.status` | Connection state, sanitized error and optional bot username |
| `telegram.message` | `id`, incoming/outgoing `direction`, delivery `status`, readable `text` and timestamp; upsert by ID |
| `artifact`, `checkpoint`, `assessment`, `acceptance` | Evidence and verification progress |
| `assignment.*`, `worker.progress`, `peer.text` | Multi-agent activity and results |
| `peer.message` / `peer.sent` | Besties message ID, group/goal ID, sender, recipient, durable sequence, readable text and selected evidence IDs |
| `peer.review` | Evidence-bearing message ID, reviewer, paired peer, supported/inconclusive/disputed assessment, rationale and inspected evidence IDs |
| `besties.turn` | Paired peer session/agent, execution ID and the reason work resumed |
| `besties.usage` | Group known token total, availability coverage and each peer's provider/model/tokens/elapsed time |
| `delegation.usage` | Reported `supervisorTokens`, `delegatedTokens`, known `totalTokens`, `complete` coverage and per-assignment `agents`; a partial total is not a complete cost estimate |
| `debate.phase` | Independent investigation started/finished; shared evidence snapshot hash |
| `debate.message` | Participant, role, phase/round, round limit and displayable assessment text |
| `debate.opening` | Main agent's opening case after all independent assessments finish |
| `debate.round` | Durable assessments and the main agent's response for a discussion round |
| `debate.linked` / `debate.result` | Original-chat linkage and final decision, objections and evidence |
| `execution.finished` | One execution ended; inspect `exitCode` and goal status |

For a delegated assessment, the parent session is the supervisor conversation.
`assignment.created` announces a bounded executor task and its chosen provider,
model and contract. `assignment.finished` returns control for supervisor review;
it does not establish success. `assignment.reviewed` records the supervisor's
decision, while `assignment.failed` leaves the parent objective unresolved.
Use these events for planning/executing/reviewing status and display attributed
`activity.summary` / `activity.details` for human progress. Full worker reports
and artifacts should be opened on demand rather than appended to every update.

`delegation.usage` also persists as `session.delegationUsage`. A worker with
missing telemetry has `tokens: null` and `available: false`; `complete: false`
means `totalTokens` sums only known usage. Keep the brain/hands split visible
and label a partial total. Token counts measure reported usage, not dollar cost.
Saved goal IDs, assignment rounds, checkpoints and reconnect cursors let clients
follow an hours-long assessment without starting another supervisor or replaying
the whole worker transcript. `--attach` and `--resume` retain the saved roles.

SSE uses `id: SEQ`, `event: TYPE`, and `data: EVENT_JSON`. Reconnect with
`?after=LAST_SEQ` or `Last-Event-ID: LAST_SEQ`. Sequence numbers are durable,
monotonic, and may have gaps. Store the last **processed** cursor in your app,
deduplicate by event ID, and ignore unknown event types. Delivery is replayable;
consumer-side side effects need their own idempotency keys.

Goal transitions and their notification outbox are saved in the same SQLite
transaction. Completion events are emitted after bzzy's acceptance gate, not when
a model first says "done". Voluntary pause and cancellation have their own
lifecycle/summary records and do not masquerade as a stall.

## JavaScript client

The package exports `BzzyClient`, usable from Node or bundled into a browser app.
This example runs on your website's backend:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BzzyClient } from 'bzzy-cli';

const bzzyHome = process.env.BZZY_HOME || path.join(os.homedir(), '.bzzy');
const local = JSON.parse(fs.readFileSync(path.join(bzzyHome, 'runtime/service.json')));
const bzzy = new BzzyClient({ url: local.url + '/v1', token: local.token });
const sessionId = 'YOUR_SESSION_UUID';
const abort = new AbortController();

for await (const event of bzzy.stream(sessionId, {
  after: savedCursor,
  signal: abort.signal,
  types: ['goal.completed', 'goal.stalled', 'summary', 'usage.updated', 'activity', 'network.*']
})) {
  await saveAndForwardToYourWebsite(event);
  // Store cursors for this subscription. A filtered stream also skips unrelated events.
  savedCursor = event.seq;
}
```

`stream` reconnects after transport failures and suppresses already-seen events
within that connection's lifetime. On an application restart pass your stored
cursor. Authentication and authorization failures surface to your application.
Use an unfiltered stream if you maintain one cursor for several website panels.

For a small integration without a library:

```bash
curl -N -H "Authorization: Bearer $BZZY_OBSERVER_TOKEN" \
  "$BZZY_URL/v1/sessions/$BZZY_SESSION/events?stream=1&after=0"
```

## Control and idempotency

Use a random stable client `owner` ID. Claim ownership before sending input;
renew every 10–15 seconds (leases last 45 seconds). `takeover: true` explicitly
transfers input and invalidates the previous owner. Viewers never claim input.

Send `Idempotency-Key: YOUR_REQUEST_ID` for `execute`, `answer` and `control`.
The same operation/key/input returns its saved result. Reusing it with different
input returns HTTP 409. Acknowledgment means the request was durably queued;
observe execution and control results separately. The server records dispatch
before execution and does not automatically replay uncertain side effects after
a crash. Idempotency does not make arbitrary external actions exactly-once.

```js
const owner = crypto.randomUUID();
await bzzy.claim(sessionId, owner, true);
await bzzy.execute(sessionId, {
  owner, prompt: 'Inspect the recorded evidence and explain the unresolved issue.',
  requestId: 'review-2026-10-21-001'
});
// Retry with the same requestId and identical input after a lost acknowledgment.
```

Check `capabilities.activeSteering` before steering. Codex supports active-turn
steering; this Claude adapter accepts the next message after the current turn
finishes or is paused. Never invent answers to outstanding questions.

## Parallel conversation tabs

Besties uses the same group overview and two child-chat views. A besties session
persists `mode: besties` and exactly two independently chosen `besties` selections.
During `/goal`, peers exchange durable `peer.message` events and record
`peer.review` judgments after opening evidence. Preserve sender/recipient and
message IDs when displaying these events; support is evidence-specific, and a
message or review is not by itself a completed goal. The usual `goal.completed`
and `goal.stalled` lifecycle events describe the final group outcome. Plain chat
does not start group orchestration; a goal execution request must set `goal: true`.

Each chat has durable `message.user`, `text`, `question` and `question.answered`
events. Replay these to reconstruct both sides of the conversation. A steering
message records the user's request; wait for `control.observed` or
`control.failed` before assuming the backend acted on it.

Activity records contain display-ready `summary` and `details`. Show `summary` in
the compact feed and `details` when expanded; no terminal scraping or command
summarization is needed. For example:

```json
{
  "summary": "Checking the footer on paypal.com",
  "details": "I’m opening paypal.com to locate its footer and extract its text.",
  "status": "running",
  "provenance": "host-inferred",
  "source": "native-tool"
}
```

Agent-authored progress has `provenance: agent-reported`. If an agent has not
published progress, bzzy produces a coarse description from the actual tool
invocation, marked `host-inferred`; this describes intent, not proof of a result.
Repeated equivalent tool actions are grouped, and recent explicit agent updates
take precedence. Raw shell commands remain in tool events, outside Activity.
Upsert records by `data.id`: later events can update or close the same entry.

On exit or recovery, the runtime adds
`executionActive: false`, `closedAt` and `executionOutcome` to unfinished
activities. This closes the live display without inventing a successful test
or changing the agent's last reported status.

A parallel launch has one **group session UUID** and a child chat UUID for each
agent. `GET /v1/sessions/GROUP_ID` returns `children` and `capabilities.chatTabs`.
Subscribe to the group for an aggregate feed, or to a child for that agent's
complete chat. Keep separate reconnect cursors for each.

An observer token for the group can read its descendant chats. Claiming the
group with takeover gives the client control of its agent chats. An explicit
later attachment to one child can transfer just that chat. Read the effective
`inputOwner` returned for the selected chat before sending input.

The terminal and bundled web view provide Overview and per-agent tabs. Terminal
navigation uses Tab/Shift+Tab or `/tabs` and `/tab NUMBER|NAME`; selected-agent
input goes to that chat. `/pause all` and `/cancel all` address the group.

The terminal uses a full-screen chat with a pinned latest user message and fixed
session/usage indicators. Ctrl+G or `/chat`, `/activity`, `/http` switches panels;
clickable view and agent tabs, mouse wheel scrolling and a draggable right
scrollbar provide mouse navigation. These are views over the same durable events.
Ctrl+S / `/copy` freezes terminal rendering for native text selection;
execution and event persistence continue. Esc resumes rendering from current state.
The TUI also supports internal drag selection and Ctrl+C, per-response **[c]**
buttons that copy the full original response, and explicit Ctrl+V clipboard reads
into the composer. These are local UI actions, including in a read-only view;
they do not create agent input or require input ownership. Remote clipboard copy
requests use OSC 52 when a native clipboard is unavailable, subject to terminal
support. If a clipboard read is unavailable, Ctrl+V can use the last text copied
inside bzzy and labels that fallback. Clipboard contents are not read on startup.
No text needs to be scraped from the TUI
to implement these panels in another client.

Telegram attachment is another explicitly authorized input channel for the same
conversation. It does not take input ownership from a controlling terminal.
`message.user.channel: telegram` identifies relay input; native text and goal
events keep their usual schema. The relay uses the same atomic execution queue,
so terminal and Telegram requests cannot start simultaneous runs in one session.
Pending Telegram messages wait until the current execution ends. An explicit
reply to a relayed question records `question.answered.channel: telegram`.

Attaching starts at the current event cursor, never by replaying old conversation
text to Telegram. Detaching revokes the attachment and prevents queued input or
unsent messages from being forwarded. The private delivery outbox distinguishes
sent, failed and uncertain results. `telegram.message` updates carry that status;
an uncertain send is not retried automatically. These events are separate from
the goal notification hub and its independent on/off control.

`/debate` creates a child debate session linked from the selected conversation.
Subscribe to that child for its independent-investigation phase, discussion
turns and final result. A `debate.result` is also recorded on the original chat,
so reconnecting clients can restore the decision. `status: awaiting_review`
means the discussion left unresolved objections or verification work. It must
not be presented as goal completion. Reports and decisions retain artifact IDs
and the fixed snapshot hash. `newVerificationDuringRounds` is always false;
default investigation records `newVerificationPerformed: null` because running
tests is agent-reported, while `--review-only` records false. Evidence, rather
than that flag, determines which claims are supported.

## Traffic capture and provenance

```bash
bzzy goal "Assess the authorized profile surface" --contract assessment.json --capture-network
bzzy activity SESSION_ID --detailed
bzzy traffic SESSION_ID
```

The `http_request` agent tool records actual host-observed requests and response
artifacts. It checks declared allowed/excluded targets, respects disabled
networking and read-only HTTP-method restrictions, bounds responses, and does
not silently follow redirects outside scope.

Claude WebFetch, supported browser navigation tools and Codex web page opens also
appear automatically in the HTTP panel and emit `network.backend`. These report
tool activity with `provenance: backend-reported`, not a locally measured HTTP
exchange. The backend does not expose its HTTP status, headers, cache behavior or
redirect chain here; do not invent them. Tool duration, when available, is stored
as `toolDurationMs`, separately from observed HTTP latency. Terminal history can
restore these visits from older persisted backend tool events as well.

`--capture-network` additionally supplies an authenticated local proxy to child
processes using standard proxy and CA environment variables. It observes HTTP
and intercepts HTTPS for compatible clients, using a private session CA. It does
not install that CA in the machine's trust store. Model-provider/authentication
domains are tunneled without decrypting or recording their payloads.

Traffic indexes redact credential headers and secret URL parameters. Proxy
records include body hashes and byte counts, not raw request/response bodies.
Explicit `http_request` response bodies become private evidence artifacts.

Coverage is **proxy-aware clients**, not an operating-system packet capture.
Direct sockets, clients ignoring proxy/CA settings, certificate-pinned clients,
and unsupported protocols may not be observed. The capture event states this
coverage. An activity note is an agent claim; a proxy/host observation is a
record of a request. Neither alone establishes a vulnerability.

## Usage and limits

Terminal summaries and completion/stall events include elapsed active runtime,
reported tokens, stopping reason and session ID. Multi-agent summaries include
per-agent values and a combined known total. Unknown usage is marked explicitly.
Codex native-goal accounting and backend token counters retain their source;
Claude includes reported cached input where available. Claude's optional dollar
figures are estimates, not subscription invoices. No exact subscription cost is
invented. Limits are checked at available backend checkpoints and can overshoot.
