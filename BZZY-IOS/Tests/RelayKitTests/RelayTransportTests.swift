import XCTest
@testable import RelayKit

final class RelayTransportTests: XCTestCase {
    func testApprovedPairBudgetsStayIndependentFromAdministrationAndEachOther() throws {
        var budget = RelayRequestBudget()
        for _ in 0..<240 { try budget.consume(dataGrantID: nil, now: 100) }
        XCTAssertThrowsError(try budget.consume(dataGrantID: nil, now: 100))
        for _ in 0..<4096 { try budget.consume(dataGrantID: "approved-pair", now: 100) }
        XCTAssertThrowsError(try budget.consume(dataGrantID: "approved-pair", now: 100))
        try budget.consume(dataGrantID: "other-approved-pair", now: 100)
        try budget.consume(dataGrantID: nil, now: 160)
        try budget.consume(dataGrantID: "approved-pair", now: 160)
    }

    func testTransientDeliveryFailuresRequireReconnectionButUntrustedContentDoesNot() {
        for code in ["RATE_LIMITED", "REQUEST_CAPACITY", "BACKPRESSURE", "UNCERTAIN", "DELIVERY_UNAVAILABLE"] {
            XCTAssertTrue(RelayTransport.requiresReconnect(RelayFailure(code)))
        }
        for code in ["REPLAY", "DECRYPTION_FAILED", "ROUTING_MISMATCH", "UNTRUSTED_PEER", "GRANT_UNAVAILABLE"] {
            XCTAssertFalse(RelayTransport.requiresReconnect(RelayFailure(code)))
        }
    }

    @MainActor func testNativeApprovedPairStreamsBeyondFormer240RequestLimit() async throws {
        try await checkStream(count: 130, serverDataLimit: nil)
    }

    @MainActor func testNativeFailedTransportReceiptReconnectsWithoutDispatchingUnacknowledgedPayload() async throws {
        // One initial host inspection plus two sends exhaust its three requests;
        // the phone's fourth request is its second receipt and is rejected.
        try await checkStream(count: 2, serverDataLimit: 3)
    }

    @MainActor private func checkStream(count: Int, serverDataLimit: Int?) async throws {
        let fixture = try TransportFixture(); defer { fixture.shutdown() }
        let identity = try RelayIdentity.generate()
        var start: [String: WireValue] = ["op": .string("start")]
        if let serverDataLimit { start["dataLimit"] = .number(Double(serverDataLimit)) }
        let configuration = try fixture.request(start)
        let endpoint = try XCTUnwrap(URL(string: try XCTUnwrap(configuration["endpoint"].string)))
        let transport = try RelayTransport(identity: identity, loopbackEndpoint: endpoint)
        defer { transport.disconnect() }
        try transport.trust(RelayCertificate.parse(configuration["host"]))
        _ = try await transport.connect()
        _ = try await transport.request("invite.claim", fields: ["code": configuration["code"]])
        _ = try fixture.request(["op": .string("approve"), "certificate": try RelayWire.object(identity.certificate)])
        var delivered: [Int64] = [], failures: [String] = []
        transport.onPayload = { _, _, payload in if let index = payload["index"].integer { delivered.append(index) } }
        transport.onFailure = { failures.append($0.code) }
        _ = try fixture.request(["op": .string("burst"), "count": .number(Double(count))])
        let deadline = ProcessInfo.processInfo.systemUptime + 12
        while ProcessInfo.processInfo.systemUptime < deadline, delivered.count < count, failures.isEmpty {
            try await Task.sleep(for: .milliseconds(20))
        }
        if serverDataLimit != nil {
            XCTAssertEqual(delivered, [0], "A failed receipt must not dispatch its payload")
            XCTAssertEqual(failures, ["RATE_LIMITED"], "The connection must visibly recover instead of silently dropping a frame")
            XCTAssertFalse(transport.online)
        } else {
            XCTAssertTrue(failures.isEmpty)
            XCTAssertEqual(delivered.sorted(), Array(0..<Int64(count)))
            XCTAssertTrue(transport.online)
            XCTAssertEqual(try fixture.request(["op": .string("state")])["received"].integer, Int64(count))
        }
    }
}

private final class TransportFixture {
    private let process = Process(), input = Pipe(), output = Pipe()
    private var buffer = Data(), stopped = false
    init() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [ProcessInfo.processInfo.environment["BZZY_TEST_NODE"] ?? "node", root.appendingPathComponent("tools/relay-transport-fixture.mjs").path]
        let allowed = Set(["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"])
        process.environment = ProcessInfo.processInfo.environment.filter { allowed.contains($0.key) }
        let version = Process(), versionOutput = Pipe()
        version.executableURL = process.executableURL; version.arguments = [process.arguments![0], "--version"]
        version.environment = process.environment; version.standardOutput = versionOutput; version.standardError = FileHandle.nullDevice
        try version.run(); version.waitUntilExit()
        let versionText = String(decoding: versionOutput.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard version.terminationStatus == 0, let major = Int(versionText.dropFirst().split(separator: ".").first ?? ""), major >= 24 else {
            throw XCTSkip("Transport integration requires Node.js 24+; set BZZY_TEST_NODE and PATH")
        }
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        try process.run()
    }
    func request(_ fields: [String: WireValue]) throws -> WireValue {
        try input.fileHandleForWriting.write(contentsOf: WireValue.object(fields).data() + Data([10]))
        while !buffer.contains(10) {
            let next = output.fileHandleForReading.availableData
            guard !next.isEmpty, buffer.count + next.count <= 65_536 else { throw RelayFailure("TRANSPORT_FIXTURE_FAILED") }
            buffer.append(next)
        }
        let newline = buffer.firstIndex(of: 10)!, bytes = Data(buffer.prefix(upTo: newline))
        buffer.removeSubrange(...newline)
        let frame = try WireValue.parse(bytes)
        guard frame["ok"].bool == true else { throw RelayFailure("TRANSPORT_FIXTURE_FAILED") }
        return frame["result"]
    }
    func shutdown() {
        guard !stopped else { return }; stopped = true
        if process.isRunning { _ = try? request(["op": .string("stop")]); try? input.fileHandleForWriting.close(); process.waitUntilExit() }
    }
    deinit { if process.isRunning { process.terminate() } }
}
