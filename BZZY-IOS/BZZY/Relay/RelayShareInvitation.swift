import Foundation

public enum RelayShareKind: String, Sendable { case agent = "AGENT", terminal = "TERMINAL" }

/// Read-only validation. It never claims a code, pins a sender or grants runtime access.
public struct RelayShareInvitation: CustomStringConvertible, CustomDebugStringConvertible {
    public let kind: RelayShareKind
    /// Temporary capability, retained only by the active import sheet. Never log or persist.
    public let code: String
    public let senderFingerprint: String?
    public let expiresAt: Date?
    public var description: String { "BZZY \(kind.rawValue) invitation (redacted)" }
    public var debugDescription: String { description }

    public static func parse(_ text: String, expectedKind: RelayShareKind, now: Date = Date()) throws -> RelayShareInvitation {
        try parse(text, expectedKind: expectedKind, now: now, endpoint: RelayWire.endpoint)
    }

    // The app supplies only its fixed TLS endpoint. Integration clients may use
    // the transport's separately validated numeric-loopback testing endpoint.
    static func parse(_ text: String, expectedKind: RelayShareKind, now: Date = Date(), endpoint: URL) throws -> RelayShareInvitation {
        do { return try validated(text, expectedKind: expectedKind, now: now, endpoint: endpoint) }
        catch let error as RelayFailure where ["INVITE_EXPIRED", "WRONG_AGENT_IMPORT", "WRONG_TERMINAL_IMPORT"].contains(error.code) { throw error }
        catch { throw RelayFailure("INVALID_SHARE_INVITATION") }
    }

    private static func validated(_ text: String, expectedKind: RelayShareKind, now: Date, endpoint: URL) throws -> RelayShareInvitation {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard raw.utf8.count <= 4096 else { throw RelayFailure("INVALID_SHARE_INVITATION") }
        var code = raw
        var sender: String?
        var expiry: Date?
        if raw.hasPrefix("BZZY:INVITE:1:") {
            guard raw.count <= 4096 else { throw RelayFailure("INVALID_SHARE_INVITATION") }
            let value = try WireValue.parse(RelayWire.decoded(String(raw.dropFirst(14))))
            try value.record(["v", "relay", "code", "sender", "expiresAt"])
            guard value["v"].integer == 1, value["relay"].string == endpoint.absoluteString,
                  let encoded = value["code"].string, let expires = value["expiresAt"].integer else { throw RelayFailure("INVALID_SHARE_INVITATION") }
            guard expires > Int64(now.timeIntervalSince1970 * 1000) else { throw RelayFailure("INVITE_EXPIRED") }
            code = encoded
            sender = try RelayCertificate.parse(value["sender"]).id
            expiry = Date(timeIntervalSince1970: Double(expires) / 1000)
        }
        let prefix = "BZZY-\(expectedKind.rawValue)-"
        guard code.hasPrefix(prefix) else { throw RelayFailure(expectedKind == .agent ? "WRONG_AGENT_IMPORT" : "WRONG_TERMINAL_IMPORT") }
        guard (try? RelayWire.decoded(String(code.dropFirst(prefix.count)), count: 32)) != nil else { throw RelayFailure("INVALID_SHARE_INVITATION") }
        return .init(kind: expectedKind, code: code, senderFingerprint: sender, expiresAt: expiry)
    }
}
