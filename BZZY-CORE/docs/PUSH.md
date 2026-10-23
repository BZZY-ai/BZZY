# Goal notifications through APNs

Core's daemon reads the existing durable goal notification outbox and sends native
Apple Push Notification service alerts directly from the home host. Relay carries
the encrypted device registration; it never receives the Apple signing key or
provider authorization. Closing/backgrounding iOS does not remove registration.

Implemented events are `goal.completed`, `goal.stalled` and
`goal.waiting_for_input`. An execution merely ending does not create a verified
goal-completion alert. The payload contains generic text and opaque navigation
identifiers, never the objective, conversations, files, email, provider keys or
invitation codes. Tapping an alert only opens/reconciles an authorized view.

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
| `notifications.register` | `deviceToken` (64–512 hexadecimal characters, even length), `environment` (`sandbox` or `production`), `enabled` (boolean), optional `scope` (`session`, default, `terminals`, or `authorized`) | `registered`, `enabled`, `providerConfigured`, actual `scope` |
| `notifications.update` | `enabled` (boolean) | Same public state |
| `notifications.revoke` | `{}` | `{ "revoked": true }` |

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

The worker runs in the existing Core daemon, scans at most 1,000 recent goal
outbox entries, sends at most eight per pass, and ignores events older than one
day or before the user enabled that registration. Device/event deliveries are
durably deduplicated, including overlapping session/catalog subscriptions. The
same opaque collapse ID and APNs request ID are retained across explicit APNs
rejection retries. Retry backoff is bounded to eight attempts; network ambiguity
or an interrupted dispatch remains `uncertain` and is never blindly resent.

Expired/revoked grants, revoked device pins or narrower Core tokens, disabled
preferences, private authentication directories and internal contexts stop
future sends. APNs `410`/invalid-device-token responses disable the matching
token registration, respecting a newer device registration timestamp. Already
accepted notifications cannot be recalled. Alerts are generic even on the lock
screen; opaque session/agent IDs only guide navigation, and the app rechecks
permission through authoritative discovery before loading details. Generic alert
titles distinguish completion, waiting for input and attention; opaque thread
identifiers group updates without exposing project names or paths.

Tests in `test/push.test.js` use generated disposable P256 keys and a loopback
HTTP/2 APNs fixture. They verify signatures, headers, strict configuration,
scopes, future-terminal coverage without a phone socket, durable deduplication,
revocation, retry/uncertainty and token invalidation. Actual background delivery
on a provisioned physical iPhone remains unverified until tested with the
owner's Apple configuration and permission.
