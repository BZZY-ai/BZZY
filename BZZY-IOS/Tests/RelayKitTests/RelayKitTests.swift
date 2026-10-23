import XCTest
@testable import RelayKit

final class RelayKitTests: XCTestCase {
    func testIdentityBindingAndAuthenticatedBoxes() throws {
        let sender = try RelayIdentity.generate(), receiver = try RelayIdentity.generate(), stranger = try RelayIdentity.generate()
        try sender.validate(); try receiver.validate()
        let payload: WireValue = .object(["v": .number(1), "message": .string("Disposable interoperability test")])
        let box = try sender.seal(payload, to: receiver.certificate)
        XCTAssertEqual(try receiver.open(box, from: sender.certificate), payload)
        XCTAssertEqual(try RelayWire.decoded(box["nonce"].string!).count, 24)
        XCTAssertThrowsError(try stranger.open(box, from: sender.certificate))
        XCTAssertThrowsError(try receiver.open(box, from: stranger.certificate))
        var modified = try RelayWire.decoded(box["ciphertext"].string!); modified[0] ^= 1
        let corrupt: WireValue = .object(["nonce": box["nonce"], "ciphertext": .string(RelayWire.encoded(modified))])
        XCTAssertThrowsError(try receiver.open(corrupt, from: sender.certificate))
        let certificate = sender.certificate
        let substituted = RelayCertificate(v: 1, id: certificate.id, signKey: certificate.signKey,
                                           boxKey: stranger.certificate.boxKey, signature: certificate.signature)
        XCTAssertThrowsError(try substituted.verify())
        let restored = try JSONDecoder().decode(RelayIdentity.self, from: JSONEncoder().encode(sender))
        try restored.validate()
        XCTAssertEqual(restored.certificate, certificate)
    }

    func testCanonicalEncodingAndStrictRecords() throws {
        XCTAssertThrowsError(try RelayWire.decoded("Zg=="))
        XCTAssertThrowsError(try RelayWire.decoded("Zh")) // Same decoded byte, noncanonical pad bits.
        XCTAssertThrowsError(try RelayWire.decoded("Zg", count: 32))
        XCTAssertEqual(try RelayWire.decoded("Zg"), Data([102]))
        XCTAssertThrowsError(try WireValue.object(["extra": .null]).record([]))
        XCTAssertThrowsError(try WireValue.object([:]).record(["required"]))
        XCTAssertThrowsError(try WireValue.parse(Data(repeating: 32, count: 65_537)))
    }

    func testPairingPurposeEndpointExpiryAndIdentity() throws {
        let host = try RelayIdentity.generate()
        let code = "BZZY-PAIR-" + RelayWire.encoded(try RelayWire.random())
        let invite: WireValue = .object(["v": .number(1), "relay": .string(RelayWire.endpoint.absoluteString),
            "code": .string(code), "sender": try RelayWire.object(host.certificate), "expiresAt": .number(20_000)])
        let qr = "BZZY:INVITE:1:" + RelayWire.encoded(try invite.data())
        XCTAssertEqual(try PairInvitation.parse(qr, now: 10_000).fingerprint, host.certificate.id)
        XCTAssertThrowsError(try PairInvitation.parse(qr, now: 20_000))
        XCTAssertEqual(try PairInvitation.parse(code, fingerprint: host.certificate.id).fingerprint, host.certificate.id)
        XCTAssertThrowsError(try PairInvitation.parse(code))
        XCTAssertThrowsError(try PairInvitation.parse(code.replacingOccurrences(of: "PAIR", with: "AGENT"), fingerprint: host.certificate.id))
        XCTAssertThrowsError(try PairInvitation.parse("https://example.com/invite"))
        var changed = invite
        if case .object(var fields) = changed {
            fields["relay"] = .string("wss://example.com/v1/socket"); changed = .object(fields)
        }
        XCTAssertThrowsError(try PairInvitation.parse("BZZY:INVITE:1:" + RelayWire.encoded(changed.data()), now: 10_000))
    }

    func testPresenceBindingAndReplayCapacity() throws {
        let host = try RelayIdentity.generate(), other = try RelayIdentity.generate()
        let epoch = RelayWire.encoded(try RelayWire.random())
        let presence = RelayPresence(epoch: epoch, signature: try host.sign("BZZY-RELAY presence v1\n\(host.certificate.id)\n\(epoch)"))
        try presence.verify(peer: host.certificate)
        XCTAssertThrowsError(try presence.verify(peer: other.certificate))
        var guardrail = ReplayWindow(capacity: 2)
        try guardrail.accept("one", expiresAt: 100, now: 1)
        XCTAssertThrowsError(try guardrail.accept("one", expiresAt: 100, now: 2))
        try guardrail.accept("two", expiresAt: 100, now: 2)
        XCTAssertThrowsError(try guardrail.accept("three", expiresAt: 100, now: 3))
        try guardrail.accept("three", expiresAt: 200, now: 100)
    }

    func testCompactPairingQRMatchesCanonicalCrossLanguageVector() throws {
        // RFC 4648 base32 for bytes 0...63, shared with the Relay codec tests.
        let qr = "BZZY:P:AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSAIJCEMSCKJRHFAUSUKZMFUXC6MBRGIZTINJWG44DSOR3HQ6T4PY"
        let invitation = try PairInvitation.parse(qr)
        XCTAssertEqual(invitation.code, "BZZY-PAIR-AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
        XCTAssertEqual(invitation.fingerprint, "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8")
        XCTAssertNil(invitation.sender)
        XCTAssertNil(invitation.expiresAt, "Relay enforces expiry after scanning, as for manual pairing codes")
        XCTAssertEqual(try PairInvitation.parse(" \n" + qr + "\n ").code, invitation.code)
        for invalid in [qr.lowercased(), qr + "=", String(qr.dropLast()), qr + "A",
                        String(qr.dropLast()) + "Z", qr.replacingOccurrences(of: "AAAQ", with: "A0AQ"),
                        qr.replacingOccurrences(of: "AAAQ", with: "AA Q")] {
            XCTAssertThrowsError(try PairInvitation.parse(invalid))
        }
    }

    func testShareInvitationKindsExpiryEndpointAndCertificate() throws {
        let sender = try RelayIdentity.generate(), other = try RelayIdentity.generate()
        let now = Date(timeIntervalSince1970: 10)
        for kind in [RelayShareKind.agent, .terminal] {
            let code = "BZZY-\(kind.rawValue)-" + RelayWire.encoded(try RelayWire.random())
            let fields: [String: WireValue] = ["v": .number(1), "relay": .string(RelayWire.endpoint.absoluteString),
                "code": .string(code), "sender": try RelayWire.object(sender.certificate), "expiresAt": .number(20_000)]
            func qr(_ fields: [String: WireValue]) throws -> String { "BZZY:INVITE:1:" + RelayWire.encoded(try WireValue.object(fields).data()) }
            let parsed = try RelayShareInvitation.parse(qr(fields), expectedKind: kind, now: now)
            XCTAssertEqual(parsed.kind, kind)
            XCTAssertEqual(parsed.senderFingerprint, sender.certificate.id)
            XCTAssertEqual(parsed.expiresAt, Date(timeIntervalSince1970: 20))
            XCTAssertFalse(parsed.description.contains(code))
            XCTAssertNil(try RelayShareInvitation.parse(code, expectedKind: kind).senderFingerprint)
            XCTAssertThrowsError(try RelayShareInvitation.parse(qr(fields), expectedKind: kind, now: Date(timeIntervalSince1970: 20)))
            XCTAssertThrowsError(try RelayShareInvitation.parse(code, expectedKind: kind == .agent ? .terminal : .agent))
            XCTAssertThrowsError(try RelayShareInvitation.parse(code + "=", expectedKind: kind))
            for (key, value) in [("v", WireValue.number(2)), ("relay", .string("wss://example.com/v1/socket")),
                                 ("extra", .bool(true)), ("expiresAt", .number(20_000.5))] {
                var changed = fields; changed[key] = value
                XCTAssertThrowsError(try RelayShareInvitation.parse(qr(changed), expectedKind: kind, now: now))
            }
            var changed = fields
            let certificate = sender.certificate
            changed["sender"] = try RelayWire.object(RelayCertificate(v: 1, id: certificate.id, signKey: certificate.signKey,
                boxKey: other.certificate.boxKey, signature: certificate.signature))
            XCTAssertThrowsError(try RelayShareInvitation.parse(qr(changed), expectedKind: kind, now: now))
        }
        XCTAssertThrowsError(try RelayShareInvitation.parse("BZZY-PAIR-" + RelayWire.encoded(try RelayWire.random()), expectedKind: .agent))
        XCTAssertThrowsError(try RelayShareInvitation.parse("https://example.com/invite", expectedKind: .terminal))
        XCTAssertThrowsError(try RelayShareInvitation.parse(String(repeating: "A", count: 4097), expectedKind: .agent))
        XCTAssertThrowsError(try RelayShareInvitation.parse("BZZY:INVITE:1:bad", expectedKind: .agent))
    }

    func testEnvelopeRejectsWrongSocketRouteAndLifetime() throws {
        let envelope: [String: WireValue] = ["v": .number(1), "from": .string("host"), "to": .string("phone"),
            "grantId": .string("grant"), "messageId": .string("message"), "receiverEpoch": .string("current-epoch"),
            "expiresAt": .number(100_000), "payload": .object(["test": .bool(true)])]
        func validate(_ fields: [String: WireValue]) throws {
            try RelayEnvelope.validate(.object(fields), from: "host", to: "phone", grantID: "grant", messageID: "message", epoch: "current-epoch", now: 50_000)
        }
        try validate(envelope)
        for field in ["from", "to", "grantId", "messageId", "receiverEpoch"] {
            var changed = envelope; changed[field] = .string("different")
            XCTAssertThrowsError(try validate(changed), "Reject mismatched \(field)")
        }
        for expiry in [45_000.0, 115_001.0, 90_000.5] {
            var changed = envelope; changed["expiresAt"] = .number(expiry)
            XCTAssertThrowsError(try validate(changed))
        }
    }

    func testSwiftToExistingNodeRuntimeInteroperability() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let reference = root.deletingLastPathComponent().appendingPathComponent("BZZY-RELAY/src/identity.js")
        guard FileManager.default.fileExists(atPath: reference.path) else { throw XCTSkip("Neighboring Relay reference runtime not installed") }
        let sender = try RelayIdentity.generate()
        let certificate = try RelayCertificate.parse(node(.object(["op": .string("certificate")]), root: root)["certificate"])
        let payload: WireValue = .object(["test": .string("Swift to Node"), "v": .number(1)])
        let result = try node(.object(["op": .string("roundtrip"), "certificate": try RelayWire.object(sender.certificate),
                                      "box": try sender.seal(payload, to: certificate)]), root: root)
        XCTAssertEqual(result["received"], payload)
        XCTAssertEqual(try sender.open(result["box"], from: certificate), .object(["test": .string("Node to Swift"), "v": .number(1)]))
    }

    private func node(_ input: WireValue, root: URL) throws -> WireValue {
        let process = Process(), incoming = Pipe(), outgoing = Pipe(), errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", root.appendingPathComponent("tools/relay-interop.mjs").path]
        process.standardInput = incoming; process.standardOutput = outgoing; process.standardError = errors
        try process.run()
        try incoming.fileHandleForWriting.write(contentsOf: input.data())
        try incoming.fileHandleForWriting.close()
        let data = outgoing.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw RelayFailure("INTEROP_FAILED") }
        return try WireValue.parse(data)
    }
}
