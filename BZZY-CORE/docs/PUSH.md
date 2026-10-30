# Core activity notifications through Relay and APNs

Owner custom alerts: `bzzy --custom-notification "hey"` (optional --json and
--request-id) queues a fixed **BZZY notification** title and normalized body up
to 180 characters. Core's owner-only POST /v1/notifications validates approval,
text and rate, then atomically saves the request receipt and outbox. Credentials
are rejected; no model/session work starts. Dispatch pins eligible registrations,
rechecks grants and reuses the existing uncertain-delivery policy. No eligible
enabled full own-phone registration yields PUSH_REGISTRATION_REQUIRED. This
needs the matching Relay title allowlist deployed; current iOS host-only Terminal
navigation is reused. Queued is not a delivered/displayed receipt.


Current clients register the phone with Relay and register its approved scope
with each Core over the encrypted Core protocol. Core saves each outcome and
outbox record transactionally, then submits a bounded alert to Relay. Relay
queues it durably and sends it through Apple's APNs even with iOS closed. Apple
push credentials are configured once on Relay; Core owner/provider credentials
stay on their original machines. Older clients and Relays retain direct Core
APNs delivery. A transient Relay failure never changes an accepted alert to a
different delivery route.

For an ordinary customer, setup is **install Core/CLI, install iOS, pair, and
allow notifications**. Apple signing setup and Relay network policy belong to
the BZZY service operator, once per supported app environment. Customers do not
provide Apple keys or perform SSH/fingerprint steps for notifications. An SSH
identity check during operator troubleshooting is separate from product pairing.

For the Relay route, place the private APNs configuration described below at
`STATE_DIRECTORY/push/apns.json` on the Relay service, with its private signing
key readable only by the Relay service user. The same strict schema, ownership,
permissions and environment checks apply. Provisioning and notification permission
on the phone are still required. No remote operation accepts Apple signing keys,
APNs endpoints or provider credentials.

Relay sees only the recipient's private device binding, bounded sanitized alert
text and opaque routing hints. Full conversation/event traffic remains end-to-end
encrypted and is never queued by Relay. Alert previews are removed after dispatch;
deduplication receipts expire with the one-day queue retention. Disable/revoke, removal of a saved computer
and device-token changes are rechecked before dispatch, along with the live
PAIR grant. A Core rechecks its narrower local permission before queueing.

Core polls new saved outcomes every second, prioritizing recent events ahead of
historical backlog. Relay also drains its queue every second. A lost Core-to-Relay
receipt is retried with the same immutable ID and request, including across Core
restarts. Relay returns the existing receipt rather than adding another push.
Explicit Apple rejections use bounded backoff. Ambiguous Apple acceptance is
reported as uncertain and is not blindly resent: APNs offers no end-to-end
exactly-once or guaranteed display contract.

The Relay service permits Apple's published networks in its otherwise
deny-by-default systemd policy. Its HTTP/2 client completes TLS before it creates
a notification POST. Failures proved to occur before POST retry with the original
identifiers through the event/grant expiry, with a five-minute backoff cap.
Connection-stage restarts can retry; a persisted dispatch with an unknown outcome
remains uncertain. Authorization, phone preferences and token bindings are
rechecked immediately before POST. Queue selection prioritizes eligible work so
older backed-off or unsupported-environment rows cannot block a new ready alert.
These Relay retries use the existing one-day lifetime; legacy direct Core
delivery retains its separate retry bound.

Test the actual service worker and durable queue when checking deployment.
Running a one-off sender with `runuser` does not inherit systemd's cgroup network
filter and cannot establish that the deployed worker can reach Apple. See the
[Relay deployment guide](../../BZZY-RELAY/deploy/README.md).

## Legacy direct Core delivery

Core's daemon reads the existing durable goal notification outbox and sends native
Apple Push Notification service alerts directly from the home host. Relay carries
the encrypted device registration; it never receives the Apple signing key or
provider authorization. Closing/backgrounding iOS does not remove registration.

Implemented events are `goal.completed`, `goal.stalled`, `goal.paused`,
`goal.cancelled`, `goal.waiting_for_input`, `library.skill_created` and
`library.agent_created`, plus `debug.export.completed` and `debug.export.failed`
for explicitly requested detached diagnostic captures. An execution merely ending does not create a verified
goal-completion alert. Titles use `Goal achieved - ALIAS`, `Goal stalled - ALIAS`
or `Input needed - ALIAS` (the alias is omitted if unavailable/unsafe). Completion
and stalled descriptions preview the last assistant reply, capped at **180 Unicode
characters including `...`** when truncated. Core pins the sanitized preview in
the durable outcome event, so delayed delivery cannot substitute a later chat or
goal. Rich emphasis becomes readable text. Debate uses its saved conclusions;
parallel/besties previews label the current group's agents. Missing output uses
a safe blocker or a short open-app message; older queued events retain their
bounded objective fallback. Recognized credential-like text is omitted before
persistence and checked again before dispatch. Input alerts keep commands and
question details out of push payloads. Navigation uses opaque identifiers; full
conversations, files, provider keys and invitation codes are excluded. Tapping an
alert only opens/reconciles an authorized view.

Committed skill and agent creations also queue alerts in the same registry
transaction, including automatic learning, creators and imports. Titles are
`Skill created - NAME` or `Agent created - NAME`, with a sanitized short portable
description or a generic fallback. Instructions, source evidence and account
bindings never enter these alerts. Draft candidates, previews, ordinary edits
and enable/disable changes do not announce a new creation. Delivery rechecks the
creation receipt and current definition; deletion or a later replacement cannot
revive an old queued alert.

Creation alerts require the fully approved own-phone grant and an enabled device
registration. Scoped session/friend registrations cannot receive the host
library feed. Existing iOS navigation hints open Agents or Terminals, optionally
the already-authorized source conversation; they never create or execute work.
The Relay route requires a Relay release supporting the new creation titles and
screen-only library navigation. Older direct Core APNs registrations continue
using the local provider configuration.

Detached full-debug captures queue `Full debug export ready - ALIAS` or
`Full debug export failed - ALIAS` only after Core records a terminal job outcome.
The event is bound to that job receipt and session; altered or imported outbox
text cannot forge a result. Success includes an opaque job ID; failures contain
only the safe export diagnostic. Host output paths, captured files and raw
exceptions are excluded. Only the full own-phone grant may receive these alerts,
and the existing terminal hint opens the authorized saved chat without executing
anything. The Relay server needs the export-title allowlist from this version;
older servers reject these titles. Core/device permissions, expiry, retries and
uncertain-delivery rules remain in force. Stopped Core retains the queued event
until it is explicitly started; the detached export itself can still finish.

Blocked goals, provider usage limits, token/runtime budget limits, acceptance
review, turn limits and interrupted goals requiring recovery all produce the
same `goal.stalled` event. Core writes that event and its outbox record with the
saved outcome, independently of CLI, Relay or iPhone connectivity. Supervision
releases notification deferral if a runner dies before its own cleanup executes.
Saving the same outcome again does not create another alert; an explicit resume
advances the goal's notification epoch so a later stall can notify again.
Manual pauses and cancellations have distinct alerts and are never reported as stalls.

## Host setup

An Apple Developer APNs authentication key, its key ID, your team ID, a correctly
provisioned iOS app with the Push Notifications entitlement, and its exact bundle
topic/environment are required. The implementation follows Apple's
[token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
and [HTTP/2 request contract](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).
Development and production device tokens are distinct; match the app's
`aps-environment` entitlement to the host configuration.

Create the private `push/apns.json` file beneath your actual Core `BZZY_HOME`
(normally `~/.bzzy`). Its exact schema is:

```json
{
  "keyId": "ABCDE12345",
  "teamId": "TEAMID1234",
  "topic": "app.bzzy.ios",
  "environment": "sandbox",
  "signingKeyFile": "/absolute/private/path/AuthKey.p8"
}
```

The IDs above are placeholders. Set `environment` to `production` for a
production-entitled build. Keep both this JSON file and the `.p8` key as regular,
owner-only files (mode `0600`) owned by the non-root Core user; the parent private
directory should be `0700`. Symlinked keys, broad permissions, non-P256 keys,
unknown fields and arbitrary APNs endpoints fail closed. The key is never copied
into an agent/project or configured through a remote RPC. No push is sent until
this valid local configuration and a permitted device registration both exist.

In iOS, explicitly enable notification permission and Activity alerts after
pairing. An observer grant may register for its own session. A host-approved
`sessionAccess: true` catalog grant may register with `scope: "terminals"` to
receive notifications for current and future ordinary CLI terminals without
opening each one. It does not include internal coordinator/worker contexts.
Plain session grants cannot enable catalog-wide alerts.
With `scope: "authorized"`, a base registration may cover both terminal and agent
goal updates, but only for the corresponding locally approved `sessionAccess`
and `agentAccess` flags. An agent-only grant never inherits unrelated terminals.
Agent events require the current nonarchived definition and its pinned workspace
to remain valid. Legacy `terminals` registrations continue to exclude agents.

## Encrypted registration contract

These operations use the existing `bzzy-core` v1 encrypted payload:

| Operation | Parameters | Result |
| --- | --- | --- |
| `notifications.register` | `deviceToken` (64–512 hexadecimal characters, even length), `environment` (`sandbox` or `production`), `enabled` (boolean), optional `scope` (`session`, default, `terminals`, or `authorized`), `hostHints` (boolean) and `relayPush` (boolean; negotiated through `capabilities.notificationsRelayPush`) | `registered`, `enabled`, `providerConfigured`, actual `scope` |
| `notifications.update` | `enabled` (boolean) | Same public state |
| `notifications.revoke` | `{}` | `{ "revoked": true }` |

A scoped `session.get` advertising `capabilities.notificationsHostRouting:true`
allows a new client to send `hostHints:true`. Only opted-in bindings include
`bzzy.hostId` in goal, Agent and update hints. Core derives it from the current
reauthorized registration, never from event/model text or a supplied client host
ID. Old bindings retain the original payload shape so older strict clients keep
working. Collapse and thread identifiers remain scoped by host, device and event;
the same iPhone token and update revision on two Cores do not collapse together.

The authorized local peer/grant/resource determines the recipient and session.
There are no remote topic, endpoint, recipient-ID or arbitrary-message fields,
and no remote send/test operation. Tokens are private host/device binding data;
responses, application events and delivery reports never echo them. The paired
app claims its APNs token; APNs itself does not cryptographically bind that token
to a Relay identity. Local token ownership, scope, capacity and rate controls
limit this surface, and every actual send revalidates the local authorization.

An accepted APNs provider response means Apple accepted the request, not that the
phone displayed it. A missing local APNs configuration or environment mismatch
returns `providerConfigured: false`; it must not appear as working host delivery.

## Delivery and limits

The worker runs in the existing Core daemon, rotates through bounded pages of 200 goal outbox records, sends at most eight per pass, and ignores events older than one
day or before the user enabled that registration. Device/event deliveries are
durably deduplicated, including overlapping session/catalog subscriptions. The
same opaque collapse ID and APNs request ID are retained across explicit APNs
rejection retries. Retry backoff is bounded to eight attempts; network ambiguity
or an interrupted dispatch remains `uncertain` and is never blindly resent.

Expired/revoked grants, revoked device pins or narrower Core tokens, disabled
preferences, private authentication directories and internal contexts stop
future sends. APNs `410`/invalid-device-token responses disable the matching
token registration, respecting a newer device registration timestamp. Already
accepted notifications cannot be recalled. Alias and reply previews can appear on the lock screen; use iOS notification-preview settings to hide them. Other metadata remains private; opaque session/agent IDs only guide navigation, and the app rechecks
permission through authoritative discovery before loading details. Generic alert
titles distinguish completion, waiting for input and attention; opaque thread
identifiers group updates without exposing project names or paths.

Tests in `test/push.test.js` use generated disposable P256 keys and a loopback
HTTP/2 APNs fixture. They verify signatures, headers, strict configuration,
scopes, future-terminal coverage without a phone socket, durable deduplication,
revocation, retry/uncertainty and token invalidation. These fixtures do not establish physical delivery. An authorized sandbox
notification was subsequently accepted through the deployed Relay worker and
confirmed on a provisioned iPhone; see the field scope and limitations in
[VALIDATION.md](VALIDATION.md). This is not production-environment or universal
delivery verification.

## Diagnosing delivery

The CLI's own-phone pairing now lasts 30 days; older pairings were one day.
Source updates preserve the same private identity and grants without extending
their expiry. An expired pairing stops alerts as well as remote controls. Safe
notification status identifies that condition: pair again through CLI Settings,
then reopen the iPhone app to register its current Apple token and preferences.
Never bypass expired/revoked authorization to deliver a queued alert.

Run `bzzy notifications status`, or open CLI Settings → BZZY Core, for safe
configuration/registration/delivery status. Missing or mismatched Apple setup
creates `waiting_for_configuration` records with a fixed reason code, rather
than appearing sent. The daemon retries eligible queued goals after private
configuration becomes valid; it never fabricates an Apple receipt. Goals are
recorded transactionally with saved lifecycle state even when Apple setup is
missing. Completing a goal with a paired phone but missing setup also displays
the setup requirement in the terminal.

Tests cover waiting/setup recovery, rotating scans beyond 1,000 records and
compact alias/objective previews in addition to the existing APNs, authorization
and retry checks. The Relay operator configures Apple signing for the published app environment;
ordinary Core clients do not configure Apple keys. Physical-device delivery
requires separate verification with the phone's permission and current binding.

## Update availability alerts

The Core update watcher uses the same durable outbox and APNs delivery worker for
`system.update_available`. It emits one generic alert per GitHub target revision:
**BZZY update available**. The notification opens iOS Settings and never carries
an install command, source URL, private account binding or executable arguments.
Only the fully approved own-phone base grant can receive these host-wide alerts;
scoped session/friend/Agent grants do not inherit update administration. The
phone's Updates notification toggle and its normal iOS notification permission
must both allow delivery. Queued alerts are skipped once their revision is no
longer the available update. Missing Apple setup remains a visible waiting state.
