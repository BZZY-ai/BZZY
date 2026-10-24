import XCTest
@testable import RelayKit

@MainActor private final class CoreHarness {
    let session = UUID().uuidString.lowercased()
    var client: CoreRelayClient!
    var sent: [WireValue] = []
    var result: CoreJSONValue?
    init(timeout: UInt64 = 500_000_000) {
        client = CoreRelayClient(hostID: "host", grantID: "grant", resource: "resource", timeoutNanoseconds: timeout) { [weak self] value in
            guard let self else { return }
            self.sent.append(value)
            if let result = self.result {
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
            "cwd": .string("/a/project outside the default root"), "executionState": .string("idle"),
            "createdAt": .string("2026-10-22T00:00:00Z"), "updatedAt": .string("2026-10-22T00:00:00Z"), "existingResource": .string("derived-resource")])]),
            "nextCursor": .null, "hasMore": .bool(false)])
        let list = try await h.client.request("sessions.list", params: ["limit": .number(25)])
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
