import XCTest
@testable import RelayKit

final class CoreHostProfileTests: XCTestCase {
    func testSingleHostMigrationPreservesEveryDurableRecoveryField() throws {
        let identity = try RelayIdentity.generate(), session = UUID().uuidString, request = UUID().uuidString
        let host = identity.certificate.id
        var legacy = SavedRelayState()
        legacy.host = HostBinding(certificate: identity.certificate, grantID: "synthetic-grant", expiresAt: RelayWire.now + 60_000)
        legacy.corePairValidated = true
        legacy.pendingVoice = PendingVoiceTurn(hostID: host, grantID: "synthetic-grant", requestID: request)
        legacy.pendingUpdate = PendingCoreUpdate(hostID: host, grantID: "synthetic-grant", requestID: request, target: "synthetic-revision")
        legacy.pending = PendingPair(claimID: "synthetic-claim", expectedFingerprint: host, expectedCertificate: identity.certificate, expiresAt: RelayWire.now + 20_000)
        let command = PendingCoreCommand(hostID: host, resource: "synthetic-resource", id: request, op: "execution.execute", params: ["prompt": .string("fixture only")])
        legacy.pendingCoreCommand = command; legacy.pendingCoreCommands = [command]; legacy.pendingAgentCommand = command
        legacy.taskID = "synthetic-task"
        legacy.coreCacheScope = CoreCacheScope(hostID: host, resource: "synthetic-resource", sessionID: session)
        legacy.coreCacheScopes = [legacy.coreCacheScope!]
        legacy.selectedSession = SelectedCoreSession(sessionID: session, resource: "synthetic-resource", kind: "agent", agentID: UUID().uuidString)
        legacy.openingSession = PendingSessionOpen(sessionID: session, requestID: request)
        legacy.openingAgent = PendingAgentOpen(agentID: UUID().uuidString, requestID: request)
        legacy.agentImport = AgentImportReference(hostID: host, grantID: "synthetic-grant", sourceFingerprint: host, requestID: request, importID: UUID().uuidString)
        let bytes = try JSONEncoder().encode(legacy), migrated = try SavedCoreHosts.decode(bytes)
        XCTAssertEqual(migrated.profiles.count, 1)
        XCTAssertEqual(migrated.defaultHostID, host); XCTAssertEqual(migrated.activeHostID, host)
        XCTAssertEqual(migrated.profiles[0].name, "Test Mac")
        let original = try JSONSerialization.jsonObject(with: bytes) as! NSDictionary
        let preserved = try JSONSerialization.jsonObject(with: JSONEncoder().encode(migrated.profiles[0].state)) as! NSDictionary
        XCTAssertEqual(original, preserved)
        XCTAssertEqual(try SavedCoreHosts.decode(JSONEncoder().encode(migrated)).profiles[0].id, host)
    }

    func testProfileCollectionRejectsDuplicateAndMisboundIdentities() throws {
        let identity = try RelayIdentity.generate(), other = try RelayIdentity.generate()
        var state = SavedRelayState()
        state.host = HostBinding(certificate: identity.certificate, grantID: "synthetic-grant", expiresAt: RelayWire.now + 60_000)
        let valid = SavedCoreHost(id: identity.certificate.id, name: "Test", state: state)
        XCTAssertThrowsError(try SavedCoreHosts.decode(JSONEncoder().encode(SavedCoreHosts(profiles: [valid, valid]))))
        let wrong = SavedCoreHost(id: other.certificate.id, name: "Wrong", state: state)
        XCTAssertThrowsError(try SavedCoreHosts.decode(JSONEncoder().encode(SavedCoreHosts(profiles: [wrong]))))
        XCTAssertThrowsError(try SavedCoreHosts.decode(JSONEncoder().encode(SavedCoreHosts(profiles: [valid], defaultHostID: other.certificate.id))))
    }

    @MainActor func testTwoRealCoresOnOneRelayMigrateSwitchDefaultOfflineAndRevokeIndependently() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.shutdown() }
        let identity = try RelayIdentity.generate()
        let configuration = try fixture.request(["op": .string("start"), "certificate": try RelayWire.object(identity.certificate)])
        let endpoint = try XCTUnwrap(URL(string: try XCTUnwrap(configuration["endpoint"].string)))
        let first = configuration["hosts"].array![0], second = configuration["hosts"].array![1]
        let firstID = try XCTUnwrap(first["host"]["id"].string), secondID = try XCTUnwrap(second["host"]["id"].string)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("bzzy-multi-host-projection-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var authorization: Data?
        func makeConnection() throws -> RelayConnection {
            try RelayConnection(isolatedIdentity: identity, loopbackTransport: RelayTransport(identity: identity, loopbackEndpoint: endpoint),
                projectionDirectory: directory, loadAuthorization: { authorization }, saveAuthorization: { authorization = $0 })
        }
        let original = try makeConnection(); defer { original.pause() }
        await original.connect()
        original.previewPairing(try XCTUnwrap(first["qr"].string)); await original.claimConfirmedHost()
        try await eventually { try fixture.request(["op": .string("state"), "host": .number(0)])["pendingCount"].integer == 1 }
        _ = try fixture.request(["op": .string("approve"), "host": .number(0)])
        try await eventually { original.coreActionsAvailable }
        original.pause()
        // Exercise the real legacy device migration with an unresolved command.
        let collection = try JSONDecoder().decode(SavedCoreHosts.self, from: XCTUnwrap(authorization))
        var legacy = collection.profiles[0].state
        let unknownID = UUID().uuidString, scope = try XCTUnwrap(legacy.coreCacheScope)
        legacy.pendingCoreCommand = PendingCoreCommand(hostID: firstID, resource: scope.resource, id: unknownID,
            op: "execution.execute", params: ["owner": .string(UUID().uuidString), "prompt": .string("never dispatched fixture")])
        authorization = try JSONEncoder().encode(legacy)
        let connection = try makeConnection(); defer { connection.pause() }
        var visible: [CoreJSONValue] = [], catalog: [CoreJSONValue] = [], cleared = 0
        connection.onCoreEvents = { visible = $0.compactMap { try? JSONDecoder().decode(CoreJSONValue.self, from: $0) } }
        connection.onCoreSessions = { catalog = (try? JSONDecoder().decode([CoreJSONValue].self, from: $0)) ?? [] }
        connection.onCoreCleared = { visible = []; catalog = []; cleared += 1; XCTAssertFalse(connection.coreActionsAvailable) }
        await connection.connect()
        try await eventually { connection.coreActionsAvailable && visible.contains { $0["data"]["text"].string == "Test Mac private answer" } }
        XCTAssertEqual(connection.hosts.first?.name, "Test Mac"); XCTAssertEqual(connection.defaultHostID, firstID)
        let syntheticPushToken = String(repeating: "a", count: 64)
        _ = await connection.synchronizeCoreNotifications(token: syntheticPushToken, environment: "sandbox", enabled: true)
        XCTAssertEqual(try fixture.request(["op": .string("state"), "host": .number(0)])["notificationHostHints"].array, [.bool(true)])
        connection.beginAddingHost()
        XCTAssertTrue(connection.coreActionsAvailable, "Adding a computer retains the currently authorized workspace until approval")
        connection.cancelAddingHost(); XCTAssertEqual(connection.activeHostID, firstID)
        connection.beginAddingHost()
        connection.previewPairing(try XCTUnwrap(second["qr"].string)); await connection.claimConfirmedHost()
        XCTAssertEqual(connection.activeHostID, firstID); XCTAssertTrue(connection.coreActionsAvailable)
        try await eventually { try fixture.request(["op": .string("state"), "host": .number(1)])["pendingCount"].integer == 1 }
        _ = try fixture.request(["op": .string("approve"), "host": .number(1)])
        try await eventually { connection.activeHostID == secondID && connection.coreActionsAvailable }
        try await eventually { visible.contains { $0["data"]["text"].string == "Real server private answer" } }
        XCTAssertEqual(connection.hosts.count, 2); XCTAssertEqual(connection.defaultHostID, firstID)
        _ = await connection.synchronizeCoreNotifications(token: syntheticPushToken, environment: "sandbox", enabled: true)
        XCTAssertEqual(try fixture.request(["op": .string("state"), "host": .number(1)])["notificationHostHints"].array, [.bool(true)])
        XCTAssertFalse(String(data: authorization ?? Data(), encoding: .utf8)?.contains(syntheticPushToken) ?? true)
        XCTAssertFalse(connection.isAddingHost); XCTAssertGreaterThan(cleared, 0)
        XCTAssertFalse(visible.contains { $0["data"]["text"].string?.contains("Test Mac") == true })
        await connection.refreshCoreSessions()
        XCTAssertEqual(catalog.map { $0["alias"].string }, ["Real server"])
        connection.renameHost(secondID, name: "Real server"); connection.setDefaultHost(secondID)
        XCTAssertEqual(connection.hostProfileID(forNotificationHostID: secondID), secondID)
        XCTAssertNil(connection.hostProfileID(forNotificationHostID: String(repeating: "x", count: 43)))
        // A former host's live delivery cannot enter the selected projection.
        _ = try fixture.request(["op": .string("append"), "host": .number(0), "text": .string("Test Mac inactive tail")])
        await connection.refreshCore()
        XCTAssertFalse(visible.contains { $0["data"]["text"].string == "Test Mac inactive tail" })
        await connection.activateHost(firstID)
        try await eventually { connection.coreActionsAvailable && visible.contains { $0["data"]["text"].string == "Test Mac inactive tail" } }
        XCTAssertTrue(connection.hasUncertainCoreCommand(sessionID: connection.coreSessionID))
        XCTAssertEqual(Set(visible.compactMap { $0["id"].string }).count, visible.count, "Returning to a computer deduplicates exact event IDs")
        let saved = try JSONDecoder().decode(SavedCoreHosts.self, from: XCTUnwrap(authorization))
        let savedFirst = try XCTUnwrap(saved.profiles.first { $0.id == firstID })
        XCTAssertEqual(savedFirst.state.pendingCoreCommand?.id ?? savedFirst.state.pendingCoreCommands?.first?.id, unknownID)
        XCTAssertEqual(connection.defaultHostID, secondID)
        // Offline default remains the selected target even with another online host.
        _ = try fixture.request(["op": .string("offline"), "host": .number(1)])
        await connection.activateHost(secondID)
        XCTAssertEqual(connection.activeHostID, secondID); XCTAssertFalse(connection.coreActionsAvailable)
        XCTAssertTrue(connection.corePairAuthorized); XCTAssertTrue(connection.hosts.contains { $0.id == secondID })
        await connection.resume(); XCTAssertEqual(connection.activeHostID, secondID)
        await connection.activateHost(firstID)
        try await eventually { connection.coreActionsAvailable }
        connection.pause()
        let cold = try makeConnection(); defer { cold.pause() }
        await cold.connect()
        XCTAssertEqual(cold.activeHostID, secondID, "A cold launch chooses the saved default, regardless of last selected computer")
        XCTAssertFalse(cold.coreActionsAvailable); XCTAssertTrue(cold.corePairAuthorized)
        await cold.resume(); XCTAssertEqual(cold.activeHostID, secondID)
        _ = try fixture.request(["op": .string("revoke"), "host": .number(0)])
        try await eventually { cold.hosts.first { $0.id == firstID }?.isPaired == false }
        XCTAssertTrue(cold.corePairAuthorized); XCTAssertEqual(cold.defaultHostID, secondID)
        _ = try fixture.request(["op": .string("online"), "host": .number(1)])
        await cold.refresh()
        try await eventually { cold.coreActionsAvailable }
        await cold.forgetHost(firstID)
        XCTAssertEqual(cold.hosts.map(\.id), [secondID]); XCTAssertTrue(cold.coreActionsAvailable)
        for host in 0...1 {
            XCTAssertEqual(try fixture.request(["op": .string("state"), "host": .number(Double(host))])["executionCount"].integer, 0,
                "Pairing, migration, switching, cold launch and reconnect must never submit model work")
        }
    }

    @MainActor func testSwitchingAndReconnectLeaveAnExistingOfflineFixtureTurnRunningExactlyOnce() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.shutdown() }
        let identity = try RelayIdentity.generate()
        let configuration = try fixture.request(["op": .string("start"), "certificate": try RelayWire.object(identity.certificate)])
        let endpoint = try XCTUnwrap(URL(string: try XCTUnwrap(configuration["endpoint"].string)))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("bzzy-multi-host-running-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var authorization: Data?
        let connection = try RelayConnection(isolatedIdentity: identity,
            loopbackTransport: RelayTransport(identity: identity, loopbackEndpoint: endpoint), projectionDirectory: directory,
            loadAuthorization: { authorization }, saveAuthorization: { authorization = $0 })
        defer { connection.pause() }
        await connection.connect()
        let hosts = try XCTUnwrap(configuration["hosts"].array)
        for index in 0...1 {
            if index > 0 { connection.beginAddingHost() }
            connection.previewPairing(try XCTUnwrap(hosts[index]["qr"].string)); await connection.claimConfirmedHost()
            try await eventually { try fixture.request(["op": .string("state"), "host": .number(Double(index))])["pendingCount"].integer == 1 }
            _ = try fixture.request(["op": .string("approve"), "host": .number(Double(index))])
            try await eventually { connection.activeHostID == hosts[index]["host"]["id"].string && connection.coreActionsAvailable }
        }
        let firstID = try XCTUnwrap(hosts[0]["host"]["id"].string), secondID = try XCTUnwrap(hosts[1]["host"]["id"].string)
        await connection.activateHost(firstID)
        try await eventually { connection.coreActionsAvailable }
        let accepted = await connection.sendCoreMessage("HOLD_LINE_INTEGRATION")
        XCTAssertTrue(accepted)
        try await eventually { try fixture.request(["op": .string("state"), "host": .number(0)])["executions"].array?.first?["state"].string == "running" }
        let started = try fixture.request(["op": .string("state"), "host": .number(0)])
        let executionID = try XCTUnwrap(started["executions"].array?.first?["id"].string)
        await connection.activateHost(secondID)
        try await eventually { connection.coreActionsAvailable }
        for _ in 0..<3 { await connection.resume() }
        await connection.activateHost(firstID)
        try await eventually { connection.coreActionsAvailable }
        connection.pause(); await connection.resume()
        try await eventually { connection.coreActionsAvailable }
        let continued = try fixture.request(["op": .string("state"), "host": .number(0)])
        XCTAssertEqual(continued["executionCount"].integer, 1)
        XCTAssertEqual(continued["executions"].array?.first?["id"].string, executionID)
        XCTAssertEqual(continued["executions"].array?.first?["state"].string, "running",
            "Changing the observed computer and backgrounding cannot pause/cancel the existing Core turn")
        XCTAssertEqual(try fixture.request(["op": .string("state"), "host": .number(1)])["executionCount"].integer, 0)
    }

    @MainActor func testNotificationRegistrationOmitsHostHintsUntilCoreAdvertisesSupport() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.shutdown() }
        let identity = try RelayIdentity.generate()
        let configuration = try fixture.request(["op": .string("start"), "certificate": try RelayWire.object(identity.certificate), "advertiseHostHints": .bool(false)])
        let endpoint = try XCTUnwrap(URL(string: try XCTUnwrap(configuration["endpoint"].string)))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("bzzy-host-hint-compatibility-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var authorization: Data?
        let connection = try RelayConnection(isolatedIdentity: identity,
            loopbackTransport: RelayTransport(identity: identity, loopbackEndpoint: endpoint), projectionDirectory: directory,
            loadAuthorization: { authorization }, saveAuthorization: { authorization = $0 })
        defer { connection.pause() }
        await connection.connect()
        connection.previewPairing(try XCTUnwrap(configuration["hosts"].array?[0]["qr"].string)); await connection.claimConfirmedHost()
        try await eventually { try fixture.request(["op": .string("state"), "host": .number(0)])["pendingCount"].integer == 1 }
        _ = try fixture.request(["op": .string("approve"), "host": .number(0)])
        try await eventually { connection.coreActionsAvailable }
        _ = await connection.synchronizeCoreNotifications(token: String(repeating: "b", count: 64), environment: "sandbox", enabled: true)
        XCTAssertEqual(try fixture.request(["op": .string("state"), "host": .number(0)])["notificationHostHints"].array, [.bool(false)],
            "Legacy Core receives its original registration schema; routing hints require advertised support")
    }

    @MainActor func testPhoneNotificationPreferenceUpdatesEveryHostAndForgettingRevokesOnlyItsBinding() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.shutdown() }
        let identity = try RelayIdentity.generate()
        let configuration = try fixture.request(["op": .string("start"), "certificate": try RelayWire.object(identity.certificate)])
        let endpoint = try XCTUnwrap(URL(string: try XCTUnwrap(configuration["endpoint"].string)))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("bzzy-all-host-notifications-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var authorization: Data?
        let connection = try RelayConnection(isolatedIdentity: identity,
            loopbackTransport: RelayTransport(identity: identity, loopbackEndpoint: endpoint), projectionDirectory: directory,
            loadAuthorization: { authorization }, saveAuthorization: { authorization = $0 })
        defer { connection.pause() }
        await connection.connect()
        let hosts = try XCTUnwrap(configuration["hosts"].array)
        for index in 0...1 {
            if index > 0 { connection.beginAddingHost() }
            connection.previewPairing(try XCTUnwrap(hosts[index]["qr"].string)); await connection.claimConfirmedHost()
            try await eventually { try fixture.request(["op": .string("state"), "host": .number(Double(index))])["pendingCount"].integer == 1 }
            _ = try fixture.request(["op": .string("approve"), "host": .number(Double(index))])
            try await eventually { connection.activeHostID == hosts[index]["host"]["id"].string && connection.coreActionsAvailable }
        }
        let firstID = try XCTUnwrap(hosts[0]["host"]["id"].string), secondID = try XCTUnwrap(hosts[1]["host"]["id"].string)
        let selectedSession = connection.coreSessionID
        var clearCount = 0
        connection.onCoreCleared = { clearCount += 1 }
        let token = String(repeating: "c", count: 64)
        func state(_ host: Int) throws -> WireValue { try fixture.request(["op": .string("state"), "host": .number(Double(host))]) }
        func enabled(_ host: Int) throws -> Bool? { try state(host)["notificationBindings"].array?.first?["enabled"].bool }
        _ = await connection.synchronizeAllCoreNotifications(token: token, environment: "sandbox", enabled: true)
        for host in 0...1 { XCTAssertEqual(try enabled(host), true) }
        let callsBefore = try (0...1).map { try state($0)["notificationCalls"].array?.count }
        _ = await connection.synchronizeAllCoreNotifications(token: token, environment: "sandbox", enabled: true)
        XCTAssertEqual(try (0...1).map { try state($0)["notificationCalls"].array?.count }, callsBefore, "Unchanged bindings skip repeat writes")
        _ = await connection.synchronizeAllCoreNotifications(token: nil, environment: "sandbox", enabled: false)
        for host in 0...1 { XCTAssertEqual(try enabled(host), false) }
        XCTAssertEqual(connection.activeHostID, secondID); XCTAssertEqual(connection.coreSessionID, selectedSession)
        _ = await connection.synchronizeAllCoreNotifications(token: nil, environment: "sandbox", enabled: true)
        for host in 0...1 { XCTAssertEqual(try enabled(host), false, "Enabling waits for a fresh Apple token") }
        _ = await connection.synchronizeAllCoreNotifications(token: token, environment: "sandbox", enabled: true)
        for host in 0...1 { XCTAssertEqual(try enabled(host), true) }
        // Hold A's disable response after its durable write, then supersede that
        // plan. The latest enable must not trust the pre-disable cached hash.
        _ = try fixture.request(["op": .string("hold-notification-responses"), "host": .number(0)])
        let disabling = Task { await connection.synchronizeAllCoreNotifications(token: nil, environment: "sandbox", enabled: false) }
        try await eventually { try enabled(0) == false }
        let enabling = Task { await connection.synchronizeAllCoreNotifications(token: token, environment: "sandbox", enabled: true) }
        await Task.yield()
        _ = try fixture.request(["op": .string("release-notification-responses"), "host": .number(0)])
        _ = await disabling.value; _ = await enabling.value
        for host in 0...1 { XCTAssertEqual(try enabled(host), true) }
        await connection.forgetHost(firstID)
        XCTAssertEqual(try state(0)["notificationBindings"].array?.first?["revoked"].bool, true)
        XCTAssertEqual(try state(0)["notificationBindings"].array?.first?["hasToken"].bool, false)
        XCTAssertEqual(try enabled(1), true)
        XCTAssertEqual(connection.activeHostID, secondID); XCTAssertEqual(connection.coreSessionID, selectedSession)
        XCTAssertEqual(clearCount, 0, "Notification synchronization and inactive removal cannot change the visible workspace")
        for host in 0...1 {
            XCTAssertEqual(try state(host)["controlCalls"].array, [])
            XCTAssertEqual(try state(host)["executionCount"].integer, 0)
        }
        XCTAssertFalse(String(data: authorization ?? Data(), encoding: .utf8)?.contains(token) ?? true)
    }

    @MainActor private func eventually(_ condition: () throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if try condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw CoreApplicationError("MULTI_HOST_FIXTURE_TIMEOUT")
    }
}

private final class MultiHostFixture {
    private let process = Process(), input = Pipe(), output = Pipe(), errors = Pipe()
    private var buffer = Data(), stopped = false
    init() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [ProcessInfo.processInfo.environment["BZZY_TEST_NODE"] ?? "node", root.appendingPathComponent("tools/multi-host-fixture.mjs").path]
        let allowed = Set(["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "SHELL", "USER", "LOGNAME"])
        process.environment = ProcessInfo.processInfo.environment.filter { allowed.contains($0.key) }
        let version = Process(), versionOutput = Pipe()
        version.executableURL = process.executableURL; version.arguments = [process.arguments![0], "--version"]
        version.environment = process.environment; version.standardOutput = versionOutput; version.standardError = FileHandle.nullDevice
        try version.run(); version.waitUntilExit()
        let text = String(decoding: versionOutput.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard version.terminationStatus == 0, let major = Int(text.dropFirst().split(separator: ".").first ?? ""), major >= 24 else {
            throw XCTSkip("Multi-host integration requires Node.js 24+; set BZZY_TEST_NODE and PATH")
        }
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        try process.run()
    }
    func request(_ fields: [String: WireValue]) throws -> WireValue {
        try input.fileHandleForWriting.write(contentsOf: WireValue.object(fields).data() + Data([10]))
        while !buffer.contains(10) {
            let next = output.fileHandleForReading.availableData
            guard !next.isEmpty, buffer.count + next.count <= 65_536 else { throw CoreApplicationError("MULTI_HOST_PROCESS_FAILED") }
            buffer.append(next)
        }
        let newline = buffer.firstIndex(of: 10)!
        let data = buffer.prefix(upTo: newline); buffer.removeSubrange(...newline)
        let frame = try WireValue.parse(Data(data))
        guard frame["ok"].bool == true else { throw CoreApplicationError("MULTI_HOST_FIXTURE_FAILED") }
        return frame["result"]
    }
    func shutdown() {
        guard !stopped else { return }; stopped = true
        if process.isRunning { _ = try? request(["op": .string("stop")]); try? input.fileHandleForWriting.close(); process.waitUntilExit() }
        try? input.fileHandleForWriting.close(); try? output.fileHandleForReading.close(); try? errors.fileHandleForReading.close()
    }
}
