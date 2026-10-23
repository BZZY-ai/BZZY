# Existing runtime and iOS connection requirements

Historical source assessment below. The engine now lives in BZZY-CORE/src/engine,
and iOS implements the Core payload handler, mandatory pairing, authorized
terminals/Agents, activity, project-sharing source and APNs registration. See
[current integrated validation](full-line-validation.md) and the product README
for implementation status. Earlier missing-handler/portableSharing statements
below apply to the inspected preview revision, not the current source.

Source assessment on 2026-10-22. The original runtime paths below refer to the existing [CLI runtime](../../BZZY-CLI/BZZY-CLI-TERMINAL/). These findings describe inspected source, not a remote deployment or completed end-to-end validation. No runtime source was changed for the iOS app.

## Product model

BZZY keeps specialized agents as persistent workspaces, available on demand with optional schedules and triggers. The iPhone supervises the same work as the terminal. Models, tools, project access, durable evidence, and account credentials belong on the authorized home host.

The two primary app tabs express different entry points into that shared engine. **Agents** opens purpose-built persistent workspaces. **Terminal** opens existing CLI conversations. They do not create two runtimes. The fly’s expression is interface feedback, not evidence that a host is connected or a goal succeeded.

## Reusable source

| iOS need | Inspected source | Consequence |
| --- | --- | --- |
| Session list and inspection | `src/runtime.js:112`, `:126–151` | Existing `/v1/sessions` and individual-session reads expose state, questions, children, ownership, and capabilities. The scoped list returns the granted root; descendants are obtained through authorized session details. |
| History and live activity | `src/database.js:67–76`, `src/runtime.js:153–174` | Durable event envelopes have IDs, sequence cursors, session identity, timestamps, and payloads. Existing SSE can be adapted by the gateway without terminal scraping. |
| Observation and control grants | `src/session-access.js:5–44`, `src/runtime.js:97–123` | Source goes beyond the older guide’s observer-only description: grants can declare explicit actions, expiry, recipient ID, descendant scope, and revocation. These bearer grants do not establish authenticated paired-device identity by themselves. |
| Input ownership | `src/runtime.js:41–69`, `:178–186` | Leases last 45 seconds and are tied to the authorization principal. Observation must not claim input. Takeover must be explicit and granted. |
| Sending and resuming | `src/runtime.js:188–191`, `src/execution-queue.js:9–29` | Existing execution requests operate on saved sessions. Scoped clients cannot override the environment or host execution options. Goal execution requires an existing goal contract. |
| Questions and controls | `src/runtime.js:193–224` | Answer a pending question by ID; request pause/cancel or supported steering. Resume uses execution semantics, not a new invented `resume` control action. |
| Capabilities | `src/runtime.js:109–111`, `:151` | Capability output explicitly reports `relay: false`, `portableSharing: false`, and `backendReadConfidentiality: false`. Active steering is limited to the supported individual Codex chats. |
| Outcome basis | `src/verification.js:48–103` | Acceptance records distinguish evidence/check-based assessment from model judgment. Contract-free legacy completion and model-judgment criteria are not independent verification. |
| Notifications | `src/notifications.js`, `src/notification-registry.js` | A reusable transport/outbox foundation exists. The inspected notification transport is Telegram, not APNs. |

The source’s `/v1/capabilities`, grant listing, and grant revocation are newer than the inspected `docs/INTEGRATION.md` route table. Reinspect source before implementing a Swift contract; do not copy the guide’s omissions into the client.

## iOS client implementation update

The native client now implements Relay challenge authentication, device-only Keychain identity, PAIR QR/code review, fingerprint confirmation, approval polling, pinned grants and encrypted routing validation. Swift ↔ Node crypto and the deployed public candidate handshake have been verified. This does not change the CLI capability flags. Subsequent inspection found the Core gateway at `BZZY-CORE/src/relay/gateway.js` and the `bzzy-core` v1 contract in `BZZY-CORE/docs/RELAY-PROTOCOL.md`; iOS payload integration is pending. That gateway advertises `portableSharing: false` and has no package transfer operations. See [client status and notification dependencies](relay-and-notifications.md).

The native UI first asks Scheduled or On demand when creating an agent. Its interval and instructions remain local inactive drafts. Native notification permission, APNs registration callbacks and privacy-safe navigation are present; host APNs registration/provider delivery remains a Core dependency.

## Connection work still required

The local runtime binds to loopback. An iPhone must not solve remote access by receiving its owner token, changing the listener to a public address, or treating TLS to Relay as application encryption.

The following are dependencies for live iOS functionality, not endpoints added by this work:

- Integrate and end-to-end validate the existing Core device-scoped gateway contract in the iOS client. The gateway source exists; this app currently installs no Core payload handler.
- End-to-end validation of the implemented iOS identity/pairing/Relay client with a real host, including the existing Core device-to-runtime authorization bridge. Existing session bearer grants alone do not supply that bridge.
- Stable resources for agent definitions, creating conversations, agent configuration, runs, host project selection, capability review, and private account bindings. These are not exposed by the inspected session router.
- Host-authoritative capability and model discovery. A mobile picker cannot change models through scoped execution-option overrides, which the runtime denies.
- Authorized artifact/evidence retrieval with redaction and bounds. Event evidence IDs and host file paths are not downloadable iPhone artifacts; the inspected public router has no general artifact-download route.
- APNs registration and delivery, notification preferences, deduplication, and in-app authorized detail fetch. Keep private content and invitation codes out of push payloads.
- Host portable package validation/transfer/import operations and explicitly scoped live grants. Native Share/Import screens and isolated demo copies are implemented; see [sharing status](sharing.md). No invitation URLs. An imported copy connects its recipient’s own host and accounts and remains inactive until reviewed.

These dependencies belong to their existing products. This iOS-only change neither implements them elsewhere nor creates replacement services.

## Client behavior when live transport is added

Persist projections and the **processed** event cursor together, scoped by host identity and session UUID. Sequences can have gaps. Upsert activity by record ID and deduplicate events by event ID. Separate group and child cursors; safely ignore unknown event types while advancing after successful envelope handling. A filtered stream cannot stand in for a complete shared projection.

Opening, foregrounding, or reconnecting only fetches state and replays observations. Never execute a saved draft or replay a side-effecting operation automatically. Explicit submission uses a durable request ID and identical payload on an authorized retry. A lost response remains uncertain until authoritative reconciliation; idempotency does not make external effects exactly once.

Show command acceptance separately from its eventual result. Steering waits for observed/failed control events. Display execution status, goal status, acceptance basis, provenance, and evidence independently. Unknown token usage stays unknown, not zero or a fabricated monetary cost.

On lost authorization, end subscriptions and disable control. Revalidate access to cached private views and define cache deletion on revoke/unpair. Keep device keys in Keychain; provider/account secrets remain on the host. All future AI-assisted behavior generation must apply the exact reusable preprompt from [SECURITY.md](../../SECURITY.md), backed by runtime policies.

## Apple platform behavior

Animation uses SwiftUI timelines and stops outside the active scene; Reduce Motion keeps the mascot still. See Apple’s [TimelineView](https://developer.apple.com/documentation/SwiftUI/TimelineView) and [Reduce Motion environment](https://developer.apple.com/documentation/swiftui/environmentvalues/accessibilityreducemotion).

The voice draft implementation uses public native speech APIs, checks on-device support, and offers typing when recognition is unavailable. Future SpeechAnalyzer/SpeechTranscriber adoption must check actual device and locale support; Apple documents runtime availability checks in [SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber).

Backgrounding suspends the iOS interface rather than the host execution. The live client must reconcile on return and use privacy-safe notifications for relevant updates. See Apple’s [background UI lifecycle](https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background) and [remote notification payload guidance](https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification).
