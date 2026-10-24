# Saved terminal chat deletion

The local-owner endpoint `POST /v1/sessions/:id/delete` accepts an empty body and a
stable `Idempotency-Key`. The privileged host facade exposes
`BzzyCore.deleteConversation(id, {requestId})`. A scoped token, paired phone or
model-facing tool cannot call this administrative endpoint.

The response is `{state:"deleted",sessionId,deletedSessionIds,deletedAt}`. Repeating
the same request returns the same receipt. Changed input under the same identity
fails with `CONFLICT`; a fresh request for an already deleted root returns its
original receipt. Persistent Agent contexts and direct child-session deletion
are rejected. The terminal root and all its descendants form one saved chat.

Deletion rejects queued/launching/running execution or a live runner, backend or
session lock with `SESSION_BUSY`. It never implicitly cancels model work. Paused
or stalled conversations can be removed once their runners have exited. The CLI
confirms the selected alias before calling Core; removing the current chat opens
a fresh unnamed idle conversation without inference.

## Durable visibility and access

One transaction records `session.deleted` envelopes, compact per-session
`session-deletion` tombstones, the root receipt, scoped-token/context revocation,
and a fresh opaque `terminal-catalog/current` revision. Project directories and
files are never removed. Compatibility JSON exports are removed when possible;
SQLite tombstones remain authoritative if an export cannot be removed.

Session loading, catalog discovery, legacy JSON migration, SSE streams, input
admission, execution enqueue and late session saves honor the tombstone. Owner
session APIs return HTTP 404 with `SESSION_DELETED`; revoked narrow tokens lose
access. A stale client or export cannot recreate the saved chat. Restart does not
resume deleted work. Internal request/execution/evidence and original raw event
records remain private for idempotency and provenance: this operation removes
accessible saved conversations, rather than claiming secure disk erasure.

Full own-phone snapshots include `capabilities.terminalCatalogRevision`, initially
`initial` and then a fresh UUID after deletion. Clients can compare this revision
on their existing authorized snapshots and coalesce a catalog refresh without
adding a separate polling stream. Scoped friend grants do not receive this host
catalog revision.

## Preserving an iPhone pairing anchored to a removed chat

Some existing own-phone grants use a terminal as their immutable base resource.
Deleting that chat does not revoke the entire phone or remap its resource/session
identity. The parent grant stays authorized for its separately approved terminal
catalog, Agent management, host updates and notifications for remaining chats.

Its `session.get` becomes a minimal shell: `sessionDeleted:true`,
`durableEvents:true`, observe-only chat permissions, empty questions and no active
execution or goal. Chat input, controls and old history/chunk reads are denied.
Event paging/subscription exposes only the authoritative `session.deleted`
envelope, with the original session identity and ordinary durable ACK semantics.
An old pending pre-deletion history page closes with `SESSION_DELETED` rather
than disclosing a saved body after removal. Output authorization rechecks the
tombstone after asynchronous reads and before encrypted transport.

Deleted derived resources and ordinary session grants are revoked independently;
other terminal contexts and the parent phone's existing approval stay valid. Goal
pushes for removed session IDs are denied, including the old base anchor; host
update notifications and alerts for remaining authorized chats remain available.

## Validation

Synthetic tests cover paused roots/descendants, live-work rejection, stable
receipts, owner-only access, stale exports and saves, fresh unnamed contexts,
restart, preserved project files/audit provenance, scoped revocation, deleted
base shells, exact deletion-only event/ACK behavior, prior large-body chunk denial,
remaining catalog/Agent access and push authorization. No real chat is deleted by
these checks.
