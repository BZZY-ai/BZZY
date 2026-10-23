import Foundation

/// Lossless JSON values for the encrypted Core application payload. Bodies remain
/// their original strings; presentation and evidence interpretation belong to clients.
public enum CoreJSONValue: Codable, Equatable, Sendable {
    case object([String: CoreJSONValue]), array([CoreJSONValue]), string(String), number(Double), bool(Bool), null

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let x = try? value.decode(Bool.self) { self = .bool(x) }
        else if let x = try? value.decode(String.self) { self = .string(x) }
        else if let x = try? value.decode(Double.self), x.isFinite { self = .number(x) }
        else if let x = try? value.decode([String: CoreJSONValue].self) { self = .object(x) }
        else if let x = try? value.decode([CoreJSONValue].self) { self = .array(x) }
        else { throw CoreApplicationError("INVALID_RESPONSE") }
    }
    public func encode(to encoder: Encoder) throws {
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
    public subscript(_ key: String) -> CoreJSONValue { object?[key] ?? .null }
    public var string: String? { if case .string(let x) = self { return x }; return nil }
    public var bool: Bool? { if case .bool(let x) = self { return x }; return nil }
    public var array: [CoreJSONValue]? { if case .array(let x) = self { return x }; return nil }
    public var object: [String: CoreJSONValue]? { if case .object(let x) = self { return x }; return nil }
    public var integer: Int64? {
        guard case .number(let x) = self, x.isFinite, x.rounded() == x, abs(x) <= 9_007_199_254_740_991 else { return nil }
        return Int64(x)
    }
    func record(_ allowed: Set<String>, required: Set<String>? = nil) throws {
        guard let values = object, Set(values.keys).isSubset(of: allowed),
              (required ?? allowed).isSubset(of: Set(values.keys)) else { throw CoreApplicationError("INVALID_RESPONSE") }
    }
    func wire() throws -> WireValue { try WireValue.parse(JSONEncoder().encode(self)) }
    init(_ wire: WireValue) throws { self = try JSONDecoder().decode(Self.self, from: wire.data()) }
}

public struct CoreApplicationError: Error, LocalizedError, Equatable, Sendable {
    public let code: String
    public init(_ code: String) {
        self.code = code.range(of: "^[A-Z_]{1,64}$", options: .regularExpression) == nil ? "CORE_UNAVAILABLE" : code
    }
    public var errorDescription: String? {
        switch code {
        case "UNCERTAIN": "Command acceptance is uncertain. Reconcile its saved ID before trying again."
        case "FORBIDDEN", "GRANT_UNAVAILABLE": "Core access is unavailable or this action is not permitted."
        case "OPERATION_DENIED": "This operation is unavailable for the paired resource."
        case "PROJECTION_UNAVAILABLE": "The saved conversation could not be read or saved."
        case "PROJECTION_CAPACITY": "The local conversation storage limit was reached."
        case "OFFLINE": "Core is disconnected."
        case "RESULT_TOO_LARGE": "This result exceeds the current protocol limit."
        default: "Core request failed (\(code))."
        }
    }
}

public struct CoreEvent: Codable, Equatable, Sendable {
    public let version: Int
    public let id: String
    public let seq: Int64
    public let sessionId: String
    public let type: String
    public let createdAt: String
    public let data: CoreJSONValue

    init(_ value: CoreJSONValue, sessionID: String) throws {
        try value.record(["version", "id", "seq", "sessionId", "type", "createdAt", "data"])
        guard value["version"].integer == 1, let seq = value["seq"].integer, seq > 0,
              value["sessionId"].string == sessionID, value["id"].string == "\(sessionID):\(seq)",
              let type = value["type"].string, !type.isEmpty, type.utf8.count <= 256,
              let createdAt = value["createdAt"].string, !createdAt.isEmpty else { throw CoreApplicationError("INVALID_RESPONSE") }
        self.version = 1; self.id = "\(sessionID):\(seq)"; self.seq = seq; self.sessionId = sessionID
        self.type = type; self.createdAt = createdAt; self.data = value["data"]
    }
    func validate(sessionID: String) throws {
        _ = try CoreEvent(JSONDecoder().decode(CoreJSONValue.self, from: JSONEncoder().encode(self)), sessionID: sessionID)
    }
}

public struct CoreEventBatch: Sendable {
    public let subscriptionId: String
    public let resource: String
    public let sessionId: String
    public let events: [CoreEvent]
    public let nextCursor: Int64
    public let hasMore: Bool

    init(_ value: CoreJSONValue, resource: String, sessionID: String, cursor: Int64) throws {
        try value.record(["v", "protocol", "type", "subscriptionId", "resource", "sessionId", "events", "nextCursor", "hasMore"])
        guard let subscription = value["subscriptionId"].string, value["resource"].string == resource,
              value["sessionId"].string == sessionID, let list = value["events"].array, !list.isEmpty, list.count <= 50,
              let next = value["nextCursor"].integer, let more = value["hasMore"].bool else { throw CoreApplicationError("INVALID_RESPONSE") }
        try CoreApplicationProtocol.opaque(subscription)
        let events = try list.map { try CoreEvent($0, sessionID: sessionID) }
        var previous = cursor
        for event in events { guard event.seq > previous else { throw CoreApplicationError("INVALID_CURSOR") }; previous = event.seq }
        guard next == previous else { throw CoreApplicationError("INVALID_CURSOR") }
        self.subscriptionId = subscription; self.resource = resource; self.sessionId = sessionID
        self.events = events; self.nextCursor = next; self.hasMore = more
    }
}

enum CoreApplicationProtocol {
    static let payloadBytes = 28 * 1024
    static let promptBytes = 16 * 1024
    static let commands: Set<String> = ["execution.execute", "task.submit", "question.answer", "control.request", "sessions.open", "share.create", "share.approve", "share.revoke", "notifications.register", "notifications.update", "notifications.revoke", "agents.create", "agents.update", "agents.archive", "agents.open", "agents.import", "agents.import.cancel"]
    static let fields: [String: Set<String>] = [
        "host.metrics": [],
        "agents.status": [], "agents.providers": [], "agents.models": ["provider", "after", "limit"], "agents.list": ["after", "limit"], "agents.get": ["agentId"],
        "agents.create": ["name", "instructions", "provider", "model", "effort"], "agents.update": ["agentId", "expectedRevision", "name", "instructions", "provider", "model", "effort"],
        "agents.archive": ["agentId", "expectedRevision"], "agents.open": ["agentId"],
        "agents.import": ["code", "expectedSenderFingerprint", "provider", "model", "effort", "name"],
        "agents.import.status": ["importId"], "agents.import.cancel": ["importId"],
        "notifications.register": ["deviceToken", "environment", "enabled", "scope"], "notifications.update": ["enabled"], "notifications.revoke": [],
        "share.create": [], "share.status": ["shareId"], "share.approve": ["shareId", "claimId", "confirmedFingerprint"], "share.revoke": ["shareId"],
        "session.get": [], "session.usage": [], "sessions.list": ["after", "limit"], "sessions.open": ["sessionId"],
        "assistant.status": [], "task.submit": ["owner", "instruction"], "task.get": ["taskId"],
        "events.list": ["after", "limit"], "events.subscribe": ["consumerId"], "events.ack": ["subscriptionId", "seq"],
        "events.unsubscribe": ["subscriptionId"], "input.claim": ["owner", "takeover"], "input.release": ["owner"],
        "execution.execute": ["owner", "prompt", "goal", "resumeGoal"], "question.answer": ["owner", "questionId", "answer"],
        "control.request": ["owner", "action", "text"], "command.status": ["requestId"]]
    static func opaque(_ value: String) throws {
        guard value.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil else { throw CoreApplicationError("INVALID_REQUEST") }
    }
    static func uuid(_ value: String?) throws -> String {
        guard let value, UUID(uuidString: value) != nil else { throw CoreApplicationError("INVALID_RESPONSE") }; return value
    }
    static func request(op: String, params: [String: CoreJSONValue], id: String, resource: String) throws -> CoreJSONValue {
        try opaque(id); try opaque(resource)
        guard let allowed = fields[op], Set(params.keys).isSubset(of: allowed) else { throw CoreApplicationError("OPERATION_DENIED") }
        var optional: Set<String> = ["after", "limit", "takeover", "goal", "resumeGoal", "text", "scope", "model", "effort"]
        if op == "agents.update" { optional.formUnion(["name", "instructions", "provider"]) }
        if op == "agents.import" { optional.insert("name"); optional.subtract(["model", "effort"]) }
        guard allowed.subtracting(optional).isSubset(of: Set(params.keys)) else { throw CoreApplicationError("INVALID_REQUEST") }
        for key in ["owner", "consumerId", "subscriptionId", "requestId", "taskId", "claimId", "confirmedFingerprint"] where params[key] != nil {
            guard let text = params[key]?.string else { throw CoreApplicationError("INVALID_REQUEST") }; try opaque(text)
        }
        for key in ["takeover", "goal", "resumeGoal", "enabled"] where params[key] != nil {
            guard params[key]?.bool != nil else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        for key in ["prompt", "instruction", "answer", "text"] where params[key] != nil {
            guard let text = params[key]?.string, text.utf8.count <= promptBytes,
                  !["prompt", "instruction"].contains(key) || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        if op == "sessions.open" { _ = try uuid(params["sessionId"]?.string) }
        if params["agentId"] != nil { _ = try uuid(params["agentId"]?.string) }
        if params["expectedRevision"] != nil {
            guard let revision = params["expectedRevision"]?.integer, revision > 0 else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        for key in ["name", "instructions", "provider", "model", "effort"] where params[key] != nil {
            let maximum = key == "instructions" ? 16000 : key == "name" ? 120 : 200
            guard let text = params[key]?.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.utf8.count <= maximum, !text.contains("\0") else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        if params["shareId"] != nil { _ = try uuid(params["shareId"]?.string) }
        if params["importId"] != nil { _ = try uuid(params["importId"]?.string) }
        if op == "agents.import" {
            guard let code = params["code"]?.string, code.hasPrefix("BZZY-AGENT-"),
                  (try? RelayWire.decoded(String(code.dropFirst(11)), count: 32)) != nil,
                  let fingerprint = params["expectedSenderFingerprint"]?.string,
                  (try? RelayWire.decoded(fingerprint, count: 32)) != nil else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        if op == "sessions.list" || op == "agents.list", let after = params["after"] { _ = try uuid(after.string) }
        for key in ["after", "seq", "limit"] where params[key] != nil && !(["sessions.list", "agents.list", "agents.models"].contains(op) && key == "after") {
            guard let number = params[key]?.integer, number >= (key == "limit" ? 1 : 0),
                  key != "limit" || number <= (["sessions.list", "agents.list", "agents.models"].contains(op) ? 25 : 50) else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        if op == "agents.models", let after = params["after"] {
            guard let id = after.string, !id.isEmpty, id.utf8.count <= 200,
                  id.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
                  !id.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        if op == "question.answer" { _ = try uuid(params["questionId"]?.string) }
        if op == "notifications.register" {
            guard let token = params["deviceToken"]?.string, token.range(of: "^[0-9a-f]{64,512}$", options: .regularExpression) != nil,
                  token.count.isMultiple(of: 2), ["sandbox", "production"].contains(params["environment"]?.string ?? ""),
                  params["scope"] == nil || ["session", "terminals", "authorized"].contains(params["scope"]?.string ?? "") else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        if op == "control.request", !["pause", "cancel", "steer"].contains(params["action"]?.string ?? "") { throw CoreApplicationError("INVALID_REQUEST") }
        let frame: CoreJSONValue = .object(["v": .number(1), "protocol": .string("bzzy-core"), "type": .string("request"),
            "id": .string(id), "resource": .string(resource), "op": .string(op), "params": .object(params)])
        guard try JSONEncoder().encode(frame).count <= payloadBytes else { throw CoreApplicationError("REQUEST_TOO_LARGE") }
        return frame
    }
}
