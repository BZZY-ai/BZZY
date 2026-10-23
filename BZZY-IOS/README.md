# BZZY native iOS

Native Swift/SwiftUI, iOS 17+, with **Agents** and **Terminal**. The home screen centers the fly eyes. The updated mascot follows `new changes/new-eyes.jpeg`, drawn in Canvas with close cyan lenses, inward pupils, highlights and swept antennae; no reference bitmap is loaded or bundled. It blinks, glances, hovers and follows touch. Motion pauses in the background and respects Reduce Motion.

## Run

Open [BZZY.xcodeproj](BZZY.xcodeproj), select **BZZY** and an iPhone simulator, then Run. Simulator runs use Xcode’s local signing; do not disable signing when testing Keychain. For a physical iPhone, select your Apple development team. Push notifications require a push-enabled App ID and a matching provisioning profile. Debug uses the development APNs environment; Release uses production.

The current device test uses **Debug 0.1.0 (4)**, installed directly through Xcode tooling on the connected iPhone 15 Pro Max and launched normally, preserving app data and pairing. TestFlight is deferred and is not required for this test. Installation/launch alone does not verify microphone recognition or real APNs delivery.

The local `RelayKit` Swift package pins [swift-sodium](https://github.com/jedisct1/swift-sodium) at `cfd195c76882aa9b997560ca7cb95d72fbf5db00`. Xcode resolves it automatically. No provider SDK or second agent runtime is added.

```sh
xcodebuild -project BZZY.xcodeproj -scheme BZZY \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath .build/Xcode CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES \
  COMPILATION_CACHE_ENABLE_CACHING=NO COMPILER_INDEX_STORE_ENABLE=NO build
```

## Agent creation

First launch offers **Pair** before the main interface. Successful host approval and Core authorization unlock the app. Revoked or invalid authorization returns to pairing; a previously validated pairing can reconnect without creating or replaying work.

For the current manual setup, create at least one CLI terminal with `bzzy`, then open **CLI Settings → Pair iPhone** on the Mac. Its QR/code appears automatically without choosing a terminal. It requests full session control, terminal catalog access, project sharing and Agent management; there are no permission/scope choices. Scan the compact QR directly from the 80x24 TUI or enter the expiring code on iPhone. Confirm the host on iPhone, then choose **Compare and approve iPhone…** on the Mac, compare **This iPhone** with the displayed fingerprint, and choose **Fingerprints match · Pair iPhone**. Expiry and revocation remain available on the secondary pairing screen. The user performs these steps.

After pairing, **Core offline** or **Connecting to Core** locks Agents, Terminal, open chats, Activity and Core actions. Relay connectivity alone does not unlock them. Authorized foreground heartbeats confirm Core readiness; brief inactive overlays such as Notification Center keep a healthy authenticated subscription; actual outages and backgrounding clear live usage and disable sending, control, agent changes and sharing. Pairing, cached history and uncertain command IDs remain saved. Reconnect only reads state and restores observation.

Terminal lists show only sessions with a nonblank `/alias`, ordered by most recent saved activity. Unnamed sessions remain in Core. A failed CPU/RAM read checks an authorized session heartbeat before reporting Core offline; closing CLI only releases its input lease.

With explicit host `agentAccess`, Agents lists real persistent Core records. Create an on-demand agent, choose its Core-discovered provider/model/effort and instructions, then open its chat/activity, edit it while idle or archive it. Workspaces are created beneath Core's configured BZZY root. Creation/opening does not start inference. Account bindings are configured privately on the host. Scheduling is currently unsupported and is never simulated as active.

Existing local drafts remain labelled inactive. Samples and demo sessions are limited to previews/UI tests. Opening a conversation, foregrounding, reconnecting or opening a notification never submits a draft or starts work. Agent management lives in iPhone; CLI stays terminal-oriented.

## Chat and response formatting

Every agent and terminal example opens the same native chat: turquoise user bubbles on the right, dark assistant bubbles on the left, with a compact header and composer. COOL, Signal, Subscriptions, Design review and Research contain fictional conversations. The examples demonstrate native tables, normal/bold/italic text, three text sizes, colored highlights, lists, quotes and literal code blocks. Sending in a Demo chat adds a predefined local reply. Created agent drafts remain separate and never receive these fake responses.

Hold the microphone beside Send to dictate using on-device Apple Speech. Partial results update the message field as available; release stops audio and briefly awaits final words. Existing typed text is preserved, and the result stays editable until the user presses Send. Unsupported languages/denied permissions keep typing available. Backgrounding, navigation and lost authorization cancel capture; releasing during a permission prompt cannot start a late recording.

[message_format.txt](message_format.txt) is the versioned body-format contract to pass to BZZY-Core. Responses remain strings, with a small XML-compatible HTML-like vocabulary inside `<message version="1">`. The app translates it into SwiftUI views. Plain text and basic inline Markdown also work. No WebView, CSS or remote asset loading is involved. Malformed/unsupported rich content falls back to bounded plain text. Tables scroll horizontally and text respects Dynamic Type. Formatting is presentation, separate from runtime permissions and verified outcomes.

The mascot's gaze uses gradual easing and a speed limit for touch, idle glances and return motion. New touch targets and background/resume no longer move the pupils instantly across the face.

## Relay connection

The app implements the deployed `bzzy-relay.v1` transport through the configured Relay endpoint, using ordinary system TLS/IP-SAN validation and ATS. It generates independent signing/encryption keys and stores the device identity and host binding in device-only Keychain records. It supports signed challenges and presence, candidate authentication, PAIR QR scanning/pasting, typed expiring codes, full host fingerprint comparison, explicit host confirmation, approval polling, pinned host certificates, scoped grant inspection and revocation handling.

The transport uses wire-compatible Curve25519/XSalsa20/Poly1305 boxes with 24-byte nonces. It validates routing identities, grants, socket epochs, expiry and replay before acknowledging delivery. Requests and buffers are bounded. Reconnect only restores transport and reads authorization state. Uncertain claims are never automatically retried.

The app uses the strict encrypted `bzzy-core` v1 contract for actual Core state. Approved terminal catalog access shows running and historical CLI sessions with their original directories. iPhone opens existing sessions and can view, resume and interact according to its grant; it never creates terminals or browses arbitrary host folders. Separate immutable resource clients retain raw history, independent cursors and uncertain-command IDs. Chat and a quick Activity view show actual execution, goal, question, evidence and tool events. Core owns the gateway independently of CLI lifetime. The installed Mac Core and production Relay passed a disposable native observer check. Manual phone pairing and its live behavior remain the next checks.

After authorized Core pairing, a compact status bar shows the execution host's actual CPU and used/total RAM. Foreground reads update about every two seconds from Core's cached sampler; CPU is unknown during initial warmup. Scope changes, disconnects and backgrounding cancel reads and clear the display. These are host measurements, never the phone's CPU/RAM.

The initial Relay protocol has no forward secrecy/ratchet and has not received an independent cryptographic audit. See [the iOS integration notes](docs/relay-and-notifications.md) and [runtime assessment](docs/runtime-assessment.md).

## Share and Import

With explicit `shareAccess`, a live terminal's Share action asks Core to package the actual project and full BZZY context. A live Agent requires both `agentAccess` and `shareAccess` and uses `BZZY-AGENT-...`. Both transient sheets display a QR/temporary code, the complete source fingerprint, recipient fingerprint approval and revocation. Codes/QR values are cleared on dismissal, backgrounding and expiry, and never enter durable chat or logs.

For terminals, the recipient uses `bzzy --import CODE` or `/import` in CLI to restore into that CLI's current directory. For Agents, iPhone's **Import agent** scans/pastes the invitation, requires complete sender fingerprint comparison, and selects the receiving Core's own provider/model/effort. Core receives and validates project files, full chats, notes, memory, goals, nested relationships and evidence, then restores a fresh idle Agent beneath its managed Agents root. Imported work is paused, account bindings/permissions remain separate, and opening it never starts inference. The phone shows the temporary recipient fingerprint for the sender's explicit approval; refresh/cancel and saved job-ID reconciliation survive ordinary outages. Codes and bundle bytes are never persisted on iPhone. A completed Core `importId` receipt can recover a transfer after helper restart without receiving it twice.

Both Cores must stay online during transfer. Imported identities/paths are remapped, credentials excluded and existing files protected. The public Relay must support the transfer quotas/lifetime; see [project sharing](../BZZY-CORE/docs/PROJECT-SHARING.md). Mobile terminal import and scheduled Agent activation remain unsupported. Legacy demo import is preview/test behavior and cannot substitute for live production import.

## Host updates

Settings → BZZY Updates shows the authoritative Core update status. The fully approved own phone can enable monitoring, update notifications and remote installation, check GitHub, and explicitly confirm the displayed CLI/Core revision. An update notification only opens Settings. Installation uses a durable Core helper; work is paused and the phone reconnects to inspect the result. Remote installation starts disabled and cannot be enabled by scoped friends or Agent/session contexts. Unknown acceptance retains its request ID for an explicit same-request retry. These controls require the updated iOS binary; they do not install the phone app itself.

## Notifications and voice

Settings → Notifications requests native alert/sound/badge permission only when **Enable notifications** is tapped. It shows current permission, an Activity alerts toggle, an iOS Settings shortcut and an explicit test notification. Native notification taps select an allowlisted screen and reconcile state; they never execute commands. Verified pairing approval/revocation can emit generic local alerts. No private content or pairing codes enter notifications.

APNs registration is sent through the encrypted Core contract. The daemon uses the durable goal outbox for generic completion, attention and input-needed alerts while the app is closed. Exact session or explicitly approved terminal/Agent scopes apply, with expiry/revocation, deduplication and bounded retries. Taps recheck authorization and navigate without executing. **Actual background delivery requires Apple provisioning, private host APNs configuration and a physical-device test.** Missing configuration is reported as pending, never as working delivery. See [host push setup](../BZZY-CORE/docs/PUSH.md).

Voice drafts use Apple Speech and AVFoundation with English/Spanish selection. Recording requests microphone/speech access only after a tap and requires supported on-device recognition. Otherwise text remains editable. Capture stops on dismissal/backgrounding. Physical-device permissions and transcription accuracy still need validation.

## Verification

Current integrated validation (2026-10-23): 38 Swift tests cover the real Core daemon/Relay/native-client line, Agent CRUD/run, full-context Agent transfer/import, terminal sharing, push registration, telemetry and offline locking. The Agent transfer preserves rich chat and historical executions with new IDs and no new inference. Operator-stop/restart recovers read-only. All 12 Debug UI tests passed in the full first-version run; targeted offline/pairing regressions and the separate Release production-pairing test pass after later updates. Model/security/format checks also pass. Release build **0.1.0 (2)** is prepared with production APNs metadata and required-reason privacy declarations; it has not been uploaded to TestFlight. A separately signed **Debug build 2** was installed and normally launched on the physical iPhone, with development APNs, matching provisioning and no demo/test arguments. Data and Keychain were preserved. The user owns the pending manual pairing; live phone/Core and APNs behavior are not yet verified. See [full-line results, stability evidence and limits](docs/full-line-validation.md). Earlier preview/UI records below describe their historical, narrower scope.

`zsh tools/check.sh` checks model persistence/migration and isolation, Relay crypto and malformed input rejection, then renders native macOS layout previews. Swift ↔ Node interoperability uses only disposable test identities and the neighboring Relay reference runtime; it skips if that source is absent. The native SwiftPM test backend avoids an exFAT AppleDouble signing failure in the default macOS test backend.

```sh
xcodebuild -project BZZY.xcodeproj -scheme BZZY \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath .build/Xcode -collect-test-diagnostics never \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES COMPILATION_CACHE_ENABLE_CACHING=NO \
  COMPILER_INDEX_STORE_ENABLE=NO test
```

Ordinary UI checks isolate local workspace data and disable Relay networking and permission requests. The dedicated notification test explicitly enables the system permission flow in the simulator. The Relay diagnostic checks public candidate authentication and an isolated disposable Keychain record, without claiming invitations or touching the app device identity. No microphone/audio capture occurs in tests.

Verified on 2026-10-22: six Relay unit/interoperability tests, local model checks, and all six native iOS UI/integration tests pass. The signed iPhone 17 Pro simulator uses iOS 26.2. This covers both tabs, type-first agent creation, scheduled intervals/inactive status, persistence after relaunch, accessibility text, notification permission/delivery/tap, public Relay authentication and isolated Keychain storage. The Relay integration test requires internet access. Results: `.build/FinalSignedIOS.xcresult`, `.build/final-signed-ios-tests.log`, `.build/final-native-checks.log`.

Local validation generates simulator screenshots and native macOS layout
previews under `previews/`. These generated artifacts are excluded from source
control; macOS layouts are not iOS screenshots.

Chat update verification (2026-10-22): both rich chat UI checks pass on iOS 26.2, including local demo sending, agent/terminal bubbles, table/code rendering and accessibility text. Draft/relaunch regression also passes. Model checks cover mixed-role persistence without duplicated sample history, rich markup validation/resource bounds, and a speed-limited gaze with no opposite-side touch jump. Current artifacts: `.build/FinalRichChat.xcresult`, `.build/ChatDraftRegression.xcresult`, `.build/rich-chat-checks.log`.

Share/Import verification (2026-10-22): seven Relay unit/interoperability tests and local model/parser/gaze checks pass. Five relevant iOS UI checks pass across `.build/ShareImportVerified.xcresult` and `.build/ShareFinalIOS.xcresult`: both demo transfer flows, purpose rejection and unredeemed real-code handling, imported chat persistence, large-text sharing/import, draft relaunch and scheduled-agent details. A rendered QR was decoded from the native iOS screenshot. Model checks also cover expiry, revocation, replay rejection, immutable definitions, capacity and failed-save rollback. Native check log: `.build/share-final-checks.log`. This verifies the local demo and invitation validation, not an actual Relay package transfer.


Pairing fix (2026-10-23): Debug build 3 is installed on the connected iPhone.
Compact PAIR QR parsing preserves the pinned fingerprint and accepts legacy QR
and manual codes. Approval polling now lets its loop finish without cancelling
the Core connection it is starting. All 42 native Swift tests pass, including
actual RelayConnection event/polling/background recovery with full permissions
and an unset coordinator. These fixtures are isolated; the user performs the
real phone pairing. The terminal-rendered 80x24 QR also decoded exactly in Apple
Vision. No app data or device identity was reset.
