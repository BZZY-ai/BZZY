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
        case "DEFAULT_REQUIRED": "Save this mode’s default models in Settings, then try again."
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

/// A chronological backward page. Its cursor is a disclosed replay baseline,
/// distinct from processed live subscription acknowledgments.
public struct CoreEventHistoryPage: Sendable {
    public let sessionID: String
    public let events: [CoreEvent]
    public let nextCursor: Int64
    public let oldestCursor: Int64
    public let hasOlder: Bool
    public let bootstrapToken: String?

    public init(_ value: CoreJSONValue, sessionID: String) throws {
        try value.record(["events", "nextCursor", "hasMore", "oldestCursor", "hasOlder", "bootstrapToken"], required: ["events", "nextCursor", "hasMore", "oldestCursor", "hasOlder"])
        guard let list = value["events"].array, list.count <= 50,
              let next = value["nextCursor"].integer, next >= 0,
              let oldest = value["oldestCursor"].integer, oldest >= 0,
              value["hasMore"].bool == false, let older = value["hasOlder"].bool else { throw CoreApplicationError("INVALID_RESPONSE") }
        let envelopes = try list.map { try CoreEvent($0, sessionID: sessionID) }
        var previous: Int64 = 0
        for event in envelopes { guard event.seq > previous else { throw CoreApplicationError("INVALID_CURSOR") }; previous = event.seq }
        guard next == previous, oldest == envelopes.first?.seq ?? 0, !envelopes.isEmpty || !older else { throw CoreApplicationError("INVALID_CURSOR") }
        if let token = value["bootstrapToken"].string { try CoreApplicationProtocol.opaque(token) }
        else if value["bootstrapToken"] != .null { throw CoreApplicationError("INVALID_RESPONSE") }
        self.sessionID = sessionID; self.events = envelopes; self.nextCursor = next; self.oldestCursor = oldest
        self.hasOlder = older; self.bootstrapToken = value["bootstrapToken"].string
    }
}

enum CoreApplicationProtocol {
    static let payloadBytes = 28 * 1024
    static let promptBytes = 16 * 1024
    static let eventBytes = 16 * 1024 * 1024
    static let chunkBytes = 16 * 1024
    static let commands: Set<String> = ["settings.configure", "session.configure", "session.mode", "voice.send", "voice.cancel", "updates.configure", "updates.install", "execution.execute", "task.submit", "question.answer", "permissions.set", "control.request", "sessions.open", "share.create", "share.approve", "share.revoke", "notifications.register", "notifications.update", "notifications.revoke", "agents.create", "agents.update", "agents.archive", "agents.open", "agents.import", "agents.import.cancel"]
    static let fields: [String: Set<String>] = [
        "updates.status": [], "updates.check": [], "updates.configure": ["monitoringEnabled", "notificationsEnabled", "remoteUpdatesEnabled"], "updates.install": ["target"],
        "settings.get": [], "settings.providers": [], "settings.models": ["provider", "after", "limit"],
        "settings.configure": ["target", "expectedRevision", "agents"],
        "session.mode": ["owner", "mode", "expectedUpdatedAt", "coordinateInput"],
        "session.configure": ["owner", "selection", "expectedUpdatedAt", "coordinateInput"],
        "host.metrics": [],
        "agents.status": [], "agents.providers": [], "agents.models": ["provider", "after", "limit"], "agents.list": ["after", "limit"], "agents.get": ["agentId"],
        "agents.create": ["name", "instructions", "provider", "model", "effort"], "agents.update": ["agentId", "expectedRevision", "name", "instructions", "provider", "model", "effort"],
        "agents.archive": ["agentId", "expectedRevision"], "agents.open": ["agentId"],
        "agents.import": ["code", "expectedSenderFingerprint", "provider", "model", "effort", "name"],
        "agents.import.status": ["importId"], "agents.import.cancel": ["importId"],
        "notifications.register": ["deviceToken", "environment", "enabled", "scope", "hostHints", "relayPush"], "notifications.update": ["enabled"], "notifications.revoke": [],
        "share.create": [], "share.status": ["shareId"], "share.approve": ["shareId", "claimId", "confirmedFingerprint"], "share.revoke": ["shareId"],
        "session.get": [], "session.usage": [], "sessions.list": ["after", "limit", "goalFeedback"], "sessions.open": ["sessionId"],
        "assistant.status": [], "voice.status": [], "voice.send": ["text"], "voice.poll": ["requestId", "cursor"], "voice.cancel": ["requestId"], "task.submit": ["owner", "instruction", "coordinateInput"], "task.get": ["taskId"],
        "events.list": ["after", "before", "latest", "limit", "eventChunks"], "events.subscribe": ["consumerId", "bootstrapToken", "eventChunks", "singleView"],
        "events.chunk": ["seq", "offset", "limit"], "events.ack": ["subscriptionId", "seq"],
        "events.unsubscribe": ["subscriptionId"], "input.claim": ["owner", "takeover"], "input.release": ["owner"],
        "execution.execute": ["owner", "prompt", "goal", "resumeGoal", "replaceGoalId", "resumeGoalId", "resumeGoalStatus", "coordinateInput"], "question.answer": ["owner", "questionId", "answer", "coordinateInput"],
        "permissions.set": ["owner", "enabled", "questionId", "coordinateInput"],
        "control.request": ["owner", "action", "text", "coordinateInput"], "command.status": ["requestId"]]
    static func opaque(_ value: String) throws {
        guard value.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil else { throw CoreApplicationError("INVALID_REQUEST") }
    }
    static func uuid(_ value: String?) throws -> String {
        guard let value, UUID(uuidString: value) != nil else { throw CoreApplicationError("INVALID_RESPONSE") }; return value
    }
    static func request(op: String, params: [String: CoreJSONValue], id: String, resource: String) throws -> CoreJSONValue {
        try opaque(id); try opaque(resource)
        guard let allowed = fields[op], Set(params.keys).isSubset(of: allowed) else { throw CoreApplicationError("OPERATION_DENIED") }
        var optional: Set<String> = ["coordinateInput", "after", "before", "latest", "bootstrapToken", "eventChunks", "singleView", "limit", "takeover", "goal", "resumeGoal", "replaceGoalId", "resumeGoalId", "resumeGoalStatus", "text", "scope", "hostHints", "relayPush", "goalFeedback", "model", "effort", "monitoringEnabled", "notificationsEnabled", "remoteUpdatesEnabled"]
        if op == "session.mode", !["solo", "delegate", "debate", "parallel", "besties"].contains(params["mode"]?.string ?? "") { throw CoreApplicationError("INVALID_REQUEST") }
        if op == "voice.send" { optional.remove("text") }
        if op == "voice.poll" { guard let cursor = params["cursor"]?.integer, cursor >= 0 && cursor <= 2_000_000 else { throw CoreApplicationError("INVALID_REQUEST") } }
        if op == "voice.send" { guard let text = params["text"]?.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw CoreApplicationError("INVALID_REQUEST") } }
        if op == "agents.update" { optional.formUnion(["name", "instructions", "provider"]) }
        if op == "agents.import" { optional.insert("name"); optional.subtract(["model", "effort"]) }
        guard allowed.subtracting(optional).isSubset(of: Set(params.keys)) else { throw CoreApplicationError("INVALID_REQUEST") }
        for key in ["owner", "consumerId", "bootstrapToken", "subscriptionId", "requestId", "taskId", "claimId", "confirmedFingerprint"] where params[key] != nil {
            guard let text = params[key]?.string else { throw CoreApplicationError("INVALID_REQUEST") }; try opaque(text)
        }
        for key in ["coordinateInput", "latest", "eventChunks", "singleView", "takeover", "goal", "resumeGoal", "enabled", "hostHints", "relayPush", "goalFeedback", "monitoringEnabled", "notificationsEnabled", "remoteUpdatesEnabled"] where params[key] != nil {
            guard params[key]?.bool != nil else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        for key in ["prompt", "instruction", "answer", "text"] where params[key] != nil {
            guard let text = params[key]?.string, text.utf8.count <= promptBytes,
                  !["prompt", "instruction"].contains(key) || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        if op == "updates.install" {
            guard let target = params["target"]?.string, target.range(of: "^[a-f0-9]{40,64}$", options: .regularExpression) != nil else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        if op == "updates.configure", params.isEmpty { throw CoreApplicationError("INVALID_REQUEST") }
        if op == "sessions.open" { _ = try uuid(params["sessionId"]?.string) }
        if params["agentId"] != nil { _ = try uuid(params["agentId"]?.string) }
        if op == "settings.configure" {
            guard let revision = params["expectedRevision"]?.string, revision.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw CoreApplicationError("INVALID_REQUEST") }
        } else if params["expectedRevision"] != nil {
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
        if op == "events.list" {
            guard !(params["after"] != nil && (params["before"] != nil || params["latest"]?.bool == true)),
                  !(params["before"] != nil && params["latest"]?.bool == true) else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        if op == "events.chunk" {
            guard let seq = params["seq"]?.integer, seq > 0, let offset = params["offset"]?.integer, offset >= 0, offset < eventBytes,
                  let limit = params["limit"]?.integer, limit > 0, limit <= chunkBytes else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        for key in ["after", "before", "seq", "limit"] where params[key] != nil && !(["sessions.list", "agents.list", "agents.models", "settings.models"].contains(op) && key == "after") {
            guard let number = params[key]?.integer, number >= (key == "limit" ? 1 : 0),
                  key != "limit" || number <= (op == "events.chunk" ? Int64(chunkBytes) : ["sessions.list", "agents.list", "agents.models", "settings.models"].contains(op) ? 25 : 50) else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        if let before = params["before"]?.integer, before < 1 { throw CoreApplicationError("INVALID_REQUEST") }
        if ["agents.models", "settings.models"].contains(op), let after = params["after"] {
            guard let id = after.string, !id.isEmpty, id.utf8.count <= 200,
                  id.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
                  !id.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        if op == "question.answer" { _ = try uuid(params["questionId"]?.string) }
        if let goal = params["replaceGoalId"] { _ = try uuid(goal.string) }
        if let goal = params["resumeGoalId"] { _ = try uuid(goal.string); guard params["resumeGoal"]?.bool == true else { throw CoreApplicationError("INVALID_REQUEST") } }
        if let status = params["resumeGoalStatus"] { guard status.string == "paused", params["resumeGoalId"] != nil else { throw CoreApplicationError("INVALID_REQUEST") } }
        if op == "permissions.set" {
            guard params["enabled"]?.bool != nil else { throw CoreApplicationError("INVALID_REQUEST") }
            if let question = params["questionId"] { _ = try uuid(question.string) }
        }
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
