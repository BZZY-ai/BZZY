import XCTest
import CryptoKit
@testable import RelayKit

@MainActor private final class CoreHarness {
    let session = UUID().uuidString.lowercased()
    var client: CoreRelayClient!
    var sent: [WireValue] = []
    var result: CoreJSONValue?
    var resultProvider: ((WireValue) -> CoreJSONValue?)?
    init(timeout: UInt64 = 500_000_000) {
        client = CoreRelayClient(hostID: "host", grantID: "grant", resource: "resource", timeoutNanoseconds: timeout) { [weak self] value in
            guard let self else { return }
            self.sent.append(value)
            if let result = self.resultProvider?(value) ?? self.result {
                try self.client.receive(from: "host", grantID: "grant", payload: self.response(value["id"].string!, result: result))
            }
        }
    }
    func response(_ id: String, result: CoreJSONValue) throws -> WireValue {
        try CoreJSONValue.object(["v": .number(1), "protocol": .string("bzzy-core"), "type": .string("response"),
            "id": .string(id), "ok": .bool(true), "result": result]).wire()
    }
    func bind(inputActor: String? = nil) async throws {
        var capabilities: [String: CoreJSONValue] = ["relay": .bool(true), "durableEvents": .bool(true)]
        if let inputActor { capabilities["inputActor"] = .string(inputActor); capabilities["inputSubmission"] = .bool(true) }
        result = .object(["session": .object(["id": .string(session)]), "execution": .null, "inputOwner": .null,
            "questions": .array([]), "capabilities": .object(capabilities)])
        _ = try await client.request("session.get")
    }
    func subscribe() async throws {
        result = .object(["subscriptionId": .string("subscription"), "consumerId": .string("consumer"), "processedCursor": .number(0)])
        _ = try await client.request("events.subscribe", params: ["consumerId": .string("consumer")])
    }
    func batch(_ seqs: [Int64], body: String = "<bzzy><p>Original &amp; raw</p></bzzy>", sessionID: String? = nil) -> CoreJSONValue {
        let id = sessionID ?? session
        return .object(["v": .number(1), "protocol": .string("bzzy-core"), "type": .string("events"),
            "subscriptionId": .string("subscription"), "resource": .string("resource"), "sessionId": .string(id),
            "events": .array(seqs.map { seq in .object(["version": .number(1), "id": .string("\(id):\(seq)"), "seq": .number(Double(seq)),
                "sessionId": .string(id), "type": .string("future.event"), "createdAt": .string("2026-10-22T00:00:00.000Z"),
                "data": .object(["text": .string(body), "provenance": .string("model-reported")])]) }),
            "nextCursor": .number(Double(seqs.last ?? 0)), "hasMore": .bool(false)])
    }
}

final class CoreApplicationTests: XCTestCase {
    @MainActor func testDefaultSettingsAndSessionSelectionValidateNativeResponses() async throws {
        let h = CoreHarness(); try await h.bind(inputActor: "phone")
        let selection: CoreJSONValue = .object(["provider": .string("codex"), "model": .string("saved-model"), "effort": .string("high")])
        let snapshot: CoreJSONValue = .object(["revision": .string(String(repeating: "a", count: 64)),
            "defaults": .object(["cli": selection, "core": .null, "parallel": .array([selection, selection, selection]),
                "besties": .null, "debate": .null, "delegate": .array([selection, selection])])])
        h.result = snapshot
        let read = try await h.client.request("settings.get")
        XCTAssertEqual(read, snapshot)
        let saved = try await h.client.request("settings.configure", params: ["target": .string("cli"),
            "expectedRevision": snapshot["revision"], "agents": .array([selection])])
        XCTAssertEqual(saved, snapshot)
        let params: [String: CoreJSONValue] = ["owner": .string("phone"), "coordinateInput": .bool(true),
            "selection": selection, "expectedUpdatedAt": .string("2026-10-24T00:00:00.000Z")]
        h.result = .object(["state": .string("accepted"), "sessionId": .string(h.session), "provider": .string("codex"), "model": .string("saved-model"), "effort": .string("high")])
        let changed = try await h.client.request("session.configure", params: params)
        XCTAssertEqual(changed["model"].string, "saved-model")
        h.result = .object(["state": .string("accepted"), "sessionId": .string(UUID().uuidString.lowercased()), "provider": .string("codex"), "model": .string("saved-model"), "effort": .string("high")])
        do { _ = try await h.client.request("session.configure", params: params); XCTFail("Foreign session accepted") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "UNCERTAIN", "An invalid mutation receipt cannot confirm acceptance") }
        var injected = params; injected["environment"] = .object([:])
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "session.configure", params: injected, id: "edit", resource: "resource"))
        XCTAssertNoThrow(try CoreApplicationProtocol.request(op: "settings.models", params: ["provider": .string("codex"), "after": .string("saved-model"), "limit": .number(25)], id: "catalog", resource: "resource"))
    }

    @MainActor func testLateSupersededSubscriptionClosureCannotInvalidateCurrentStream() async throws {
        let h = CoreHarness(); try await h.bind(); try await h.subscribe()
        var closed = false; h.client.onSubscriptionClosed = { _, _ in closed = true }
        let frame: CoreJSONValue = .object(["v": .number(1), "protocol": .string("bzzy-core"), "type": .string("subscription.closed"), "resource": .string("resource"), "subscriptionId": .string("old-consumer"), "code": .string("SUBSCRIPTION_REPLACED")])
        try h.client.receive(from: "host", grantID: "grant", payload: frame.wire())
        XCTAssertFalse(closed)
        var delivered = false; h.client.onEvents = { _ in delivered = true }
        try h.client.receive(from: "host", grantID: "grant", payload: h.batch([1]).wire()); XCTAssertTrue(delivered)
    }

    @MainActor func testModeReceiptIsBoundToTheRequestedModeAndSession() async throws {
        let h = CoreHarness(); try await h.bind(inputActor: "phone")
        let params: [String: CoreJSONValue] = ["owner": .string("phone"), "coordinateInput": .bool(true), "mode": .string("parallel"), "expectedUpdatedAt": .string("revision")]
        h.result = .object(["state": .string("accepted"), "sessionId": .string(h.session), "mode": .string("parallel")])
        let accepted = try await h.client.request("session.mode", params: params)
        XCTAssertEqual(accepted["mode"].string, "parallel")
        h.result = .object(["state": .string("accepted"), "sessionId": .string(h.session), "mode": .string("delegate")])
        do { _ = try await h.client.request("session.mode", params: params); XCTFail("Wrong mode accepted") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "UNCERTAIN") }
        var invalid = params; invalid["mode"] = .string("arbitrary")
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "session.mode", params: invalid, id: "mode", resource: "resource"))
    }

    @MainActor func testNextPageMayOvertakeProcessedAckResponse() async throws {
        let h = CoreHarness(); try await h.bind(); try await h.subscribe()
        var delivered: [Int64] = []
        h.client.onEvents = { delivered.append($0.nextCursor) }
        try h.client.receive(from: "host", grantID: "grant", payload: h.batch([1]).wire())
        h.result = nil
        let ack = Task { try await h.client.request("events.ack", params: ["subscriptionId": .string("subscription"), "seq": .number(1)]) }
        while h.sent.last?["op"].string != "events.ack" { await Task.yield() }
        let id = h.sent.last!["id"].string!
        try h.client.receive(from: "host", grantID: "grant", payload: h.batch([2]).wire())
        try h.client.receive(from: "host", grantID: "grant", payload: h.response(id, result: .object(["processedCursor": .number(1)])))
        _ = try await ack.value
        XCTAssertEqual(delivered, [1, 2])
        h.result = .object(["processedCursor": .number(2)])
        _ = try await h.client.request("events.ack", params: ["subscriptionId": .string("subscription"), "seq": .number(2)])
    }

    @MainActor func testBoundedHistoryMovesBackwardAndLiveTailKeepsAdvancing() async throws {
        let h = CoreHarness(), directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: h.session)
        func page(_ lower: Int64, token: String? = nil) throws -> CoreEventHistoryPage {
            let envelopes = h.batch(Array(lower..<(lower + 50)))["events"]
            var value: [String: CoreJSONValue] = ["events": envelopes, "nextCursor": .number(Double(lower + 49)), "hasMore": .bool(false), "oldestCursor": .number(Double(lower)), "hasOlder": .bool(lower > 1)]
            if let token { value["bootstrapToken"] = .string(token) }
            return try CoreEventHistoryPage(.object(value), sessionID: h.session)
        }
        try store.bootstrap(page(11001, token: "tail-proof")); try store.markSubscribed()
        for lower in stride(from: Int64(10951), through: 951, by: -50) { try store.prepend(page(lower)) }
        XCTAssertEqual(store.firstCursor, 951); XCTAssertLessThanOrEqual(store.events.count, 10000)
        XCTAssertEqual(store.cursor, 11050); XCTAssertTrue(store.hasNewerHistory)
        let first = store.firstCursor
        try store.apply(CoreEventBatch(h.batch([11051]), resource: "resource", sessionID: h.session, cursor: 11050))
        XCTAssertEqual(store.firstCursor, first); XCTAssertEqual(store.cursor, 11051)
        store.showLatestHistory(); XCTAssertEqual(store.events.last?.seq, 11051); XCTAssertFalse(store.hasNewerHistory)
        let restored = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: h.session)
        XCTAssertLessThanOrEqual(restored.events.count, 10000); XCTAssertEqual(restored.cursor, 11051); XCTAssertTrue(restored.hasOlderHistory)
        // A lost ACK can replay an evicted event without reintroducing it.
        try restored.apply(CoreEventBatch(h.batch([1]), resource: "resource", sessionID: h.session, cursor: 0))
        XCTAssertEqual(restored.cursor, 11051); XCTAssertFalse(restored.events.contains(where: { $0.seq == 1 }))
    }

    @MainActor func testHoldingCachedHistoryPreservesReadingWhileNewEventsAreSaved() async throws {
        let h = CoreHarness(), directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: h.session)
        try store.apply(CoreEventBatch(h.batch([1, 2]), resource: "resource", sessionID: h.session, cursor: 0))
        store.holdHistoryWindow()
        try store.apply(CoreEventBatch(h.batch([3, 4]), resource: "resource", sessionID: h.session, cursor: 2))
        XCTAssertEqual(store.events.map(\.seq), [1, 2]); XCTAssertEqual(store.cursor, 4)
        XCTAssertTrue(store.hasNewerHistory)
        let reopened = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: h.session)
        XCTAssertEqual(reopened.events.map(\.seq), [1, 2, 3, 4]); XCTAssertEqual(reopened.cursor, 4)
        store.showLatestHistory()
        XCTAssertEqual(store.events.map(\.seq), [1, 2, 3, 4]); XCTAssertFalse(store.hasNewerHistory)
        try store.apply(CoreEventBatch(h.batch([5]), resource: "resource", sessionID: h.session, cursor: 4))
        XCTAssertEqual(store.events.last?.seq, 5)
    }

    @MainActor func testChunkedHistoryReassemblesExactEnvelopeAndChecksDigest() async throws {
        let h = CoreHarness(timeout: 2_000_000_000); try await h.bind()
        var snapshot = h.result!.object!, capabilities = snapshot["capabilities"]!.object!
        capabilities["eventChunks"] = .bool(true); snapshot["capabilities"] = .object(capabilities); h.result = .object(snapshot)
        _ = try await h.client.request("session.get")
        let event = h.batch([9], body: String(repeating: "🪰 raw &amp; ", count: 4000))["events"].array![0]
        let bytes = try JSONEncoder().encode(event), hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let descriptor: CoreJSONValue = .object(["chunked": .bool(true), "id": .string("\(h.session):9"), "seq": .number(9), "sessionId": .string(h.session), "bytes": .number(Double(bytes.count)), "sha256": .string(hash)])
        h.result = nil
        var corrupt = false
        h.resultProvider = { request in
            if request["op"].string == "events.list" { return .object(["events": .array([descriptor]), "nextCursor": .number(9), "hasMore": .bool(false), "oldestCursor": .number(9), "hasOlder": .bool(true), "bootstrapToken": .string("proof")]) }
            guard request["op"].string == "events.chunk", let offset = request["params"]["offset"].integer else { return nil }
            let start = Int(offset), end = min(bytes.count, start + 16384)
            var part = Data(bytes[start..<end]); if corrupt { part[0] ^= 1 }
            return .object(["seq": .number(9), "offset": .number(Double(start)), "bytes": .number(Double(bytes.count)), "sha256": .string(hash), "data": .string(part.base64EncodedString()), "nextOffset": .number(Double(end))])
        }
        let page = try await h.client.request("events.list", params: ["latest": .bool(true)])
        XCTAssertEqual(page["events"].array, [event]); XCTAssertTrue(h.sent.last?["op"].string == "events.chunk")
        XCTAssertTrue(h.sent.contains { $0["op"].string == "events.list" && $0["params"]["eventChunks"].bool == true })
        corrupt = true
        do { _ = try await h.client.request("events.list", params: ["latest": .bool(true)]); XCTFail("Changed chunk bytes") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "CONFLICT") }
    }

    @MainActor func testBootstrapRefreshPreservesPrivateOutboxAndRotatesOnlyConsumer() async throws {
        let h = CoreHarness(), directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: h.session)
        let snapshot: CoreJSONValue = .object(["session": .object(["id": .string(h.session), "alias": .string("Cached title")]), "questions": .array([]), "capabilities": .object([:])])
        try store.saveSnapshot(snapshot)
        let outgoing = CoreOutgoingMessage(id: UUID().uuidString, text: "Keep my draft", operation: "execution.execute", params: ["owner": .string(store.ownerID), "prompt": .string("Keep my draft")])
        try store.putOutgoing(outgoing)
        func tail(_ seq: Int64, _ token: String) throws -> CoreEventHistoryPage {
            try CoreEventHistoryPage(.object(["events": h.batch([seq])["events"], "nextCursor": .number(Double(seq)), "hasMore": .bool(false), "oldestCursor": .number(Double(seq)), "hasOlder": .bool(true), "bootstrapToken": .string(token)]), sessionID: h.session)
        }
        try store.bootstrap(tail(50, "expired-proof"))
        let oldConsumer = store.consumerID, owner = store.ownerID
        try store.refreshBootstrap(tail(60, "fresh-proof"))
        XCTAssertNotEqual(store.consumerID, oldConsumer); XCTAssertEqual(store.ownerID, owner)
        XCTAssertEqual(store.outgoing.map(\.id), [outgoing.id]); XCTAssertEqual(store.cachedSnapshot, snapshot)
        let restored = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: h.session)
        XCTAssertEqual(restored.cursor, 60); XCTAssertEqual(restored.bootstrapToken, "fresh-proof"); XCTAssertEqual(restored.cachedSnapshot, snapshot)
        try restored.markSubscribed()
        XCTAssertThrowsError(try restored.refreshBootstrap(tail(70, "arbitrary-proof")))
    }

    @MainActor func testAuthoritativeAdmissionEventConfirmsLostRPCWithoutRetryAndRejectsOtherActors() async throws {
        let h = CoreHarness(timeout: 2_000_000_000)
        try await h.bind(inputActor: "this-device"); try await h.subscribe()
        h.result = nil
        var completed = false
        let request = Task { @MainActor in
            defer { completed = true }
            return try await h.client.request("execution.execute", params: ["owner": .string("phone"), "prompt": .string("Hello"), "coordinateInput": .bool(true)], id: "message-request")
        }
        while h.sent.count < 3 { await Task.yield() }
        let execution = UUID().uuidString
        func frame(_ seq: Int64, actor: String) throws -> WireValue {
            var value = h.batch([seq]).object!
            value["events"] = .array([.object(["version": .number(1), "id": .string("\(h.session):\(seq)"), "seq": .number(Double(seq)),
                "sessionId": .string(h.session), "type": .string("input.accepted"), "createdAt": .string("2026-10-24T00:00:00Z"),
                "data": .object(["actor": .string(actor), "requestId": .string("message-request"),
                    "result": .object(["executionId": .string(execution), "sessionId": .string(h.session)])])])])
            return try CoreJSONValue.object(value).wire()
        }
        let wrongActor = try frame(1, actor: "another-device")
        try h.client.receive(from: "host", grantID: "grant", payload: wrongActor)
        try h.client.receive(from: "host", grantID: "grant", payload: wrongActor) // exact pending-frame replay
        await Task.yield(); XCTAssertFalse(completed)
        XCTAssertThrowsError(try h.client.receive(from: "host", grantID: "grant", payload: frame(1, actor: "altered")))
        h.result = .object(["processedCursor": .number(1)])
        _ = try await h.client.request("events.ack", params: ["subscriptionId": .string("subscription"), "seq": .number(1)])
        try h.client.receive(from: "host", grantID: "grant", payload: frame(2, actor: "this-device"))
        let receipt = try await request.value
        XCTAssertEqual(receipt["executionId"].string, execution)
        XCTAssertEqual(h.sent.filter { $0["op"].string == "execution.execute" }.count, 1)
    }
    @MainActor func testStoppedCoreIsTypedAndReadTimeoutNeverChangesMutationSemantics() async throws {
        let h = CoreHarness(); try await h.bind(); h.result = nil
        let task = Task { try await h.client.request("host.metrics") }
        for _ in 0..<50 {
            if h.sent.last?["op"].string == "host.metrics" { break }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        let id = try XCTUnwrap(h.sent.last?["id"].string)
        try h.client.receive(from: "host", grantID: "grant", payload: CoreJSONValue.object([
            "v": .number(1), "protocol": .string("bzzy-core"), "type": .string("response"),
            "id": .string(id), "ok": .bool(false), "error": .object(["code": .string("CORE_STOPPED")])]).wire())
        do { _ = try await task.value; XCTFail("A stopped Core cannot appear available") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "CORE_STOPPED") }
        let before = h.sent.count
        do {
            _ = try await h.client.request("execution.execute", params: ["owner": .string("phone"), "prompt": .string("Blocked")], readTimeoutNanoseconds: 4_000_000_000)
            XCTFail("Mutation timeouts are never overridden by heartbeat settings")
        } catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "INVALID_REQUEST") }
        XCTAssertEqual(h.sent.count, before)
    }

    func testRequestsHaveExactAllowlistedFieldsAndUTF8Bounds() throws {
        let request = try CoreApplicationProtocol.request(op: "execution.execute", params: ["owner": .string("phone"), "prompt": .string("Hello")], id: "stable", resource: "approved")
        XCTAssertEqual(request["resource"].string, "approved")
        XCTAssertEqual(request["protocol"].string, "bzzy-core")
        for key in ["credentials", "environment", "url", "sessionId", "headers"] {
            XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "execution.execute", params: ["owner": .string("phone"), "prompt": .string("Hello"), key: .string("forbidden")], id: "id", resource: "resource"))
        }
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "agent.create", params: [:], id: "id", resource: "resource"))
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "execution.execute", params: ["owner": .string("phone"), "prompt": .string(String(repeating: "😀", count: 4097))], id: "id", resource: "resource"))
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "events.list", params: ["after": .number(-1)], id: "id", resource: "resource"))
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "events.list", params: ["limit": .number(51)], id: "id", resource: "resource"))
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "input.claim", params: ["owner": .string("phone"), "takeover": .string("yes")], id: "id", resource: "resource"))
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "sessions.list", params: ["after": .number(0)], id: "id", resource: "resource"))
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "sessions.list", params: ["limit": .number(26)], id: "id", resource: "resource"))
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "sessions.open", params: ["sessionId": .string(UUID().uuidString), "owner": .string("phone")], id: "id", resource: "resource"))
    }

    @MainActor func testAuthenticatedScopeAndStrictResponses() async throws {
        let h = CoreHarness()
        try await h.bind()
        XCTAssertEqual(h.client.sessionID, h.session)
        XCTAssertThrowsError(try h.client.receive(from: "other", grantID: "grant", payload: h.batch([1]).wire()))
        XCTAssertThrowsError(try h.client.receive(from: "host", grantID: "other", payload: h.batch([1]).wire()))
        h.result = .object(["session": .object(["id": .string(UUID().uuidString)]), "questions": .array([]),
            "capabilities": .object(["relay": .bool(true), "durableEvents": .bool(true)])])
        do { _ = try await h.client.request("session.get"); XCTFail("Cannot replace a resource's bound session") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "INVALID_RESPONSE") }
        XCTAssertEqual(h.client.sessionID, h.session)
    }

    @MainActor func testTransportReceiptDoesNotCompleteCoreCommandOrRetryIt() async throws {
        let h = CoreHarness(timeout: 25_000_000)
        try await h.bind(); h.result = nil
        let before = h.sent.count
        do { _ = try await h.client.request("execution.execute", params: ["owner": .string("phone"), "prompt": .string("Disposable")], id: "saved-command"); XCTFail("No application response") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "UNCERTAIN") }
        XCTAssertEqual(h.sent.count, before + 1)
        // A late response cannot silently revive the mutation or trigger another run.
        try h.client.receive(from: "host", grantID: "grant", payload: h.response("saved-command", result: .object(["state": .string("accepted"), "sessionId": .string(h.session), "executionId": .string(UUID().uuidString)])))
        h.client.disconnected()
        do { _ = try await h.client.request("session.get"); XCTFail("Disconnected client") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "OFFLINE") }
        XCTAssertEqual(h.sent.count, before + 1)
    }

    @MainActor func testYoloAcceptanceMustMatchModeAndExactPendingApproval() async throws {
        let h = CoreHarness(); try await h.bind()
        let question = UUID().uuidString.lowercased()
        let params: [String: CoreJSONValue] = ["owner": .string("phone"), "enabled": .bool(true), "questionId": .string(question)]
        h.result = .object(["state": .string("accepted"), "yolo": .bool(true), "approvedQuestionId": .string(question)])
        let accepted = try await h.client.request("permissions.set", params: params)
        XCTAssertEqual(accepted["approvedQuestionId"].string, question)
        for bad: CoreJSONValue in [
            .object(["state": .string("accepted"), "yolo": .bool(false), "approvedQuestionId": .string(question)]),
            .object(["state": .string("accepted"), "yolo": .bool(true), "approvedQuestionId": .string(UUID().uuidString.lowercased())]),
            .object(["state": .string("accepted"), "yolo": .bool(true)])
        ] {
            h.result = bad
            do { _ = try await h.client.request("permissions.set", params: params); XCTFail("Mismatched approval accepted") }
            catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "UNCERTAIN") }
        }
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "permissions.set", params: ["owner": .string("phone"), "enabled": .string("yes")], id: "bad-yolo", resource: "resource"))
    }

    @MainActor func testTaskAndExecutionAcceptanceShapesAndUncertainty() async throws {
        let h = CoreHarness(); try await h.bind()
        h.result = .object(["state": .string("accepted"), "taskId": .string("opaque-task-id")])
        let task = try await h.client.request("task.submit", params: ["owner": .string("phone"), "instruction": .string("Disposable task")], id: "task-command")
        XCTAssertEqual(task["taskId"].string, "opaque-task-id")
        h.result = .object(["state": .string("accepted"), "sessionId": .string(h.session), "executionId": .string(UUID().uuidString)])
        let execution = try await h.client.request("execution.execute", params: ["owner": .string("phone"), "prompt": .string("Disposable chat")], id: "chat-command")
        XCTAssertEqual(execution["sessionId"].string, h.session)
        // A host mutation may have executed even when the response is malformed.
        h.result = .object(["state": .string("accepted"), "taskId": .string("wrong-execution-shape")])
        do { _ = try await h.client.request("execution.execute", params: ["owner": .string("phone"), "prompt": .string("Disposable chat")], id: "uncertain-command"); XCTFail("Malformed acceptance") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "UNCERTAIN") }
        h.result = .object(["state": .string("accepted"), "acceptance": .object(["executionId": execution["executionId"], "sessionId": .string(h.session)])])
        let reconciled = try await h.client.request("command.status", params: ["requestId": .string("uncertain-command")])
        XCTAssertEqual(reconciled["state"].string, "accepted")
        XCTAssertEqual(h.sent.last?["op"].string, "command.status")
    }

    @MainActor func testCatalogOpeningUsesNewImmutableResourceWithoutClaimOrExecution() async throws {
        let h = CoreHarness(); try await h.bind()
        let other = UUID().uuidString.lowercased()
        h.result = .object(["sessions": .array([.object(["id": .string(other), "provider": .string("discovered-provider"), "model": .null,
            "cwd": .string("/a/project outside the default root"), "executionState": .string("idle"), "goalStatus": .string("complete"), "goalReason": .null,
            "createdAt": .string("2026-10-22T00:00:00Z"), "updatedAt": .string("2026-10-22T00:00:00Z"), "existingResource": .string("derived-resource")])]),
            "nextCursor": .null, "hasMore": .bool(false)])
        let list = try await h.client.request("sessions.list", params: ["limit": .number(25), "goalFeedback": .bool(true)])
        XCTAssertEqual(list["sessions"].array?.first?["cwd"].string, "/a/project outside the default root")
        h.result = .object(["state": .string("accepted"), "resource": .string("derived-resource"), "sessionId": .string(other),
            "cwd": .string("/a/project outside the default root"), "provider": .string("discovered-provider"), "model": .null, "effort": .string("default")])
        let opened = try await h.client.request("sessions.open", params: ["sessionId": .string(other)], id: "saved-open")
        XCTAssertEqual(opened["resource"].string, "derived-resource")
        XCTAssertEqual(h.client.resource, "resource"); XCTAssertEqual(h.client.sessionID, h.session)
        XCTAssertEqual(h.sent.map { $0["op"].string }, ["session.get", "sessions.list", "sessions.open"])
        XCTAssertEqual(h.sent.last?["params"]["owner"], .null)
        h.result = .object(["state": .string("accepted"), "acceptance": .object(["resource": .string("derived-resource"), "sessionId": .string(other),
            "cwd": .string("/a/project outside the default root"), "provider": .string("discovered-provider"), "model": .null, "effort": .string("default")])])
        let status = try await h.client.request("command.status", params: ["requestId": .string("saved-open")])
        XCTAssertEqual(status["acceptance"]["sessionId"].string, other)
    }

    @MainActor func testProcessedBatchAckCannotCrossSessionOrSkipUndeliveredEvent() async throws {
        let h = CoreHarness(); try await h.bind(); try await h.subscribe()
        var delivered: CoreEventBatch?
        h.client.onEvents = { delivered = $0 }
        XCTAssertThrowsError(try h.client.receive(from: "host", grantID: "grant", payload: h.batch([1], sessionID: UUID().uuidString).wire()))
        try h.client.receive(from: "host", grantID: "grant", payload: h.batch([1, 3]).wire())
        XCTAssertEqual(delivered?.events.map(\.seq), [1, 3])
        XCTAssertEqual(delivered?.events[0].data["provenance"].string, "model-reported")
        // Repeating the old processed cursor leaves the delivered batch intact.
        h.result = .object(["processedCursor": .number(0)])
        _ = try await h.client.request("events.ack", params: ["subscriptionId": .string("subscription"), "seq": .number(0)])
        do { _ = try await h.client.request("events.ack", params: ["subscriptionId": .string("subscription"), "seq": .number(2)]); XCTFail("Undelivered cursor") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "INVALID_CURSOR") }
        h.result = .object(["processedCursor": .number(1)])
        _ = try await h.client.request("events.ack", params: ["subscriptionId": .string("subscription"), "seq": .number(1)])
        // Partial acknowledgment leaves the tail to replay from the processed cursor.
        try h.client.receive(from: "host", grantID: "grant", payload: h.batch([3]).wire())
        XCTAssertEqual(delivered?.events.map(\.seq), [3])
    }

    @MainActor func testProjectionAtomicReplayRawBodiesAndScope() async throws {
        let h = CoreHarness(); try await h.bind()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: h.session)
        let consumer = store.consumerID, owner = store.ownerID
        let first = try CoreEventBatch(h.batch([1, 2]), resource: "resource", sessionID: h.session, cursor: 0)
        try store.apply(first); try store.apply(first)
        XCTAssertEqual(store.events.count, 2); XCTAssertEqual(store.cursor, 2)
        XCTAssertEqual(store.events[0].data["text"].string, "<bzzy><p>Original &amp; raw</p></bzzy>")
        let restored = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: h.session)
        XCTAssertEqual(restored.consumerID, consumer); XCTAssertEqual(restored.ownerID, owner)
        XCTAssertEqual(restored.events, store.events); XCTAssertEqual(restored.cursor, 2)
        let changed = try CoreEventBatch(h.batch([1], body: "altered"), resource: "resource", sessionID: h.session, cursor: 0)
        XCTAssertThrowsError(try restored.apply(changed)); XCTAssertEqual(restored.cursor, 2)
        let other = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "another-resource", sessionID: h.session)
        XCTAssertNotEqual(other.consumerID, consumer); XCTAssertEqual(other.cursor, 0)
        XCTAssertThrowsError(try other.apply(first))
        try restored.purge()
        XCTAssertEqual(restored.cursor, 0); XCTAssertTrue(restored.events.isEmpty)
        XCTAssertNotEqual(restored.consumerID, consumer)
    }

    @MainActor func testProjectionFailedWriteNeverAdvancesCursor() async throws {
        let h = CoreHarness(); try await h.bind()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: h.session)
        try FileManager.default.removeItem(at: directory)
        try Data("blocks directory".utf8).write(to: directory)
        let batch = try CoreEventBatch(h.batch([1]), resource: "resource", sessionID: h.session, cursor: 0)
        XCTAssertThrowsError(try store.apply(batch)); XCTAssertEqual(store.cursor, 0); XCTAssertTrue(store.events.isEmpty)
    }

    @MainActor func testRevocationCanPurgeUndecodablePrivateProjection() async throws {
        let h = CoreHarness(); try await h.bind()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: h.session)
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 1)
        try Data("corrupt private cache".utf8).write(to: XCTUnwrap(files.first))
        XCTAssertThrowsError(try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: h.session))
        try CoreEventProjectionStore.purge(directory: directory, hostID: "host", resource: "resource", sessionID: h.session)
        let fresh = try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: h.session)
        XCTAssertNotEqual(fresh.consumerID, original.consumerID)
        XCTAssertTrue(fresh.events.isEmpty); XCTAssertEqual(fresh.cursor, 0)
    }
}
