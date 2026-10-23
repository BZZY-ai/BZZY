import XCTest
@testable import RelayKit

@MainActor private final class AgentTransferHarness {
    let host: RelayIdentity
    var client: CoreRelayClient!
    var result: CoreJSONValue = .object([:])
    var sent: [WireValue] = []
    init(kind: RelayShareKind = .agent) throws {
        host = try RelayIdentity.generate()
        client = CoreRelayClient(hostID: host.certificate.id, grantID: "paired-grant", resource: "approved-agent", expectedShareKind: kind) { [weak self] frame in
            guard let self else { return }
            self.sent.append(frame)
            let response: CoreJSONValue = .object(["v": .number(1), "protocol": .string("bzzy-core"), "type": .string("response"), "id": .string(frame["id"].string!), "ok": .bool(true), "result": self.result])
            try self.client.receive(from: self.host.certificate.id, grantID: "paired-grant", payload: response.wire())
        }
    }
    func share(kind: RelayShareKind) throws -> CoreJSONValue {
        let code = "BZZY-\(kind.rawValue)-" + RelayWire.encoded(try RelayWire.random())
        let expiry = RelayWire.now + 60_000
        let envelope: WireValue = .object(["v": .number(1), "relay": .string(RelayWire.endpoint.absoluteString), "code": .string(code), "sender": try RelayWire.object(host.certificate), "expiresAt": .number(Double(expiry))])
        return .object(["state": .string("accepted"), "kind": .string(kind.rawValue), "shareId": .string(UUID().uuidString), "code": .string(code), "qr": .string("BZZY:INVITE:1:" + RelayWire.encoded(try envelope.data())), "expiresAt": .number(Double(expiry)), "senderFingerprint": .string(host.certificate.id), "bytes": .number(1024), "sha256": .string(String(repeating: "a", count: 64))])
    }
}

final class CoreAgentTransferTests: XCTestCase {
    private func params() throws -> [String: CoreJSONValue] {
        ["code": .string("BZZY-AGENT-" + RelayWire.encoded(try RelayWire.random())), "expectedSenderFingerprint": .string(RelayWire.encoded(try RelayWire.random())), "provider": .string("fixture-provider"), "model": .string("default"), "effort": .string("default")]
    }
    func testImportRequiresAgentCodeFullSourceFingerprintAndOwnProviderWithoutPathsOrCredentials() throws {
        let valid = try params()
        _ = try CoreApplicationProtocol.request(op: "agents.import", params: valid, id: "stable-request", resource: "base")
        for field in ["cwd", "path", "archive", "url", "credentials", "apiKey", "owner", "sessionId", "agentId"] {
            var bad = valid; bad[field] = .string("denied")
            XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "agents.import", params: bad, id: "stable-request", resource: "base"))
        }
        for key in valid.keys {
            var bad = valid; bad.removeValue(forKey: key)
            XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "agents.import", params: bad, id: "stable-request", resource: "base"))
        }
        for (field, value) in [("code", "BZZY-TERMINAL-" + RelayWire.encoded(try RelayWire.random())), ("code", "https://example.test/invite"), ("expectedSenderFingerprint", "partial-fingerprint")] {
            var bad = valid; bad[field] = .string(value)
            XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "agents.import", params: bad, id: "stable-request", resource: "base"))
        }
        XCTAssertTrue(CoreApplicationProtocol.commands.contains("agents.import"))
        XCTAssertFalse(CoreApplicationProtocol.commands.contains("agents.import.status"))
    }
    @MainActor func testAgentShareCannotAcceptTerminalPurposeAndInvitationDescriptionsHideCodes() async throws {
        let h = try AgentTransferHarness()
        h.result = try h.share(kind: .agent)
        let result = try await h.client.request("share.create")
        let code = try XCTUnwrap(result["code"].string)
        let invitation = try RelayShareInvitation.parse(XCTUnwrap(result["qr"].string), expectedKind: .agent)
        XCTAssertEqual(invitation.code, code)
        XCTAssertEqual(invitation.senderFingerprint, h.host.certificate.id)
        XCTAssertFalse(String(describing: invitation).contains(code))
        XCTAssertFalse(String(reflecting: invitation).contains(code))
        h.result = try h.share(kind: .terminal)
        do { _ = try await h.client.request("share.create"); XCTFail("Agent context accepted Terminal code") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "UNCERTAIN") }
        XCTAssertEqual(h.sent.count, 2, "No automatic source approval or execution")
    }
    @MainActor func testImportAcceptancePinsExpectedSourceAndMalformedAcceptanceStaysUncertain() async throws {
        let h = try AgentTransferHarness(), p = try params(), id = UUID().uuidString
        h.result = .object(["state": .string("accepted"), "importId": .string(id), "sourceFingerprint": p["expectedSenderFingerprint"]!, "expiresAt": .number(Double(RelayWire.now + 60_000))])
        let accepted = try await h.client.request("agents.import", params: p, id: "stable-import")
        XCTAssertEqual(accepted["importId"].string, id)
        if case .object(var fields) = h.result {
            fields["sourceFingerprint"] = .string(h.host.certificate.id); h.result = .object(fields)
        }
        do { _ = try await h.client.request("agents.import", params: p); XCTFail("Source substitution") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "UNCERTAIN") }
        XCTAssertEqual(h.sent.map { $0["op"].string }, ["agents.import", "agents.import"])
    }
    @MainActor func testStatusIsBoundToJobAndBoundedProgressAndRecipientIdentity() async throws {
        let h = try AgentTransferHarness(), id = UUID().uuidString, recipient = try RelayIdentity.generate()
        let status: [String: CoreJSONValue] = ["importId": .string(id), "state": .string("awaitingApproval"), "sourceFingerprint": .string(h.host.certificate.id), "recipientFingerprint": .string(recipient.certificate.id), "received": .number(0), "total": .null, "expiresAt": .number(Double(RelayWire.now + 60_000))]
        h.result = .object(status)
        _ = try await h.client.request("agents.import.status", params: ["importId": .string(id)])
        XCTAssertEqual(h.sent.count, 1, "Reading status cannot approve sender or start execution")
        for (field, value) in [("importId", CoreJSONValue.string(UUID().uuidString)), ("recipientFingerprint", .string("partial")), ("received", .number(-1)), ("total", .number(268_435_457)), ("state", .string("running")), ("errorCode", .string("secret raw failure"))] {
            var bad = status; bad[field] = value; h.result = .object(bad)
            do { _ = try await h.client.request("agents.import.status", params: ["importId": .string(id)]); XCTFail("Invalid \(field)") }
            catch { XCTAssertNotEqual((error as? CoreApplicationError)?.code, "UNCERTAIN") }
        }
    }
    @MainActor func testCancelOnlyAcceptsOwnJobReceipt() async throws {
        let h = try AgentTransferHarness(), id = UUID().uuidString
        h.result = .object(["state": .string("accepted"), "importId": .string(id), "cancelled": .bool(true)])
        _ = try await h.client.request("agents.import.cancel", params: ["importId": .string(id)])
        h.result = .object(["state": .string("accepted"), "importId": .string(UUID().uuidString), "cancelled": .bool(true)])
        do { _ = try await h.client.request("agents.import.cancel", params: ["importId": .string(id)]); XCTFail("Job substitution") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "UNCERTAIN") }
    }
    @MainActor func testCompletedImportRequiresItsOwnPersistedIdleAgentReceipt() async throws {
        let h = try AgentTransferHarness(), id = UUID().uuidString
        let agent: [String: CoreJSONValue] = ["id": .string(UUID().uuidString), "sessionId": .string(UUID().uuidString),
            "importId": .string(id), "name": .string("Imported helper"), "instructions": .string("Inspect the approved workspace."),
            "provider": .string("fixture"), "model": .string("fixture-model"), "effort": .string("default"), "cwd": .string("/managed/agents/fresh"),
            "revision": .number(1), "state": .string("idle"), "archived": .bool(false), "createdAt": .string("2026-10-23T00:00:00Z"), "updatedAt": .string("2026-10-23T00:00:00Z")]
        let status: [String: CoreJSONValue] = ["importId": .string(id), "state": .string("complete"),
            "sourceFingerprint": .string(h.host.certificate.id), "recipientFingerprint": .null,
            "received": .number(1024), "total": .number(1024), "expiresAt": .number(Double(RelayWire.now + 60_000)), "agent": .object(agent)]
        h.result = .object(status)
        _ = try await h.client.request("agents.import.status", params: ["importId": .string(id)])
        for (field, value) in [("importId", CoreJSONValue.string(UUID().uuidString)), ("state", .string("running")), ("archived", .bool(true))] {
            var changed = agent; changed[field] = value
            var altered = status; altered["agent"] = .object(changed); h.result = .object(altered)
            do { _ = try await h.client.request("agents.import.status", params: ["importId": .string(id)]); XCTFail("Wrong completion receipt") }
            catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "INVALID_RESPONSE") }
        }
    }
}
