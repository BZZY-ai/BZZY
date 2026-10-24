# BZZY native iOS

Native Swift/SwiftUI, iOS 17+, with **Agents** and **Terminal**. The home screen displays the supplied two-eye artwork with its original texture and silhouette, paired with a complete single-eye app icon and celeste controls. Local pixel distortion animates the pupils and antennae without blinking, pauses in the background and respects Reduce Motion.

Build **Debug 0.1.0 (17)** adds multiple saved Core computers. The celeste computer
selector stays visible in chats and offline, with **Set default**, rename, add and
remove actions. The default opens on a fresh app launch; explicit switches stay
in place during that app session, including brief inactive overlays. Pairing a
second computer preserves the first, and switching changes observation only:
Core tasks continue on their original computer.

Host authorization and pending receipts remain separate in device-only Keychain;
protected host-scoped files cache catalogs/history, and typed drafts are scoped by
host and conversation. Current single-host authorization migrates in place. The
active computer is always named so test and production conversations stay distinct.
New host-aware push hints open the correct saved computer after authentication;
unknown or ambiguous legacy hints cannot silently route to another host.

Pair each computer using its own CLI fingerprint approval. Each Core needs its
own initial Relay host enrollment and provider setup; adding a phone profile does
not enroll an arbitrary server or copy provider credentials. Keep the production
Core separate from a transport-only Relay if Relay compromise must not expose
Core's keys or chat storage. See [multiple computers](docs/MULTIPLE-COMPUTERS.md).

The signed build 17 passed development APNs entitlement, privacy and signature
checks, was installed in place on the connected iPhone, and launched successfully.
CoreDevice confirmed **0.1.0 (17)**. Validation: **82 native Swift tests**, model
and message-format checks, **241 Core tests**, four targeted Debug UI regressions
and a separate visual readiness check pass. Multi-host transport tests run two
isolated Core instances on one local Relay, including migration, default selection,
offline behavior, continued work, global notification preferences and revocation.

Build **Debug 0.1.0 (16)** follows Core's saved-chat deletions. A CLI deletion
removes that terminal from the iPhone list after authenticated catalog revision
synchronization. Deleting a terminal that originally anchored phone pairing keeps
that pairing and access to other terminals and Agents. Confirmed deletion clears
that conversation's phone cache and closes its open view. Cached live-session
fallback rows cannot recreate a terminal absent from an authoritative catalog.
Update Core/CLI through the CLI updater to enable saved-chat deletion and catalog
revision discovery; older Core versions retain their existing behavior.
The signed build 16 passed development APNs/privacy/signature checks and was
installed in place on the connected iPhone; CoreDevice confirmed **0.1.0 (16)**.
Automatic launch was blocked by the phone lock. App data and pairing were kept.
Validation: 76 native Swift tests, model/format checks and targeted offline/keyboard
UI regressions pass; Core has 239 passing tests, and CLI has 438 passing tests plus
21 existing platform skips. Deletion tests use isolated synthetic chats.


Build **Debug 0.1.0 (15)** repairs conversation attachment and receipt recovery.
Readiness belongs to the visible conversation: changing terminals waits for that
exact scoped attachment and retries observation after reconnect. An unresolved
send in another terminal keeps its own durable receipt without disabling this
conversation. Reconnecting never automatically resends model work.

The private iPhone cache now keeps a bounded recent tail with display-only
snapshot metadata. Reopening shows cached messages before the network response;
the forward subscription fetches missing events and deduplicates their exact IDs.
New conversations can bootstrap from the latest page, and scrolling back fetches
older pages from Core without advancing the live acknowledgment cursor. Only the
latest 200 projected messages render initially. Reading older history stays in
place while new text streams; **Latest** returns to the current tail. Core remains
the authoritative full history. Revoking/forgetting a host removes its cache.
Older Core versions retain their forward-replay fallback; update Core through the
CLI updater for newest-first history and oversized-event chunk transfer.

The native transport matches Relay's separate bounded PAIR data budget, coalesces
concurrent fresh inspections and reconnects on transient receipt failures instead
of silently consuming a delivery. Keys, runtime authorization and processed ACKs
remain separate from cached display data.

Signed build 15 passed development APNs/privacy/signature checks, was installed
in place on the connected iPhone, and launched successfully. CoreDevice confirmed
**0.1.0 (15)**. App data and pairing were preserved. See the
[connection and history validation record](docs/connection-history-validation.md).

Build **Debug 0.1.0 (14)** keeps the paired workspace visible while offline.
A small bottom **Online/Offline** indicator uses an authenticated Core response
through Relay, with an eight-second monotonic lease and immediate invalidation
on disconnect/failure. A connected Relay socket or cached catalog cannot turn it
green. Core actions disable offline and re-enable on confirmed reconnection;
Refresh actively reconnects instead of silently returning. Viewing another
terminal no longer waits for an unrelated message receipt. Settings and Refresh
remain accessible. The previous full-screen Core disconnect shield is removed.
The eyes now make short, fast gaze darts followed by stationary pauses, checking
different directions rather than drifting continuously. Touch tracking remains
smooth, the eyes never blink, and Reduce Motion/background pausing still apply.
The signed build 14 passed development APNs/privacy/signature checks and was installed and launched on the connected iPhone.

Build **Debug 0.1.0 (13)** preserves the CLI's assistant-message boundaries in
live and saved conversations. Different item/turn identities and tool/approval
boundaries create separate bubbles; deltas belonging to one reply stay together.
Interleaved peer replies retain their own bubbles. Reconnecting rebuilds the same
stable messages from the existing raw events without replaying model work.
The single-eye icon is now a complete, centered emblem with deliberate padding;
see the [artwork and generation prompt](docs/app-icon-artwork.md).

## Run

Open [BZZY.xcodeproj](BZZY.xcodeproj), select **BZZY** and an iPhone simulator, then Run. Simulator runs use Xcode’s local signing; do not disable signing when testing Keychain. For a physical iPhone, select your Apple development team. Push notifications require a push-enabled App ID and a matching provisioning profile. Debug uses the development APNs environment; Release uses production.

Build **Debug 0.1.0 (12)** adds compact **Set goal** and **Resume goal** chat
shortcuts. Set goal preserves typed text, inserts the green `/goal` prefix and
focuses the same editor with the cursor at the end. Resume stays disabled unless
an authorized Core snapshot reports an idle stalled goal. It binds the action to
that goal's exact ID; a changed/active/completed goal is rejected by Core.
Update Core through the CLI to enable the new stalled-only resume capability.

Build 11 added Core-coordinated input, persistent outgoing
message states and explicit Retry. CLI/Core must also be updated through the CLI
updater to enable this path. The iPhone binary is built and installed separately;
the CLI updater does not replace iOS. Builds 9–10 introduced goal submission and
replacement confirmation; build 11 replaces their client lease handling with
Core-owned admission. TestFlight is deferred.

The signed build 13 passed development APNs/privacy/signature artifact checks
and was installed in place on the connected iPhone. CoreDevice confirmed
**0.1.0 (13)**. Automatic launch was blocked by the phone lock; opening the
installed app remains a device check. App data and pairing were preserved.

Build 7 previously added send-on-release, fluid 64-band audio, independent
speech-language settings and alias-only terminal rows to build 6's animated
artwork and visual polish.

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

After pairing, the workspace stays visible offline with its bottom status indicator. Core-dependent Agents, Terminal and chat actions remain disabled until a fresh authorized Core response; cached history remains readable. Relay connectivity alone does not unlock them. Authorized foreground heartbeats confirm Core readiness; brief inactive overlays such as Notification Center keep a healthy authenticated subscription; actual outages and backgrounding clear live usage and disable sending, control, agent changes and sharing. Pairing, cached history and uncertain command IDs remain saved. Reconnect only reads state and restores observation.

Terminal lists show only sessions with a nonblank `/alias`, ordered by most recent saved activity. Unnamed sessions remain in Core. A failed CPU/RAM read checks an authorized session heartbeat before reporting Core offline; closing CLI only releases its input lease.

With explicit host `agentAccess`, Agents lists real persistent Core records. Create an on-demand agent, choose its Core-discovered provider/model/effort and instructions, then open its chat/activity, edit it while idle or archive it. Workspaces are created beneath Core's configured BZZY root. Creation/opening does not start inference. Account bindings are configured privately on the host. Scheduling is currently unsupported and is never simulated as active.

Existing local drafts remain labelled inactive. Samples and demo sessions are limited to previews/UI tests. Opening a conversation, foregrounding, reconnecting or opening a notification never submits a draft or starts work. Agent management lives in iPhone; CLI stays terminal-oriented.

## Chat and response formatting

The top-left heading reads **BZZY** in the shared strong celeste accent.
The native composer highlights `/goal` inline in green while keeping one text
editor, selection and keyboard. Sending `/goal <objective>` enters Core's goal
lifecycle and durable notification path. If another goal is active, verifying or
paused, **Replace current goal?** offers No/Yes; confirmation binds to that exact
goal ID. No preserves the existing goal and input. Resume uses the saved checkpoint.

With updated Core, iPhone streams the session and submits explicit input through
Core's admission coordinator. No preclaim/lease-renewal loop or second permission
dialog is needed. Existing host-approved claim/takeover/execute permissions are
still enforced. CLI stays open and receives the same reply; either client can
continue by sending its next input. Old Core retains its legacy lease controls.

Outgoing messages appear gray while sending and turn teal after authenticated
Core admission. Failed/uncertain messages offer **Retry**. Private local storage
preserves their exact request IDs and parameters across backgrounding/relaunch.
Retry first reconciles the receipt; uncertain delivery uses the original ID,
while a definitive rejection permits a new ID. Reconnect never sends messages
automatically. A matching Core event can confirm admission if the response was
lost, and event replay cannot create duplicate chat bubbles. Admission does not
mean the execution or goal succeeded. See [Core's input contract](../BZZY-CORE/docs/SESSION-INPUT.md).

Validation includes a real loopback Relay/Core and attached CLI, bidirectional
handoff across the former renewal intervals, exact-ID retries, scope denial,
reply replay and native keyboard checks. These isolated fixtures do not claim
production APNs delivery. All 61 native Swift tests, model/format checks and the
simulator typing/deleting `/goal` keyboard test passed. The separate denied
Retry check also passed without executing work or taking the existing input.

Build 8 adds a gray **YOLO OFF** / pink **YOLO ON** control to live terminal chats,
using the same Core-owned permission setting as CLI. Enabling it while a request
is pending atomically accepts that exact approval. The full own-phone grant and
input lease are required; scoped friends and isolated persistent Agents cannot
enable it. Pause active work before disabling an already launched bypass mode;
the full native launch/sandbox setting changes on the next execution. Older Core
versions leave the control unavailable until the host is updated through CLI.
Approval cards now appear directly in chat with command details and green
**✔ Approve once** / red **✕ Deny** controls. Commands remain inspectable, typed
drafts stay intact, and Core rechecks question identity, expiry and ownership.
The composer also shows authoritative goal progress/completion/stall colors.

Every agent and terminal opens the same native chat at its most recent message, without an animated trip through old history. Late Core history also lands at the bottom. Turquoise user bubbles sit on the right and dark assistant bubbles on the left, with a compact header and composer. COOL, Signal, Subscriptions, Design review and Research contain fictional conversations. The examples demonstrate native tables, normal/bold/italic text, three text sizes, colored highlights, lists, quotes and literal code blocks. Sending in a Demo chat adds a predefined local reply. Created agent drafts remain separate and never receive these fake responses.

Hold the microphone beside Send to dictate using on-device Apple Speech. Partial results update the message field as available; release stops audio and briefly awaits final words. Existing typed text is preserved, and the result stays editable until the user presses Send. Unsupported languages/denied permissions keep typing available. Backgrounding, navigation and lost authorization cancel capture; releasing during a permission prompt cannot start a late recording.

[message_format.txt](message_format.txt) is the versioned body-format contract to pass to BZZY-Core. Responses remain strings, with a small XML-compatible HTML-like vocabulary inside `<message version="1">`. The app translates it into SwiftUI views. Plain text and basic inline Markdown also work. No WebView, CSS or remote asset loading is involved. Malformed/unsupported rich content falls back to bounded plain text. Tables scroll horizontally and text respects Dynamic Type. Formatting is presentation, separate from runtime permissions and verified outcomes.

The mascot uses the supplied two-eye artwork directly, preserving its compound-eye texture. It is displayed 25% larger and a bounded Metal distortion moves existing pupil and antenna pixels with touch/idle motion; eyes never close. Reduce Motion shows the original still artwork and backgrounding pauses its clock. The app icon shows a complete single-eye and antenna emblem, centered with deliberate padding. Buttons, borders and selection states share the artwork's sky-blue/celeste accent, rounded action surfaces and pressed feedback. See [brand assets and palette](docs/BRAND.md).

## Relay connection

The app implements the deployed `bzzy-relay.v1` transport through the configured Relay endpoint, using ordinary system TLS/IP-SAN validation and ATS. It generates independent signing/encryption keys and stores the device identity and host binding in device-only Keychain records. It supports signed challenges and presence, candidate authentication, PAIR QR scanning/pasting, typed expiring codes, full host fingerprint comparison, explicit host confirmation, approval polling, pinned host certificates, scoped grant inspection and revocation handling.

The transport uses wire-compatible Curve25519/XSalsa20/Poly1305 boxes with 24-byte nonces. It validates routing identities, grants, socket epochs, expiry and replay before acknowledging delivery. Requests and buffers are bounded. Reconnect only restores transport and reads authorization state. Uncertain claims are never automatically retried.

The app uses the strict encrypted `bzzy-core` v1 contract for actual Core state. Approved terminal catalog access shows running and historical CLI sessions with their original directories. iPhone opens existing sessions and can view, resume and interact according to its grant; it never creates terminals or browses arbitrary host folders. Separate immutable resource clients retain raw history, independent cursors and uncertain-command IDs. Chat and a quick Activity view show actual execution, goal, question, evidence and tool events. Core owns the gateway independently of CLI lifetime. The installed Mac Core and production Relay passed a disposable native observer check. Manual phone pairing and its live behavior remain the next checks.

After authorized Core pairing, a compact status bar shows the execution host's actual CPU and used/total RAM. Foreground reads update about every four seconds from Core's cached sampler; CPU is unknown during initial warmup. Scope changes, disconnects and backgrounding cancel reads and clear the display. These are host measurements, never the phone's CPU/RAM.

The initial Relay protocol has no forward secrecy/ratchet and has not received an independent cryptographic audit. See [the iOS integration notes](docs/relay-and-notifications.md) and [runtime assessment](docs/runtime-assessment.md).

## Share and Import

With explicit `shareAccess`, a live terminal's Share action asks Core to package the actual project and full BZZY context. A live Agent requires both `agentAccess` and `shareAccess` and uses `BZZY-AGENT-...`. Both transient sheets display a QR/temporary code, the complete source fingerprint, recipient fingerprint approval and revocation. Codes/QR values are cleared on dismissal, backgrounding and expiry, and never enter durable chat or logs.

For terminals, the recipient uses `bzzy --import CODE` or `/import` in CLI to restore into that CLI's current directory. For Agents, iPhone's **Import agent** scans/pastes the invitation, requires complete sender fingerprint comparison, and selects the receiving Core's own provider/model/effort. Core receives and validates project files, full chats, notes, memory, goals, nested relationships and evidence, then restores a fresh idle Agent beneath its managed Agents root. Imported work is paused, account bindings/permissions remain separate, and opening it never starts inference. The phone shows the temporary recipient fingerprint for the sender's explicit approval; refresh/cancel and saved job-ID reconciliation survive ordinary outages. Codes and bundle bytes are never persisted on iPhone. A completed Core `importId` receipt can recover a transfer after helper restart without receiving it twice.

Both Cores must stay online during transfer. Imported identities/paths are remapped, credentials excluded and existing files protected. The public Relay must support the transfer quotas/lifetime; see [project sharing](../BZZY-CORE/docs/PROJECT-SHARING.md). Mobile terminal import and scheduled Agent activation remain unsupported. Legacy demo import is preview/test behavior and cannot substitute for live production import.

## Models, defaults and goal pause

Settings → Models and defaults configures each computer’s independent CLI solo,
Core assistant, Besties, Parallel, Debate and Delegate defaults. Provider/model
catalogs come from Core; effort options follow the selected model. Each agent
has its own selection, with two or three agents except Delegate’s supervisor and
executor. Saves use revision checks and explicit same-request retry. They affect
new chats/mode launches and start no work. The fully approved own phone is
required; scoped collaboration grants cannot change these defaults.

An individual live terminal’s composer has Pause, Model and Resume goal controls. Pause
stops the saved goal, Model changes an idle conversation’s provider/model/effort,
and Resume continues the exact paused goal. History, objective, evidence and
spent budget remain. Offline controls stay locked. These controls require both
the updated app binary and Core; updating CLI/Core does not install the app.
Provider API keys are edited securely on the host in CLI Settings → API keys.

## Host updates

Settings → BZZY Updates shows the authoritative Core update status. The fully approved own phone can enable monitoring, update notifications and remote installation, check GitHub, and explicitly confirm the displayed CLI/Core revision. An update notification only opens Settings. Installation uses a durable Core helper; work is paused and the phone reconnects to inspect the result. Remote installation starts disabled and cannot be enabled by scoped friends or Agent/session contexts. Unknown acceptance retains its request ID for an explicit same-request retry. These controls require the updated iOS binary; they do not install the phone app itself.

## Notifications and voice

Settings → Notifications requests native alert/sound/badge permission only when **Enable notifications** is tapped. It shows current permission, an Activity alerts toggle, an iOS Settings shortcut and an explicit test notification. Native notification taps select an allowlisted screen and reconcile state; they never execute commands. Verified pairing approval/revocation can emit generic local alerts. Pairing codes and credentials never enter notifications; goal aliases and sanitized previews may appear on the lock screen.

The phone registers its APNs token with authenticated Relay and sends its approved notification scope through the encrypted Core contract. Current Core/Relay versions use a durable Relay queue while the app is closed; older versions retain direct Core push. Registration is reasserted after foreground/reconnect, and a startup permission check cannot prematurely disable it. Goal alerts distinguish **achieved, stalled, paused, cancelled and input needed**, with the session alias with a sanitized final-reply preview limited to 180 Unicode characters, including `...` when truncated. Input alerts keep command details inside the app. Exact session or explicitly approved terminal/Agent scopes apply, with expiry/revocation, deduplication and bounded retries. Taps recheck authorization and navigate without executing. **Actual background delivery requires Apple provisioning, private Relay APNs configuration (or legacy direct Core setup) and a physical-device test.** Missing configuration is reported as pending, never as working delivery. See [host push setup](../BZZY-CORE/docs/PUSH.md).

Voice drafts use Apple Speech and AVFoundation with English/Spanish selection. Recording requests microphone/speech access only after a tap and requires supported on-device recognition. Otherwise text remains editable. Capture stops on dismissal/backgrounding. Physical-device permissions and transcription accuracy still need validation.

**Talk to BZZY** opens a full-screen voice interface with no visible transcript or status text. Hold the microphone to talk and release to send; the last words finalize immediately or within a 650 ms bound. The spectrum uses 64 frequency bands from actual microphone audio, with a quick attack and gentle release smoothed at display cadence. Stop, Replay, Recheck and Close use accessible icons. Failed capture/dispatch can leave an explicit retry arrow and Discard. Permission cancellation, navigation, backgrounding and reconnect do not send. Apple speech synthesis speaks replies and safe connection/setup notices; no third-party speech service or audio upload is used.

Settings → Voice provides separate **Listening language · STT** and **Speaking voice · TTS** choices for English and Español. Listening applies to voice chat and regular chat dictation; speaking selects Apple's voice and the language of fixed spoken notices. The two preferences persist independently. Regular chat dictation remains editable and requires its own Send tap.

Voice runs through the fully approved own-phone pairing and Core's independent default assistant, in its configured managed folder. Core validates the folder's actual identity before enabling capture. Setup notices identify CLI Settings on the host computer. Core stores execution/history normally; the phone saves only an opaque pending request receipt. Reopening reads the receipt without resending. Update CLI/Core through the CLI updater and configure `bzzy-core assistant` plus the default BZZY folder if needed. See [Core voice contract](../BZZY-CORE/docs/VOICE.md). Recognition, physical microphone quality and audible playback still require manual testing. Terminal picker rows show only an icon and alias; directory/model details remain inside the selected conversation.

## Verification

Build 8 validation (2026-10-23): **197 Core**, **413 CLI** (21 optional/platform
skips), and **50 native Swift tests** pass. Native model/chat checks also pass,
including keeping approval decisions in activity instead of adding yes/no chat
bubbles. Core tests exercise exact-question atomic acceptance, stale/expired and
foreign requests, read-only/Agent boundaries, full-phone versus scoped grants,
idempotency and pinned reply previews. CLI layouts were inspected at 80×24 and
140×40. The signed build 8 artifact passed validation and was installed and
launched on the connected phone. Physical approval interaction and the changed
notification preview remain manual checks after updating the host through CLI.

Build 7 validation (2026-10-23): **188 Core**, **401 CLI** (21 platform/optional skips), and **49 native Swift tests** pass. Model checks cover exactly-once release intent, permission/background/error cancellation, final-word waiting, 64-band FFT and smoothing to silence. Two simulator UI tests pass for independent persisted speech settings, alias-only terminal rows, the text-free voice screen and latest-message chat entry. The signed device artifact validates and build 7 is installed. The folder's stale mount identity was explicitly reconfirmed on the host; the reusable fix validates volume UUID/inode continuity without accepting a replaced directory. See [build 7 validation](docs/full-line-validation.md#speech-settings-folder-recovery-and-updater-reload-build-7-2026-10-23).

Build 6 validation (2026-10-23): **185 Core tests**, **396 CLI tests** (21 platform/optional skips), and **49 native Swift tests** pass. Model checks include bounded open-eye motion, pause/resume and real FFT frequency separation. Three targeted simulator UI checks pass: voice without visible text plus latest-message entry, rich Agent/terminal chats, and Core-offline locking. The native voice roundtrip uses an isolated provider fixture and encrypted Relay/Core; background recovery observes one execution without resending. Signed device build 6 passes artifact/signature/privacy/shader checks and is installed on the connected iPhone. No microphone capture occurs in automated checks; audible device speech and real recognition remain manual checks. See [build 6 validation](docs/full-line-validation.md#voice-and-open-eye-animation-build-6-2026-10-23).

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

Terminal goal feedback: each aliased terminal row shows a green achieved dot,
red stalled dot, amber paused/input-needed dot, or a progress spinner while its
goal is running. Labels provide the same information without relying on color.
Reduce Motion uses a static running dot; offline rows show dimmed last-known
state without animation. Core lifecycle revisions refresh the catalog without
opening each chat. An ordinary response ending is never labeled goal achieved.

Chat layout: opening a conversation hides the global BZZY/computer header and
connection footer to leave room for messages. The top-right Chat settings menu
contains Share, Import, Activity, Details, model/effort, defaults, YOLO and Set goal.
Pause/Resume stays beside the compact goal status above the composer. The mode
below the alias opens a dropdown for Solo, Delegate, Debate, Parallel and Besties.
Unpaused chats offer Pause first; Core independently requires a saved paused
state and stopped workers. Selecting a mode consumes its existing preset, keeps
the same chat/history/goal and starts no work. Missing presets point to Mode
defaults. Persistent Agents and scoped observers cannot change terminal modes.
