import Foundation

/// Administrative requests and approved PAIR data use the same independent
/// bounded windows as Relay. This is traffic accounting, never authorization.
struct RelayRequestBudget {
    private struct Window { var count = 0; let until: TimeInterval }
    private var administrative: Window?
    private var data: [String: Window] = [:]

    mutating func consume(dataGrantID: String?, now: TimeInterval = ProcessInfo.processInfo.systemUptime) throws {
        data = data.filter { $0.value.until > now }
        if let grantID = dataGrantID {
            guard data[grantID] != nil || data.count < 512 else { throw RelayFailure("REQUEST_CAPACITY") }
            var window = data[grantID] ?? Window(until: now + 60)
            guard window.count < 4096 else { throw RelayFailure("RATE_LIMITED") }
            window.count += 1; data[grantID] = window
        } else {
            var window = administrative.flatMap { $0.until > now ? $0 : nil } ?? Window(until: now + 60)
            guard window.count < 240 else { throw RelayFailure("RATE_LIMITED") }
            window.count += 1; administrative = window
        }
    }
}

private final class RelaySessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class RelayTransport {
    private let identity: RelayIdentity
    let endpoint: URL
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var generation = UUID()
    private var epoch = ""
    private(set) var online = false
    private var outboundBytes = 0
    private var requestBudget = RelayRequestBudget()
    private struct DataGrant { let peerID: String; let expiresAt: Int64 }
    private var dataGrants: [String: DataGrant] = [:]
    private var deliveryGrants: [String: String] = [:]
    private var inspections: [String: Task<WireValue, Error>] = [:]
    private struct Pending {
        let continuation: CheckedContinuation<WireValue, Error>
        let timeout: Task<Void, Never>
    }
    private var pending: [String: Pending] = [:]
    private var trusted: [String: RelayCertificate] = [:]
    private var revoked: Set<String> = []
    private var replay = ReplayWindow()
    private var activeDeliveries = 0
    var onEvent: ((String, WireValue) -> Void)?
    var onFailure: ((RelayFailure) -> Void)?
    var onPayload: ((String, String, WireValue) -> Void)?

    convenience init(identity: RelayIdentity) {
        self.init(identity: identity, validatedEndpoint: RelayWire.endpoint)
    }

    // Internal integration-test seam. The app always uses the fixed TLS endpoint.
    // An explicit loopback URL is the only supported insecure alternative.
    convenience init(identity: RelayIdentity, loopbackEndpoint: URL) throws {
        guard let value = URLComponents(url: loopbackEndpoint, resolvingAgainstBaseURL: false),
              value.scheme == "ws", ["127.0.0.1", "[::1]", "::1"].contains(value.host ?? ""),
              value.port != nil, value.user == nil, value.password == nil, value.query == nil,
              value.fragment == nil, value.path == "/v1/socket" else { throw RelayFailure("INVALID_ENDPOINT") }
        self.init(identity: identity, validatedEndpoint: loopbackEndpoint)
    }

    private init(identity: RelayIdentity, validatedEndpoint: URL) {
        self.identity = identity
        self.endpoint = validatedEndpoint
    }

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.urlCache = nil
        config.httpCookieStorage = nil
        return URLSession(configuration: config, delegate: RelaySessionDelegate(), delegateQueue: nil)
    }

    func connect() async throws -> String {
        disconnect()
        let connection = UUID()
        generation = connection
        epoch = RelayWire.encoded(try RelayWire.random())
        replay = ReplayWindow()
        revoked.removeAll()
        let session = makeSession()
        self.session = session
        let task = session.webSocketTask(with: endpoint, protocols: [RelayWire.subprotocol])
        task.maximumMessageSize = 65_536
        socket = task
        task.resume()
        do {
            let challenge = try await firstFrame(task)
            guard generation == connection,
                  let response = task.response as? HTTPURLResponse, response.statusCode == 101,
                  response.value(forHTTPHeaderField: "Sec-WebSocket-Protocol") == RelayWire.subprotocol,
                  challenge["v"].integer == 1, challenge["event"].string == "challenge",
                  challenge["data"]["audience"].string == endpoint.absoluteString,
                  let nonce = challenge["data"]["challenge"].string else { throw RelayFailure("INVALID_CHALLENGE") }
            _ = try RelayWire.decoded(nonce, count: 32)
            let id = RelayWire.encoded(try RelayWire.random())
            let presence = RelayPresence(epoch: epoch, signature: try identity.sign("BZZY-RELAY presence v1\n\(identity.certificate.id)\n\(epoch)"))
            let auth: WireValue = .object(["v": .number(1), "id": .string(id), "op": .string("auth"),
                "certificate": try RelayWire.object(identity.certificate), "presence": try RelayWire.object(presence),
                "signature": .string(try identity.sign("BZZY-RELAY authentication v1\n\(endpoint.absoluteString)\n\(nonce)\n\(epoch)"))])
            let authData = try auth.data()
            try await task.send(.string(String(decoding: authData, as: UTF8.self)))
            let responseFrame = try await firstFrame(task)
            guard generation == connection, responseFrame["v"].integer == 1, responseFrame["id"].string == id else {
                throw RelayFailure("INVALID_SERVER_MESSAGE")
            }
            guard responseFrame["ok"].bool == true else { throw RelayFailure(responseFrame["error"]["code"].string ?? "AUTH_FAILED") }
            guard responseFrame["result"]["deviceId"].string == identity.certificate.id,
                  let role = responseFrame["result"]["role"].string, ["candidate", "client"].contains(role) else {
                throw RelayFailure("AUTH_FAILED")
            }
            online = true
            reader = Task { [weak self] in
                while !Task.isCancelled {
                    do {
                        let message = try await task.receive()
                        let frame = try Self.decode(message)
                        guard let self, self.generation == connection else { return }
                        try self.handle(frame, connection: connection)
                    } catch {
                        guard let self, self.generation == connection else { return }
                        let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) }
                        let failure = ["DEVICE_REVOKED", "AUTH_FAILED"].contains(reason ?? "")
                            ? RelayFailure(reason!) : Self.safeFailure(error)
                        self.disconnect()
                        self.onFailure?(failure)
                        return
                    }
                }
            }
            return role
        } catch {
            if generation == connection { disconnect() }
            throw Self.safeFailure(error)
        }
    }

    func disconnect() {
        generation = UUID()
        online = false
        reader?.cancel()
        reader = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        // Tear down the underlying connection too. A close handshake alone can
        // leave an authenticated socket alive during an immediate foreground.
        session?.invalidateAndCancel()
        session = nil
        outboundBytes = 0
        // Keep quota windows across reconnects; fresh inspection is still needed
        // before a grant qualifies for the data budget on this socket.
        dataGrants.removeAll(); deliveryGrants.removeAll()
        let abandonedInspections = inspections; inspections.removeAll()
        for inspection in abandonedInspections.values { inspection.cancel() }
        let abandoned = pending
        pending.removeAll()
        for row in abandoned.values { row.timeout.cancel(); row.continuation.resume(throwing: RelayFailure("UNCERTAIN")) }
    }

    func trust(_ certificate: RelayCertificate) throws {
        try certificate.verify()
        if let existing = trusted[certificate.id], existing != certificate { throw RelayFailure("IDENTITY_CHANGED") }
        guard trusted[certificate.id] != nil || trusted.count < 64 else { throw RelayFailure("TRUST_CAPACITY") }
        trusted[certificate.id] = certificate
    }

    func forgetPeer(_ id: String) {
        trusted.removeValue(forKey: id)
        dataGrants = dataGrants.filter { $0.value.peerID != id }
    }

    private func dataGrantID(for op: String, fields: [String: WireValue]) -> String? {
        let candidate: String?
        switch op {
        case "grant.inspect", "route.send": candidate = fields["grantId"]?.string
        case "delivery.ack": candidate = fields["deliveryId"]?.string.flatMap { deliveryGrants[$0] }
        default: candidate = nil
        }
        guard let id = candidate, let grant = dataGrants[id], grant.expiresAt > RelayWire.now,
              !revoked.contains(id), trusted[grant.peerID] != nil else { return nil }
        return id
    }

    func request(_ op: String, fields: [String: WireValue] = [:], timeoutNanoseconds: UInt64 = 10_000_000_000) async throws -> WireValue {
        guard (1_000_000...10_000_000_000).contains(timeoutNanoseconds) else { throw RelayFailure("INVALID_MESSAGE") }
        let allowed: [String: Set<String>] = ["invite.claim": ["code"], "invite.status": ["claimId"],
            "grant.list": [], "grant.inspect": ["grantId"], "route.send": ["grantId", "messageId", "box"], "delivery.ack": ["deliveryId"],
            "push.register": fields["enabled"]?.bool == false ? ["enabled"] : ["enabled", "deviceToken", "environment", "grantIds"]]
        guard allowed[op] == Set(fields.keys) else { throw RelayFailure("INVALID_MESSAGE") }
        if op == "push.register" {
            guard let enabled = fields["enabled"]?.bool else { throw RelayFailure("INVALID_MESSAGE") }
            if enabled {
                guard let token = fields["deviceToken"]?.string, token.count % 2 == 0,
                      token.range(of: "^[a-fA-F0-9]{64,512}$", options: .regularExpression) != nil,
                      let grants = fields["grantIds"]?.array, grants.count <= 256,
                      grants.allSatisfy({ $0.string?.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil }),
                      ["sandbox", "production"].contains(fields["environment"]?.string ?? "") else { throw RelayFailure("INVALID_MESSAGE") }
            }
        }
        guard online, let socket else { throw RelayFailure("OFFLINE") }
        guard pending.count < 64 else { throw RelayFailure("REQUEST_CAPACITY") }
        let id = RelayWire.encoded(try RelayWire.random())
        var object = fields
        object["v"] = .number(1); object["id"] = .string(id); object["op"] = .string(op)
        let data = try WireValue.object(object).data()
        guard data.count <= 65_536, outboundBytes + data.count <= 256 * 1024 else { throw RelayFailure("BACKPRESSURE") }
        guard !Task.isCancelled else { throw CancellationError() }
        try requestBudget.consume(dataGrantID: dataGrantID(for: op, fields: fields))
        let connection = generation
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                let timeout = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: timeoutNanoseconds) } catch { return }
                    self?.finish(id, result: .failure(RelayFailure("UNCERTAIN")))
                }
                pending[id] = Pending(continuation: continuation, timeout: timeout)
                outboundBytes += data.count
                Task { [weak self] in
                    do {
                        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
                        if let self, self.generation == connection { self.outboundBytes -= data.count }
                    } catch {
                        if let self, self.generation == connection {
                            self.outboundBytes -= data.count
                            self.finish(id, result: .failure(RelayFailure("UNCERTAIN")))
                        }
                    }
                }
            }
        }, onCancel: { [weak self] in
            Task { @MainActor in self?.finish(id, result: .failure(RelayFailure("UNCERTAIN"))) }
        })
    }

    func inspect(_ grantID: String) async throws -> WireValue {
        try RelayWire.opaque(grantID)
        // Share only an in-flight inspection. Never cache signed presence across
        // requests: the peer may have reconnected with a different socket epoch.
        if let inspection = inspections[grantID] { return try await inspection.value }
        let connection = generation
        let inspection = Task { @MainActor in try await self.inspectFresh(grantID, connection: connection) }
        inspections[grantID] = inspection
        defer { if generation == connection { inspections.removeValue(forKey: grantID) } }
        return try await inspection.value
    }

    /// A bounded independent inspection for narrowly scoped background RPC.
    /// Foreground observations keep their existing coalesced inspection path.
    func inspect(_ grantID: String, timeoutNanoseconds: UInt64) async throws -> WireValue {
        try RelayWire.opaque(grantID)
        return try await inspectFresh(grantID, connection: generation, timeoutNanoseconds: timeoutNanoseconds)
    }

    private func inspectFresh(_ grantID: String, connection: UUID, timeoutNanoseconds: UInt64 = 10_000_000_000) async throws -> WireValue {
        let grant = try await request("grant.inspect", fields: ["grantId": .string(grantID)], timeoutNanoseconds: timeoutNanoseconds)
        guard generation == connection, grant["id"].string == grantID, let expiry = grant["expiresAt"].integer, expiry > RelayWire.now,
              !revoked.contains(grantID), let host = grant["hostId"].string,
              grant["recipientId"].string == identity.certificate.id, grant["revokedAt"] == .null else {
            throw RelayFailure("GRANT_UNAVAILABLE")
        }
        let peer = try RelayCertificate.parse(grant["peer"])
        guard host == peer.id, trusted[peer.id] == peer else { throw RelayFailure("UNTRUSTED_PEER") }
        let spec = grant["spec"]
        try spec.record(["kind", "mode", "resource", "actions", "ttlSeconds", "grantTtlSeconds"])
        guard let kind = spec["kind"].string, ["PAIR", "AGENT", "TERMINAL"].contains(kind),
              let mode = spec["mode"].string, kind == "PAIR" ? mode == "pair" : ["live", "portable"].contains(mode),
              let resource = spec["resource"].string, let actions = spec["actions"].array,
              !actions.isEmpty, actions.count <= 8 else { throw RelayFailure("GRANT_UNAVAILABLE") }
        try RelayWire.opaque(resource)
        let allowed = mode == "portable" ? ["import"] : ["observe", "claim", "takeover", "execute", "answer", "pause", "cancel", "steer"]
        let names = actions.compactMap(\.string)
        guard names.count == actions.count, Set(names).count == names.count,
              Set(names).isSubset(of: Set(allowed)), names.contains(mode == "portable" ? "import" : "observe"),
              !names.contains(where: { ["takeover", "execute", "answer", "pause", "cancel", "steer"].contains($0) }) || names.contains("claim") else {
            throw RelayFailure("GRANT_UNAVAILABLE")
        }
        if grant["online"].bool == true {
            try grant["presence"].record(["epoch", "signature"])
            try RelayWire.decode(RelayPresence.self, grant["presence"]).verify(peer: peer)
        }
        if kind == "PAIR", mode == "pair" {
            dataGrants = dataGrants.filter { $0.value.expiresAt > RelayWire.now }
            guard dataGrants[grantID] != nil || dataGrants.count < 512 else { throw RelayFailure("REQUEST_CAPACITY") }
            dataGrants[grantID] = DataGrant(peerID: peer.id, expiresAt: expiry)
        }
        return grant
    }

    func send(grantID: String, payload: WireValue, timeoutNanoseconds: UInt64? = nil,
              beforeSend: (() throws -> Void)? = nil) async throws -> WireValue {
        let connection = generation
        let grant: WireValue
        if let timeoutNanoseconds { grant = try await inspect(grantID, timeoutNanoseconds: timeoutNanoseconds) }
        else { grant = try await inspect(grantID) }
        try beforeSend?()
        guard connection == generation, grant["online"].bool == true,
              grant["spec"]["mode"].string != "portable",
              let receiverEpoch = grant["presence"]["epoch"].string else { throw RelayFailure("PEER_OFFLINE") }
        let peer = try RelayCertificate.parse(grant["peer"])
        let messageID = RelayWire.encoded(try RelayWire.random())
        let envelope: WireValue = .object(["v": .number(1), "from": .string(identity.certificate.id), "to": .string(peer.id),
            "grantId": .string(grantID), "messageId": .string(messageID), "receiverEpoch": .string(receiverEpoch),
            "expiresAt": .number(Double(RelayWire.now + 60_000)), "payload": payload])
        let box = try identity.seal(envelope, to: peer)
        guard generation == connection, !revoked.contains(grantID) else { throw RelayFailure("GRANT_UNAVAILABLE") }
        return try await request("route.send", fields: ["grantId": .string(grantID), "messageId": .string(messageID), "box": box],
                                 timeoutNanoseconds: timeoutNanoseconds ?? 10_000_000_000)
    }

    private func receiveDelivery(_ data: WireValue, connection: UUID) async throws {
        try data.record(["deliveryId", "from", "to", "grantId", "messageId", "box"])
        guard let grantID = data["grantId"].string, let messageID = data["messageId"].string,
              let deliveryID = data["deliveryId"].string else { throw RelayFailure("INVALID_MESSAGE") }
        try RelayWire.opaque(messageID); try RelayWire.opaque(deliveryID)
        let grant = try await inspect(grantID)
        let peer = try RelayCertificate.parse(grant["peer"])
        guard grant["online"].bool == true, generation == connection, data["from"].string == peer.id, data["to"].string == identity.certificate.id,
              grant["spec"]["mode"].string != "portable" else { throw RelayFailure("ROUTING_MISMATCH") }
        let value = try identity.open(data["box"], from: peer)
        try RelayEnvelope.validate(value, from: peer.id, to: identity.certificate.id,
                                   grantID: grantID, messageID: messageID, epoch: epoch)
        guard let expiry = value["expiresAt"].integer else { throw RelayFailure("INVALID_MESSAGE") }
        try replay.accept(peer.id + ":" + messageID, expiresAt: expiry + 5_000)
        guard generation == connection, !revoked.contains(grantID) else { throw RelayFailure("GRANT_UNAVAILABLE") }
        deliveryGrants[deliveryID] = grantID
        defer { if generation == connection { deliveryGrants.removeValue(forKey: deliveryID) } }
        _ = try await request("delivery.ack", fields: ["deliveryId": .string(deliveryID)])
        guard generation == connection, !revoked.contains(grantID) else { throw RelayFailure("GRANT_UNAVAILABLE") }
        // The caller must implement an allowlisted Core schema before consuming this.
        onPayload?(peer.id, grantID, value["payload"])
    }

    private func handle(_ frame: WireValue, connection: UUID) throws {
        guard frame["v"].integer == 1 else { throw RelayFailure("INVALID_SERVER_MESSAGE") }
        if let id = frame["id"].string {
            guard pending[id] != nil else { return }
            if frame["ok"].bool == true { finish(id, result: .success(frame["result"])) }
            else {
                let failure = RelayFailure(frame["error"]["code"].string ?? "REQUEST_FAILED")
                finish(id, result: .failure(failure))
                if ["AUTH_FAILED", "DEVICE_REVOKED"].contains(failure.code) { throw failure }
            }
        } else if let event = frame["event"].string {
            switch event {
            case "delivery":
                guard activeDeliveries < 64 else { throw RelayFailure("REQUEST_CAPACITY") }
                activeDeliveries += 1
                Task { [weak self] in
                    guard let self else { return }
                    defer { self.activeDeliveries -= 1 }
                    do { try await self.receiveDelivery(frame["data"], connection: connection) }
                    catch {
                        guard self.generation == connection else { return }
                        // A transient transport failure cannot silently consume a
                        // decrypted frame. Reconnect and let Core replay from its
                        // processed cursor; application mutations are never retried.
                        let failure = Self.safeFailure(error)
                        if Self.requiresReconnect(failure) {
                            self.disconnect(); self.onFailure?(failure)
                        }
                        // Invalid/untrusted encrypted content is rejected without
                        // acknowledgment, disclosure or disconnecting healthy peers.
                    }
                }
            case "grant.revoked":
                guard let id = frame["data"]["grantId"].string else { throw RelayFailure("INVALID_MESSAGE") }
                try RelayWire.opaque(id)
                if revoked.count >= 512 { throw RelayFailure("GRANT_UNAVAILABLE") }
                revoked.insert(id)
                dataGrants.removeValue(forKey: id)
                onEvent?(event, frame["data"])
            case "invite.decided", "delivery.received", "delivery.uncertain": onEvent?(event, frame["data"])
            default: throw RelayFailure("INVALID_SERVER_MESSAGE")
            }
        } else { throw RelayFailure("INVALID_SERVER_MESSAGE") }
    }

    private func finish(_ id: String, result: Result<WireValue, Error>) {
        guard let row = pending.removeValue(forKey: id) else { return }
        row.timeout.cancel()
        row.continuation.resume(with: result)
    }

    private func firstFrame(_ task: URLSessionWebSocketTask) async throws -> WireValue {
        try await withThrowingTaskGroup(of: WireValue.self) { group in
            group.addTask { let message = try await task.receive(); return try Self.decode(message) }
            group.addTask {
                try await Task.sleep(for: .seconds(10))
                task.cancel(with: .goingAway, reason: nil)
                throw RelayFailure("CONNECTION_TIMEOUT")
            }
            defer { group.cancelAll() }
            guard let result = try await group.next() else { throw RelayFailure("CONNECTION_FAILED") }
            return result
        }
    }
    nonisolated private static func decode(_ message: URLSessionWebSocketTask.Message) throws -> WireValue {
        guard case .string(let text) = message else { throw RelayFailure("INVALID_MESSAGE") }
        return try WireValue.parse(Data(text.utf8))
    }
    nonisolated private static func safeFailure(_ error: Error) -> RelayFailure {
        if let failure = error as? RelayFailure { return failure }
        if let error = error as? URLError, (-1206 ... -1200).contains(error.errorCode) { return RelayFailure("TLS_FAILED") }
        return RelayFailure("CONNECTION_FAILED")
    }

    nonisolated static func requiresReconnect(_ failure: RelayFailure) -> Bool {
        ["OFFLINE", "RATE_LIMITED", "REQUEST_CAPACITY", "BACKPRESSURE", "UNCERTAIN", "DELIVERY_UNAVAILABLE",
         "CONNECTION_FAILED", "CONNECTION_TIMEOUT", "PEER_OFFLINE"].contains(failure.code)
    }
}
