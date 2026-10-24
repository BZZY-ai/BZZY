import XCTest
@testable import RelayKit

final class PairingConnectionTests: XCTestCase {
    @MainActor func testLegacyReceiptInAnotherSessionCannotBlockVisibleTerminalOrReplayWork() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, resourceJournal: true)
    }

    @MainActor func testPhoneGoalDispatchRequiresReplacementAndUsesCoreGoalLifecycle() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, goals: true)
    }
    @MainActor func testConfirmedGoalCannotTakeCLIOwnershipWithoutHostTakeoverPermission() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, goals: true, allowTakeover: false)
    }
    @MainActor func testVoiceUsesCoreDefaultAndRecoversAfterBackgroundWithoutSendingAgain() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, voiceChat: true)
    }
    @MainActor func testNotificationCenterRoundtripKeepsAuthorizedCoreOnline() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, overlayResume: true)
    }

    @MainActor func testOwnPhoneCanConfigureHostUpdatesWithoutStartingInstallation() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, updatePreferences: true)
    }

    @MainActor func testOwnPhonePairingUnlocksWithoutConfiguredCoordinator() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false)
    }

    @MainActor func testPollingApprovalDoesNotCancelInitialCoreConnection() async throws {
        try await checkPairing(ignoreDecisionEvent: true, backgroundBeforeApproval: false)
    }

    @MainActor func testPendingPairingCompletesAfterBackgroundAndForeground() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: true)
    }

    @MainActor func testClosingCLILeavesPairedCoreSessionOnline() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, closeCLI: true)
    }

    @MainActor func testUnavailableMetricsUsesAuthorizedSessionHeartbeat() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, failMetrics: true)
    }

    @MainActor private func checkPairing(ignoreDecisionEvent: Bool, backgroundBeforeApproval: Bool,
                                        closeCLI: Bool = false, failMetrics: Bool = false, overlayResume: Bool = false, updatePreferences: Bool = false, voiceChat: Bool = false, goals: Bool = false, allowTakeover: Bool = true, resourceJournal: Bool = false) async throws {
        let fixture = try PairingConnectionFixture()
        defer { fixture.shutdown() }
        let identity = try RelayIdentity.generate()
        let configuration = try fixture.request(["op": .string("start"), "certificate": try RelayWire.object(identity.certificate), "allowTakeover": .bool(allowTakeover)])
        XCTAssertEqual(configuration["coordinatorConfigured"].bool, false)
        let endpoint = try XCTUnwrap(URL(string: try XCTUnwrap(configuration["endpoint"].string)))
        let transport = try RelayTransport(identity: identity, loopbackEndpoint: endpoint)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("bzzy-pair-projection-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var savedAuthorization: Data?
        let connection = try RelayConnection(isolatedIdentity: identity, loopbackTransport: transport,
            projectionDirectory: directory, loadAuthorization: { savedAuthorization }, saveAuthorization: { savedAuthorization = $0 })
        defer { connection.pause() }
        var streamed: [CoreJSONValue] = [], deliveryStates: [CoreOutgoingMessage.Status] = []
        connection.onCoreEvents = { [weak connection] data in
            streamed = data.compactMap { try? JSONDecoder().decode(CoreJSONValue.self, from: $0) }
            deliveryStates += connection?.coreOutgoingMessages.map(\.status) ?? []
        }
        var availabilityFailures: [String] = []
        connection.onCoreAvailability = { available, message in
            if !available && message.hasPrefix("Core session unavailable") { availabilityFailures.append(message) }
        }
        await connection.connect()
        XCTAssertEqual(connection.status, .connected)
        if ignoreDecisionEvent {
            let handler = transport.onEvent
            transport.onEvent = { event, payload in if event != "invite.decided" { handler?(event, payload) } }
        }
        if backgroundBeforeApproval {
            connection.previewPairing(try XCTUnwrap(configuration["code"].string),
                expectedFingerprint: try XCTUnwrap(configuration["host"]["id"].string))
        } else {
            connection.previewPairing(try XCTUnwrap(configuration["qr"].string))
        }
        XCTAssertTrue(connection.hasPairingPreview)
        await connection.claimConfirmedHost()
        XCTAssertEqual(connection.pairingStatus, "Pending approval")
        XCTAssertFalse(connection.corePairAuthorized)
        XCTAssertFalse(connection.coreActionsAvailable)
        XCTAssertNotNil(savedAuthorization, "The claimed invitation must survive app suspension")
        try await eventually {
            try fixture.request(["op": .string("state")])["pendingCount"].integer == 1
        }
        if backgroundBeforeApproval { connection.pause() }
        XCTAssertEqual(try fixture.request(["op": .string("approve")])["approved"].bool, true)
        if backgroundBeforeApproval { await connection.resume() }
        try await eventually { connection.coreActionsAvailable }
        XCTAssertTrue(connection.hasHost)
        XCTAssertTrue(connection.corePairAuthorized, "The real onboarding gate must unlock after scoped Core responses")
        XCTAssertEqual(connection.pairingStatus, "Paired")
        XCTAssertTrue(connection.coreCatalogReady)
        XCTAssertTrue(connection.coreCatalogAvailable)
        XCTAssertTrue(connection.coreAgentsAvailable)
        XCTAssertTrue(connection.coreSharingAllowed)
        XCTAssertFalse(connection.coreIsAssistant, "A terminal pair must not depend on coordinator setup")
        XCTAssertEqual(connection.corePermissions, Set(["observe", "claim", "takeover", "execute", "answer", "pause", "cancel", "steer"].filter { allowTakeover || $0 != "takeover" }))
        XCTAssertTrue(availabilityFailures.isEmpty, "Approval must not cancel its own initial Core read: \(availabilityFailures)")
        if resourceJournal {
            var journalPhase = "create second session"
            var journalDiagnostics: () -> String = { "not restored" }
            do {
            let firstID = connection.coreSessionID
            let second = try fixture.request(["op": .string("second-session")])
            let secondID = try XCTUnwrap(second["sessionId"].string)
            XCTAssertTrue(second["catalogEligible"].bool == true, "Disposable second session must be catalog-eligible")
            XCTAssertEqual(second["sessionCount"].integer, 2)
            connection.pause()
            var saved = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(savedAuthorization)) as? [String: Any])
            let scope = try XCTUnwrap(saved["coreCacheScope"] as? [String: Any])
            let unknownID = UUID().uuidString
            // Restore the old on-device schema with an unresolved request in A.
            // No command with this ID was executed by the disposable fixture.
            saved["pendingCoreCommand"] = ["hostID": try XCTUnwrap(scope["hostID"] as? String),
                "resource": try XCTUnwrap(scope["resource"] as? String), "id": unknownID,
                "op": "execution.execute", "params": ["owner": UUID().uuidString, "prompt": "Unsent fixture input", "goal": false]]
            savedAuthorization = try JSONSerialization.data(withJSONObject: saved)
            let restoredTransport = try RelayTransport(identity: identity, loopbackEndpoint: endpoint)
            let restored = try RelayConnection(isolatedIdentity: identity, loopbackTransport: restoredTransport,
                projectionDirectory: directory, loadAuthorization: { savedAuthorization }, saveAuthorization: { savedAuthorization = $0 })
            defer { restored.pause() }
            var restoredAvailability: [String] = []
            restored.onCoreAvailability = { available, message in
                if !available, restoredAvailability.last != message { restoredAvailability.append(message) }
            }
            journalDiagnostics = { [weak restored] in
                guard let restored else { return "released" }
                return "online=\(restored.connectionOnline) connected=\(restored.coreConnected) busy=\(restored.coreBusy) attaching=\(restored.coreAttaching) catalog=\(restored.coreCatalogReady)/\(restored.coreCatalogAvailable) target=\(restored.coreSessionID == secondID) pair=\(restored.corePairAuthorized) relay=\(restored.status.rawValue) failures=\(restoredAvailability) error=\(restored.coreError ?? "none")"
            }
            journalPhase = "restore first connection"
            await restored.connect()
            try await eventually { restored.isCoreSessionReady(firstID) }
            XCTAssertTrue(restored.hasUncertainCoreCommand(sessionID: firstID))
            // Refresh and opening overlap deliberately: the visible attachment
            // must wait/retry through startup rather than fail once and go blank.
            journalPhase = "attach second session"
            var catalogContainsSecond = false
            restored.onCoreSessions = { data in
                guard let entries = try? JSONDecoder().decode([CoreJSONValue].self, from: data) else { return }
                catalogContainsSecond = entries.contains { $0["id"].string == secondID }
            }
            let refresh = Task { await restored.refreshCoreSessions() }
            let viewing = Task { await restored.observeCoreSession(secondID) }
            defer { viewing.cancel() }
            do { try await eventually { restored.isCoreSessionReady(secondID) } }
            catch { print("JOURNAL attachment before cleanup:", journalDiagnostics(), "catalogContainsTarget=", catalogContainsSecond); throw error }
            await refresh.value
            XCTAssertTrue(restored.connectionOnline)
            XCTAssertFalse(restored.hasUncertainCoreCommand(sessionID: secondID))
            XCTAssertFalse(restored.isCoreSessionBusy(secondID))
            journalPhase = "send second session"
            let accepted = await restored.sendCoreMessage("SYNTHETIC_SECOND_SESSION", sessionID: secondID)
            XCTAssertTrue(accepted, "An unresolved receipt in A cannot disable input in B")
            try await eventually { try fixture.request(["op": .string("state")])["executionCount"].integer == 1 }
            let migrated = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(savedAuthorization)) as? [String: Any])
            XCTAssertNil(migrated["pendingCoreCommand"], "The legacy field is migrated on the next journal write")
            let journal = try XCTUnwrap(migrated["pendingCoreCommands"] as? [[String: Any]])
            XCTAssertTrue(journal.contains { $0["id"] as? String == unknownID }, "Unknown receipts retain their original request identity")
            restored.pause()
            try await Task.sleep(for: .milliseconds(600))
            XCTAssertFalse(restored.coreActionsAvailable, "A surviving view task cannot undo actual app suspension")
            journalPhase = "resume visible second session"
            await restored.resume()
            try await eventually { restored.isCoreSessionReady(secondID) }
            XCTAssertEqual(try fixture.request(["op": .string("state")])["executionCount"].integer, 1, "Recovery never replays either input")
            viewing.cancel()
            return
            } catch { print("JOURNAL regression phase:", journalPhase, "error:", String(describing: error), journalDiagnostics()); throw error }
        }
        if goals {
            var phase = "seed"
            do {
            let seed = try fixture.request(["op": .string("goal-seed")])
            XCTAssertEqual(try fixture.request(["op": .string("cli-attach")])["ownsInput"].bool, true)
            await connection.refreshCore()
            XCTAssertTrue(connection.coreGoalSubmission)
            XCTAssertEqual(connection.coreGoalID, seed["goalID"].string)
            let rejected = await connection.sendCoreMessage("/goal New mobile objective")
            XCTAssertFalse(rejected)
            XCTAssertEqual(try fixture.request(["op": .string("goal-state")])["executionCount"].integer, 0)
            XCTAssertEqual(try fixture.request(["op": .string("goal-state")])["inputHeldByCLI"].bool, true, "An unconfirmed goal never takes input")
            phase = "goal acceptance"
            let accepted = await connection.sendCoreMessage("/goal New mobile objective", replaceGoalID: seed["goalID"].string)
            XCTAssertEqual(accepted, allowTakeover)
            if allowTakeover {
                try await eventually { try fixture.request(["op": .string("goal-state")])["status"].string == "complete" }
                let result = try fixture.request(["op": .string("goal-state")])
                XCTAssertEqual(result["objective"].string, "New mobile objective")
                XCTAssertEqual(result["goalExecution"].bool, true)
                XCTAssertEqual(result["executionCount"].integer, 1)
                XCTAssertEqual(result["notificationCount"].integer, 1)
                XCTAssertEqual(result["inputHeldByCLI"].bool, false)
                XCTAssertNotEqual(result["goalID"].string, seed["goalID"].string)
                XCTAssertTrue(connection.coreOwnsInput)
                try await eventually { streamed.contains(where: { $0["type"].string == "text" && ($0["data"]["text"].string ?? "").contains("Verified the full objective") }) }
                XCTAssertTrue(deliveryStates.contains(.sending))
                XCTAssertTrue(connection.coreOutgoingMessages.isEmpty)
                // Cross both clients' former lease/heartbeat boundaries while
                // the actual CLI stays attached and receives the full reply.
                phase = "watch after completion"
                try await Task.sleep(for: .seconds(16))
                let watched = try fixture.request(["op": .string("goal-state")])
                XCTAssertEqual(watched["cliFinished"].bool, false)
                XCTAssertEqual(watched["cliMode"].string, "VIEW")
                XCTAssertTrue(watched["cliText"].string?.contains("Verified the full objective") == true)
                XCTAssertNil(connection.coreError)
                phase = "CLI followup"
                XCTAssertEqual(try fixture.request(["op": .string("cli-send"), "text": .string("CLI_STREAM_FOLLOWUP")])["sent"].bool, true)
                try await eventually {
                    let progress = try fixture.request(["op": .string("goal-state")])
                    return progress["executionCount"].integer == 2 && progress["latestExecution"]["state"].string == "finished"
                }
                try await Task.sleep(for: .seconds(16))
                XCTAssertTrue(connection.coreActionsAvailable); XCTAssertNil(connection.coreError)
                XCTAssertFalse(connection.coreOwnsInput)
                XCTAssertTrue(streamed.contains { $0["type"].string == "message.user" && $0["data"]["text"].string == "CLI_STREAM_FOLLOWUP" })
                phase = "phone followup"
                let followup = await connection.sendCoreMessage("PHONE_STREAM_FOLLOWUP")
                XCTAssertTrue(followup)
                try await eventually {
                    let progress = try fixture.request(["op": .string("goal-state")])
                    return progress["executionCount"].integer == 3 && progress["latestExecution"]["state"].string == "finished"
                }
                XCTAssertEqual(try fixture.request(["op": .string("goal-state")])["cliFinished"].bool, false)
                XCTAssertEqual(try fixture.request(["op": .string("state")])["inputClaimRequests"].integer, 0, "The phone submits to Core; it never preclaims a lease")
                try await eventually { connection.coreOutgoingMessages.isEmpty }
            } else {
                let result = try fixture.request(["op": .string("goal-state")])
                XCTAssertEqual(result["goalID"].string, seed["goalID"].string)
                XCTAssertEqual(result["executionCount"].integer, 0)
                XCTAssertEqual(result["inputHeldByCLI"].bool, true)
                XCTAssertFalse(connection.coreOwnsInput)
                let failed = try XCTUnwrap(connection.coreOutgoingMessages.first)
                XCTAssertEqual(failed.status, .failed)
                await connection.retryOutgoingMessage(failed.id)
                let retried = try XCTUnwrap(connection.coreOutgoingMessages.first)
                XCTAssertEqual(retried.id, failed.id, "Retry preserves the same visible bubble")
                XCTAssertNotEqual(retried.requestID, failed.requestID, "A definitive rejection needs a new admission ID")
                XCTAssertEqual(retried.status, .failed, "Retry cannot manufacture missing grant permissions")
                XCTAssertEqual(try fixture.request(["op": .string("goal-state")])["executionCount"].integer, 0)
                XCTAssertEqual(try fixture.request(["op": .string("goal-state")])["inputHeldByCLI"].bool, true)
            }
            phase = "close CLI viewer"
            _ = try fixture.request(["op": .string("cli-close")])
            XCTAssertEqual(connection.coreOwnsInput, allowTakeover, "Closing CLI cannot release the phone's transferred lease")
            } catch { print("HANDOFF failure phase:", phase, "error:", String(describing: error)); throw error }
        }
        if voiceChat {
            await connection.prepareVoiceChat()
            XCTAssertFalse(connection.voiceConfigured)
            XCTAssertEqual(connection.voiceErrorCode, "ASSISTANT_SETUP_REQUIRED")
            _ = try fixture.request(["op": .string("voice-configure")])
            await connection.prepareVoiceChat()
            XCTAssertTrue(connection.voiceConfigured)
            XCTAssertEqual(try fixture.request(["op": .string("state")])["executionCount"].integer, 0, "Checking voice readiness never starts work")
            let accepted = await connection.sendVoiceText("SYNTHETIC_NATIVE_VOICE")
            XCTAssertTrue(accepted)
            XCTAssertFalse(String(data: savedAuthorization ?? Data(), encoding: .utf8)?.contains("SYNTHETIC_NATIVE_VOICE") ?? true, "Only the request receipt is saved on the phone")
            connection.pause()
            await connection.resume()
            try await eventually { connection.coreActionsAvailable }
            await connection.prepareVoiceChat()
            try await eventually { connection.voicePhase == "answered" }
            XCTAssertTrue(connection.voiceReply.contains("First pass"))
            XCTAssertFalse(connection.coreIsAssistant, "Voice must not replace the selected terminal resource")
            XCTAssertEqual(try fixture.request(["op": .string("state")])["executionCount"].integer, 1)
        }
        if updatePreferences {
            await connection.refreshCoreUpdates()
            XCTAssertEqual(connection.coreUpdateSnapshot?["remoteUpdatesEnabled"].bool, false)
            await connection.configureCoreUpdates(["remoteUpdatesEnabled": .bool(true), "notificationsEnabled": .bool(false), "monitoringEnabled": .bool(false)])
            XCTAssertEqual(connection.coreUpdateSnapshot?["remoteUpdatesEnabled"].bool, true)
            XCTAssertEqual(connection.coreUpdateSnapshot?["notificationsEnabled"].bool, false)
            await connection.refreshCoreUpdates()
            XCTAssertEqual(connection.coreUpdateSnapshot?["remoteUpdatesEnabled"].bool, true)
            XCTAssertEqual(try fixture.request(["op": .string("state")])["executionCount"].integer, 0)
        }
        if overlayResume {
            var outages: [String] = []
            connection.onCoreAvailability = { available, message in if !available { outages.append(message) } }
            for _ in 0..<3 { await connection.resume(); XCTAssertTrue(connection.coreActionsAvailable) }
            XCTAssertTrue(outages.isEmpty, "Inactive overlays must preserve the healthy scoped connection")
            XCTAssertEqual(try fixture.request(["op": .string("state")])["subscriptions"].integer, 1)
        }
        if closeCLI || failMetrics {
            var outages: [String] = []
            connection.onCoreAvailability = { available, message in if !available { outages.append(message) } }
            if closeCLI {
                let attached = try fixture.request(["op": .string("cli-attach")])
                XCTAssertEqual(attached["attached"].bool, true)
                XCTAssertEqual(attached["ownsInput"].bool, true)
                let closed = try fixture.request(["op": .string("cli-close")])
                XCTAssertEqual(closed["closed"].bool, true)
                XCTAssertEqual(closed["ownsInput"].bool, false, "The real CLI close path releases its own lease")
            }
            if failMetrics { _ = try fixture.request(["op": .string("metrics-failure")]) }
            // Cross both heartbeat expiry (8s) and the normal session refresh
            // interval (12s), so a cached healthy state cannot pass this check.
            let deadline = Date().addingTimeInterval(13)
            while Date() < deadline {
                try await Task.sleep(for: .milliseconds(100))
                guard connection.coreActionsAvailable && outages.isEmpty else {
                    XCTFail("Healthy scoped Core lost readiness: \(outages), \(connection.coreError ?? "no error")")
                    break
                }
            }
            let state = try fixture.request(["op": .string("state")])
            XCTAssertEqual(state["gateway"].string, "ready")
            XCTAssertEqual(state["subscriptions"].integer, 1)
            XCTAssertEqual(state["activeGrants"].integer, 1)
            XCTAssertEqual(state["executionCount"].integer, 0)
            XCTAssertTrue(connection.coreActionsAvailable)
            XCTAssertTrue(outages.isEmpty)
            if failMetrics {
                XCTAssertGreaterThanOrEqual(state["metricsFailures"].integer ?? 0, 2)
                XCTAssertNil(connection.hostMetrics, "Missing metrics must remain honest while a session heartbeat proves readiness")
            }
        }
        connection.pause()
        XCTAssertTrue(connection.corePairAuthorized)
        XCTAssertFalse(connection.coreActionsAvailable)
        await connection.resume()
        do { try await eventually { connection.coreActionsAvailable } }
        catch { print("HANDOFF reconnect failed:", connection.coreError ?? "none", connection.hostStatus, connection.status, connection.errorMessage ?? "none"); throw error }
        let state = try fixture.request(["op": .string("state")])
        XCTAssertEqual(state["executionCount"].integer, goals && allowTakeover ? 3 : voiceChat ? 1 : 0, "Pairing and reconnecting observe only")
        XCTAssertEqual(state["coordinatorConfigured"].bool, voiceChat)
        XCTAssertEqual(state["activeGrants"].integer, 1)
        if goals && allowTakeover {
            XCTAssertFalse(connection.canResumeStalledGoal, "A completed goal keeps the shortcut disabled")
            let stalled = try fixture.request(["op": .string("goal-stall")])
            await connection.refreshCore()
            try await eventually { connection.canResumeStalledGoal }
            XCTAssertEqual(connection.coreGoalID, stalled["goalID"].string)
            let accepted = await connection.resumeStalledCoreGoal(sessionID: connection.coreSessionID)
            XCTAssertTrue(accepted)
            try await eventually { try fixture.request(["op": .string("goal-state")])["status"].string == "complete" }
            await connection.refreshCore()
            XCTAssertFalse(connection.canResumeStalledGoal)
            let resumed = try fixture.request(["op": .string("goal-state")])
            XCTAssertEqual(resumed["goalID"].string, stalled["goalID"].string)
            XCTAssertEqual(resumed["executionCount"].integer, 4, "A shortcut continues the saved goal exactly once")
        }
        if failMetrics {
            XCTAssertEqual(try fixture.request(["op": .string("core-stop")])["stopped"].bool, true)
            try await eventually { !connection.coreActionsAvailable }
            XCTAssertEqual(connection.status, .connected, "Relay can remain online while Core is explicitly stopped")
            XCTAssertTrue(connection.corePairAuthorized, "An offline Core does not revoke the valid pairing")
            XCTAssertFalse(connection.coreActionsAvailable, "A failed fallback must lock Core-dependent actions")
            XCTAssertFalse(connection.connectionOnline, "Relay availability cannot make the bottom indicator green")
            await connection.refreshCoreSessions()
            XCTAssertFalse(connection.connectionOnline)
            XCTAssertEqual(try fixture.request(["op": .string("core-restart")])["restarted"].bool, true)
            try await eventually { connection.connectionOnline }
            XCTAssertTrue(connection.coreActionsAvailable, "Actions reactivate automatically after a fresh Core response")
            await connection.refreshCoreSessions()
            XCTAssertNil(connection.coreError)
        }
    }

    @MainActor private func eventually(_ condition: () throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if try condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw CoreApplicationError("PAIRING_FIXTURE_TIMEOUT")
    }
}

private final class PairingConnectionFixture {
    private let process = Process(), input = Pipe(), output = Pipe(), errors = Pipe()
    private var buffer = Data(), stopped = false
    init() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [ProcessInfo.processInfo.environment["BZZY_TEST_NODE"] ?? "node", root.appendingPathComponent("tools/pairing-connection-fixture.mjs").path]
        let allowed = Set(["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "SHELL", "USER", "LOGNAME"])
        process.environment = ProcessInfo.processInfo.environment.filter { allowed.contains($0.key) }
        let version = Process(), versionOutput = Pipe()
        version.executableURL = process.executableURL; version.arguments = [process.arguments![0], "--version"]
        version.environment = process.environment; version.standardOutput = versionOutput; version.standardError = FileHandle.nullDevice
        try version.run(); version.waitUntilExit()
        let text = String(decoding: versionOutput.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard version.terminationStatus == 0, let major = Int(text.dropFirst().split(separator: ".").first ?? ""), major >= 24 else {
            throw XCTSkip("Pairing integration requires Node.js 24+; set BZZY_TEST_NODE and PATH")
        }
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        try process.run()
    }
    func request(_ fields: [String: WireValue]) throws -> WireValue {
        try input.fileHandleForWriting.write(contentsOf: WireValue.object(fields).data() + Data([10]))
        while !buffer.contains(10) {
            let next = output.fileHandleForReading.availableData
            guard !next.isEmpty, buffer.count + next.count <= 65_536 else { throw CoreApplicationError("PAIRING_FIXTURE_PROCESS_FAILED") }
            buffer.append(next)
        }
        let newline = buffer.firstIndex(of: 10)!
        let data = buffer.prefix(upTo: newline); buffer.removeSubrange(...newline)
        let frame = try WireValue.parse(Data(data))
        guard frame["ok"].bool == true else { throw CoreApplicationError("PAIRING_FIXTURE_" + (frame["error"].string ?? "FAILED")) }
        return frame["result"]
    }
    func shutdown() {
        guard !stopped else { return }; stopped = true
        if process.isRunning {
            _ = try? request(["op": .string("stop")])
            try? input.fileHandleForWriting.close(); process.waitUntilExit()
        }
    }
    deinit { if process.isRunning { process.terminate() } }
}
