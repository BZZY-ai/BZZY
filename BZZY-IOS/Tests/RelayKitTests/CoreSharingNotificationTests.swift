import XCTest
@testable import RelayKit

@MainActor private final class SharingNotificationHarness {
    let host: RelayIdentity
    let shareID = UUID().uuidString.lowercased()
    var client: CoreRelayClient!
    var result: CoreJSONValue = .object([:])
    var sent: [WireValue] = []
    init() throws {
        host = try RelayIdentity.generate()
        client = CoreRelayClient(hostID: host.certificate.id, grantID: "paired-grant", resource: "approved-resource") { [weak self] frame in
            guard let self else { return }
            self.sent.append(frame)
            let response: CoreJSONValue = .object(["v": .number(1), "protocol": .string("bzzy-core"), "type": .string("response"),
                "id": .string(frame["id"].string!), "ok": .bool(true), "result": self.result])
            try self.client.receive(from: self.host.certificate.id, grantID: "paired-grant", payload: response.wire())
        }
    }
    func share(certificate: RelayCertificate? = nil, code: String? = nil, expiry: Int64? = nil,
               qrCode: String? = nil, qrExpiry: Int64? = nil) throws -> CoreJSONValue {
        let code = try code ?? "BZZY-TERMINAL-" + RelayWire.encoded(RelayWire.random())
        let expires = expiry ?? RelayWire.now + 60_000
        let invitation: WireValue = .object(["v": .number(1), "relay": .string(RelayWire.endpoint.absoluteString),
            "code": .string(qrCode ?? code), "sender": try RelayWire.object(certificate ?? host.certificate),
            "expiresAt": .number(Double(qrExpiry ?? expires))])
        return .object(["state": .string("accepted"), "kind": .string("TERMINAL"), "shareId": .string(shareID), "code": .string(code),
            "qr": .string("BZZY:INVITE:1:" + RelayWire.encoded(try invitation.data())), "expiresAt": .number(Double(expires)),
            "senderFingerprint": .string(host.certificate.id), "bytes": .number(2048), "sha256": .string(String(repeating: "a", count: 64))])
    }
}

final class CoreSharingNotificationTests: XCTestCase {
    func testSourceSharingOperationsAcceptOnlyExplicitBoundedSchema() throws {
        let share = UUID().uuidString, fingerprint = RelayWire.encoded(try RelayWire.random())
        _ = try CoreApplicationProtocol.request(op: "share.create", params: [:], id: "create", resource: "approved")
        _ = try CoreApplicationProtocol.request(op: "share.approve", params: ["shareId": .string(share), "claimId": .string("claim"), "confirmedFingerprint": .string(fingerprint)], id: "approve", resource: "approved")
        for op in ["share.status", "share.revoke"] {
            _ = try CoreApplicationProtocol.request(op: op, params: ["shareId": .string(share)], id: "request", resource: "approved")
        }
        for field in ["sessionId", "cwd", "path", "archive", "url", "headers", "credentials", "owner"] {
            XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "share.create", params: [field: .string("unapproved")], id: "create", resource: "approved"))
        }
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "share.approve", params: ["shareId": .string(share), "claimId": .string("claim")], id: "approve", resource: "approved"))
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "share.status", params: ["shareId": .string("not-a-uuid")], id: "request", resource: "approved"))
    }

    @MainActor func testShareCreationChecksPinnedHostPurposeCodeAndExpiryConsistency() async throws {
        let h = try SharingNotificationHarness()
        h.result = try h.share()
        let valid = try await h.client.request("share.create")
        XCTAssertEqual(valid["senderFingerprint"].string, h.host.certificate.id)
        XCTAssertEqual(h.sent.last?["resource"].string, "approved-resource")
        let other = try RelayIdentity.generate()
        let agentCode = "BZZY-AGENT-" + RelayWire.encoded(try RelayWire.random())
        let terminalCode = "BZZY-TERMINAL-" + RelayWire.encoded(try RelayWire.random())
        let malformed = [try h.share(certificate: other.certificate), try h.share(code: agentCode),
            try h.share(expiry: RelayWire.now - 1), try h.share(qrCode: terminalCode), try h.share(qrExpiry: RelayWire.now + 90_000)]
        for result in malformed {
            h.result = result
            do { _ = try await h.client.request("share.create"); XCTFail("Reject inconsistent source invitation") }
            catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "UNCERTAIN", "A malformed mutation response requires reconciliation") }
        }
    }

    @MainActor func testShareStatusValidatesSignedRecipientAndApprovalsRemainExplicit() async throws {
        let h = try SharingNotificationHarness(), recipient = try RelayIdentity.generate()
        let certificate = try CoreJSONValue(RelayWire.object(recipient.certificate))
        h.result = .object(["shareId": .string(h.shareID), "state": .string("pending"), "bytes": .number(2048),
            "expiresAt": .number(Double(RelayWire.now + 60_000)), "pending": .array([.object(["claimId": .string("claim"),
                "certificate": certificate, "fingerprint": .string(recipient.certificate.id)])])])
        let status = try await h.client.request("share.status", params: ["shareId": .string(h.shareID)])
        XCTAssertEqual(status["pending"].array?.count, 1)
        XCTAssertEqual(h.sent.count, 1, "Reading a pending recipient cannot automatically approve it")
        if case .object(var fields) = h.result {
            fields["pending"] = .array([.object(["claimId": .string("claim"), "certificate": certificate, "fingerprint": .string(h.host.certificate.id)])])
            h.result = .object(fields)
        }
        do { _ = try await h.client.request("share.status", params: ["shareId": .string(h.shareID)]); XCTFail("Recipient substitution") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "FORBIDDEN") }
        h.result = .object(["approved": .bool(true)])
        _ = try await h.client.request("share.approve", params: ["shareId": .string(h.shareID), "claimId": .string("claim"), "confirmedFingerprint": .string(recipient.certificate.id)])
        h.result = .object(["revoked": .bool(true)])
        _ = try await h.client.request("share.revoke", params: ["shareId": .string(h.shareID)])
        XCTAssertEqual(h.sent.map { $0["op"].string }, ["share.status", "share.status", "share.approve", "share.revoke"])
    }

    func testPushRegistrationAllowsOnlyDeviceTokenEnvironmentAndOwnNotificationScope() throws {
        let token = String(repeating: "ab", count: 32)
        let params: [String: CoreJSONValue] = ["deviceToken": .string(token), "environment": .string("sandbox"), "enabled": .bool(true), "scope": .string("terminals")]
        _ = try CoreApplicationProtocol.request(op: "notifications.register", params: params, id: "register", resource: "approved")
        for field in ["topic", "url", "recipient", "deviceId", "sessionId", "message", "headers", "credentials"] {
            var altered = params; altered[field] = .string("denied")
            XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "notifications.register", params: altered, id: "register", resource: "approved"))
        }
        for (field, value) in [("deviceToken", CoreJSONValue.string(String(repeating: "a", count: 63))),
                               ("deviceToken", .string(String(repeating: "a", count: 514))), ("deviceToken", .string(String(repeating: "g", count: 64))),
                               ("environment", .string("other")), ("scope", .string("all-users")), ("enabled", .string("yes"))] {
            var altered = params; altered[field] = value
            XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "notifications.register", params: altered, id: "register", resource: "approved"))
        }
        _ = try CoreApplicationProtocol.request(op: "notifications.update", params: ["enabled": .bool(false)], id: "update", resource: "approved")
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "notifications.update", params: ["enabled": .bool(false), "scope": .string("terminals")], id: "update", resource: "approved"))
        _ = try CoreApplicationProtocol.request(op: "notifications.revoke", params: [:], id: "revoke", resource: "approved")
    }

    @MainActor func testPushRegistrationResultCannotWidenRequestedScopeAndNeverEchoesToken() async throws {
        let h = try SharingNotificationHarness(), token = String(repeating: "ab", count: 32)
        let params: [String: CoreJSONValue] = ["deviceToken": .string(token), "environment": .string("sandbox"), "enabled": .bool(true), "scope": .string("session")]
        h.result = .object(["registered": .bool(true), "enabled": .bool(true), "providerConfigured": .bool(false), "scope": .string("session")])
        let result = try await h.client.request("notifications.register", params: params)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(result), as: UTF8.self).contains(token))
        h.result = .object(["registered": .bool(true), "enabled": .bool(true), "providerConfigured": .bool(true), "scope": .string("terminals")])
        do { _ = try await h.client.request("notifications.register", params: params); XCTFail("Scope widening") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "UNCERTAIN") }
        h.result = .object(["registered": .bool(true), "enabled": .bool(false), "providerConfigured": .bool(false), "scope": .string("session")])
        _ = try await h.client.request("notifications.update", params: ["enabled": .bool(false)])
        h.result = .object(["revoked": .bool(true)])
        _ = try await h.client.request("notifications.revoke")
    }
}
