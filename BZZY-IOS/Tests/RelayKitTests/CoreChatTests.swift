import CryptoKit
import Foundation
import XCTest
@testable import RelayKit

private struct ChatHistoryFixture {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("bzzy-chat-" + UUID().uuidString)
    let host = "fixture-host", grant = "fixture-grant"
    func file(host: String? = nil, grant: String? = nil) -> URL {
        let digest = SHA256.hash(data: Data(((host ?? self.host) + ":" + (grant ?? self.grant)).utf8))
            .map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("AssessmentChat").appendingPathComponent(digest + ".json")
    }
    func message(_ index: Int, text: String? = nil) -> CoreChatMessage {
        .init(id: "message-\(index)", text: text ?? "Recorded answer \(index)", isUser: index % 2 == 0,
              createdAt: "2026-10-27T12:00:00Z", observedAt: index % 2 == 0 ? nil : "2026-10-27T12:00:00Z")
    }
    func load() throws -> CoreChatHistory { try .load(directory: directory, hostID: host, grantID: grant) }
    func remove() { try? FileManager.default.removeItem(at: directory) }
}

@MainActor private final class ChatWireHarness {
    var client: CoreRelayClient!
    var result: CoreJSONValue?
    var sent: [WireValue] = []
    init() {
        client = CoreRelayClient(hostID: "host", grantID: "grant", resource: "base", timeoutNanoseconds: 25_000_000) { [weak self] frame in
            guard let self else { return }
            self.sent.append(frame)
            guard let result = self.result else { return }
            let response: CoreJSONValue = .object(["v": .number(1), "protocol": .string("bzzy-core"), "type": .string("response"),
                "id": .string(frame["id"].string!), "ok": .bool(true), "result": result])
            try self.client.receive(from: "host", grantID: "grant", payload: response.wire())
        }
    }
}

final class CoreChatTests: XCTestCase {
    func testPrivateHistoryKeepsExactUnicodeBodiesAndHostGrantIsolation() throws {
        let fixture = ChatHistoryFixture(); defer { fixture.remove() }
        let text = "  <message version=\"1\"><p>👩🏽‍💻 e\u{301} 漢字 &amp; evidence</p></message>\n\n"
        let original = fixture.message(1, text: text)
        var history = CoreChatHistory(hostID: fixture.host, grantID: fixture.grant, messages: [original])
        try history.save(directory: fixture.directory)
        XCTAssertEqual(try fixture.load().messages, [original], "Caching preserves the complete canonical body and stable ID")
        XCTAssertEqual(try fixture.load().messages[0].text.utf8.map { $0 }, text.utf8.map { $0 })
        XCTAssertTrue(try CoreChatHistory.load(directory: fixture.directory, hostID: "other-host", grantID: fixture.grant).messages.isEmpty)
        XCTAssertTrue(try CoreChatHistory.load(directory: fixture.directory, hostID: fixture.host, grantID: "other-grant").messages.isEmpty)

        let file = fixture.file()
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: file.deletingLastPathComponent().path)[.posixPermissions] as? NSNumber, NSNumber(value: 0o700))
        XCTAssertEqual(try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        XCTAssertEqual(Set(document.keys), ["hostID", "grantID", "messages"], "The display cache cannot carry execution authority or pending commands")
    }

    func testHistoryRetainsTheNewestHundredAndBoundsTotalBytesWithoutSlicingBodies() throws {
        let fixture = ChatHistoryFixture(); defer { fixture.remove() }
        let messages = (0..<145).map { fixture.message($0) }
        var history = CoreChatHistory(hostID: fixture.host, grantID: fixture.grant, messages: messages)
        try history.save(directory: fixture.directory)
        XCTAssertEqual(history.messages, Array(messages.suffix(100)))
        XCTAssertEqual(try fixture.load().messages, Array(messages.suffix(100)))

        let bodies = (0..<100).map { fixture.message($0, text: "\($0):" + String(repeating: "漢", count: 10_000) + "\nEND") }
        history.messages = bodies
        try history.save(directory: fixture.directory)
        let restored = try fixture.load()
        XCTAssertLessThanOrEqual(try Data(contentsOf: fixture.file()).count, 512 * 1024)
        XCTAssertLessThan(restored.messages.count, 100)
        XCTAssertFalse(restored.messages.isEmpty)
        XCTAssertEqual(restored.messages, Array(bodies.suffix(restored.messages.count)), "Byte eviction removes whole older rows rather than altering canonical bodies")
    }

    func testRepeatedAtomicReplacementReloadsOnlyCompleteDocumentsAndPurgeIsScoped() throws {
        let fixture = ChatHistoryFixture(); defer { fixture.remove() }
        var history = CoreChatHistory(hostID: fixture.host, grantID: fixture.grant, messages: [])
        var other = CoreChatHistory(hostID: fixture.host, grantID: "other-grant", messages: [fixture.message(99)])
        try other.save(directory: fixture.directory)
        for index in 0..<8 {
            history.messages.append(fixture.message(index))
            try history.save(directory: fixture.directory)
            XCTAssertEqual(try fixture.load().messages, history.messages)
        }
        try CoreChatHistory.purge(directory: fixture.directory, hostID: fixture.host, grantID: fixture.grant)
        XCTAssertTrue(try fixture.load().messages.isEmpty)
        XCTAssertEqual(try CoreChatHistory.load(directory: fixture.directory, hostID: fixture.host, grantID: "other-grant").messages, other.messages)
    }

    func testHistoryRejectsCorruptOversizedAndMismatchedDocuments() throws {
        let fixture = ChatHistoryFixture(); defer { fixture.remove() }
        var valid = CoreChatHistory(hostID: fixture.host, grantID: fixture.grant, messages: [fixture.message(1)])
        try valid.save(directory: fixture.directory)
        let file = fixture.file()
        for bytes in [Data("{not-json".utf8), Data(repeating: 32, count: 512 * 1024 + 1)] {
            try bytes.write(to: file, options: .atomic)
            XCTAssertThrowsError(try fixture.load())
        }
        let invalid = [
            CoreChatHistory(hostID: "wrong-host", grantID: fixture.grant, messages: valid.messages),
            CoreChatHistory(hostID: fixture.host, grantID: "wrong-grant", messages: valid.messages),
            CoreChatHistory(hostID: fixture.host, grantID: fixture.grant, messages: [fixture.message(1), fixture.message(1)]),
            CoreChatHistory(hostID: fixture.host, grantID: fixture.grant, messages: (0..<101).map { fixture.message($0) }),
            CoreChatHistory(hostID: fixture.host, grantID: fixture.grant, messages: [fixture.message(1, text: String(repeating: "x", count: 32769))]),
            CoreChatHistory(hostID: fixture.host, grantID: fixture.grant, messages: [.init(id: "", text: "body", isUser: true, createdAt: "2026-10-27T12:00:00Z", observedAt: nil)])
        ]
        for history in invalid {
            try JSONEncoder().encode(history).write(to: file, options: .atomic)
            XCTAssertThrowsError(try fixture.load())
        }
    }

    func testHistoryRejectsSymlinkFilesAndFolders() throws {
        let fixture = ChatHistoryFixture(); defer { fixture.remove() }
        var history = CoreChatHistory(hostID: fixture.host, grantID: fixture.grant, messages: [fixture.message(1)])
        try history.save(directory: fixture.directory)
        let file = fixture.file(), target = fixture.directory.appendingPathComponent("outside.json")
        try FileManager.default.moveItem(at: file, to: target)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: target)
        XCTAssertThrowsError(try fixture.load())
        try FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: target, to: file)
        let folder = file.deletingLastPathComponent(), movedFolder = fixture.directory.appendingPathComponent("outside-folder")
        try FileManager.default.moveItem(at: folder, to: movedFolder)
        try FileManager.default.createSymbolicLink(at: folder, withDestinationURL: movedFolder)
        XCTAssertThrowsError(try fixture.load(), "A regular file beneath a symlink directory is not trusted cache storage")
        XCTAssertThrowsError(try history.save(directory: fixture.directory))
    }

    func testInvalidWritesDoNotReplaceAReadableHistory() throws {
        let fixture = ChatHistoryFixture(); defer { fixture.remove() }
        var valid = CoreChatHistory(hostID: fixture.host, grantID: fixture.grant, messages: [fixture.message(1)])
        try valid.save(directory: fixture.directory)
        let invalidRows: [[CoreChatMessage]] = [
            [fixture.message(2), fixture.message(2)],
            [fixture.message(2, text: String(repeating: "x", count: 32769))],
            [.init(id: String(repeating: "x", count: 101), text: "body", isUser: true, createdAt: "2026-10-27T12:00:00Z", observedAt: nil)]
        ]
        for rows in invalidRows {
            var invalid = CoreChatHistory(hostID: fixture.host, grantID: fixture.grant, messages: rows)
            XCTAssertThrowsError(try invalid.save(directory: fixture.directory))
            XCTAssertEqual(try fixture.load().messages, valid.messages, "A failed cache update must leave the preceding complete document readable")
        }
    }

    func testChatProtocolExposesOnlyBoundedAssessmentFieldsAndStableSendCommands() throws {
        XCTAssertNoThrow(try CoreApplicationProtocol.request(op: "chat.status", params: [:], id: "status", resource: "base"))
        let text = "What does the recorded evidence say? 👩🏽‍💻"
        let first = try CoreApplicationProtocol.request(op: "chat.send", params: ["text": .string(text)], id: "stable-send", resource: "base")
        XCTAssertEqual(first, try CoreApplicationProtocol.request(op: "chat.send", params: ["text": .string(text)], id: "stable-send", resource: "base"))
        XCTAssertEqual(first["params"]["text"].string, text)
        XCTAssertNoThrow(try CoreApplicationProtocol.request(op: "chat.poll", params: ["requestId": .string("stable-send"), "cursor": .number(0)], id: "poll", resource: "base"))
        XCTAssertEqual(CoreApplicationProtocol.commands.filter { $0.hasPrefix("chat.") }, ["chat.send"])
        for invalid: [String: CoreJSONValue] in [[:], ["text": .string(" \n")], ["text": .bool(true)], ["text": .string(String(repeating: "😀", count: 4097))]] {
            XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "chat.send", params: invalid, id: "send", resource: "base"))
        }
        for key in ["sessionId", "owner", "goal", "resumeGoal", "action", "tools", "model", "instructions", "coordinateInput"] {
            XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "chat.send", params: ["text": .string("Assess"), key: .string("forbidden")], id: "send", resource: "base")) {
                XCTAssertEqual(($0 as? CoreApplicationError)?.code, "OPERATION_DENIED")
            }
            XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "chat.status", params: [key: .string("forbidden")], id: "status", resource: "base"))
        }
        for invalid: [String: CoreJSONValue] in [[:], ["requestId": .string("send")], ["requestId": .string("send"), "cursor": .number(-1)], ["requestId": .string("send"), "cursor": .number(2_000_001)], ["requestId": .string("send"), "cursor": .number(0.5)], ["requestId": .string("send"), "cursor": .number(0), "sessionId": .string("other")]] {
            XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "chat.poll", params: invalid, id: "poll", resource: "base"))
        }
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "chat.execute", params: [:], id: "execute", resource: "base"))
    }

    @MainActor func testChatStatusAndPollRejectAuthorityClaimsAndAcceptUnicodePages() async throws {
        let harness = ChatWireHarness()
        harness.result = .object(["configured": .bool(true), "readOnly": .bool(true)])
        let status = try await harness.client.request("chat.status")
        XCTAssertEqual(status["readOnly"].bool, true)
        for invalid: CoreJSONValue in [
            .object(["configured": .bool(true), "readOnly": .bool(false)]),
            .object(["configured": .bool(true), "readOnly": .bool(true), "execute": .bool(true)]),
            .object(["configured": .string("true"), "readOnly": .bool(true)])
        ] {
            harness.result = invalid
            do { _ = try await harness.client.request("chat.status"); XCTFail("Reject invalid assessment status") }
            catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "INVALID_RESPONSE") }
        }
        let text = "Recorded only: 👩🏽‍💻 e\u{301} 漢字"
        let valid: [String: CoreJSONValue] = ["state": .string("finished"), "text": .string(text),
            "cursor": .number(Double(text.utf16.count)), "hasMore": .bool(false),
            "observedAt": .string("2026-10-27T12:00:00.123Z"), "verification": .string("not-assessed")]
        let params: [String: CoreJSONValue] = ["requestId": .string("stable-send"), "cursor": .number(0)]
        harness.result = .object(valid)
        let page = try await harness.client.request("chat.poll", params: params)
        XCTAssertEqual(page["text"].string, text)
        XCTAssertEqual(page["cursor"].integer, Int64(text.utf16.count))
        XCTAssertEqual(page["observedAt"].string, "2026-10-27T12:00:00.123Z")
        for alteration: [String: CoreJSONValue] in [
            ["state": .string("executing")], ["verification": .string("verified")],
            ["sessionId": .string(UUID().uuidString)], ["executionId": .string(UUID().uuidString)],
            ["text": .string(String(repeating: "😀", count: 1501))], ["cursor": .number(-1)], ["cursor": .number(32769)]
        ] {
            harness.result = .object(valid.merging(alteration) { _, replacement in replacement })
            do { _ = try await harness.client.request("chat.poll", params: params); XCTFail("Reject authority claims or malformed assessment page") }
            catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "INVALID_RESPONSE") }
        }
        XCTAssertTrue(harness.sent.allSatisfy { ["chat.status", "chat.poll"].contains($0["op"].string ?? "") })
    }

    @MainActor func testChatSendRetainsItsCommandIDAndUncertainDeliveryNeverResends() async throws {
        let harness = ChatWireHarness()
        harness.result = .object(["state": .string("accepted"), "requestId": .string("stable-send")])
        _ = try await harness.client.request("chat.send", params: ["text": .string("Assess saved evidence")], id: "stable-send")
        XCTAssertEqual(harness.sent.last?["id"].string, "stable-send")
        XCTAssertEqual(harness.sent.last?["params"]["text"].string, "Assess saved evidence")
        harness.result = nil
        let count = harness.sent.count
        do { _ = try await harness.client.request("chat.send", params: ["text": .string("Another question")], id: "uncertain-send"); XCTFail("No application response") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "UNCERTAIN") }
        XCTAssertEqual(harness.sent.count, count + 1)
        harness.client.disconnected()
        do { _ = try await harness.client.request("chat.status"); XCTFail("Disconnected client cannot send") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "OFFLINE") }
        XCTAssertEqual(harness.sent.count, count + 1, "A disconnect must not replay the question or invoke a session control")
    }
}
