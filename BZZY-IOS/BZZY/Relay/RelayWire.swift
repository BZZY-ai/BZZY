import Foundation
import CryptoKit
import Security
import Sodium

enum WireValue: Codable, Equatable, Sendable {
    case object([String: WireValue]), array([WireValue]), string(String), number(Double), bool(Bool), null

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let item = try? value.decode(Bool.self) { self = .bool(item) }
        else if let item = try? value.decode(String.self) { self = .string(item) }
        else if let item = try? value.decode(Double.self), item.isFinite { self = .number(item) }
        else if let item = try? value.decode([String: WireValue].self) { self = .object(item) }
        else if let item = try? value.decode([WireValue].self) { self = .array(item) }
        else { throw RelayFailure("INVALID_MESSAGE") }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let x): try value.encode(x)
        case .array(let x): try value.encode(x)
        case .string(let x): try value.encode(x)
        case .number(let x): try value.encode(x)
        case .bool(let x): try value.encode(x)
        case .null: try value.encodeNil()
        }
    }
    subscript(_ key: String) -> WireValue { if case .object(let x) = self { return x[key] ?? .null }; return .null }
    var string: String? { if case .string(let x) = self { return x }; return nil }
    var integer: Int64? {
        guard case .number(let x) = self, x.rounded() == x, abs(x) <= 9_007_199_254_740_991 else { return nil }
        return Int64(x)
    }
    var bool: Bool? { if case .bool(let x) = self { return x }; return nil }
    var array: [WireValue]? { if case .array(let x) = self { return x }; return nil }
    func record(_ keys: Set<String>, required: Set<String>? = nil) throws {
        guard case .object(let values) = self, Set(values.keys).isSubset(of: keys),
              (required ?? keys).isSubset(of: Set(values.keys)) else { throw RelayFailure("INVALID_MESSAGE") }
    }
    static func parse(_ data: Data) throws -> WireValue {
        guard data.count <= 65_536 else { throw RelayFailure("FRAME_TOO_LARGE") }
        do { return try JSONDecoder().decode(WireValue.self, from: data) }
        catch { throw RelayFailure("INVALID_MESSAGE") }
    }
    func data() throws -> Data { try JSONEncoder().encode(self) }
}

struct RelayFailure: Error, LocalizedError, Equatable {
    let code: String
    init(_ code: String) {
        self.code = code.range(of: "^[A-Z_]{1,64}$", options: .regularExpression) != nil ? code : "REQUEST_FAILED"
    }
    var errorDescription: String? {
        switch code {
        case "HOST_OFFLINE", "PEER_OFFLINE": "Host offline."
        case "INVITE_EXPIRED": "Code expired."
        case "INVITE_UNAVAILABLE": "Code unavailable. Ask your host for a new one."
        case "UNTRUSTED_PEER", "IDENTITY_CHANGED", "HOST_MISMATCH": "Host identity does not match."
        case "DEVICE_REVOKED", "AUTH_FAILED": "Device authorization denied."
        case "DEVICE_CONNECTED": "This device already has a connection. Try again shortly."
        case "GRANT_UNAVAILABLE": "Access expired or was revoked."
        case "KEYCHAIN_UNAVAILABLE", "INVALID_IDENTITY": "Device identity unavailable. Unlock your iPhone and try again."
        case "UNCERTAIN": "Request status is uncertain. Check your host before trying again."
        case "INVALID_INVITATION", "INVALID_CODE", "INVALID_ENCODING": "Use a valid BZZY pairing QR or code."
        case "WRONG_AGENT_IMPORT": "Use an AGENT invitation in this tab."
        case "WRONG_TERMINAL_IMPORT": "Use a TERMINAL invitation in this tab."
        case "INVALID_SHARE_INVITATION": "Use a valid BZZY import QR or code."
        case "WRONG_PURPOSE": "Use a PAIR invitation to connect a host."
        case "TLS_FAILED": "Secure connection could not be verified."
        default: "Connection unavailable. Try again."
        }
    }
}

enum RelayWire {
    static let endpoint = URL(string: "wss://190.114.255.214/v1/socket")!
    static let subprotocol = "bzzy-relay.v1"
    static let sodium = Sodium()
    static var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    static func encoded(_ bytes: Data) -> String {
        bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func decoded(_ text: String, count: Int? = nil) throws -> Data {
        guard text.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
              text.count <= 65_536 else { throw RelayFailure("INVALID_ENCODING") }
        let padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            + String(repeating: "=", count: (4 - text.count % 4) % 4)
        guard let data = Data(base64Encoded: padded), encoded(data) == text,
              count == nil || data.count == count else { throw RelayFailure("INVALID_ENCODING") }
        return data
    }
    static func random(_ count: Int = 32) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { throw RelayFailure("RANDOM_FAILED") }
        return Data(bytes)
    }
    static func opaque(_ value: String) throws {
        guard value.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil else { throw RelayFailure("INVALID_MESSAGE") }
    }
    static func object<T: Encodable>(_ value: T) throws -> WireValue { try WireValue.parse(JSONEncoder().encode(value)) }
    static func decode<T: Decodable>(_ type: T.Type, _ value: WireValue) throws -> T {
        do { return try JSONDecoder().decode(type, from: value.data()) }
        catch { throw RelayFailure("INVALID_MESSAGE") }
    }
}

struct RelayCertificate: Codable, Equatable, Sendable {
    let v: Int
    let id: String
    let signKey: String
    let boxKey: String
    let signature: String

    func verify() throws {
        guard v == 1, id == RelayWire.encoded(Data(SHA256.hash(data: Data(signKey.utf8)))),
              RelayWire.sodium.sign.verify(message: Array("BZZY-RELAY encryption key v1\n\(boxKey)".utf8),
                                           publicKey: Array(try RelayWire.decoded(signKey, count: 32)),
                                           signature: Array(try RelayWire.decoded(signature, count: 64))) else {
            throw RelayFailure("INVALID_IDENTITY")
        }
        _ = try RelayWire.decoded(boxKey, count: 32)
    }
    static func parse(_ value: WireValue) throws -> RelayCertificate {
        try value.record(["v", "id", "signKey", "boxKey", "signature"])
        let cert = try RelayWire.decode(Self.self, value)
        try cert.verify()
        return cert
    }
}

struct RelayIdentity: Codable {
    let certificate: RelayCertificate
    private let signingSecret: Data
    private let boxSecret: Data

    static func generate() throws -> RelayIdentity {
        guard let signing = RelayWire.sodium.sign.keyPair(), let encryption = RelayWire.sodium.box.keyPair() else {
            throw RelayFailure("INVALID_IDENTITY")
        }
        let signKey = RelayWire.encoded(Data(signing.publicKey)), boxKey = RelayWire.encoded(Data(encryption.publicKey))
        guard let signature = RelayWire.sodium.sign.signature(message: Array("BZZY-RELAY encryption key v1\n\(boxKey)".utf8),
                                                               secretKey: signing.secretKey) else { throw RelayFailure("INVALID_IDENTITY") }
        return RelayIdentity(certificate: .init(v: 1, id: RelayWire.encoded(Data(SHA256.hash(data: Data(signKey.utf8)))),
                                                signKey: signKey, boxKey: boxKey, signature: RelayWire.encoded(Data(signature))),
                             signingSecret: Data(signing.secretKey), boxSecret: Data(encryption.secretKey))
    }
    func validate() throws {
        try certificate.verify()
        guard signingSecret.count == 64, boxSecret.count == 32 else { throw RelayFailure("INVALID_IDENTITY") }
        let proof = try sign("BZZY identity storage validation")
        guard RelayWire.sodium.sign.verify(message: Array("BZZY identity storage validation".utf8),
                                           publicKey: Array(try RelayWire.decoded(certificate.signKey, count: 32)),
                                           signature: Array(try RelayWire.decoded(proof, count: 64))) else { throw RelayFailure("INVALID_IDENTITY") }
        // A roundtrip using an independent ephemeral peer checks the stored box key.
        let peer = try RelayIdentity.generate()
        let box = try peer.seal(.string("storage validation"), to: certificate)
        guard try open(box, from: peer.certificate) == .string("storage validation") else { throw RelayFailure("INVALID_IDENTITY") }
    }
    func sign(_ text: String) throws -> String {
        guard let signature = RelayWire.sodium.sign.signature(message: Array(text.utf8), secretKey: Array(signingSecret)) else {
            throw RelayFailure("INVALID_IDENTITY")
        }
        return RelayWire.encoded(Data(signature))
    }
    func seal(_ value: WireValue, to peer: RelayCertificate) throws -> WireValue {
        try peer.verify()
        let nonce = try RelayWire.random(24)
        guard let ciphertext = RelayWire.sodium.box.seal(message: Array(try value.data()),
                    recipientPublicKey: Array(try RelayWire.decoded(peer.boxKey, count: 32)),
                    senderSecretKey: Array(boxSecret), nonce: Array(nonce)), ciphertext.count <= 45 * 1024 else {
            throw RelayFailure("ENCRYPTION_FAILED")
        }
        return .object(["nonce": .string(RelayWire.encoded(nonce)), "ciphertext": .string(RelayWire.encoded(Data(ciphertext)))])
    }
    func open(_ box: WireValue, from peer: RelayCertificate) throws -> WireValue {
        try box.record(["nonce", "ciphertext"])
        guard let nonceText = box["nonce"].string, let ciphertextText = box["ciphertext"].string else { throw RelayFailure("DECRYPTION_FAILED") }
        let nonce = try RelayWire.decoded(nonceText, count: 24), ciphertext = try RelayWire.decoded(ciphertextText)
        guard ciphertext.count >= 16, ciphertext.count <= 45 * 1024,
              let plaintext = RelayWire.sodium.box.open(authenticatedCipherText: Array(ciphertext),
                    senderPublicKey: Array(try RelayWire.decoded(peer.boxKey, count: 32)),
                    recipientSecretKey: Array(boxSecret), nonce: Array(nonce)) else { throw RelayFailure("DECRYPTION_FAILED") }
        return try WireValue.parse(Data(plaintext))
    }
}

struct RelayPresence: Codable, Equatable {
    let epoch: String
    let signature: String
    func verify(peer: RelayCertificate) throws {
        _ = try RelayWire.decoded(epoch, count: 32)
        guard RelayWire.sodium.sign.verify(message: Array("BZZY-RELAY presence v1\n\(peer.id)\n\(epoch)".utf8),
                                           publicKey: Array(try RelayWire.decoded(peer.signKey, count: 32)),
                                           signature: Array(try RelayWire.decoded(signature, count: 64))) else { throw RelayFailure("INVALID_PRESENCE") }
    }
}

struct PairInvitation {
    let code: String
    let sender: RelayCertificate?
    let fingerprint: String
    let expiresAt: Int64?

    static func parse(_ text: String, fingerprint: String = "", now: Int64 = RelayWire.now) throws -> PairInvitation {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.hasPrefix("BZZY:P:") {
            let bytes = try compactBytes(String(raw.dropFirst(7)))
            // The configured Relay enforces the same expiry and single-use claim
            // as the manual code. Trust is confirmed against the approved peer.
            return PairInvitation(code: "BZZY-PAIR-" + RelayWire.encoded(bytes.prefix(32)), sender: nil,
                fingerprint: RelayWire.encoded(bytes.suffix(32)), expiresAt: nil)
        }
        if raw.hasPrefix("BZZY:INVITE:1:") {
            guard raw.count <= 4096 else { throw RelayFailure("INVALID_INVITATION") }
            let value = try WireValue.parse(RelayWire.decoded(String(raw.dropFirst(14))))
            try value.record(["v", "relay", "code", "sender", "expiresAt"])
            guard value["v"].integer == 1, value["relay"].string == RelayWire.endpoint.absoluteString,
                  let code = value["code"].string, let expiry = value["expiresAt"].integer, expiry > now else {
                throw RelayFailure("INVALID_INVITATION")
            }
            try validateCode(code)
            let sender = try RelayCertificate.parse(value["sender"])
            return PairInvitation(code: code, sender: sender, fingerprint: sender.id, expiresAt: expiry)
        }
        try validateCode(raw)
        _ = try RelayWire.decoded(fingerprint, count: 32)
        return PairInvitation(code: raw, sender: nil, fingerprint: fingerprint, expiresAt: nil)
    }

    private static func compactBytes(_ text: String) throws -> Data {
        guard text.utf8.count == 103 else { throw RelayFailure("INVALID_INVITATION") }
        var bytes = Data(), buffer: UInt16 = 0, bits = 0
        for character in text.utf8 {
            let value: UInt16
            switch character {
            case 65...90: value = UInt16(character - 65)
            case 50...55: value = UInt16(character - 24)
            default: throw RelayFailure("INVALID_INVITATION")
            }
            buffer = (buffer << 5) | value
            bits += 5
            if bits >= 8 {
                bits -= 8
                bytes.append(UInt8((buffer >> bits) & 255))
                buffer &= (1 << bits) - 1
            }
        }
        guard bytes.count == 64, bits == 3, buffer == 0 else { throw RelayFailure("INVALID_INVITATION") }
        return bytes
    }
    static func validateCode(_ text: String) throws {
        guard text.hasPrefix("BZZY-PAIR-") else { throw RelayFailure("WRONG_PURPOSE") }
        _ = try RelayWire.decoded(String(text.dropFirst(10)), count: 32)
    }
}

struct ReplayWindow {
    private var entries: [String: Int64] = [:]
    let capacity: Int
    init(capacity: Int = 4096) { self.capacity = capacity }
    mutating func accept(_ id: String, expiresAt: Int64, now: Int64 = RelayWire.now) throws {
        entries = entries.filter { $0.value > now }
        guard entries[id] == nil else { throw RelayFailure("REPLAY") }
        guard entries.count < capacity else { throw RelayFailure("REPLAY_CAPACITY") }
        entries[id] = expiresAt
    }
}

/// Validates authenticated plaintext against the routing context of this socket.
enum RelayEnvelope {
    static func validate(_ value: WireValue, from: String, to: String, grantID: String,
                         messageID: String, epoch: String, now: Int64 = RelayWire.now) throws {
        try value.record(["v", "from", "to", "grantId", "messageId", "receiverEpoch", "expiresAt", "payload"])
        guard value["v"].integer == 1, value["from"].string == from, value["to"].string == to,
              value["grantId"].string == grantID, value["messageId"].string == messageID,
              value["receiverEpoch"].string == epoch, let expiry = value["expiresAt"].integer,
              expiry > now - 5_000, expiry <= now + 65_000 else { throw RelayFailure("ROUTING_MISMATCH") }
    }
}
