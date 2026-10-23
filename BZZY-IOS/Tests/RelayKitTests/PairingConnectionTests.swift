import XCTest
@testable import RelayKit

final class PairingConnectionTests: XCTestCase {
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
                                        closeCLI: Bool = false, failMetrics: Bool = false, overlayResume: Bool = false, updatePreferences: Bool = false, voiceChat: Bool = false) async throws {
        let fixture = try PairingConnectionFixture()
        defer { fixture.shutdown() }
        let identity = try RelayIdentity.generate()
        let configuration = try fixture.request(["op": .string("start"), "certificate": try RelayWire.object(identity.certificate)])
        XCTAssertEqual(configuration["coordinatorConfigured"].bool, false)
        let endpoint = try XCTUnwrap(URL(string: try XCTUnwrap(configuration["endpoint"].string)))
        let transport = try RelayTransport(identity: identity, loopbackEndpoint: endpoint)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("bzzy-pair-projection-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var savedAuthorization: Data?
        let connection = try RelayConnection(isolatedIdentity: identity, loopbackTransport: transport,
            projectionDirectory: directory, loadAuthorization: { savedAuthorization }, saveAuthorization: { savedAuthorization = $0 })
        defer { connection.pause() }
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
        XCTAssertEqual(connection.corePermissions, Set(["observe", "claim", "takeover", "execute", "answer", "pause", "cancel", "steer"]))
        XCTAssertTrue(availabilityFailures.isEmpty, "Approval must not cancel its own initial Core read: \(availabilityFailures)")
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
        try await eventually { connection.coreActionsAvailable }
        let state = try fixture.request(["op": .string("state")])
        XCTAssertEqual(state["executionCount"].integer, voiceChat ? 1 : 0, "Pairing and reconnecting observe only")
        XCTAssertEqual(state["coordinatorConfigured"].bool, voiceChat)
        XCTAssertEqual(state["activeGrants"].integer, 1)
        if failMetrics {
            XCTAssertEqual(try fixture.request(["op": .string("core-stop")])["stopped"].bool, true)
            try await eventually { !connection.coreActionsAvailable }
            XCTAssertEqual(connection.status, .connected, "Relay can remain online while Core is explicitly stopped")
            XCTAssertTrue(connection.corePairAuthorized, "An offline Core does not revoke the valid pairing")
            XCTAssertFalse(connection.coreActionsAvailable, "A failed fallback must lock Core-dependent actions")
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
