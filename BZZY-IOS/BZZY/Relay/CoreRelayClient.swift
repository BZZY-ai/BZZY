import Foundation

/// Device-scoped RPC over the existing encrypted Relay channel. A transport
/// delivery receipt is never interpreted as Core command acceptance.
@MainActor public final class CoreRelayClient {
    public let hostID: String
    public let grantID: String
    public let resource: String
    private let relayEndpoint: URL
    private let expectedShareKind: RelayShareKind
    public private(set) var sessionID: String?
    public var onEvents: ((CoreEventBatch) -> Void)?
    public var onSubscriptionClosed: ((String, String) -> Void)?
    private let send: (WireValue) async throws -> Void
    private let timeoutNanoseconds: UInt64
    private var connected = true
    private struct Pending {
        let op: String
        let params: [String: CoreJSONValue]
        let continuation: CheckedContinuation<CoreJSONValue, Error>
        let timer: Task<Void, Never>
    }
    private struct Subscription { var cursor: Int64; var delivered: Set<Int64> = [] }
    private var pending: [String: Pending] = [:]
    private var subscriptions: [String: Subscription] = [:]

    init(transport: RelayTransport, hostID: String, grantID: String, resource: String, expectedShareKind: RelayShareKind = .terminal) {
        self.hostID = hostID; self.grantID = grantID; self.resource = resource
        self.expectedShareKind = expectedShareKind
        self.relayEndpoint = transport.endpoint
        send = { payload in _ = try await transport.send(grantID: grantID, payload: payload) }
        timeoutNanoseconds = 15_000_000_000
    }
    init(hostID: String, grantID: String, resource: String, expectedShareKind: RelayShareKind = .terminal, timeoutNanoseconds: UInt64 = 15_000_000_000,
         send: @escaping (WireValue) async throws -> Void) {
        self.hostID = hostID; self.grantID = grantID; self.resource = resource
        self.expectedShareKind = expectedShareKind
        self.relayEndpoint = RelayWire.endpoint
        self.send = send; self.timeoutNanoseconds = timeoutNanoseconds
    }
    nonisolated public static func commandID() -> String { UUID().uuidString }

    /// Keep mutation IDs until reconciled with command.status. Retrying is an
    /// explicit caller action; reconnect never resubmits or claims input.
    public func request(_ op: String, params: [String: CoreJSONValue] = [:], id: String = CoreRelayClient.commandID(), readTimeoutNanoseconds: UInt64? = nil) async throws -> CoreJSONValue {
        guard connected else { throw CoreApplicationError("OFFLINE") }
        if let timeout = readTimeoutNanoseconds {
            guard !CoreApplicationProtocol.commands.contains(op), (1_000_000_000...15_000_000_000).contains(timeout) else { throw CoreApplicationError("INVALID_REQUEST") }
        }
        try CoreApplicationProtocol.opaque(hostID); try CoreApplicationProtocol.opaque(grantID)
        let payload = try CoreApplicationProtocol.request(op: op, params: params, id: id, resource: resource)
        guard pending[id] == nil else { throw CoreApplicationError("CONFLICT") }
        guard pending.count < 4 else { throw CoreApplicationError("CAPACITY") }
        if op == "events.subscribe", sessionID == nil { throw CoreApplicationError("INVALID_REQUEST") }
        if op == "events.ack" {
            guard let subID = params["subscriptionId"]?.string, let seq = params["seq"]?.integer,
                  let sub = subscriptions[subID], seq == sub.cursor || sub.delivered.contains(seq) else { throw CoreApplicationError("INVALID_CURSOR") }
        }
        guard !Task.isCancelled else { throw CancellationError() }
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                let timer = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: readTimeoutNanoseconds ?? self?.timeoutNanoseconds ?? 0) } catch { return }
                    self?.finish(id, result: .failure(CoreApplicationError("UNCERTAIN")))
                }
                pending[id] = Pending(op: op, params: params, continuation: continuation, timer: timer)
                Task { [weak self] in
                    do { try await self?.send(payload.wire()) }
                    catch { self?.finish(id, result: .failure(CoreApplicationError("UNCERTAIN"))) }
                }
            }
        }, onCancel: { [weak self] in Task { @MainActor in self?.finish(id, result: .failure(CoreApplicationError("UNCERTAIN"))) } })
    }

    /// Only RelayTransport's authenticated payload callback may call this.
    func receive(from: String, grantID: String, payload: WireValue) throws {
        guard connected, from == hostID, grantID == self.grantID else { throw CoreApplicationError("FORBIDDEN") }
        guard try payload.data().count <= CoreApplicationProtocol.payloadBytes else { throw CoreApplicationError("RESULT_TOO_LARGE") }
        let frame = try CoreJSONValue(payload)
        guard frame["v"].integer == 1, frame["protocol"].string == "bzzy-core" else { throw CoreApplicationError("PROTOCOL_UNSUPPORTED") }
        switch frame["type"].string {
        case "response":
            guard let id = frame["id"].string else { throw CoreApplicationError("INVALID_RESPONSE") }
            try CoreApplicationProtocol.opaque(id)
            guard let row = pending[id] else { return } // A late response cannot revive an uncertain command.
            do {
                guard let ok = frame["ok"].bool else { throw CoreApplicationError("INVALID_RESPONSE") }
                if ok {
                    try frame.record(["v", "protocol", "type", "id", "ok", "result"])
                    try acceptResult(frame["result"], op: row.op, params: row.params)
                    finish(id, result: .success(frame["result"]))
                } else {
                    try frame.record(["v", "protocol", "type", "id", "ok", "error"])
                    try frame["error"].record(["code"])
                    let codes: Set<String> = ["ASSISTANT_SETUP_REQUIRED", "VOICE_UNAVAILABLE", "FORBIDDEN", "INVALID_REQUEST", "CONFLICT", "UNCERTAIN", "OPERATION_DENIED", "PROTOCOL_UNSUPPORTED", "REQUEST_TOO_LARGE", "RESULT_TOO_LARGE", "RATE_LIMITED", "CAPACITY", "INVALID_CURSOR", "GRANT_UNAVAILABLE", "AUTHORIZATION_REQUIRED", "GATEWAY_UNAVAILABLE", "CORE_STOPPED", "WORKSPACE_SETUP_REQUIRED", "WORKSPACE_CHANGED", "WORKSPACE_UNAVAILABLE", "PROVIDER_UNAVAILABLE", "CONFIRMATION_REQUIRED", "EXPORT_ACTIVE", "SECRET_DETECTED", "EXPORT_INVALID", "SHARE_CONTEXT_INCOMPLETE"]
                    guard let code = frame["error"]["code"].string, codes.contains(code) || ["IMPORT_UNAVAILABLE", "IMPORT_INVALID", "IMPORT_CONFLICT", "TRANSFER_UNAVAILABLE", "CANCELLED"].contains(code) else { throw CoreApplicationError("INVALID_RESPONSE") }
                    finish(id, result: .failure(CoreApplicationError(code)))
                }
            } catch {
                // A malformed acceptance cannot establish that a mutation did
                // not run. Keep the caller on the explicit reconciliation path.
                let failure: Error = CoreApplicationProtocol.commands.contains(row.op) ? CoreApplicationError("UNCERTAIN") : error
                finish(id, result: .failure(failure)); throw error
            }
        case "events":
            guard let subID = frame["subscriptionId"].string, var subscription = subscriptions[subID], let sessionID else { throw CoreApplicationError("INVALID_CURSOR") }
            let batch = try CoreEventBatch(frame, resource: resource, sessionID: sessionID, cursor: subscription.cursor)
            guard subscription.delivered.isEmpty else { throw CoreApplicationError("INVALID_CURSOR") }
            subscription.delivered = Set(batch.events.map(\.seq)); subscriptions[subID] = subscription
            onEvents?(batch)
        case "subscription.closed":
            try frame.record(["v", "protocol", "type", "subscriptionId", "resource", "code"])
            guard frame["resource"].string == resource, let subID = frame["subscriptionId"].string,
                  subscriptions.removeValue(forKey: subID) != nil, let code = frame["code"].string,
                  code.range(of: "^[A-Z_]{1,64}$", options: .regularExpression) != nil else { throw CoreApplicationError("INVALID_RESPONSE") }
            onSubscriptionClosed?(subID, code)
        default: throw CoreApplicationError("PROTOCOL_UNSUPPORTED")
        }
    }

    public func disconnected() {
        connected = false; subscriptions.removeAll()
        let abandoned = pending; pending.removeAll()
        for row in abandoned.values { row.timer.cancel(); row.continuation.resume(throwing: CoreApplicationError("UNCERTAIN")) }
    }

    private func acceptResult(_ result: CoreJSONValue, op: String, params: [String: CoreJSONValue]) throws {
        guard result.object != nil else { throw CoreApplicationError("INVALID_RESPONSE") }
        switch op {
        case "voice.status":
            try result.record(["configured", "assistantConfigured", "workspaceConfigured"])
            guard result["configured"].bool != nil, result["assistantConfigured"].bool != nil, result["workspaceConfigured"].bool != nil else { throw CoreApplicationError("INVALID_RESPONSE") }
        case "voice.send":
            try result.record(["state", "requestId"])
            guard result["state"].string == "accepted", let id = result["requestId"].string else { throw CoreApplicationError("INVALID_RESPONSE") }
            try CoreApplicationProtocol.opaque(id)
        case "voice.cancel":
            try result.record(["stopped"]); guard result["stopped"].bool == true else { throw CoreApplicationError("INVALID_RESPONSE") }
        case "voice.poll":
            try result.record(["state", "text", "cursor", "hasMore", "question", "verification", "code"], required: ["state", "text", "cursor", "hasMore"])
            guard ["unknown", "dispatching", "rejected", "uncertain", "accepted", "queued", "launching", "running", "waiting_for_input", "finished", "failed", "cancelled", "paused"].contains(result["state"].string ?? ""),
                  let text = result["text"].string, text.utf8.count <= 6000, let cursor = result["cursor"].integer, cursor >= 0 && cursor <= 2_000_000,
                  result["hasMore"].bool != nil, result["verification"] == .null || result["verification"].string == "not-assessed" else { throw CoreApplicationError("INVALID_RESPONSE") }
            if result["question"] != .null { guard let text = result["question"].string, text.utf8.count <= 16000 else { throw CoreApplicationError("INVALID_RESPONSE") } }
        case "host.metrics":
            _ = try CoreHostMetrics(result)
        case "session.get":
            try result.record(["session", "execution", "questions", "inputOwner", "capabilities"], required: ["session", "questions", "capabilities"])
            let id = try CoreApplicationProtocol.uuid(result["session"]["id"].string)
            guard sessionID == nil || sessionID == id, let questions = result["questions"].array,
                  result["capabilities"]["relay"].bool == true,
                  result["capabilities"]["durableEvents"].bool == true else { throw CoreApplicationError("INVALID_RESPONSE") }
            for question in questions { guard question["sessionId"].string == id else { throw CoreApplicationError("FORBIDDEN") } }
            if result["execution"] != .null { guard result["execution"]["sessionId"].string == id else { throw CoreApplicationError("FORBIDDEN") } }
            if result["inputOwner"] != .null { guard result["inputOwner"]["sessionId"].string == id else { throw CoreApplicationError("FORBIDDEN") } }
            sessionID = id
        case "events.subscribe":
            try result.record(["subscriptionId", "consumerId", "processedCursor"])
            guard let subID = result["subscriptionId"].string, result["consumerId"].string == params["consumerId"]?.string,
                  let cursor = result["processedCursor"].integer, cursor >= 0 else { throw CoreApplicationError("INVALID_RESPONSE") }
            try CoreApplicationProtocol.opaque(subID)
            if subscriptions[subID] == nil { subscriptions[subID] = Subscription(cursor: cursor) }
        case "events.ack":
            try result.record(["processedCursor"])
            guard let subID = params["subscriptionId"]?.string, var sub = subscriptions[subID],
                  let cursor = result["processedCursor"].integer, cursor == params["seq"]?.integer else { throw CoreApplicationError("INVALID_CURSOR") }
            // Repeating the already processed cursor must not consume a newer
            // outstanding batch; Core preserves that batch in the same case.
            if cursor > sub.cursor { sub.cursor = cursor; sub.delivered = [] }
            subscriptions[subID] = sub
        case "events.unsubscribe":
            try result.record(["unsubscribed"])
            guard result["unsubscribed"].bool == true, let subID = params["subscriptionId"]?.string else { throw CoreApplicationError("INVALID_RESPONSE") }
            subscriptions.removeValue(forKey: subID)
        case "events.list":
            try result.record(["events", "nextCursor", "hasMore"])
            guard let list = result["events"].array, list.count <= 50, let sessionID,
                  let cursor = result["nextCursor"].integer, result["hasMore"].bool != nil else { throw CoreApplicationError("INVALID_RESPONSE") }
            var previous = params["after"]?.integer ?? 0
            for value in list { let event = try CoreEvent(value, sessionID: sessionID); guard event.seq > previous else { throw CoreApplicationError("INVALID_CURSOR") }; previous = event.seq }
            guard cursor == previous else { throw CoreApplicationError("INVALID_CURSOR") }
        case "input.claim":
            try result.record(["owner", "sessionId", "expiresAt"])
            guard result["sessionId"].string == sessionID, result["owner"].string != nil,
                  let expiry = result["expiresAt"].integer, expiry > RelayWire.now else { throw CoreApplicationError("INVALID_RESPONSE") }
        case "input.release":
            try result.record(["released"])
            guard result["released"].bool == true else { throw CoreApplicationError("INVALID_RESPONSE") }
        case "command.status":
            try result.record(["state", "acceptance", "code"], required: ["state"])
            guard ["unknown", "dispatching", "uncertain", "rejected", "accepted"].contains(result["state"].string ?? "") else { throw CoreApplicationError("INVALID_RESPONSE") }
            if result["state"].string == "accepted" {
                guard result["acceptance"].object != nil else { throw CoreApplicationError("INVALID_RESPONSE") }
                if let resource = result["acceptance"]["resource"].string {
                    try CoreApplicationProtocol.opaque(resource)
                    _ = try CoreApplicationProtocol.uuid(result["acceptance"]["sessionId"].string)
                } else if let session = result["acceptance"]["sessionId"].string, session != sessionID { throw CoreApplicationError("FORBIDDEN") }
            }
        case "agents.status":
            try result.record(["workspaceRoot", "configured", "scheduling"])
            guard result["configured"].bool != nil, result["scheduling"].bool == false,
                  result["workspaceRoot"] == .null || result["workspaceRoot"].object != nil else { throw CoreApplicationError("INVALID_RESPONSE") }
        case "agents.providers":
            try result.record(["providers"])
            guard let providers = result["providers"].array, providers.count <= 100 else { throw CoreApplicationError("INVALID_RESPONSE") }
            for provider in providers {
                try provider.record(["id", "name", "backend", "model", "supportedEfforts"])
                guard provider["id"].string != nil, provider["name"].string != nil, provider["backend"].string != nil,
                      provider["model"] == .null || provider["model"].string != nil,
                      provider["supportedEfforts"].array?.allSatisfy({ $0.string != nil }) == true else { throw CoreApplicationError("INVALID_RESPONSE") }
            }
        case "agents.models":
            try result.record(["models", "source", "description", "hasMore", "nextCursor"], required: ["models", "source", "hasMore", "nextCursor"])
            guard let models = result["models"].array, models.count <= Int(params["limit"]?.integer ?? 25),
                  ["provider", "installed backend", "manual"].contains(result["source"].string ?? "") else { throw CoreApplicationError("INVALID_RESPONSE") }
            for model in models { guard model["id"].string != nil else { throw CoreApplicationError("INVALID_RESPONSE") } }
            guard let more = result["hasMore"].bool else { throw CoreApplicationError("INVALID_RESPONSE") }
            if let cursor = result["nextCursor"].string {
                guard more, cursor == models.last?["id"].string else { throw CoreApplicationError("INVALID_CURSOR") }
            } else if result["nextCursor"] != .null || more { throw CoreApplicationError("INVALID_CURSOR") }
        case "agents.list":
            try result.record(["agents", "nextCursor", "hasMore"])
            guard let agents = result["agents"].array, agents.count <= Int(params["limit"]?.integer ?? 25),
                  let more = result["hasMore"].bool else { throw CoreApplicationError("INVALID_RESPONSE") }
            for agent in agents { try validateAgent(agent) }
            if result["nextCursor"] != .null {
                let cursor = try CoreApplicationProtocol.uuid(result["nextCursor"].string)
                guard more, agents.last?["id"].string == cursor else { throw CoreApplicationError("INVALID_CURSOR") }
            } else if more { throw CoreApplicationError("INVALID_CURSOR") }
        case "agents.get", "agents.create", "agents.update", "agents.archive":
            let mutation = op != "agents.get"
            try result.record(mutation ? ["state", "agent"] : ["agent"])
            guard !mutation || result["state"].string == "accepted" else { throw CoreApplicationError("INVALID_RESPONSE") }
            try validateAgent(result["agent"])
            if let expected = params["agentId"]?.string, result["agent"]["id"].string != expected { throw CoreApplicationError("FORBIDDEN") }
            if op != "agents.archive" { guard result["agent"]["instructions"].string != nil else { throw CoreApplicationError("INVALID_RESPONSE") } }
        case "agents.open":
            try result.record(["state", "kind", "resource", "sessionId", "agentId", "cwd", "provider", "model", "effort"])
            guard result["state"].string == "accepted", result["kind"].string == "agent",
                  result["agentId"].string == params["agentId"]?.string, let resource = result["resource"].string,
                  let cwd = result["cwd"].string, cwd.hasPrefix("/"), result["provider"].string != nil,
                  result["model"] == .null || result["model"].string != nil, result["effort"].string != nil else { throw CoreApplicationError("INVALID_RESPONSE") }
            _ = try CoreApplicationProtocol.uuid(result["sessionId"].string); try CoreApplicationProtocol.opaque(resource)
        case "agents.import":
            try result.record(["state", "importId", "sourceFingerprint", "expiresAt"])
            _ = try CoreApplicationProtocol.uuid(result["importId"].string)
            guard result["state"].string == "accepted", result["sourceFingerprint"].string == params["expectedSenderFingerprint"]?.string,
                  let expiry = result["expiresAt"].integer, expiry > RelayWire.now else { throw CoreApplicationError("INVALID_RESPONSE") }
        case "agents.import.status":
            try result.record(["importId", "state", "sourceFingerprint", "recipientFingerprint", "received", "total", "expiresAt", "agent", "errorCode"], required: ["importId", "state", "sourceFingerprint", "recipientFingerprint", "received", "total", "expiresAt"])
            guard result["importId"].string == params["importId"]?.string,
                  ["connecting", "awaitingApproval", "receiving", "importing", "complete", "cancelled", "failed"].contains(result["state"].string ?? ""),
                  let source = result["sourceFingerprint"].string, (try? RelayWire.decoded(source, count: 32)) != nil,
                  let received = result["received"].integer, (0...268_435_456).contains(received),
                  let expiry = result["expiresAt"].integer, expiry > 0 else { throw CoreApplicationError("INVALID_RESPONSE") }
            if result["recipientFingerprint"] != .null {
                guard let recipient = result["recipientFingerprint"].string, (try? RelayWire.decoded(recipient, count: 32)) != nil else { throw CoreApplicationError("INVALID_RESPONSE") }
            }
            if result["total"] != .null { guard let total = result["total"].integer, (received...268_435_456).contains(total) else { throw CoreApplicationError("INVALID_RESPONSE") } }
            if result["state"].string == "complete" {
                try validateAgent(result["agent"])
                guard result["agent"]["instructions"].string != nil, result["agent"]["archived"].bool == false,
                      result["agent"]["state"].string == "idle", result["agent"]["importId"].string == params["importId"]?.string else { throw CoreApplicationError("INVALID_RESPONSE") }
            } else if result.object?["agent"] != nil { throw CoreApplicationError("INVALID_RESPONSE") }
            if let code = result.object?["errorCode"] {
                guard ["failed", "cancelled"].contains(result["state"].string ?? ""), result["state"].string != "cancelled" || code.string == "CANCELLED",
                      ["CANCELLED", "FORBIDDEN", "IMPORT_UNAVAILABLE", "IMPORT_INVALID", "IMPORT_CONFLICT", "PROVIDER_UNAVAILABLE", "WORKSPACE_SETUP_REQUIRED", "WORKSPACE_CHANGED", "WORKSPACE_UNAVAILABLE", "CAPACITY", "SECRET_DETECTED", "TRANSFER_UNAVAILABLE", "CONFIRMATION_REQUIRED"].contains(code.string ?? "") else { throw CoreApplicationError("INVALID_RESPONSE") }
            }
        case "agents.import.cancel":
            try result.record(["state", "importId", "cancelled"])
            guard result["state"].string == "accepted", result["importId"].string == params["importId"]?.string,
                  result["cancelled"].bool == true else { throw CoreApplicationError("INVALID_RESPONSE") }
        case "notifications.register", "notifications.update":
            try result.record(["registered", "enabled", "providerConfigured", "scope"])
            guard result["registered"].bool != nil, result["enabled"].bool != nil, result["providerConfigured"].bool != nil,
                  ["session", "terminals", "authorized"].contains(result["scope"].string ?? "") else { throw CoreApplicationError("INVALID_RESPONSE") }
            guard result["enabled"].bool == params["enabled"]?.bool else { throw CoreApplicationError("INVALID_RESPONSE") }
            if op == "notifications.register" {
                guard result["scope"].string == (params["scope"]?.string ?? "session"), result["enabled"].bool == params["enabled"]?.bool else { throw CoreApplicationError("INVALID_RESPONSE") }
            }
        case "notifications.revoke":
            try result.record(["revoked"])
            guard result["revoked"].bool == true else { throw CoreApplicationError("INVALID_RESPONSE") }
        case "share.create":
            try result.record(["state", "kind", "shareId", "code", "qr", "expiresAt", "senderFingerprint", "bytes", "sha256"])
            _ = try CoreApplicationProtocol.uuid(result["shareId"].string)
            guard result["state"].string == "accepted", result["kind"].string == expectedShareKind.rawValue, let code = result["code"].string,
                  let qr = result["qr"].string, qr.hasPrefix("BZZY:INVITE:1:"),
                  result["senderFingerprint"].string == hostID, let expiry = result["expiresAt"].integer, expiry > RelayWire.now,
                  let bytes = result["bytes"].integer, bytes > 0,
                  let hash = result["sha256"].string, hash.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw CoreApplicationError("INVALID_RESPONSE") }
            _ = try RelayShareInvitation.parse(code, expectedKind: expectedShareKind)
            let invitation = try RelayShareInvitation.parse(qr, expectedKind: expectedShareKind, endpoint: relayEndpoint)
            let encoded = try WireValue.parse(RelayWire.decoded(String(qr.dropFirst(14))))
            guard invitation.senderFingerprint == hostID, encoded["code"].string == code,
                  encoded["expiresAt"].integer == expiry else { throw CoreApplicationError("FORBIDDEN") }
        case "share.status":
            try result.record(["shareId", "state", "pending", "bytes", "expiresAt"])
            guard result["shareId"].string == params["shareId"]?.string,
                  ["open", "pending", "approved", "complete", "revoked", "expired"].contains(result["state"].string ?? ""),
                  let pending = result["pending"].array, pending.count <= 64,
                  let bytes = result["bytes"].integer, bytes > 0, result["expiresAt"].integer != nil else { throw CoreApplicationError("INVALID_RESPONSE") }
            for claim in pending {
                try claim.record(["claimId", "certificate", "fingerprint"])
                guard let claimID = claim["claimId"].string else { throw CoreApplicationError("INVALID_RESPONSE") }
                try CoreApplicationProtocol.opaque(claimID)
                let certificate = try RelayCertificate.parse(claim["certificate"].wire())
                guard claim["fingerprint"].string == certificate.id else { throw CoreApplicationError("FORBIDDEN") }
            }
        case "share.approve":
            try result.record(["approved"])
            guard result["approved"].bool == true else { throw CoreApplicationError("INVALID_RESPONSE") }
        case "share.revoke":
            try result.record(["revoked"])
            guard result["revoked"].bool == true else { throw CoreApplicationError("INVALID_RESPONSE") }
        case "sessions.list":
            try result.record(["sessions", "nextCursor", "hasMore"])
            guard let sessions = result["sessions"].array, sessions.count <= Int(params["limit"]?.integer ?? 25),
                  let more = result["hasMore"].bool else { throw CoreApplicationError("INVALID_RESPONSE") }
            var seen = Set<String>()
            for session in sessions {
                try session.record(["id", "alias", "provider", "model", "mode", "cwd", "executionState", "createdAt", "updatedAt", "existingResource"],
                                   required: ["id", "provider", "model", "cwd", "executionState", "createdAt", "updatedAt"])
                let id = try CoreApplicationProtocol.uuid(session["id"].string)
                guard seen.insert(id).inserted, session["provider"].string != nil,
                      session["model"] == .null || session["model"].string != nil,
                      let cwd = session["cwd"].string, cwd.hasPrefix("/"), cwd.utf8.count <= 4096, !cwd.contains("\0"),
                      session["executionState"].string != nil, session["createdAt"].string != nil,
                      session["updatedAt"].string != nil else { throw CoreApplicationError("INVALID_RESPONSE") }
                if let resource = session["existingResource"].string { try CoreApplicationProtocol.opaque(resource) }
            }
            if result["nextCursor"] != .null {
                let cursor = try CoreApplicationProtocol.uuid(result["nextCursor"].string)
                guard more, sessions.last?["id"].string == cursor else { throw CoreApplicationError("INVALID_CURSOR") }
            } else if more { throw CoreApplicationError("INVALID_CURSOR") }
        case "sessions.open":
            try result.record(["state", "resource", "sessionId", "cwd", "provider", "model", "effort"])
            guard result["state"].string == "accepted", let resource = result["resource"].string,
                  result["sessionId"].string == params["sessionId"]?.string,
                  let cwd = result["cwd"].string, cwd.hasPrefix("/"), cwd.utf8.count <= 4096, !cwd.contains("\0"),
                  result["provider"].string != nil, result["model"] == .null || result["model"].string != nil,
                  result["effort"].string != nil else { throw CoreApplicationError("INVALID_RESPONSE") }
            try CoreApplicationProtocol.opaque(resource)
        case "permissions.set":
            try result.record(["state", "yolo", "approvedQuestionId"], required: ["state", "yolo"])
            guard result["state"].string == "accepted", result["yolo"].bool == params["enabled"]?.bool else { throw CoreApplicationError("INVALID_RESPONSE") }
            if let question = params["questionId"]?.string {
                guard result["approvedQuestionId"].string == question else { throw CoreApplicationError("INVALID_RESPONSE") }
            } else if result.object?["approvedQuestionId"] != nil { throw CoreApplicationError("INVALID_RESPONSE") }
        case "execution.execute", "task.submit", "question.answer", "control.request":
            let fields: Set<String> = op == "task.submit" ? ["state", "taskId"] : ["state", "sessionId", "executionId", "answered", "controlId"]
            try result.record(fields, required: ["state"])
            guard result["state"].string == "accepted" else { throw CoreApplicationError("INVALID_RESPONSE") }
            if op == "task.submit" { guard let task = result["taskId"].string else { throw CoreApplicationError("INVALID_RESPONSE") }; try CoreApplicationProtocol.opaque(task) }
            if let id = result["sessionId"].string, id != sessionID { throw CoreApplicationError("FORBIDDEN") }
            if op == "execution.execute" {
                guard result["sessionId"].string == sessionID else { throw CoreApplicationError("FORBIDDEN") }
                _ = try CoreApplicationProtocol.uuid(result["executionId"].string)
            }
            if op == "question.answer", result["answered"].bool != true { throw CoreApplicationError("INVALID_RESPONSE") }
            if op == "control.request" { _ = try CoreApplicationProtocol.uuid(result["controlId"].string) }
        case "task.get":
            try result.record(["taskId", "state", "execution", "verification", "output", "code"], required: ["taskId", "state", "verification", "output"])
            guard result["taskId"].string == params["taskId"]?.string, result["verification"].string == "not-assessed",
                  result["output"]["source"].string == "execution-events" else { throw CoreApplicationError("INVALID_RESPONSE") }
            for key in ["after", "through"] { if result["output"][key] != .null { guard let cursor = result["output"][key].integer, cursor >= 0 else { throw CoreApplicationError("INVALID_CURSOR") } } }
            if let after = result["output"]["after"].integer, let through = result["output"]["through"].integer, through <= after { throw CoreApplicationError("INVALID_CURSOR") }
            if result["execution"] != .null {
                guard result["execution"]["id"].string == result["output"]["executionId"].string else { throw CoreApplicationError("INVALID_RESPONSE") }
            }
        case "assistant.status":
            try result.record(["provider", "model", "effort", "purpose", "selection"], required: ["provider", "purpose"])
            guard result["provider"].string != nil, result["purpose"].string == "core-assistant" else { throw CoreApplicationError("INVALID_RESPONSE") }
        default: break // Usage and assistant status retain their documented optional telemetry.
        }
    }

    private func validateAgent(_ agent: CoreJSONValue) throws {
        _ = try CoreApplicationProtocol.uuid(agent["id"].string)
        _ = try CoreApplicationProtocol.uuid(agent["sessionId"].string)
        guard let name = agent["name"].string, !name.isEmpty, agent["provider"].string != nil,
              agent["model"] == .null || agent["model"].string != nil,
              agent["effort"].string != nil, let cwd = agent["cwd"].string, cwd.hasPrefix("/"),
              let revision = agent["revision"].integer, revision > 0, agent["state"].string != nil,
              agent["archived"].bool != nil, agent["createdAt"].string != nil, agent["updatedAt"].string != nil else { throw CoreApplicationError("INVALID_RESPONSE") }
        if let resource = agent["existingResource"].string { try CoreApplicationProtocol.opaque(resource) }
    }

    private func finish(_ id: String, result: Result<CoreJSONValue, Error>) {
        guard let row = pending.removeValue(forKey: id) else { return }
        row.timer.cancel(); row.continuation.resume(with: result)
    }
}
