# Native communication validation

The automated native line check runs the real Swift Relay transport and Core
application client against an actual local Relay and a supervised Core daemon.
It uses disposable device identities, private temporary host storage and an
offline Codex-protocol model fixture. It never enrolls a host on the public Relay,
uses existing provider logins, or submits a paid model request.

From `BZZY-IOS`, with Node.js 24+ on `PATH`, run:

```sh
swift test --build-system native --disable-index-store --scratch-path .build/relay-package
```

If another Node version is the default, set `BZZY_TEST_NODE` to the absolute path
of a Node.js 24+ executable. Without a supported Node installation, the native
line test explicitly skips; that skip is not a successful readiness check.
The sibling Core, CLI and Relay packages and their installed dependencies are
required for this workspace integration test.

The line test verifies:

- Authenticated Swift/Node encryption, pairing and exact session grants.
- Observation without starting a model; observer control and cross-resource
  requests rejected by Core.
- Explicitly approved terminal discovery with original working directories,
  separate immutable session resources and stable rediscovery after restart.
- Closing the CLI Settings adapter leaves the daemon's Relay gateway running.
- Input lease renewal, durable execution acceptance and same-ID retries without
  another execution.
- The original canonical rich body reaches the native event projection and is
  readable by the actual terminal renderer.
- Projection and processed cursor are saved together before an application ACK.
- Network disconnect and an actual Core daemon restart restore the saved Relay
  configuration, grants and event cursor without repeating model work.
- Replay deduplication and reloading the native on-disk projection.
- Pause acceptance followed by an authoritative `control.observed` event.
- Pending approval delivery, an explicit denial and idempotent question answers.
- A separately selected Core coordinator model, context and task receipt.
- Live grant revocation remains effective after reconnect.
- Independently approved persistent Agent creation, idempotent opening, a real
  offline model execution, rich history, updating and archiving through Core.
- Independently approved source project sharing produces one transient code,
  supports safe same-ID replay and can be inspected/revoked from Swift.
- Device-scoped notification registration, preferences and removal work with a
  synthetic token. The host explicitly reports no Apple provider credentials.
- Relay audit records do not contain the synthetic private prompt or model body.

`CoreLineIntegrationTests.swift` owns the Swift test, and
`tools/core-line-fixture.mjs` owns the disposable host setup and teardown.
`tools/core-line-model.mjs` is an offline model protocol fixture, not an installed
provider or a replacement runtime. The insecure transport initializer accepts
only an explicit numeric loopback address; the application still uses its fixed
TLS endpoint and normal system certificate validation.

In the initial 2026-10-22 run, all 24 Swift package tests passed, including both expanded native
line scenarios, with zero failures or skips on Apple Silicon macOS using Node
24. The client implementation is validated on
macOS using the same Foundation transport code. It does not prove iPhone
Keychain/provisioning, physical camera scans, background suspension, cellular
handoff, live provider authorization, real APNs delivery, or native Linux service
installation. The separate Node project-transfer tests validate an actual
encrypted multi-chunk ZIP and strict import of project files/context/history,
including corrupt-chunk rejection before extraction; the native test covers
source-side sharing. Those checks do not establish physical iPhone behavior or
that the deployed Relay has been updated for the transfer limits.

## Fresh first-version checks (2026-10-22)

The complete checks were run again against the current source with Node
24.22.1. The final Swift package suite has **27 passing tests, zero failures and
zero skips**. It includes the real local Core daemon/Relay/native-client line,
terminal catalogs, scoped Agent CRUD/run/archive, source sharing and notification
registration, plus actual authorized `host.metrics` telemetry. Three new metrics
checks cover CPU warmup, separate host/process measurements, invalid/private
fields and read-only requests that cannot choose another process or scope.
The model persistence/migration/security checks, canonical chat/gaze checks,
13 native preview layouts, six mascot poses and project/plist lint also pass.

All **12 Debug iOS UI tests** pass on the signed iPhone 17 Pro simulator running
iOS 26.2. The suite covers mandatory initial pairing, rejected invitation
purpose, draft persistence/relaunch, both tabs, rich chat/table/code rendering,
accessibility text, inactive scheduled drafts, explicitly local sharing/import
previews, native notification permission/delivery/tap and public Relay TLS
candidate authentication with an isolated disposable Keychain record. A separate
**Release UI test** passes and proves that preview/test launch arguments cannot
unlock navigation, add samples or expose the diagnostic overlay before approved
Core pairing. A final signed Debug simulator build also passes.

These UI tests do not claim live Agent creation or a full project transfer from
an iPhone. Those Core contracts are exercised by the real local native-client
line; physical iPhone foreground/background behavior remains a separate test.
The public Relay diagnostic authenticates only a disposable candidate; it does
not enroll a host or execute a model.

One additional repeated native-line run failed intermittently before stage
diagnostics were available. Its raw log is retained as
`first-version-native-intermittent-failure.log`; its cause was not established.
Assertions and timeouts were preserved. After adding named stage diagnostics
and freezing backend source, **ten consecutive serial native-line repetitions
passed**, recorded in `first-version-native-stability.log` and the ten matching
individual logs. The final complete native/model check is recorded separately
in `first-version-final-checks.log`. The successful repetitions do not prove
that the earlier intermittent failure is impossible.

Artifact inspection found and fixed an APNs packaging error: the generated
Info.plist omitted the custom environment key. An explicit source plist now
retains `BZZYAPNSEnvironment` in both configurations. The bundled privacy manifest
declares the APIs actually used for private notification preferences
(UserDefaults, CA92.1) and app-container cache metadata (FileTimestamp, C617.1).
No tracking/data-collection declaration was inferred from these required-reason
entries. The built-app validator checks these files, permission descriptions,
the bundle identifier and the signature; distribution mode also requires
production APNs, the expected application/team identifiers and no debugger
entitlement.

The Release archive was prepared using a local signing-team override. No
personal development team is committed as a project default. No physical
installation or App Store Connect upload was part of that first-version run;
the later direct-device test is recorded below.
The privacy-inclusive local App Store export also succeeded. The exported
`TestFlight/Export/BZZY.ipa` was extracted and its distribution signature checked:
production APNs, matching bundle/team identifiers, debugger attachment disabled,
the production environment metadata and both required-reason manifest entries.
This is a prepared upload artifact; it is **not uploaded to TestFlight**.

Current evidence (under `BZZY-IOS/.build/`):

| Check | Artifact |
| --- | --- |
| Complete native/model/security/format run | `first-version-final-checks.log` |
| All 12 updated Debug UI tests | `FirstVersionFinalAllUI.xcresult`, `first-version-final-all-ui-tests.log` |
| Production pairing and preview isolation | `FirstVersionReleaseGate.xcresult`, `first-version-release-gate.log` |
| Ten serial native-line repetitions | `first-version-native-stability.log`, `first-version-native-stability-01.log` through `-10.log` |
| Final signed simulator build | `first-version-final-build.log` |
| Built Debug/Release metadata checks | `first-version-debug-artifact-validation.log`, `first-version-release-artifact-validation.log` |
| Release archive and local export | `TestFlight/archive.log`, `TestFlight/export.log` |
| Exported distribution IPA validation | `TestFlight/ipa-validation.log`, `TestFlight/Export/BZZY.ipa` |

Reproduce the native checks with:

```sh
PATH=/absolute/node24/bin:$PATH BZZY_TEST_NODE=/absolute/node24/bin/node zsh tools/check.sh
```

For any produced app, run the artifact check as well. Use `development` for
Debug or `production` for Release; an App Store distribution export additionally
requires `--distribution --team YOUR_TEAM_ID`:

```sh
python3 tools/check-app-artifact.py /path/to/BZZY.app --environment production
```

Actual TestFlight availability, a physical iPhone pairing/QR scan and background
suspension/cellular behavior, real provider/account authorization, microphone
permission/transcription, and actual Apple APNs delivery are not established by
these automated checks. Real push delivery still requires private host APNs
configuration and an on-device test. Host installation and the deployed Relay
version are checked separately from the iOS build.

## Core offline lock (2026-10-22)

The app now distinguishes Relay connectivity from an authorized, responsive
Core. A valid saved pairing with an offline or stopped Core shows a prominent
offline/connecting screen and locks Agents, Terminal, an already-open chat,
Activity, voice, agent editing and sharing. Connection and local Settings remain
available for recovery. Cached history and pending uncertain command IDs are
preserved; cached CPU/RAM is cleared rather than displayed as current.

The existing two-second foreground metrics read doubles as a scoped Core
heartbeat with a bounded four-second read timeout and an eight-second freshness
limit. A Relay presence response cannot unlock the app. Backgrounding,
disconnects and context changes invalidate the health generation; delayed
responses cannot unlock a replacement session. Reconnect restores observation
and reconciles command status without claiming input or dispatching work.
The production first-launch Pair gate and Debug-only preview isolation remain
unchanged.

The complete checks now pass **32 Swift tests with zero failures or skips**.
Four connection-health regressions cover Relay-only presence, heartbeat expiry,
background/disconnect invalidation, stale scope responses and rejecting offline
send/control/Agent/share actions while keeping pairing. Another protocol check
covers typed `CORE_STOPPED` and prevents shortened timeouts on mutations. The
actual native line stops the disposable Core using its owner-only operator API,
receives `CORE_STOPPED` for both `session.get` and `host.metrics`, clears the
private fixture's stop intent, restarts that private daemon and reconnects with
the same pairing. Its execution count remains four throughout recovery. The
fixture does not install or start a supervised operating-system service.

Three targeted Debug simulator UI tests pass: the initial Pair gate, connection
settings, and the new paired-but-offline screen despite a connected Relay. The
offline test also backgrounds and reactivates the app and verifies that cached
tab/action controls are disabled and cannot receive taps. A separate Release
Pair-gate test passes even with preview/offline test arguments. The previous
complete twelve-test Debug UI run remains recorded above; it was not described
as a rerun after this change.

Current offline evidence, under `.build/`:

| Check | Artifact |
| --- | --- |
| Complete 32-test native/model/security run | `core-offline-final-checks.log` |
| Three targeted Debug UI regressions | `CoreOfflineUIFinal.xcresult`, `core-offline-ui-tests-final.log` |
| Release pairing and test-argument isolation | `CoreOfflineReleaseGate.xcresult`, `core-offline-release-gate.log` |
| Final offline UI smoke/build | `CoreOfflineFinalSmoke.xcresult`, `core-offline-final-smoke.log` |
| Updated signed archive and local export | `TestFlight/BZZY.xcarchive`, `TestFlight/Export/BZZY.ipa`, `TestFlight/archive.log`, `TestFlight/export.log` |
| Distribution signature, privacy and APNs metadata | `TestFlight/archive-validation.log`, `TestFlight/ipa-validation.log` |
| Updated IPA checksum | `TestFlight/ipa-sha256.txt` |

The updated IPA is a local prepared upload artifact. **It has not been uploaded
to TestFlight.** At this stage, no physical iPhone installation or real Apple
APNs delivery had been performed. Later public-network and direct-device checks
are recorded below; on-device pairing/background/cellular behavior and real
APNs delivery remain separate checks.

## Full-context Agent transfer and build 2 (2026-10-23)

Live Agent Share now requires both explicit `agentAccess` and `shareAccess`.
Its immutable client purpose and Core's returned `kind` must both be AGENT;
Terminal and Agent codes/packages cannot substitute for one another. The QR and
temporary code remain transient, with source fingerprint comparison and explicit
recipient approval. Production Import Agent uses Core jobs rather than local
demo copies. The phone selects its Core's own actual provider/model/effort,
reviews the full-context/paused/account-separation conditions and sends only the
temporary code plus confirmed source fingerprint. Bundle bytes never materialize
on iPhone. Safe opaque request/import IDs alone are retained for reconciliation.
Cancellation, offline locking and late-response scope checks apply throughout.
An exact persisted `importId` Agent receipt can recover a completed import after
the ephemeral helper restarts without reusing the code.

The final complete run passes **38 Swift tests, zero failures and zero skips**,
plus model/security/chat/gaze checks, 13 layouts, six poses and plist/project
lint. Six new strict transfer regressions cover wrong-purpose codes, full source
fingerprints, forbidden path/credential fields, source/recipient substitution,
bounded status, cancellation and matching idle completion receipts. The actual
native-client advanced scenario creates a disposable Core Agent, runs the offline
model fixture, exports its full context through encrypted Relay, compares and
approves the recipient fingerprint, and receives a fresh idle Agent on Core.
The restored session contains the original rich messages and a remapped historical
execution. Exactly one native execution and one imported historical execution are
present; importing/opening performs no additional inference.

That test found a real evidence-path bug: macOS `/tmp` and `/private/tmp` aliases
were not canonicalized consistently by the Agent converter. The Core fix and
regression now pass the originally failing native path. The offline model fixture
also implements the new isolated-permission-profile handshake and rejects launch
configurations that omit its required restrictions. This is protocol wiring
evidence, not proof of OS isolation by a synthetic backend; the separate real
native-backend security checks belong to Core's validation record.

The updated signed Debug offline gate and Release production Pair-isolation
tests pass. The broader twelve-test UI run above remains historical evidence;
the live transfer is exercised by the native Core/Relay scenario, not a claim
that an actual iPhone has completed it. The signed build-2 archive/export use
separate paths so the build-1 failed upload evidence remains intact.

| Current check | Artifact under `.build/` |
| --- | --- |
| Complete 38-test run and model checks | `agent-transfer-final-checks.log` |
| Actual native Agent transfer | `agent-transfer-native-line-final.log` |
| Strict transfer/share/offline regressions | `agent-transfer-swift-focused.log` |
| Signed Debug offline UI | `AgentTransferGates.xcresult`, `agent-transfer-ui-gates.log` |
| Release Pair/test-argument isolation | `AgentTransferReleaseGate.xcresult`, `agent-transfer-release-gate.log` |
| Build 2 archive and IPA | `TestFlightBuild2/BZZY.xcarchive`, `TestFlightBuild2/Export/BZZY.ipa` |
| Archive/export/signature/metadata evidence | `TestFlightBuild2/archive.log`, `export.log`, `archive-validation.log`, `ipa-validation.log`, `ipa-sha256.txt` |

Build 1's supported internal-TestFlight upload attempt failed in Xcode's App
Store Connect provider lookup (`Actor/relationships/providerId`) before a verified
delivery. The selected signing team matches the archive. An account visible in
Xcode does not establish that this separate upload/provider lookup succeeded;
app-record availability was not verified. Computer Use was unavailable for
inspecting the current account UI. No account absence or encryption exemption
was inferred. Build 2's Release IPA has not been uploaded. Its subsequent Debug
installation on the physical iPhone is recorded below. TestFlight is deferred;
manual phone pairing and real Apple APNs/on-device behavior remain unverified.


## Actual public Relay observer check — 2026-10-23

The prepared native Swift observer probe completed against the real public Relay
and installed Mac Core after its production upgrade. Private stdin carried the
single-use pairing code; no invitation URL, code file or model execution was used.
The host approved the generated identity with observe-only access to one existing
session. Verified TLS plus encrypted application messages returned the expected
session, 50 durable events and strictly decoded live host CPU/RAM. The temporary
grant was immediately revoked. Evidence:
`/private/tmp/bzzy-public-native-observer.log` and
`/private/tmp/bzzy-public-native-observer-result.json`.

This proves the native transport/Core protocol on the real network path. It is
not a physical iPhone install, TestFlight upload or real APNs delivery check.

## Direct physical iPhone install and manual handoff — 2026-10-23

The user explicitly chose direct development installation for the first phone
test, replacing TestFlight as its prerequisite. Xcode CLI built scheme `BZZY`,
configuration `Debug`, version **0.1.0 (2)** for only the connected iPhone 15 Pro
Max running iOS 27.0.1. The final app signature and provisioning match
`app.bzzy.ios` and the authorized team, include that exact phone, use development
APNs and permit development debugging. Required-reason privacy metadata also
passed inspection.

The documented `devicectl device install app` command succeeded. A subsequent
normal foreground launch succeeded with **no command-line arguments**, no demo
or UI-testing flags and no start-stopped option. An independent targeted process
query recorded the installed BZZY executable running as PID 57876. The user
confirmed seeing the app. No uninstall, app-data wipe or Keychain reset occurred,
and no source or App Store Connect changes were needed for this installation.

**Pairing is pending and belongs to the user.** No further automated pairing
creation, approval, revocation or phone interaction is part of this handoff.
This proves development installation and normal launch on the real phone; it
does not yet prove phone-to-Core pairing, chat/control, camera scanning, voice,
background/cellular recovery or actual APNs delivery. The earlier successful
native public observer test remains separate evidence of the network path.
TestFlight is deferred; its failed upload history above is retained.

Saved evidence under `.build/DeviceTest/` was checked without interacting with
the phone again:

| Check | Evidence |
| --- | --- |
| Device-targeted Debug build | `build.log` |
| Signature, profile and development APNs | `signing-validation.log` |
| Successful app installation | `install.json`, `install.log`, `app-after.json` |
| Normal foreground launch, empty arguments | `launch.json`, `launch.log` |
| Independent running-process check | `processes.json`, `processes.log` |
| Concise outcome and preservation record | `result-summary.json` |


## Aliased sessions, connection health and composer dictation (2026-10-23)

Debug **0.1.0 (4)** builds and passes signature verification, is installed on the connected iPhone, and launches normally without test arguments. Existing app data and approved pairing remain intact. After the CLI maintenance restart, Core is supervised and online, Relay is ready, and the existing phone has one authorized active subscription; no model execution was started.

Both clients show only actual nonblank terminal aliases, sorted by last saved activity descending. CLI Sessions supports arrows and Enter, restores the selected chat's original cwd/history and preserves drafts. Saved parallel groups restore the actual child scope and reset its projection cursor without mixing parent history or replaying work. The persistent CLI header remains above Settings, pickers and chat/activity views; its compact pairing layout retains the complete QR and quiet zone at 80x24.

Composer dictation uses on-device Apple Speech: hold the microphone before Send, receive partial text in the input when available, release to stop audio and briefly await final words, then edit/send manually. Generation checks reject late permission/callback results after release, backgrounding or navigation. Unavailable recognition preserves typing and edited transcripts.

Verification: **99 focused CLI tests pass** (3 Linux-only PTY cases skipped), **44 Swift tests pass**, model/lifecycle checks pass, and the navigation/draft UI test passes in the iOS simulator. A separate actual macOS PTY test verifies newest-first aliases, arrow/Enter opening, original cwd and saved history with zero execution. Installed Settings and Sessions smoke checks pass at 80x24 and leave Core running. Apple Vision decoded the new terminal QR render exactly. Telemetry-failure fixtures retain readiness only after an authorized session heartbeat, while explicit Core stop still locks actions.

No automated check captured microphone audio; real speech recognition and first-use permission behavior still require the user's phone test. No new production pairing was created/approved/revoked, and credentials and host identity are unchanged. The deployment record is `~/BZZY/Setup/SESSIONS-VOICE-UPDATE-STATUS.json`.
## Voice and open-eye animation build 6 (2026-10-23)

Build 6 preserves the supplied face asset unchanged and animates its existing
pixels through the shared Metal shader. Pupils track and antennae sway; no blink
or eyelid state exists. The face is displayed 25% larger. Shared celeste action
surfaces replace bare buttons, and chats open at the latest message immediately,
including history loaded after opening.

The full-screen voice surface contains only icon controls and a 32-band spectrum
from microphone FFT data. Capture uses on-device Apple Speech. Release finalizes;
explicit Send forwards text through the encrypted own-phone/Core API. Apple TTS
reads replies and safe connection notices. Closing/backgrounding stops local
audio and observation; accepted work is recovered through its saved receipt.
Core selects its independent default assistant and managed folder, retains the
normal execution/history path and does not expose its private context token.

Validation completed:

- Core: **185/185 tests**, including real encrypted voice execution, lost
  acceptance, output/question boundaries, Unicode pages, revocation/root changes,
  transaction rollback and Stop against a newer turn.
- CLI: **396 passed, 21 platform/optional skips**, with no failures; Core/CLI
  source checks pass.
- Native Swift: **49/49 tests**, including a real `RelayConnection` voice request,
  Core-default selection and background/reconnect recovery with one execution.
- Model checks: no-blink bounded motion, paused animation clock, synthetic
  low/high tone FFT separation and silence. No ambient microphone input is used.
- Targeted simulator UI: text-free voice, latest Agent/terminal message on entry,
  existing rich chats and Core-offline locking pass. The three checks passed
  across focused runs; screenshots were inspected.
- Native macOS previews: 14 layouts and six open-eye expressions rendered with
  the same compiled shader. These are previews, not device screenshots.
- Signed physical **Debug 0.1.0 (6)** builds, validates and installs in place on
  the connected iPhone. The phone reports build 6. Application signing identity,
  development push entitlement, permission/privacy declarations, eye/icon assets
  and `default.metallib` were checked before installation. No app uninstall or
  data reset was performed.

Physical microphone permission/recognition, audible TTS and the user's saved
pairing were not exercised by automation. The host Core must receive the new API
through the CLI updater; this device installation does not update the running
host. APNs delivery still depends on its separate private Apple/host setup.

## Speech settings, folder recovery and updater reload build 7 (2026-10-23)

The voice screen now sends on the user's deliberate release, with up to 650 ms
for final recognition. Permission cancellation, background/navigation, failed
recognition and reconnect cannot submit speech. Regular chat dictation keeps its
editable draft and explicit Send. The real FFT has 64 bands, a 2,048-sample window
and display-cadence attack/release smoothing. English/Spanish listening and Apple
speaking voice are separate persisted settings. Terminal picker rows contain
only their icon and alias.

The host folder error was traced to a changed macOS device number with the same
inode/path. Its existing configured directory was explicitly reconfirmed; no
model execution, terminal-directory move or app data reset was performed. New
folder identities include a stable volume UUID when available. Core accepts a
verified remount of the same volume/inode and still rejects replaced directories,
different volumes and unverifiable legacy pins. Voice readiness checks the real
folder before capture is enabled. Core's saved model is independent of the
separate missing-APNs warning.

The CLI updater keeps its TUI visible during installation and then replaces its
process with the updated CLI, preserving the terminal, saved chat/tab and composer
draft. A bounded, private, one-time UI handoff contains no executable work or
credentials. Reloading does not take another client's input lease or start
paused work, and an explicitly stopped Core stays stopped. A preexisting old CLI
must be reopened once after installing this updater. Tests replace an actual
Node process, verify its PID/stdio continue, and verify draft recovery, failure
handling, locked progress controls, private-file checks and read-only restoration.

Validation: **188 Core tests**, **401 CLI tests** (21 platform/optional skips),
**49 native Swift tests**, model checks and two focused simulator UI tests pass.
Fifteen native macOS layouts and six open-eye expressions render. The signed
Debug **0.1.0 (7)** artifact passes signature/identity, development APNs metadata,
permission/privacy and shader checks; the connected phone reports build 7 after
in-place installation. Launch was blocked by the device lock. No automated test
records ambient microphone audio or claims audible physical-device validation.
Actual background push still needs the private Apple APNs key/configuration.
