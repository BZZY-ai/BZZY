# iOS Relay and notifications

Current Core payload integration, mandatory Pair, terminal/Agent resources and
encrypted APNs registration are implemented. See [current full-line validation](full-line-validation.md)
and [host APNs setup](../../BZZY-CORE/docs/PUSH.md). The earlier implementation
record below predates the payload handler and provider worker; its pending-work
statements are historical. Real-device/Apple background delivery still requires
provisioning and actual validation.

## Verified and pending

| Area | Status |
| --- | --- |
| Public endpoint TLS, WebSocket subprotocol, challenge, signed candidate auth, scoped empty grant list | Verified with native Swift `RelayProbe` on macOS and a locally signed iOS simulator build, using disposable in-memory identities |
| Ed25519 certificate binding, crypto_box interoperability both ways | Verified against the existing Node Relay identity module using disposable test identities |
| Canonical base64url, identity substitution, wrong peer, modified ciphertext, QR purpose/endpoint/expiry, presence binding | Automated rejection checks |
| Message route, socket epoch, expiry, replay and capacity | Automated rejection checks for pure validation; live granted routing remains pending |
| Keychain identity and pinned binding | Device-only write/read/identity validation verified with an isolated disposable record on the signed iOS simulator; real-device relaunch/protected-data lifecycle remain pending |
| PAIR QR scanner, typed code, fingerprint confirmation, approval polling, grant reconciliation/revocation | Implemented; requires an explicitly provisioned real host for end-to-end verification |
| Core sessions, commands, agent definitions/schedules, authoritative activity/cursors | Core gateway and `bzzy-core` v1 contract now exist; iOS payload integration is pending |
| Agent/terminal Share and Import | Native screens, QR/code validation and inactive local demo copies; actual host transfer unavailable (`portableSharing: false`); see [sharing](sharing.md) |
| Native notification permission, local delivery, foreground display and tap routing | Verified local permission, banner delivery and tap navigation in the iOS simulator; results are recorded in `.build` test artifacts |
| Background APNs host delivery | Requires Apple signing/provisioning and Core registration/provider integration; not end-to-end verified |

Run the transport probe independently:

```sh
swift run --build-system native --disable-index-store --scratch-path .build/relay-package RelayProbe
```

It never provisions a host, claims a code, reads Keychain or exposes keys/frames. A candidate socket passing authentication proves only transport readiness.

The simulator Keychain check requires local app signing (`CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES`). Disabling signing omits the application identity entitlement and Keychain correctly fails closed. This is not handled by weakening device identity storage or moving keys to a file.

## Trust and lifecycle

Real invitation QRs are accepted only with `BZZY:INVITE:1:` and the published Relay endpoint. Import additionally accepts the deliberately separate `BZZY:DEMO:1:` format for local immutable samples; these codes never go to Relay. Pairing rejects AGENT/TERMINAL imports and ordinary URLs. A typed PAIR code also requires the complete host fingerprint. The user must compare the full host fingerprint against a separately trusted host display before claiming. The host must compare and approve the exact phone certificate. A signature on an unverified QR is not independent identity proof.

Codes exist only in the transient secure input and private pairing preview. Pending claim metadata and confirmed pins are stored in Keychain; raw invitation codes and private keys never enter drafts/preferences/logs/notifications. Keychain read failure does not regenerate the device identity. A lost claim response stays uncertain; obtain a fresh host code after checking the host rather than retrying automatically.

Backgrounding disconnects the socket. Foregrounding authenticates with a fresh epoch, checks pending approval and revalidates the binding. It never resends an application command. Revocation clears the active binding and disables host status; no remote session cache currently exists. Forget host removes local trust and pending pairing; it is not a server-side revocation of an already issued grant.

The internal transport accepts no host/admin operations. PAIR authorization is not a shell/runtime permission. The Core gateway must separately bind a verified device certificate to exact runtime principals, resource scope and actions. Reuse the existing CLI engine and its durable event/command behavior; do not expose its owner token or loopback API publicly.

## Notification integration contract still needed

The iOS notification envelope is a proposed minimal navigation hint, not a deployed Core payload schema:

```json
{"aps":{"alert":{"title":"BZZY","body":"An update is available."},"sound":"default","category":"BZZY_UPDATE"},"bzzy":{"v":1,"eventId":"opaque-event-id","destination":"agents"}}
```

Allowed destinations: `agents`, `terminal`, `connection`. Unknown destinations, extra `bzzy` fields, commands and URLs are rejected for app navigation. A tap never means an action was approved, a goal succeeded or an agent should run. Fetch authorized authoritative details in-app. The APNs sender must use generic fixed text with no account data, email, files, transcripts, pairing codes or secrets in `aps` or custom fields. The OS can display a remote alert before app validation, so privacy must also be enforced by the provider.

For actual background host delivery:

1. Select a paid Apple Developer team, enable Push Notifications for `app.bzzy.ios` and use a matching physical-device profile. The target contains the Push capability and an APNs environment entitlement: development for Debug, production for Release.
2. Implement the Core device-scoped APNs registration/update/removal contract, distinct from Relay grants. Registration tokens are not account credentials, but are private device identifiers. The current registration callback deliberately does not persist, log or upload them; APNs registration is repeated on future launches/foregrounds after permission is granted, allowing the later gateway integration to receive the current token.
3. Keep the APNs signing key, Apple team/key identifiers and provider authorization on the host/provider. Never put the APNs private key in the app, Relay, a QR, a model prompt or repository.
4. Reuse the host notification outbox for supported event types and preferences. Deduplicate provider sends by authoritative event ID; handle APNs invalidation/token rotation; clear registrations on unpair/revoke. Per-agent preference synchronization and durable authorized event cursors need the Core schema. The current native master preference and bounded tap deduplication are not that host outbox.
5. Validate foreground/background/terminated delivery and tap reconciliation on a signed physical device. iOS does not guarantee a continuously connected WebSocket while suspended. Do not use a phone timer as an agent scheduler.

References: Apple [notification permission](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications), [APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns), and [payload guidance](https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification).
