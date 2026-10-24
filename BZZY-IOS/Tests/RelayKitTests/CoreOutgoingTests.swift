import XCTest
@testable import RelayKit

final class CoreOutgoingTests: XCTestCase {
    func testUnconfirmedSendSurvivesRestartAndKeepsExactRetryIdentity() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let session = UUID().uuidString, id = UUID().uuidString
        let store = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: session)
        let pending = CoreOutgoingMessage(id: id, text: "Hello", operation: "execution.execute",
            params: ["owner": .string(store.ownerID), "prompt": .string("Hello"), "coordinateInput": .bool(true)])
        try store.putOutgoing(pending)
        let restored = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: session)
        XCTAssertEqual(restored.outgoing.first?.status, .uncertain)
        XCTAssertEqual(restored.outgoing.first?.requestID, id)
        XCTAssertEqual(restored.outgoing.first?.params, pending.params)
        XCTAssertEqual(restored.cursor, 0, "Pending delivery never fabricates an authoritative event")
    }
    func testEchoBeforeAcceptanceAndAcceptanceBeforeEchoBothProduceOneMessage() throws {
        for echoFirst in [true, false] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let session = UUID().uuidString, execution = UUID().uuidString
            let store = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: session)
            var message = CoreOutgoingMessage(id: UUID().uuidString, text: "Hello", operation: "execution.execute",
                params: ["owner": .string(store.ownerID), "prompt": .string("Hello")])
            try store.putOutgoing(message)
            let event: CoreJSONValue = .object(["version": .number(1), "id": .string("\(session):1"), "seq": .number(1), "sessionId": .string(session),
                "type": .string("message.user"), "createdAt": .string("2026-10-24T00:00:00Z"),
                "data": .object(["text": .string("Hello"), "executionId": .string(execution)])])
            let envelope: CoreJSONValue = .object(["v": .number(1), "protocol": .string("bzzy-core"), "type": .string("events"), "subscriptionId": .string("sub"),
                "resource": .string("resource"), "sessionId": .string(session), "events": .array([event]), "nextCursor": .number(1), "hasMore": .bool(false)])
            let batch = try CoreEventBatch(envelope, resource: "resource", sessionID: session, cursor: 0)
            if echoFirst { try store.apply(batch) }
            message.status = .accepted; message.executionID = execution
            try store.putOutgoing(message)
            if !echoFirst { try store.apply(batch) }
            XCTAssertTrue(store.outgoing.isEmpty)
            XCTAssertEqual(store.events.count, 1)
            try store.apply(batch)
            XCTAssertEqual(store.events.count, 1)
        }
    }
}
