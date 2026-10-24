# Shared session input

CLI and iOS observe the same Core session. Opening, reconnecting and replaying
history never claim input or start inference. A client submits an explicit
input intent; Core coordinates admission and publishes durable events to both
clients. Losing input control changes the CLI to a viewer without closing it.
Its next submitted message can continue the session.

The authenticated loopback endpoint is `POST /sessions/:id/input`, advertised
by `capabilities.inputSubmission`. Operations are `execute`, `goal`, `answer`,
`control`, `permissions`, `selection` and `mode`. Each carries a stable request ID and client owner ID.
Relay v1 remains compatible: updated clients set `coordinateInput: true` on
existing mutation operations when `session.get.capabilities.inputSubmission`
is present. Older explicit lease operations remain available.

Core serializes admission per session with a bounded queue. It rechecks the
authenticated principal's operation, claim and, when transferring input,
takeover rights. Original tool policies, question identity/expiry, own-phone
YOLO restrictions and group/session scope still apply. Neither Relay nor iOS
receives the host owner credential. Fully paired own-phone actions use their
already approved grant; no additional takeover prompt is necessary.

Goal replacement still requires the current goal's exact ID and cancel rights
when stopping live execution. Confirmation is checked before changing control
and again before committing the replacement. Reconnection cannot resume a goal.

`/goal resume` explicitly continues an unfinished paused or stalled goal with
its original ID, objective, checkpoint and evidence. It resets the blocker audit
and notification epoch, while retaining token consumption. Exhausted budgets
require an explicit higher total. The mobile stalled-only shortcut additionally
sends `resumeGoalId`; Core checks both identity and stalled state inside queue
admission. `stalledGoalResume` advertises this optional gateway capability.

An `input-intent` journal namespaces each request by session and authenticated
principal, fingerprints its complete input and records acceptance. Retrying an
accepted intent returns its receipt without reclaiming input or executing again.
A reused ID with different content is rejected. After a crash, a durable
underlying request receipt can reconcile an incomplete intent; otherwise Core
reports uncertainty and never blindly replays the input. Admission is separate
from execution outcome and verified goal completion.

Core adds an opaque actor/request channel to `message.user` and publishes
`input.accepted`. iOS can reconcile its exact pending message from an
authenticated event even if the direct response is lost. Private local outgoing
messages show sending, accepted, failed or uncertain state; explicit Retry first
checks the saved receipt. Uncertain retries retain the original ID and parameters.
A definitively rejected message receives a new ID on retry. Relaunch/reconnect
restores these records without sending them automatically.

Subscriptions retain one bounded unacknowledged page. Resubscription replays
that exact page; the client persists/deduplicates it before acknowledging. An
identical replay is allowed, but changed content under the same IDs is rejected.
Control changes and transport errors do not delete accepted replies or interrupt
the independently supervised Core execution.

## Paused mode changes

The full own-phone grant may send `session.mode` with `coordinateInput:true`,
`owner`, a supported `mode`, and the displayed `expectedUpdatedAt` revision.
Core supports Solo, Delegate, Debate, Parallel and Besties in the same root
terminal conversation. It requires durably paused execution, no queued/running
work and stopped children/assignment rounds. Persistent Agents and worker chats
cannot switch their execution architecture. Mode selection starts no work.
Missing presets require explicit setup; Core reads the mode's saved models and
efforts from its own defaults. It never accepts client execution options here.

The operation retains conversation/goal IDs, the cwd, policy, contract, evidence
and cumulative token/runtime usage. Returning to Solo restores its prior model
selection. New group generations receive distinct worker directories and bounded
prior conversation context, rather than restarting a previous group checkpoint
under different models. Group budget offsets retain consumption from earlier
modes and are not counted twice on ordinary group resume. Besties cannot increase
an existing concurrency boundary.

Fully paired own-phone input may control the root coordinator of a group through
canonical admission. Its token still has `includeChildren:false`; direct worker
reads/controls and scoped friends remain blocked. This is root coordinator input,
not a child-session permission expansion. CLI observers update mode and remove
obsolete group tabs without replaying model work.
