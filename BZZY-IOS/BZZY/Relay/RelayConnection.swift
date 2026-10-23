import Foundation
import Observation
import Security
import CryptoKit

enum RelayKeychain {
    private static let service = "app.bzzy.relay.v1"
    static func read(_ account: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else { throw RelayFailure("KEYCHAIN_UNAVAILABLE") }
        return data
    }
    static func write(_ data: Data, account: String, replacing: Bool) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                   kSecAttrAccount as String: account]
        if replacing, try read(account) != nil {
            guard SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecSuccess else {
                throw RelayFailure("KEYCHAIN_UNAVAILABLE")
            }
        } else {
            var insert = query
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw RelayFailure("KEYCHAIN_UNAVAILABLE") }
        }
    }
    static func removeDiagnostic(_ account: String) {
        guard account.hasPrefix("diagnostic-") else { return }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
    }
    static func identity() throws -> RelayIdentity {
        if let data = try read("device-identity") {
            let identity: RelayIdentity
            do { identity = try JSONDecoder().decode(RelayIdentity.self, from: data) }
            catch { throw RelayFailure("INVALID_IDENTITY") }
            try identity.validate()
            return identity
        }
        let identity = try RelayIdentity.generate()
        try write(JSONEncoder().encode(identity), account: "device-identity", replacing: false)
        return identity
    }
}

private struct HostBinding: Codable {
    let certificate: RelayCertificate
    let grantID: String
    let expiresAt: Int64
}

private struct PendingPair: Codable {
    let claimID: String
    let expectedFingerprint: String
    let expectedCertificate: RelayCertificate?
    let expiresAt: Int64?
}

private struct PendingCoreCommand: Codable {
    let hostID: String
    let resource: String
    let id: String
    let op: String
    let params: [String: CoreJSONValue]
}

private struct CoreCacheScope: Codable {
    let hostID: String
    let resource: String
    let sessionID: String
}

private struct SelectedCoreSession: Codable {
    let sessionID: String
    let resource: String
    var kind: String? = nil
    var agentID: String? = nil
}
private struct PendingAgentOpen: Codable {
    let agentID: String
    let requestID: String
}
private struct PendingSessionOpen: Codable {
    let sessionID: String
    let requestID: String
}
private struct AgentImportReference: Codable {
    let hostID: String
    let grantID: String
    let sourceFingerprint: String
    let requestID: String
    var importID: String?
}

private struct PendingCoreUpdate: Codable {
    let hostID: String
    let grantID: String
    let requestID: String
    let target: String
}

private struct SavedRelayState: Codable {
    var pendingUpdate: PendingCoreUpdate?
    var host: HostBinding?
    var pending: PendingPair?
    var pendingCoreCommand: PendingCoreCommand?
    var taskID: String?
    var coreCacheScope: CoreCacheScope?
    var coreCacheScopes: [CoreCacheScope]?
    var selectedSession: SelectedCoreSession?
    var openingSession: PendingSessionOpen?
    var corePairValidated: Bool?
    var openingAgent: PendingAgentOpen?
    var pendingAgentCommand: PendingCoreCommand?
    var agentImport: AgentImportReference?
}

public struct CoreShareReference: Sendable {
    public let shareID: String
    public let expiresAt: Date?
}

public enum RelayStatus: String, Sendable {
    case offline = "Offline", connecting = "Connecting", connected = "Relay connected", failed = "Unavailable"
}

@MainActor @Observable
public final class RelayConnection {
    public private(set) var status: RelayStatus = .offline
    public private(set) var hostStatus = "Not paired"
    public private(set) var deviceFingerprint = ""
    public private(set) var hostFingerprint = ""
    public private(set) var pairingStatus = ""
    public private(set) var errorMessage: String?
    public private(set) var isBusy = false
    public private(set) var hasPairingPreview = false
    public private(set) var hasHost = false
    @ObservationIgnored public var onNotice: ((String) -> Void)?
    @ObservationIgnored public var onCoreSnapshot: ((Data) -> Void)?
    @ObservationIgnored public var onCoreEvents: (([Data]) -> Void)?
    @ObservationIgnored public var onCoreAvailability: ((Bool, String) -> Void)?
    @ObservationIgnored public var onCoreCleared: (() -> Void)?
    @ObservationIgnored public var onCoreConversationCleared: (() -> Void)?
    @ObservationIgnored public var onCoreSessions: ((Data) -> Void)?
    @ObservationIgnored public var onCoreAgents: ((Data) -> Void)?
    @ObservationIgnored public var onCoreAgentStatus: ((Data) -> Void)?
    public private(set) var coreUpdateSnapshot: CoreJSONValue?
    public private(set) var coreUpdateStatus = "Connect to Core to check updates."
    public private(set) var coreUpdateBusy = false
    public var coreUpdatePending: Bool { state.pendingUpdate != nil }
    public var coreUpdatePendingTarget: String? { state.pendingUpdate?.target }
    public private(set) var coreAgentsAvailable = false
    public private(set) var coreAgentsConfigured = false
    public private(set) var coreIsAgent = false
    public private(set) var coreAgentStatus = ""
    public var coreAgentMutationPending: Bool { state.pendingAgentCommand != nil }
    private var agentImportRevision = UUID()
    public var coreAgentImportPending: Bool { _ = agentImportRevision; return state.agentImport != nil }
    public private(set) var coreAgentImportSnapshot: CoreJSONValue?
    public private(set) var coreAgentImportRecoveredAgent: CoreJSONValue?
    @ObservationIgnored private var agentEntries: [CoreJSONValue] = []
    public private(set) var coreCatalogAvailable = false
    public private(set) var coreCatalogReady = false
    public private(set) var coreSharingAllowed = false
    @ObservationIgnored private var recentCoreShares: [String: CoreShareReference] = [:]
    @ObservationIgnored private var pendingCoreShareRequests: [String: String] = [:]
    @ObservationIgnored private var pushRegistrationHash: String?
    @ObservationIgnored private var pushRegistrationStatus = "Host delivery not registered"
    @ObservationIgnored private var pushRegistrationBusy = false
    public var coreSessionAttachmentPending: Bool { state.openingSession != nil || state.openingAgent != nil }
    @ObservationIgnored private var catalogClient: CoreRelayClient?
    @ObservationIgnored private var catalogEntries: [CoreJSONValue] = []
    @ObservationIgnored private var coreOfferedPermissions: Set<String> = []
    @ObservationIgnored private var coreRefreshEpoch = UUID()
    @ObservationIgnored private var inputRenewalEpoch = UUID()
    @ObservationIgnored private var pollingEpoch = UUID()

    public private(set) var coreConnected = false
    private var coreHealth = CoreConnectionHealth()
    @ObservationIgnored private var coreMonitor: Task<Void, Never>?
    @ObservationIgnored private var coreMonitorEpoch = UUID()
    public var coreActionsAvailable: Bool { coreConnected && coreHealth.isOnline() && corePairAuthorized && !suspended && transport?.online == true && coreClient != nil }
    public var coreConnectionLabel: String {
        if coreActionsAvailable { return "Core online" }
        return status == .connecting || coreHealth.phase == .connecting ? "Connecting to Core" : "Core offline"
    }
    public private(set) var hostMetrics: CoreHostMetrics?
    public private(set) var hostMetricsStatus = "Waiting for Core"
    @ObservationIgnored private var metricsPolling: Task<Void, Never>?
    @ObservationIgnored private var metricsEpoch = UUID()
    private var confirmedCorePair = false
    private var forgettingHost = false
    public var corePairAuthorized: Bool { confirmedCorePair && !forgettingHost && (state.host?.expiresAt ?? 0) > RelayWire.now && !fatalAuthorizationLoss }
    public private(set) var coreSessionID = ""
    public private(set) var coreIsAssistant = false
    public private(set) var corePermissions: Set<String> = []
    public private(set) var coreOwnsInput = false
    public private(set) var coreBusy = false
    public private(set) var coreError: String?
    public private(set) var coreCommandStatus = ""
    public private(set) var coreCommandUncertain = false
    public private(set) var coreTaskStatus = ""
    @ObservationIgnored private var coreClient: CoreRelayClient?
    @ObservationIgnored private var coreProjection: CoreEventProjectionStore?
    @ObservationIgnored private var coreResource = ""
    @ObservationIgnored private var coreGrantID = ""
    @ObservationIgnored private var coreSubscriptionID: String?
    @ObservationIgnored private var coreStarting = false
    @ObservationIgnored private var coreRefresh: Task<Void, Never>?
    @ObservationIgnored private var inputRenewal: Task<Void, Never>?
    @ObservationIgnored private var claimedOwnerID: String?
    @ObservationIgnored private var lastCommandAccepted = false

    public let networkingEnabled: Bool
    @ObservationIgnored private var transport: RelayTransport?
    @ObservationIgnored private var state = SavedRelayState()
    @ObservationIgnored private var invitation: PairInvitation?
    @ObservationIgnored private var reconnect: Task<Void, Never>?
    @ObservationIgnored private var polling: Task<Void, Never>?
    @ObservationIgnored private var attempts = 0
    @ObservationIgnored private var suspended = false
    @ObservationIgnored private var authorizing = false
    @ObservationIgnored private var fatalAuthorizationLoss = false
    @ObservationIgnored private var loadIdentity: () throws -> RelayIdentity = RelayKeychain.identity
    @ObservationIgnored private var loadAuthorization: () throws -> Data? = { try RelayKeychain.read("host-authorization") }
    @ObservationIgnored private var saveAuthorization: (Data) throws -> Void = {
        try RelayKeychain.write($0, account: "host-authorization", replacing: true)
    }
    @ObservationIgnored private var makeTransport: (RelayIdentity) throws -> RelayTransport = { RelayTransport(identity: $0) }
    @ObservationIgnored private var isolatedProjectionDirectory: URL?

    public init(networkingEnabled: Bool = false) { self.networkingEnabled = networkingEnabled }

    /// Internal local integration seam. Production always uses device Keychain,
    /// the fixed TLS endpoint, and the app's own projection directory.
    init(isolatedIdentity: RelayIdentity, loopbackTransport: RelayTransport, projectionDirectory: URL,
         loadAuthorization: @escaping () throws -> Data?, saveAuthorization: @escaping (Data) throws -> Void) throws {
        _ = try RelayTransport(identity: isolatedIdentity, loopbackEndpoint: loopbackTransport.endpoint)
        self.networkingEnabled = true
        self.loadIdentity = { isolatedIdentity }
        self.loadAuthorization = loadAuthorization
        self.saveAuthorization = saveAuthorization
        self.makeTransport = { _ in loopbackTransport }
        self.isolatedProjectionDirectory = projectionDirectory
    }

    #if DEBUG
    /// Explicit isolated UI fixture. It never enables networking, writes the
    /// device Keychain, or establishes Core readiness.
    public static func pairedOfflinePreview() throws -> RelayConnection {
        let connection = RelayConnection(networkingEnabled: false)
        let identity = try RelayIdentity.generate()
        connection.state.host = HostBinding(certificate: identity.certificate, grantID: "offline-preview", expiresAt: RelayWire.now + 600_000)
        connection.state.corePairValidated = true
        connection.confirmedCorePair = true
        connection.hasHost = true; connection.status = .connected
        connection.hostStatus = "Host offline"
        return connection
    }
    #endif

    public var shortStatus: String {
        if corePairAuthorized { return coreConnectionLabel }
        if hasHost { return hostStatus }
        if status == .connected { return "Pair host" }
        return status == .connecting ? "Connecting" : "Connect"
    }

    public func resume() async {
        guard networkingEnabled, !authorizing, !fatalAuthorizationLoss else { return }
        suspended = false
        if transport?.online == true {
            if coreConnected && coreHealth.isOnline() {
                // Inactive overlays do not suspend the app. Keep the existing
                // scoped subscription; its heartbeat continues to prove readiness.
                scheduleCoreMonitor(); scheduleHostMetrics(); return
            }
            await reconcile(); return
        }
        await connect()
    }

    public func connect() async {
        guard networkingEnabled, !authorizing else { return }
        if transport?.online == true { await reconcile(); return }
        suspended = false
        fatalAuthorizationLoss = false
        reconnect?.cancel()
        authorizing = true
        status = .connecting
        errorMessage = nil
        defer { authorizing = false }
        do {
            if transport == nil {
                let identity = try loadIdentity()
                deviceFingerprint = identity.certificate.id
                if let data = try loadAuthorization() {
                    do { state = try JSONDecoder().decode(SavedRelayState.self, from: data) }
                    catch { throw RelayFailure("INVALID_IDENTITY") }
                }
                let client = try makeTransport(identity)
                if let host = state.host {
                    try client.trust(host.certificate); hostFingerprint = host.certificate.id
                    confirmedCorePair = state.corePairValidated == true && host.expiresAt > RelayWire.now
                }
                transport = client
                client.onEvent = { [weak self] event, data in
                    guard let self else { return }
                    if event == "grant.revoked", data["grantId"].string == self.state.host?.grantID {
                        self.stopCore(purge: true)
                        self.state.host = nil
                        self.hasHost = false
                        self.hostStatus = "Access revoked"
                        self.onNotice?("revoked")
                        try? self.save()
                    } else if event == "invite.decided", data["claimId"].string == self.state.pending?.claimID {
                        Task { await self.pollDecision() }
                    }
                }
                client.onFailure = { [weak self] error in self?.failed(error) }
                client.onPayload = { [weak self] peer, grant, payload in
                    guard let self else { return }
                    do {
                        if payload["type"].string == "response" {
                            try self.catalogClient?.receive(from: peer, grantID: grant, payload: payload)
                            if self.coreClient !== self.catalogClient { try self.coreClient?.receive(from: peer, grantID: grant, payload: payload) }
                        } else if let resource = payload["resource"].string {
                            if self.coreClient?.resource == resource { try self.coreClient?.receive(from: peer, grantID: grant, payload: payload) }
                            else if self.catalogClient?.resource == resource { try self.catalogClient?.receive(from: peer, grantID: grant, payload: payload) }
                        }
                    } catch { self.coreError = "Invalid Core response. Reconnect to reconcile." }
                }
            }
            guard let transport else { throw RelayFailure("INVALID_IDENTITY") }
            _ = try await transport.connect()
            guard !suspended else { transport.disconnect(); status = .offline; return }
            attempts = 0
            status = .connected
            await reconcile()
            scheduleCoreMonitor()
        } catch { failed(error as? RelayFailure ?? RelayFailure("CONNECTION_FAILED")) }
    }

    public func pause() {
        suspended = true
        reconnect?.cancel(); reconnect = nil
        polling?.cancel(); polling = nil
        stopCoreMonitor()
        stopCore(purge: false)
        transport?.disconnect()
        status = .offline
        if hasHost { hostStatus = "Host offline" }
    }

    public func previewPairing(_ text: String, expectedFingerprint: String = "") {
        errorMessage = nil
        invitation = nil
        hasPairingPreview = false
        do {
            let value = try PairInvitation.parse(text, fingerprint: expectedFingerprint.trimmingCharacters(in: .whitespacesAndNewlines))
            if let existing = state.host, existing.certificate.id == value.fingerprint,
               let supplied = value.sender, existing.certificate != supplied { throw RelayFailure("IDENTITY_CHANGED") }
            invitation = value
            hostFingerprint = value.fingerprint
            hasPairingPreview = true
        } catch { errorMessage = (error as? RelayFailure ?? RelayFailure("INVALID_INVITATION")).localizedDescription }
    }

    public func cancelPairingPreview() {
        invitation = nil
        hasPairingPreview = false
        hostFingerprint = state.host?.certificate.id ?? ""
    }

    /// Call only after the user compares the complete host fingerprint with a trusted host display.
    public func claimConfirmedHost() async {
        guard networkingEnabled, !isBusy, !authorizing, let invitation else { return }
        self.invitation = nil
        hasPairingPreview = false
        if let expires = invitation.expiresAt, expires <= RelayWire.now {
            errorMessage = RelayFailure("INVITE_EXPIRED").localizedDescription
            return
        }
        isBusy = true
        defer { isBusy = false }
        if transport?.online != true { await connect() }
        guard let transport, transport.online else { return }
        do {
            let reply = try await transport.request("invite.claim", fields: ["code": .string(invitation.code)])
            guard reply["state"].string == "pending", let claimID = reply["claimId"].string else {
                throw RelayFailure("INVALID_MESSAGE")
            }
            try RelayWire.opaque(claimID)
            state.pending = PendingPair(claimID: claimID, expectedFingerprint: invitation.fingerprint,
                                        expectedCertificate: invitation.sender, expiresAt: invitation.expiresAt)
            try save()
            pairingStatus = "Pending approval"
            schedulePolling()
        } catch {
            // Claims consume codes. Never retry a claim on timeout/reconnect.
            errorMessage = (error as? RelayFailure ?? RelayFailure("UNCERTAIN")).localizedDescription
            pairingStatus = "Not paired"
        }
    }

    public func refresh() async { await reconcile(); scheduleCoreMonitor() }

    public func forgetHost() async {
        guard !forgettingHost else { return }
        forgettingHost = true; isBusy = true
        defer { forgettingHost = false; isBusy = false }
        let previousGrant = state.host?.grantID
        confirmedCorePair = false
        if let client = catalogClient, client.grantID == previousGrant {
            _ = try? await client.request("notifications.revoke")
        }
        guard state.host?.grantID == previousGrant else { return }
        stopCore(purge: true)
        if let host = state.host { transport?.forgetPeer(host.certificate.id) }
        state.host = nil
        state.pending = nil
        polling?.cancel(); polling = nil
        cancelPairingPreview()
        hasHost = false
        hostFingerprint = ""
        hostStatus = "Not paired"
        pairingStatus = ""
        do { try save() }
        catch { errorMessage = RelayFailure("KEYCHAIN_UNAVAILABLE").localizedDescription }
    }

    private func reconcile() async {
        guard transport?.online == true, !suspended else { return }
        if state.pending != nil { await pollDecision(); schedulePolling() }
        if let host = state.host, let transport {
            do {
                guard host.expiresAt > RelayWire.now else { throw RelayFailure("GRANT_UNAVAILABLE") }
                try transport.trust(host.certificate)
                let grant = try await transport.inspect(host.grantID)
                guard state.host?.grantID == host.grantID, self.transport === transport, !suspended else { return }
                hasHost = true
                hostFingerprint = host.certificate.id
                hostStatus = grant["online"].bool == true ? "Host paired" : "Host offline"
                if grant["online"].bool == true { await startCore(grant: grant) }
                else { stopCore(purge: false) }
            } catch {
                guard state.host?.grantID == host.grantID, self.transport === transport, !suspended else { return }
                hasHost = false
                let failure = error as? RelayFailure ?? RelayFailure("CONNECTION_FAILED")
                hostStatus = failure.code == "GRANT_UNAVAILABLE" ? "Access expired or revoked" : "Host unavailable"
                stopCore(purge: failure.code == "GRANT_UNAVAILABLE")
                if failure.code == "GRANT_UNAVAILABLE" { state.host = nil; try? save() }
            }
        }
    }

    private func pollDecision() async {
        guard let pending = state.pending, let transport, transport.online, !suspended else { return }
        do {
            let result = try await transport.request("invite.status", fields: ["claimId": .string(pending.claimID)])
            guard result["claimId"].string == pending.claimID, let decision = result["state"].string else {
                throw RelayFailure("INVALID_MESSAGE")
            }
            if decision == "pending" { pairingStatus = "Pending approval"; return }
            guard decision == "approved" else {
                pairingStatus = decision == "denied" ? "Declined" : "Expired or revoked"
                state.pending = nil; polling?.cancel(); try save(); return
            }
            let grant = result["grant"]
            let peer = try RelayCertificate.parse(grant["peer"])
            guard peer.id == pending.expectedFingerprint,
                  pending.expectedCertificate == nil || pending.expectedCertificate == peer,
                  grant["hostId"].string == peer.id, grant["recipientId"].string == deviceFingerprint,
                  grant["spec"]["kind"].string == "PAIR", grant["spec"]["mode"].string == "pair",
                  grant["spec"]["actions"].array?.contains(.string("observe")) == true,
                  let grantID = grant["id"].string, let expiry = grant["expiresAt"].integer, expiry > RelayWire.now else {
                throw RelayFailure("HOST_MISMATCH")
            }
            try transport.trust(peer)
            let current = try await transport.inspect(grantID)
            guard state.pending?.claimID == pending.claimID else { return }
            // Re-pairing replaces the approved resource; old private projections and
            // pending commands must not follow the new authorization.
            if state.host?.grantID != grantID { stopCore(purge: true) }
            state.host = HostBinding(certificate: peer, grantID: grantID, expiresAt: expiry)
            state.pending = nil
            try save()
            hasHost = true
            hostFingerprint = peer.id
            hostStatus = current["online"].bool == true ? "Host paired" : "Host offline"
            pairingStatus = "Paired"
            onNotice?("paired")
            // The polling task may be running this completion. Its next loop
            // exits with no pending claim; cancelling it here aborts startCore.
            scheduleCoreMonitor()
            if current["online"].bool == true { await startCore(grant: current) }
        } catch {
            let failure = error as? RelayFailure ?? RelayFailure("CONNECTION_FAILED")
            errorMessage = failure.localizedDescription
            if ["HOST_MISMATCH", "INVALID_IDENTITY", "INVITE_EXPIRED", "CLAIM_UNAVAILABLE", "GRANT_UNAVAILABLE"].contains(failure.code) {
                state.pending = nil; polling?.cancel(); try? save()
                pairingStatus = "Not paired"
            }
        }
    }

    private func startCore(grant: WireValue) async {
        guard !coreStarting, let transport, let host = state.host,
              grant["id"].string == host.grantID, grant["spec"]["kind"].string == "PAIR",
              grant["spec"]["mode"].string == "pair", let baseResource = grant["spec"]["resource"].string else { return }
        coreStarting = true
        defer { coreStarting = false }
        var startingClient: CoreRelayClient?
        do {
            if catalogClient == nil || catalogClient?.grantID != host.grantID || catalogClient?.resource != baseResource {
                stopCore(purge: false)
                catalogClient = CoreRelayClient(transport: transport, hostID: host.certificate.id, grantID: host.grantID, resource: baseResource)
            }
            guard let catalog = catalogClient else { return }
            if !coreConnected { coreHealth.begin(scope: catalog.resource) }
            startingClient = catalog
            let baseSnapshot = try await catalog.request("session.get")
            guard catalogClient === catalog, state.host?.grantID == host.grantID, !suspended else { return }
            coreCatalogAvailable = baseSnapshot["capabilities"]["sessionAccess"].bool == true
            coreAgentsAvailable = baseSnapshot["capabilities"]["agentAccess"].bool == true
            coreCatalogReady = true
            coreOfferedPermissions = Set(grant["spec"]["actions"].array?.compactMap(\.string) ?? [])
            if coreCatalogAvailable { try await loadCoreSessions(using: catalog) }
            else { catalogEntries = []; onCoreSessions?(try JSONEncoder().encode([CoreJSONValue]())) }
            if coreAgentsAvailable {
                do { try await loadCoreAgents(using: catalog) }
                catch { coreAgentsConfigured = false; coreAgentStatus = "Agent management unavailable. Refresh after checking your host." }
            } else { agentEntries = []; onCoreAgents?(Data("[]".utf8)) }
            guard catalogClient === catalog, state.host?.grantID == host.grantID, !suspended else { return }
            var resource = baseResource
            if let selected = state.selectedSession, selected.resource != baseResource {
                let permitted: Bool
                if selected.kind == "agent" {
                    permitted = coreAgentsAvailable && agentEntries.contains(where: {
                        $0["id"].string == selected.agentID && $0["sessionId"].string == selected.sessionID && $0["existingResource"].string == selected.resource
                    })
                } else {
                    permitted = coreCatalogAvailable && catalogEntries.contains(where: {
                        $0["id"].string == selected.sessionID && $0["existingResource"].string == selected.resource
                    })
                }
                guard permitted else {
                    removeSelectedCoreContext()
                    coreError = "The saved conversation is no longer authorized. Choose another available conversation."
                    onCoreAvailability?(false, coreError!); return
                }
                resource = selected.resource
            }
            let client: CoreRelayClient
            if let current = coreClient, current.resource == resource, current.grantID == host.grantID { client = current }
            else {
                stopCore(purge: false, preserveCatalog: true)
                client = resource == baseResource ? catalog : CoreRelayClient(transport: transport, hostID: host.certificate.id, grantID: host.grantID, resource: resource, expectedShareKind: state.selectedSession?.kind == "agent" ? .agent : .terminal)
                coreClient = client
            }
            startingClient = client
            coreResource = resource; coreGrantID = host.grantID
            coreIsAgent = state.selectedSession?.kind == "agent"
            configureCoreCallbacks(client)
            coreHealth.begin(scope: client.resource)
            let snapshot = resource == baseResource ? baseSnapshot : try await client.request("session.get")
            guard coreClient === client, state.host?.grantID == host.grantID, !suspended, transport.online else { return }
            try await bindCoreSession(client, snapshot: snapshot)
        } catch {
            guard startingClient == nil || coreClient === startingClient || catalogClient === startingClient else { return }
            let code = (error as? CoreApplicationError)?.code
            stopCore(purge: code == "FORBIDDEN" || code == "GRANT_UNAVAILABLE")
            coreError = "Core session unavailable. Refresh after checking host authorization."
            onCoreAvailability?(false, coreError!)
        }
    }

    private func configureCoreCallbacks(_ client: CoreRelayClient) {
        client.onEvents = { [weak self, weak client] batch in
            Task { @MainActor in
                guard let self, let client, self.coreClient === client, let projection = self.coreProjection else { return }
                do {
                    try projection.apply(batch)
                    self.publishCoreEvents()
                    _ = try await client.request("events.ack", params: ["subscriptionId": .string(batch.subscriptionId), "seq": .number(Double(batch.nextCursor))])
                } catch {
                    guard self.coreClient === client else { return }
                    self.stopCore(purge: false)
                    self.coreError = "History could not be saved or acknowledged. Refresh to replay safely."
                    self.onCoreAvailability?(false, self.coreError!)
                }
            }
        }
        client.onSubscriptionClosed = { [weak self, weak client] _, code in
            guard let self, let client, self.coreClient === client else { return }
            if ["FORBIDDEN", "GRANT_UNAVAILABLE"].contains(code), client !== self.catalogClient { self.removeSelectedCoreContext() }
            else { self.stopCore(purge: false) }
            self.coreError = "Live updates stopped (\(code)). Refresh to reconnect."
        }
    }

    private func bindCoreSession(_ client: CoreRelayClient, snapshot: CoreJSONValue) async throws {
        let healthGeneration = coreHealth.begin(scope: client.resource)
        guard coreClient === client, let sessionID = snapshot["session"]["id"].string, UUID(uuidString: sessionID) != nil else {
            throw RelayFailure("INVALID_MESSAGE")
        }
        if coreProjection == nil || coreSessionID != sessionID || state.coreCacheScope?.hostID != client.hostID || state.coreCacheScope?.resource != client.resource {
            let directory = isolatedProjectionDirectory ?? Self.coreProjectionDirectory
            coreProjection = try CoreEventProjectionStore(directory: directory, hostID: client.hostID, resource: client.resource, sessionID: sessionID)
            let scope = CoreCacheScope(hostID: client.hostID, resource: client.resource, sessionID: sessionID)
            state.coreCacheScope = scope
            var scopes = state.coreCacheScopes ?? []
            if !scopes.contains(where: { $0.hostID == scope.hostID && $0.resource == scope.resource && $0.sessionID == scope.sessionID }) { scopes.append(scope) }
            state.coreCacheScopes = scopes
            try save()
        }
        if coreSessionID != sessionID { coreCommandStatus = ""; coreTaskStatus = "" }
        coreSessionID = sessionID
        coreSharingAllowed = snapshot["capabilities"]["shareAccess"].bool == true && (!coreIsAgent || coreAgentsAvailable)
        corePermissions = Set(snapshot["capabilities"]["permissions"].array?.compactMap(\.string) ?? []).intersection(coreOfferedPermissions)
        if let claimedOwnerID, snapshot["inputOwner"]["owner"].string != claimedOwnerID {
            coreOwnsInput = false; self.claimedOwnerID = nil; inputRenewal?.cancel(); inputRenewal = nil
        }
        onCoreSnapshot?(try JSONEncoder().encode(snapshot)); publishCoreEvents()
        if coreSubscriptionID == nil, let projection = coreProjection {
            let subscription = try await client.request("events.subscribe", params: ["consumerId": .string(projection.consumerID)])
            guard coreClient === client, !suspended else { return }
            coreSubscriptionID = subscription["subscriptionId"].string
            do {
                _ = try await client.request("assistant.status")
                guard coreClient === client, !suspended else { return }
                coreIsAssistant = true
            } catch let failure as CoreApplicationError where failure.code == "OPERATION_DENIED" {
                guard coreClient === client, !suspended else { return }
                coreIsAssistant = false
            }
        }
        guard coreClient === client, !suspended,
              coreHealth.confirm(healthGeneration, scope: client.resource) else { return }
        state.corePairValidated = true
        try save()
        confirmedCorePair = true
        coreConnected = true; coreError = nil
        onCoreAvailability?(true, "Connected to Core")
        await reconcileCoreCommand()
        await reconcileCoreAgentCommand()
        guard coreClient === client else { return }
        scheduleCoreRefresh()
        scheduleHostMetrics()
        scheduleCoreMonitor()
    }

    private static var coreProjectionDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BZZY/Core", isDirectory: true)
    }

    private func loadCoreSessions(using catalog: CoreRelayClient) async throws {
        var entries: [CoreJSONValue] = [], cursor: String?
        repeat {
            var params: [String: CoreJSONValue] = ["limit": .number(25)]
            if let cursor { params["after"] = .string(cursor) }
            let page = try await catalog.request("sessions.list", params: params)
            guard catalogClient === catalog, !suspended else { return }
            entries += page["sessions"].array ?? []
            guard entries.count <= 500 else { throw CoreApplicationError("CAPACITY") }
            cursor = page["hasMore"].bool == true ? page["nextCursor"].string : nil
        } while cursor != nil
        catalogEntries = entries
        onCoreSessions?(try JSONEncoder().encode(entries))
    }

    public func refreshCoreSessions() async {
        guard coreActionsAvailable, coreCatalogReady, coreCatalogAvailable, let catalog = catalogClient else { return }
        do { try await loadCoreSessions(using: catalog) }
        catch {
            guard catalogClient === catalog else { return }
            let code = (error as? CoreApplicationError)?.code
            if code == "FORBIDDEN" || code == "GRANT_UNAVAILABLE" { stopCore(purge: true); try? save() }
            coreError = "Terminal list could not be refreshed."
        }
    }

    /// Opening is an authorized attachment to an existing CLI session. It never creates or executes a terminal.
    public func openCoreSession(_ sessionID: String) async -> Bool {
        guard coreActionsAvailable, !coreBusy, !coreStarting, !coreCommandUncertain, state.pendingCoreCommand == nil,
              coreCatalogReady, coreCatalogAvailable, let catalog = catalogClient,
              let transport, let host = state.host, UUID(uuidString: sessionID) != nil,
              catalogEntries.contains(where: { $0["id"].string == sessionID }) else { return false }
        if state.openingAgent != nil { coreError = "Resolve or cancel the pending agent attachment first."; return false }
        if coreConnected && coreSessionID == sessionID { return true }
        if let opening = state.openingSession, opening.sessionID != sessionID {
            coreError = "Resolve the previous terminal attachment before choosing another terminal."; return false
        }
        coreBusy = true; coreError = nil
        defer { coreBusy = false }
        do {
            let opening = state.openingSession ?? PendingSessionOpen(sessionID: sessionID, requestID: CoreRelayClient.commandID())
            state.openingSession = opening; try save()
            let opened = try await catalog.request("sessions.open", params: ["sessionId": .string(sessionID)], id: opening.requestID)
            guard coreActionsAvailable, catalogClient === catalog, state.host?.grantID == host.grantID, state.openingSession?.requestID == opening.requestID,
                  !suspended, let resource = opened["resource"].string, opened["sessionId"].string == sessionID else { return false }
            if coreOwnsInput { await releaseCoreInput() }
            guard coreActionsAvailable, catalogClient === catalog, state.host?.grantID == host.grantID, !suspended else { return false }
            if let old = coreClient, let subscription = coreSubscriptionID {
                // Cleanup is best-effort: a lost unsubscribe receipt must not
                // permanently prevent attaching to another authorized session.
                _ = try? await old.request("events.unsubscribe", params: ["subscriptionId": .string(subscription)])
                guard coreActionsAvailable, catalogClient === catalog, coreClient === old, !suspended else { return false }
            }
            stopCore(purge: false, preserveCatalog: true)
            let previousSelection = state.selectedSession
            state.selectedSession = SelectedCoreSession(sessionID: sessionID, resource: resource)
            state.openingSession = nil; state.taskID = nil
            do { try save() }
            catch { state.selectedSession = previousSelection; state.openingSession = opening; throw error }
            let client = resource == catalog.resource ? catalog : CoreRelayClient(transport: transport, hostID: host.certificate.id, grantID: host.grantID, resource: resource)
            coreClient = client; coreResource = resource; coreGrantID = host.grantID; coreIsAgent = false
            configureCoreCallbacks(client)
            coreHealth.begin(scope: client.resource)
            let snapshot = try await client.request("session.get")
            guard coreClient === client, state.host?.grantID == host.grantID, !suspended else { return false }
            try await bindCoreSession(client, snapshot: snapshot)
            return coreClient === client && coreConnected && coreSessionID == sessionID
        } catch {
            guard catalogClient === catalog, state.host?.grantID == host.grantID else { return false }
            coreError = "Terminal attachment was not confirmed. Select the same terminal to retry; no execution was started."
            return false
        }
    }

    /// Host updates always use the approved base pairing, never a selected
    /// terminal/Agent context or notification payload. Reconnect only reads status.
    public func refreshCoreUpdates(checkNow: Bool = false) async {
        guard coreActionsAvailable, !suspended, !coreUpdateBusy, let client = catalogClient else { return }
        coreUpdateBusy = true; defer { coreUpdateBusy = false }
        do {
            let result = try await client.request(checkNow ? "updates.check" : "updates.status")
            guard catalogClient === client, !suspended else { return }
            coreUpdateSnapshot = result
            if let pending = state.pendingUpdate, pending.hostID == client.hostID, pending.grantID == client.grantID,
               result["job"]["requestId"].string == pending.requestID {
                state.pendingUpdate = nil; try save()
            }
            switch result["job"]["state"].string {
            case "queued", "installing": coreUpdateStatus = "Updating CLI and Core. The host will reconnect."
            case "failed": coreUpdateStatus = "Update failed. Check the host before retrying."
            case "uncertain": coreUpdateStatus = "Update interrupted. Check the host before retrying."
            default:
                coreUpdateStatus = result["available"].bool == true ? "A new BZZY version is available." : result["phase"].string == "ready" ? "CLI and Core are up to date." : result["blocked"].string ?? "Check GitHub for updates."
            }
        } catch {
            coreUpdateStatus = (error as? CoreApplicationError)?.code == "FORBIDDEN" ? "Host updates require your fully approved phone pairing." : "Update status unavailable. Reconnect to Core and retry."
        }
    }

    public func configureCoreUpdates(_ preferences: [String: CoreJSONValue]) async {
        guard coreActionsAvailable, !suspended, !coreUpdateBusy, let client = catalogClient else { return }
        coreUpdateBusy = true; defer { coreUpdateBusy = false }
        do {
            let result = try await client.request("updates.configure", params: preferences)
            guard catalogClient === client, !suspended else { return }
            coreUpdateSnapshot = result; coreUpdateStatus = "Update preferences saved on Core."
        } catch { coreUpdateStatus = "Update preferences were not confirmed. Refresh before retrying." }
    }

    public func installCoreUpdate(expectedTarget: String? = nil) async {
        guard coreActionsAvailable, !suspended, !coreUpdateBusy, let client = catalogClient else { return }
        coreUpdateBusy = true; defer { coreUpdateBusy = false }
        do {
            let pending: PendingCoreUpdate
            if let saved = state.pendingUpdate {
                guard saved.hostID == client.hostID, saved.grantID == client.grantID else { throw CoreApplicationError("FORBIDDEN") }
                pending = saved
            } else {
                guard coreUpdateSnapshot?["canInstall"].bool == true, let target = coreUpdateSnapshot?["target"].string, expectedTarget == nil || expectedTarget == target else {
                    coreUpdateStatus = "The available version changed. Review it before updating."; return
                }
                pending = PendingCoreUpdate(hostID: client.hostID, grantID: client.grantID, requestID: CoreRelayClient.commandID(), target: target)
                state.pendingUpdate = pending; try save()
            }
            _ = try await client.request("updates.install", params: ["target": .string(pending.target)], id: pending.requestID)
            guard catalogClient === client else { return }
            state.pendingUpdate = nil; try save()
            coreUpdateStatus = "Update accepted. CLI and Core will restart; saved goals remain paused."
        } catch {
            if let code = (error as? CoreApplicationError)?.code, ["FORBIDDEN", "INVALID_REQUEST", "CONFLICT"].contains(code) {
                state.pendingUpdate = nil; try? save(); coreUpdateStatus = "Update rejected. Refresh the version and permissions before retrying."
            } else { coreUpdateStatus = "Update acceptance is uncertain. Refresh status or explicitly retry the same request." }
        }
    }

    /// Registers only this paired device and locally approved notification
    /// scope. Token contents never enter durable client history or event streams.
    public func synchronizeCoreNotifications(token: String?, environment: String?, enabled: Bool) async -> String {
        guard coreActionsAvailable, coreCatalogReady, !suspended, let client = catalogClient else { return "Waiting for authorized Core connection" }
        guard !pushRegistrationBusy else { return pushRegistrationStatus }
        pushRegistrationBusy = true; defer { pushRegistrationBusy = false }
        do {
            if !enabled {
                _ = try await client.request("notifications.update", params: ["enabled": .bool(false)])
                guard coreActionsAvailable, catalogClient === client else { return "Waiting for authorized Core connection" }
                pushRegistrationHash = nil; pushRegistrationStatus = "Host activity alerts disabled"
                return pushRegistrationStatus
            }
            guard let token, let environment else { return "Device push registration unavailable; check app signing and notification permission" }
            let scope = coreCatalogAvailable || coreAgentsAvailable ? "authorized" : "session"
            let bytes = try JSONEncoder().encode([client.hostID, client.grantID, client.resource, token, environment, scope])
            let fingerprint = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            if pushRegistrationHash == fingerprint { return pushRegistrationStatus }
            let result = try await client.request("notifications.register", params: ["deviceToken": .string(token), "environment": .string(environment), "enabled": .bool(true), "scope": .string(scope)])
            guard coreActionsAvailable, catalogClient === client else { return "Waiting for authorized Core connection" }
            pushRegistrationHash = fingerprint
            pushRegistrationStatus = result["providerConfigured"].bool == true ? "Host push configured · Delivery requires Apple connectivity" : "Device registered · Configure APNs on the source Core"
            return pushRegistrationStatus
        } catch { return "Host push registration unavailable; retry after reconnecting" }
    }

    /// Push resource values are navigation hints. Re-read the authorized catalog
    /// before attaching and never claim input or execute from a notification.
    public func reconcileNotificationResource(_ resource: String, sessionID: String? = nil, agentID: String? = nil) async {
        guard coreActionsAvailable else { return }
        if let agentID {
            guard coreAgentsAvailable, let catalog = catalogClient else { return }
            do {
                try await loadCoreAgents(using: catalog)
                guard catalogClient === catalog,
                      resource == catalog.resource || agentEntries.contains(where: { $0["existingResource"].string == resource }),
                      agentEntries.contains(where: { $0["id"].string == agentID && $0["sessionId"].string == sessionID }) else { return }
                _ = await openCoreAgent(agentID)
            } catch { }
            return
        }
        if resource == coreResource, sessionID == nil || sessionID == coreSessionID { await refreshCore(); return }
        guard coreCatalogAvailable, let catalog = catalogClient else { return }
        do {
            try await loadCoreSessions(using: catalog)
            guard catalogClient === catalog,
                  resource == catalog.resource || catalogEntries.contains(where: { $0["existingResource"].string == resource }),
                  let entry = catalogEntries.first(where: {
                      if let sessionID { return $0["id"].string == sessionID }
                      return $0["existingResource"].string == resource
                  }), let authorizedID = entry["id"].string else { return }
            _ = await openCoreSession(authorizedID)
        } catch { /* Navigation cannot widen access or start work. */ }
    }

    public func recentCoreShare(sessionID: String) -> CoreShareReference? {
        guard coreActionsAvailable, sessionID == coreSessionID, coreSharingAllowed else { return nil }
        guard let reference = recentCoreShares[coreResource], reference.expiresAt == nil || reference.expiresAt! > Date() else { return nil }
        return reference
    }

    /// Source-only portable sharing. The host derives the project path from the
    /// active session; iOS never supplies a path, archive or account binding.
    public func requestCoreShare(_ op: String, fields: [String: String] = [:], sessionID: String, requestID: String) async throws -> CoreJSONValue {
        let allowed: [String: Set<String>] = ["share.create": [], "share.status": ["shareId"],
            "share.approve": ["shareId", "claimId", "confirmedFingerprint"], "share.revoke": ["shareId"]]
        guard allowed[op] == Set(fields.keys), coreActionsAvailable, coreSessionID == sessionID,
              coreSharingAllowed, let client = coreClient else { throw CoreApplicationError("FORBIDDEN") }
        if op == "share.create" {
            guard pendingCoreShareRequests[client.resource] == nil || pendingCoreShareRequests[client.resource] == requestID else { throw CoreApplicationError("UNCERTAIN") }
            pendingCoreShareRequests[client.resource] = requestID
        }
        let result = try await client.request(op, params: fields.mapValues(CoreJSONValue.string), id: requestID)
        guard coreActionsAvailable, coreClient === client, coreSessionID == sessionID, coreSharingAllowed else { throw CoreApplicationError("FORBIDDEN") }
        if op == "share.create", let shareID = result["shareId"].string, let expiry = result["expiresAt"].integer {
            recentCoreShares[client.resource] = CoreShareReference(shareID: shareID, expiresAt: Date(timeIntervalSince1970: Double(expiry) / 1000))
            pendingCoreShareRequests.removeValue(forKey: client.resource)
        } else if op == "share.status", let shareID = result["shareId"].string, let expiry = result["expiresAt"].integer {
            recentCoreShares[client.resource] = CoreShareReference(shareID: shareID, expiresAt: Date(timeIntervalSince1970: Double(expiry) / 1000))
            if ["complete", "revoked", "expired"].contains(result["state"].string ?? "") { recentCoreShares.removeValue(forKey: client.resource) }
        } else if op == "share.revoke" { recentCoreShares.removeValue(forKey: client.resource) }
        return result
    }

    public func pendingCoreShareRequest(sessionID: String) -> String? {
        guard coreActionsAvailable, sessionID == coreSessionID, coreSharingAllowed else { return nil }
        return pendingCoreShareRequests[coreResource]
    }

    public func checkCoreShareRequest(_ requestID: String, sessionID: String) async throws -> CoreJSONValue {
        guard coreActionsAvailable, coreSessionID == sessionID, coreSharingAllowed, let client = coreClient else { throw CoreApplicationError("FORBIDDEN") }
        let result = try await client.request("command.status", params: ["requestId": .string(requestID)])
        guard coreActionsAvailable, coreClient === client, coreSessionID == sessionID, coreSharingAllowed else { throw CoreApplicationError("FORBIDDEN") }
        if result["state"].string == "accepted", let shareID = result["acceptance"]["shareId"].string {
            recentCoreShares[client.resource] = CoreShareReference(shareID: shareID, expiresAt: nil)
            pendingCoreShareRequests.removeValue(forKey: client.resource)
        } else if result["state"].string == "rejected" { pendingCoreShareRequests.removeValue(forKey: client.resource) }
        return result
    }

    private func loadCoreAgents(using catalog: CoreRelayClient) async throws {
        let status = try await catalog.request("agents.status")
        guard catalogClient === catalog, !suspended else { return }
        coreAgentsConfigured = status["configured"].bool == true
        onCoreAgentStatus?(try JSONEncoder().encode(status))
        var entries: [CoreJSONValue] = [], cursor: String?
        repeat {
            var params: [String: CoreJSONValue] = ["limit": .number(25)]
            if let cursor { params["after"] = .string(cursor) }
            let page = try await catalog.request("agents.list", params: params)
            guard catalogClient === catalog, !suspended else { return }
            entries += page["agents"].array ?? []
            guard entries.count <= 200 else { throw CoreApplicationError("CAPACITY") }
            cursor = page["hasMore"].bool == true ? page["nextCursor"].string : nil
        } while cursor != nil
        agentEntries = entries; coreAgentStatus = ""
        onCoreAgents?(try JSONEncoder().encode(entries))
    }

    public func refreshCoreAgents() async {
        guard coreActionsAvailable, coreAgentsAvailable, coreCatalogReady, let catalog = catalogClient else { return }
        do { try await loadCoreAgents(using: catalog); await reconcileCoreAgentCommand() }
        catch { if catalogClient === catalog { coreAgentStatus = "Agent list could not be refreshed." } }
    }

    public func readCoreAgent(_ op: String, fields: [String: String] = [:]) async throws -> CoreJSONValue {
        let allowed: [String: Set<String>] = ["agents.status": [], "agents.providers": [], "agents.models": ["provider"], "agents.get": ["agentId"]]
        guard allowed[op] == Set(fields.keys), coreActionsAvailable, coreAgentsAvailable, coreCatalogReady,
              let catalog = catalogClient else { throw CoreApplicationError("FORBIDDEN") }
        let result = try await catalog.request(op, params: fields.mapValues(CoreJSONValue.string))
        guard coreActionsAvailable, catalogClient === catalog, coreAgentsAvailable else { throw CoreApplicationError("FORBIDDEN") }
        return result
    }

    public func readCoreAgentModels(_ provider: String, after: String? = nil) async throws -> CoreJSONValue {
        guard coreActionsAvailable, coreAgentsAvailable, coreCatalogReady, let catalog = catalogClient else { throw CoreApplicationError("FORBIDDEN") }
        var params: [String: CoreJSONValue] = ["provider": .string(provider), "limit": .number(25)]
        if let after { params["after"] = .string(after) }
        let result = try await catalog.request("agents.models", params: params)
        guard coreActionsAvailable, catalogClient === catalog, coreAgentsAvailable else { throw CoreApplicationError("FORBIDDEN") }
        return result
    }

    /// Only opaque job/request metadata is persisted. The code, QR and private
    /// bundle never enter iPhone storage or command receipts.
    public func beginCoreAgentImport(code: String, sourceFingerprint: String, provider: String, model: String, effort: String, name: String? = nil) async throws {
        guard coreActionsAvailable, coreAgentsAvailable, coreCatalogReady, coreAgentsConfigured,
              let catalog = catalogClient, state.agentImport == nil else { throw CoreApplicationError("FORBIDDEN") }
        let reference = AgentImportReference(hostID: catalog.hostID, grantID: catalog.grantID, sourceFingerprint: sourceFingerprint, requestID: CoreRelayClient.commandID())
        var params: [String: CoreJSONValue] = ["code": .string(code), "expectedSenderFingerprint": .string(sourceFingerprint),
            "provider": .string(provider), "model": .string(model), "effort": .string(effort)]
        if let name, !name.isEmpty { params["name"] = .string(name) }
        // Validate before saving the safe receipt or sending anything.
        _ = try CoreApplicationProtocol.request(op: "agents.import", params: params, id: reference.requestID, resource: catalog.resource)
        state.agentImport = reference; agentImportRevision = UUID()
        do { try save() } catch { state.agentImport = nil; throw error }
        do {
            let result = try await catalog.request("agents.import", params: params, id: reference.requestID)
            guard coreActionsAvailable, catalogClient === catalog, state.agentImport?.requestID == reference.requestID else { throw CoreApplicationError("UNCERTAIN") }
            state.agentImport?.importID = result["importId"].string
            try save()
        } catch {
            if catalogClient === catalog, state.agentImport?.requestID == reference.requestID,
               let code = (error as? CoreApplicationError)?.code,
               ["INVALID_REQUEST", "FORBIDDEN", "OPERATION_DENIED", "CAPACITY", "WORKSPACE_SETUP_REQUIRED", "WORKSPACE_CHANGED", "WORKSPACE_UNAVAILABLE", "PROVIDER_UNAVAILABLE", "CONFIRMATION_REQUIRED", "IMPORT_INVALID"].contains(code) {
                state.agentImport = nil; agentImportRevision = UUID(); try? save()
            }
            throw error
        }
    }

    public func refreshCoreAgentImport() async throws -> CoreJSONValue {
        guard coreActionsAvailable, coreAgentsAvailable, coreCatalogReady, let catalog = catalogClient,
              var reference = state.agentImport, reference.hostID == catalog.hostID,
              reference.grantID == catalog.grantID else { throw CoreApplicationError("FORBIDDEN") }
        if reference.importID == nil {
            let status = try await catalog.request("command.status", params: ["requestId": .string(reference.requestID)])
            guard coreActionsAvailable, catalogClient === catalog, state.agentImport?.requestID == reference.requestID else { throw CoreApplicationError("FORBIDDEN") }
            if status["state"].string == "rejected" { state.agentImport = nil; agentImportRevision = UUID(); try save(); throw CoreApplicationError("IMPORT_INVALID") }
            guard status["state"].string == "accepted", let id = status["acceptance"]["importId"].string,
                  UUID(uuidString: id) != nil else { throw CoreApplicationError("UNCERTAIN") }
            reference.importID = id; state.agentImport = reference; try save()
        }
        guard let id = reference.importID else { throw CoreApplicationError("UNCERTAIN") }
        let result: CoreJSONValue
        do { result = try await catalog.request("agents.import.status", params: ["importId": .string(id)]) }
        catch {
            guard (error as? CoreApplicationError)?.code == "UNCERTAIN", coreActionsAvailable,
                  catalogClient === catalog, state.agentImport?.requestID == reference.requestID else { throw error }
            // A completed Core record is authoritative even if the ephemeral
            // transfer helper was lost on restart. Never receive the code again.
            try await loadCoreAgents(using: catalog)
            guard coreActionsAvailable, catalogClient === catalog, state.agentImport?.requestID == reference.requestID,
                  let agentID = agentEntries.first(where: { $0["importId"].string == id })?["id"].string else { throw error }
            let recovered = try await catalog.request("agents.get", params: ["agentId": .string(agentID)])
            guard coreActionsAvailable, catalogClient === catalog, state.agentImport?.requestID == reference.requestID,
                  recovered["agent"]["importId"].string == id else { throw CoreApplicationError("FORBIDDEN") }
            coreAgentImportRecoveredAgent = recovered["agent"]
            return recovered
        }
        guard coreActionsAvailable, catalogClient === catalog, state.agentImport?.requestID == reference.requestID,
              result["sourceFingerprint"].string == reference.sourceFingerprint else { throw CoreApplicationError("FORBIDDEN") }
        coreAgentImportSnapshot = result
        if result["state"].string == "complete" { await refreshCoreAgents() }
        return result
    }

    public func cancelCoreAgentImport() async throws {
        guard coreActionsAvailable, coreAgentsAvailable, coreCatalogReady, let catalog = catalogClient, let reference = state.agentImport,
              reference.hostID == catalog.hostID, reference.grantID == catalog.grantID,
              let id = reference.importID else { throw CoreApplicationError("UNCERTAIN") }
        _ = try await catalog.request("agents.import.cancel", params: ["importId": .string(id)])
        guard coreActionsAvailable, catalogClient === catalog, state.agentImport?.requestID == reference.requestID else { throw CoreApplicationError("UNCERTAIN") }
        _ = try await refreshCoreAgentImport()
    }

    public func finishCoreAgentImport() {
        guard ["complete", "cancelled", "failed"].contains(coreAgentImportSnapshot?["state"].string ?? "") ||
                coreAgentImportRecoveredAgent?["importId"].string == state.agentImport?.importID && state.agentImport?.importID != nil else { return }
        let previous = state.agentImport
        state.agentImport = nil; agentImportRevision = UUID()
        do { try save(); coreAgentImportSnapshot = nil; coreAgentImportRecoveredAgent = nil }
        catch { state.agentImport = previous }
    }

    public func mutateCoreAgent(_ op: String, params: [String: CoreJSONValue]) async -> Bool {
        guard ["agents.create", "agents.update", "agents.archive"].contains(op), coreActionsAvailable, coreAgentsAvailable,
              coreCatalogReady, !coreBusy, !coreCommandUncertain, state.pendingAgentCommand == nil,
              let catalog = catalogClient else { return false }
        coreBusy = true; coreAgentStatus = ""
        defer { coreBusy = false }
        let pending = PendingCoreCommand(hostID: catalog.hostID, resource: catalog.resource, id: CoreRelayClient.commandID(), op: op, params: params)
        state.pendingAgentCommand = pending
        do { try save() }
        catch { state.pendingAgentCommand = nil; coreAgentStatus = "Agent changes could not be saved securely; nothing was sent."; return false }
        return await dispatchCoreAgentCommand(pending, catalog: catalog)
    }

    private func dispatchCoreAgentCommand(_ pending: PendingCoreCommand, catalog: CoreRelayClient) async -> Bool {
        guard coreActionsAvailable, catalogClient === catalog else { return false }
        do {
            _ = try await catalog.request(pending.op, params: pending.params, id: pending.id)
            guard coreActionsAvailable, catalogClient === catalog, state.pendingAgentCommand?.id == pending.id,
                  state.host?.certificate.id == pending.hostID, catalog.resource == pending.resource else { return false }
            try clearSavedCoreAgentCommand(expectedID: pending.id)
            if pending.op == "agents.archive", pending.params["agentId"]?.string == state.selectedSession?.agentID { removeSelectedCoreContext() }
            coreCommandUncertain = state.pendingCoreCommand != nil; coreAgentStatus = "Agent saved on Core"
            try? await loadCoreAgents(using: catalog)
            return true
        } catch {
            guard catalogClient === catalog, state.pendingAgentCommand?.id == pending.id else { return false }
            coreCommandUncertain = true; coreAgentStatus = "Agent request is uncertain. Check saved status before retrying."
            return await reconcileCoreAgentCommand()
        }
    }

    private func clearSavedCoreAgentCommand(expectedID: String) throws {
        guard state.pendingAgentCommand?.id == expectedID else { throw CoreApplicationError("CONFLICT") }
        let previous = state.pendingAgentCommand; state.pendingAgentCommand = nil
        do { try save() } catch { state.pendingAgentCommand = previous; throw error }
    }

    @discardableResult public func reconcileCoreAgentCommand() async -> Bool {
        guard coreActionsAvailable, let pending = state.pendingAgentCommand, let catalog = catalogClient,
              pending.hostID == catalog.hostID, pending.resource == catalog.resource else { return false }
        do {
            let result = try await catalog.request("command.status", params: ["requestId": .string(pending.id)])
            guard catalogClient === catalog, state.pendingAgentCommand?.id == pending.id else { return false }
            if result["state"].string == "accepted" {
                try clearSavedCoreAgentCommand(expectedID: pending.id)
                if pending.op == "agents.archive", pending.params["agentId"]?.string == state.selectedSession?.agentID { removeSelectedCoreContext() }
                coreCommandUncertain = state.pendingCoreCommand != nil; coreAgentStatus = "Agent saved on Core"
                try? await loadCoreAgents(using: catalog)
                return true
            } else if result["state"].string == "rejected" {
                try clearSavedCoreAgentCommand(expectedID: pending.id)
                coreCommandUncertain = state.pendingCoreCommand != nil; coreAgentStatus = "Agent request rejected. Reload before editing."
            } else { coreCommandUncertain = true; coreAgentStatus = "Agent request \(result["state"].string ?? "uncertain"). No automatic retry." }
        } catch { if catalogClient === catalog { coreCommandUncertain = true; coreAgentStatus = "Saved agent request status unavailable." } }
        return false
    }

    public func retryCoreAgentCommand() async {
        guard coreActionsAvailable, !coreBusy, coreAgentsAvailable, coreCatalogReady, let pending = state.pendingAgentCommand,
              let catalog = catalogClient else { return }
        coreBusy = true; defer { coreBusy = false }
        _ = await dispatchCoreAgentCommand(pending, catalog: catalog)
    }

    public func openCoreAgent(_ agentID: String) async -> Bool {
        guard coreActionsAvailable, !coreBusy, !coreStarting, !coreCommandUncertain, state.pendingCoreCommand == nil, state.pendingAgentCommand == nil,
              coreAgentsAvailable, coreCatalogReady, let catalog = catalogClient, let transport,
              let host = state.host, UUID(uuidString: agentID) != nil,
              let entry = agentEntries.first(where: { $0["id"].string == agentID }) else { return false }
        if coreConnected && coreIsAgent && entry["sessionId"].string == coreSessionID { return true }
        guard state.openingSession == nil else { coreAgentStatus = "Resolve or cancel the terminal attachment first."; return false }
        if let opening = state.openingAgent, opening.agentID != agentID { coreAgentStatus = "Resolve or cancel the previous agent attachment first."; return false }
        coreBusy = true; coreAgentStatus = ""
        defer { coreBusy = false }
        do {
            let opening = state.openingAgent ?? PendingAgentOpen(agentID: agentID, requestID: CoreRelayClient.commandID())
            state.openingAgent = opening; try save()
            let opened = try await catalog.request("agents.open", params: ["agentId": .string(agentID)], id: opening.requestID)
            guard coreActionsAvailable, catalogClient === catalog, state.host?.grantID == host.grantID, state.openingAgent?.requestID == opening.requestID,
                  !suspended, let resource = opened["resource"].string, let sessionID = opened["sessionId"].string,
                  opened["agentId"].string == agentID else { return false }
            if coreOwnsInput { await releaseCoreInput() }
            guard coreActionsAvailable, catalogClient === catalog, state.host?.grantID == host.grantID, !suspended else { return false }
            if let old = coreClient, let subscription = coreSubscriptionID {
                _ = try? await old.request("events.unsubscribe", params: ["subscriptionId": .string(subscription)])
                guard coreActionsAvailable, catalogClient === catalog, coreClient === old, !suspended else { return false }
            }
            stopCore(purge: false, preserveCatalog: true)
            let previous = state.selectedSession
            state.selectedSession = SelectedCoreSession(sessionID: sessionID, resource: resource, kind: "agent", agentID: agentID)
            state.openingAgent = nil; state.taskID = nil
            do { try save() } catch { state.selectedSession = previous; state.openingAgent = opening; throw error }
            let client = CoreRelayClient(transport: transport, hostID: host.certificate.id, grantID: host.grantID, resource: resource, expectedShareKind: .agent)
            coreClient = client; coreResource = resource; coreGrantID = host.grantID; coreIsAgent = true
            configureCoreCallbacks(client)
            coreHealth.begin(scope: client.resource)
            let snapshot = try await client.request("session.get")
            guard coreClient === client, state.host?.grantID == host.grantID, !suspended else { return false }
            try await bindCoreSession(client, snapshot: snapshot)
            return coreClient === client && coreConnected && coreSessionID == sessionID
        } catch {
            guard catalogClient === catalog, state.host?.grantID == host.grantID else { return false }
            coreAgentStatus = "Agent attachment was not confirmed. Select the same agent to retry; no execution was started."
            return false
        }
    }

    public func cancelCoreSessionAttachment() {
        let previous = state.openingSession, previousAgent = state.openingAgent
        state.openingSession = nil; state.openingAgent = nil
        do { try save(); coreError = nil }
        catch { state.openingSession = previous; state.openingAgent = previousAgent; coreError = "Attachment state could not be saved securely." }
    }

    private func removeSelectedCoreContext() {
        let resource = state.selectedSession?.resource ?? coreResource
        let scopes = state.coreCacheScopes ?? state.coreCacheScope.map { [$0] } ?? []
        for scope in scopes where scope.resource == resource {
            try? CoreEventProjectionStore.purge(directory: isolatedProjectionDirectory ?? Self.coreProjectionDirectory, hostID: scope.hostID, resource: scope.resource, sessionID: scope.sessionID)
        }
        state.coreCacheScopes = scopes.filter { $0.resource != resource }
        if state.coreCacheScope?.resource == resource { state.coreCacheScope = nil }
        if state.pendingCoreCommand?.resource == resource { state.pendingCoreCommand = nil }
        state.selectedSession = nil; state.taskID = nil
        stopCore(purge: false, preserveCatalog: true)
        coreProjection = nil; coreSessionID = ""; coreResource = ""
        coreCommandStatus = "Conversation access removed"; coreTaskStatus = ""
        onCoreConversationCleared?()
        try? save()
    }

    private func publishCoreEvents() {
        guard let projection = coreProjection else { return }
        onCoreEvents?(projection.events.compactMap { try? JSONEncoder().encode($0) })
    }

    private func stopCore(purge: Bool, preserveCatalog: Bool = false) {
        if purge { coreUpdateSnapshot = nil; state.pendingUpdate = nil }
        coreHealth.disconnect()
        metricsEpoch = UUID(); metricsPolling?.cancel(); metricsPolling = nil
        hostMetrics = nil; hostMetricsStatus = "Waiting for Core"
        coreAgentImportSnapshot = nil
        coreAgentImportRecoveredAgent = nil
        coreRefreshEpoch = UUID(); coreRefresh?.cancel(); coreRefresh = nil
        inputRenewalEpoch = UUID(); inputRenewal?.cancel(); inputRenewal = nil
        coreClient?.onEvents = nil; coreClient?.onSubscriptionClosed = nil
        if coreClient !== catalogClient || !preserveCatalog { coreClient?.disconnected() }
        coreClient = nil
        if !preserveCatalog { pushRegistrationHash = nil }
        if !preserveCatalog { catalogClient?.disconnected(); catalogClient = nil; coreCatalogReady = false }
        coreCommandUncertain = state.pendingCoreCommand != nil || state.pendingAgentCommand != nil
        coreConnected = false; coreOwnsInput = false; claimedOwnerID = nil
        coreSubscriptionID = nil; corePermissions = []; coreIsAssistant = false; coreSharingAllowed = false; coreIsAgent = false
        if purge {
            confirmedCorePair = false; state.corePairValidated = false
            do {
                var scopes = state.coreCacheScopes ?? []
                if let legacy = state.coreCacheScope, !scopes.contains(where: { $0.hostID == legacy.hostID && $0.resource == legacy.resource && $0.sessionID == legacy.sessionID }) { scopes.append(legacy) }
                for scope in scopes {
                    try CoreEventProjectionStore.purge(directory: isolatedProjectionDirectory ?? Self.coreProjectionDirectory, hostID: scope.hostID, resource: scope.resource, sessionID: scope.sessionID)
                }
                state.coreCacheScope = nil; state.coreCacheScopes = nil
            } catch { coreError = "Private cache could not be removed. Remove app data on this device." }
            coreProjection = nil
            state.pendingCoreCommand = nil; state.taskID = nil
            state.selectedSession = nil; state.openingSession = nil; state.openingAgent = nil; state.pendingAgentCommand = nil
            state.agentImport = nil; agentImportRevision = UUID()
            agentEntries = []; coreAgentsAvailable = false; coreAgentsConfigured = false; coreAgentStatus = ""
            onCoreAgents?(Data("[]".utf8))
            catalogEntries = []; coreCatalogAvailable = false; recentCoreShares = [:]; pendingCoreShareRequests = [:]
            onCoreSessions?(Data("[]".utf8))
            coreSessionID = ""; coreResource = ""; coreGrantID = ""
            coreCommandStatus = ""; coreCommandUncertain = false; coreTaskStatus = ""
            onCoreCleared?()
            do { try save() }
            catch { coreError = "Access was removed, but local authorization changes could not be saved securely." }
        }
        onCoreAvailability?(false, purge ? "Access removed" : "Disconnected; host work continues")
    }

    private func scheduleCoreRefresh() {
        guard coreRefresh == nil else { return }
        let epoch = UUID(); coreRefreshEpoch = epoch
        coreRefresh = Task { [weak self] in
            defer { if self?.coreRefreshEpoch == epoch { self?.coreRefresh = nil } }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(12)) } catch { return }
                guard let self, self.coreRefreshEpoch == epoch, self.coreConnected, !self.suspended else { return }
                await self.refreshCore()
            }
        }
    }

    private func stopCoreMonitor() {
        coreMonitorEpoch = UUID(); coreMonitor?.cancel(); coreMonitor = nil
    }

    private func scheduleCoreMonitor() {
        guard coreMonitor == nil, let transport, state.host != nil, !suspended else { return }
        let epoch = UUID(); coreMonitorEpoch = epoch
        coreMonitor = Task { [weak self] in
            defer { if self?.coreMonitorEpoch == epoch { self?.coreMonitor = nil } }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                guard let self, self.coreMonitorEpoch == epoch, self.transport === transport,
                      transport.online, self.state.host != nil, !self.suspended else { return }
                if self.coreConnected && !self.coreStarting && !self.coreBusy && !self.coreHealth.isOnline() {
                    self.stopCore(purge: false)
                    self.coreError = "Core did not confirm its online state. Start Core on your host and reconnect."
                }
                if !self.coreConnected && !self.coreStarting && !self.coreBusy { await self.reconcile() }
            }
        }
    }

    private func scheduleHostMetrics() {
        guard metricsPolling == nil, let client = coreClient, corePairAuthorized,
              coreConnected, corePermissions.contains("observe"), !suspended else { return }
        let epoch = UUID(); metricsEpoch = epoch
        metricsPolling = Task { [weak self] in
            defer { if self?.metricsEpoch == epoch { self?.metricsPolling = nil } }
            while !Task.isCancelled {
                guard let self, self.metricsEpoch == epoch, self.coreClient === client,
                      self.corePairAuthorized, self.coreConnected, !self.suspended else { return }
                do {
                    let generation = self.coreHealth.generation
                    let result = try await client.request("host.metrics", readTimeoutNanoseconds: 4_000_000_000)
                    guard self.metricsEpoch == epoch, self.coreClient === client,
                          self.corePairAuthorized, self.coreConnected, !self.suspended else { return }
                    let metrics = try CoreHostMetrics(result)
                    if self.coreHealth.confirm(generation, scope: client.resource) {
                        self.hostMetrics = metrics
                        self.hostMetricsStatus = "Core host"
                    }
                } catch {
                    guard self.metricsEpoch == epoch, self.coreClient === client, !self.suspended else { return }
                    self.hostMetrics = nil; self.hostMetricsStatus = "Host metrics unavailable"
                    let code = (error as? CoreApplicationError)?.code ?? ""
                    if !["CORE_STOPPED", "FORBIDDEN", "GRANT_UNAVAILABLE"].contains(code) {
                        // Telemetry can fail while this authorized session is
                        // healthy. Only a fresh scoped Core response may keep
                        // actions available when metrics cannot prove readiness.
                        do {
                            let generation = self.coreHealth.generation
                            let snapshot = try await client.request("session.get", readTimeoutNanoseconds: 4_000_000_000)
                            guard self.metricsEpoch == epoch, self.coreClient === client, !self.suspended,
                                  snapshot["session"]["id"].string == self.coreSessionID else { return }
                            self.coreHealth.confirm(generation, scope: client.resource)
                        } catch {
                            guard self.metricsEpoch == epoch, self.coreClient === client else { return }
                            self.stopCore(purge: false)
                            self.coreError = "Core did not confirm its online state. Start Core on your host and reconnect."
                            return
                        }
                    } else {
                        self.stopCore(purge: false)
                        self.coreError = "Core is offline or stopped. Start Core on your host and reconnect."
                        return
                    }
                }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
    }

    public func refreshCore() async {
        guard coreConnected, let client = coreClient else { return }
        let generation = coreHealth.generation
        do {
            let snapshot = try await client.request("session.get")
            guard coreClient === client else { return }
            guard snapshot["session"]["id"].string == coreSessionID else { throw RelayFailure("INVALID_MESSAGE") }
            guard coreHealth.confirm(generation, scope: client.resource) else { return }
            coreSharingAllowed = snapshot["capabilities"]["shareAccess"].bool == true && (!coreIsAgent || coreAgentsAvailable)
            corePermissions.formIntersection(Set(snapshot["capabilities"]["permissions"].array?.compactMap(\.string) ?? []))
            onCoreSnapshot?(try JSONEncoder().encode(snapshot))
            if let claimedOwnerID, snapshot["inputOwner"]["owner"].string != claimedOwnerID {
                coreOwnsInput = false; self.claimedOwnerID = nil; inputRenewal?.cancel(); inputRenewal = nil
            }
            await reconcileCoreCommand()
            guard coreClient === client else { return }
            if let taskID = state.taskID, coreIsAssistant {
                let task = try await client.request("task.get", params: ["taskId": .string(taskID)])
                guard coreClient === client, state.taskID == taskID else { return }
                coreTaskStatus = "Task \(task["state"].string ?? "unknown") · Verification \(task["verification"].string ?? "not-assessed")"
            }
        } catch {
            guard coreClient === client else { return }
            let code = (error as? CoreApplicationError)?.code
            if (code == "FORBIDDEN" || code == "GRANT_UNAVAILABLE"), client !== catalogClient { removeSelectedCoreContext() }
            else { stopCore(purge: code == "FORBIDDEN" || code == "GRANT_UNAVAILABLE") }
            coreError = "Core refresh unavailable. Last observed state may be stale."
        }
    }

    /// Observation never claims input. Call after an explicit send/control/takeover action.
    public func claimCoreInput(takeover: Bool = false) async -> Bool {
        guard coreActionsAvailable, corePermissions.contains("claim"), !takeover || corePermissions.contains("takeover"),
              let client = coreClient, let projection = coreProjection else { return false }
        do {
            let lease = try await client.request("input.claim", params: ["owner": .string(projection.ownerID), "takeover": .bool(takeover)])
            guard coreActionsAvailable, coreClient === client, coreProjection === projection,
                  state.host?.certificate.id == client.hostID, coreResource == client.resource, !suspended else { return false }
            claimedOwnerID = lease["owner"].string
            coreOwnsInput = claimedOwnerID != nil
            coreError = nil
            scheduleInputRenewal()
            return coreOwnsInput
        } catch {
            guard coreClient === client else { return false }
            coreOwnsInput = false; claimedOwnerID = nil
            coreError = "Input is unavailable or owned by another client. Explicit takeover requires host permission."
            return false
        }
    }

    public func releaseCoreInput() async {
        inputRenewal?.cancel(); inputRenewal = nil
        guard coreActionsAvailable else { coreOwnsInput = false; claimedOwnerID = nil; return }
        guard let client = coreClient, let projection = coreProjection else { return }
        defer { if coreClient === client { coreOwnsInput = false; claimedOwnerID = nil } }
        do { _ = try await client.request("input.release", params: ["owner": .string(projection.ownerID)]) }
        catch { if coreClient === client { coreError = "Release was not confirmed. The input lease expires automatically." } }
    }

    private func scheduleInputRenewal() {
        guard inputRenewal == nil else { return }
        let epoch = UUID(); inputRenewalEpoch = epoch
        inputRenewal = Task { [weak self] in
            defer { if self?.inputRenewalEpoch == epoch { self?.inputRenewal = nil } }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                guard let self, self.inputRenewalEpoch == epoch, self.coreConnected, self.coreOwnsInput, !self.suspended else { return }
                guard await self.claimCoreInput() else { return }
            }
        }
    }

    @discardableResult public func sendCoreMessage(_ text: String, sessionID: String? = nil) async -> Bool {
        guard sessionID == nil || sessionID == coreSessionID else { return false }
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf8.count <= 16 * 1024, corePermissions.contains("execute") else { return false }
        return await mutateCore(coreIsAssistant ? "task.submit" : "execution.execute",
            params: [coreIsAssistant ? "instruction" : "prompt": .string(text)])
    }

    @discardableResult public func answerCoreQuestion(_ id: String, answer: String, sessionID: String? = nil) async -> Bool {
        guard sessionID == nil || sessionID == coreSessionID else { return false }
        guard corePermissions.contains("answer"), UUID(uuidString: id) != nil, answer.utf8.count <= 16 * 1024 else { return false }
        return await mutateCore("question.answer", params: ["questionId": .string(id), "answer": .string(answer)])
    }

    @discardableResult public func controlCore(_ action: String, text: String? = nil, sessionID: String? = nil) async -> Bool {
        guard sessionID == nil || sessionID == coreSessionID else { return false }
        guard ["pause", "cancel", "steer"].contains(action), corePermissions.contains(action) else { return false }
        var params: [String: CoreJSONValue] = ["action": .string(action)]
        if let text { params["text"] = .string(text) }
        return await mutateCore("control.request", params: params)
    }

    @discardableResult public func resumeCoreGoal(sessionID: String? = nil) async -> Bool {
        guard sessionID == nil || sessionID == coreSessionID else { return false }
        guard corePermissions.contains("execute") else { return false }
        return await mutateCore("execution.execute", params: ["prompt": .string("Continue the existing goal."), "goal": .bool(true), "resumeGoal": .bool(true)])
    }

    private func mutateCore(_ op: String, params: [String: CoreJSONValue]) async -> Bool {
        guard !coreBusy, coreActionsAvailable, !coreCommandUncertain, state.pendingCoreCommand == nil,
              let client = coreClient, let projection = coreProjection, let hostID = state.host?.certificate.id else { return false }
        let resource = coreResource
        coreBusy = true; coreError = nil; lastCommandAccepted = false
        defer { coreBusy = false }
        if !coreOwnsInput, !(await claimCoreInput()) { return false }
        guard coreClient === client, coreProjection === projection, state.host?.certificate.id == hostID,
              coreResource == resource, coreActionsAvailable, !suspended else { return false }
        var params = params; params["owner"] = .string(projection.ownerID)
        let pending = PendingCoreCommand(hostID: hostID, resource: resource,
            id: CoreRelayClient.commandID(), op: op, params: params)
        do {
            state.pendingCoreCommand = pending
            try save() // Persist exact request identity and parameters before any dispatch.
        } catch {
            state.pendingCoreCommand = nil; coreError = "Command could not be saved securely; nothing was sent."; return false
        }
        return await dispatchCore(pending)
    }

    private func dispatchCore(_ pending: PendingCoreCommand) async -> Bool {
        guard coreActionsAvailable, let client = coreClient, state.host?.certificate.id == pending.hostID, coreResource == pending.resource else { return false }
        do {
            let receipt = try await client.request(pending.op, params: pending.params, id: pending.id)
            guard coreActionsAvailable, coreClient === client, state.pendingCoreCommand?.id == pending.id,
                  state.host?.certificate.id == pending.hostID, coreResource == pending.resource else { return false }
            guard receipt["state"].string == "accepted" else { throw RelayFailure("UNCERTAIN") }
            if let taskID = receipt["taskId"].string { state.taskID = taskID }
            try clearSavedCoreCommand(expectedID: pending.id)
            coreCommandUncertain = false; lastCommandAccepted = true; coreCommandStatus = "Accepted by Core; awaiting outcome"
            await refreshCore()
            return true
        } catch {
            guard coreClient === client, state.pendingCoreCommand?.id == pending.id else { return false }
            coreCommandUncertain = true
            coreCommandStatus = "Command status uncertain. Reconcile before sending more."
            await reconcileCoreCommand()
            return lastCommandAccepted
        }
    }

    private func clearSavedCoreCommand(expectedID: String) throws {
        guard state.pendingCoreCommand?.id == expectedID else { throw CoreApplicationError("CONFLICT") }
        let previous = state.pendingCoreCommand
        state.pendingCoreCommand = nil
        do { try save() }
        catch { state.pendingCoreCommand = previous; throw error }
    }

    public func reconcileCoreCommand() async {
        guard coreActionsAvailable, let pending = state.pendingCoreCommand, let client = coreClient,
              pending.hostID == state.host?.certificate.id, pending.resource == coreResource else { return }
        coreCommandUncertain = true
        do {
            let result = try await client.request("command.status", params: ["requestId": .string(pending.id)])
            guard coreActionsAvailable, coreClient === client, state.pendingCoreCommand?.id == pending.id,
                  state.host?.certificate.id == pending.hostID, coreResource == pending.resource else { return }
            switch result["state"].string {
            case "accepted":
                if let taskID = result["acceptance"]["taskId"].string { state.taskID = taskID }
                try clearSavedCoreCommand(expectedID: pending.id)
                coreCommandUncertain = false; lastCommandAccepted = true; coreCommandStatus = "Accepted by Core; awaiting outcome"
            case "rejected":
                try clearSavedCoreCommand(expectedID: pending.id)
                coreCommandUncertain = false; coreCommandStatus = "Rejected by Core"
            default:
                coreCommandStatus = "Command \(result["state"].string ?? "uncertain"). No automatic retry."
            }
        } catch {
            guard coreClient === client, state.pendingCoreCommand?.id == pending.id else { return }
            coreCommandStatus = "Command status uncertain. No automatic retry."
        }
    }

    /// Explicit user retry only; retains the saved ID and identical original parameters.
    public func retryCoreCommand() async {
        guard !coreBusy, coreActionsAvailable, let pending = state.pendingCoreCommand, let client = coreClient else { return }
        coreBusy = true; defer { coreBusy = false }
        if !coreOwnsInput, !(await claimCoreInput()) { return }
        guard coreActionsAvailable, coreClient === client, state.pendingCoreCommand?.id == pending.id,
              coreResource == pending.resource, state.host?.certificate.id == pending.hostID else { return }
        _ = await dispatchCore(pending)
    }

    private func save() throws {
        guard networkingEnabled else { return }
        try saveAuthorization(JSONEncoder().encode(state))
    }

    private func schedulePolling() {
        guard polling == nil, state.pending != nil, !suspended else { return }
        let epoch = UUID(); pollingEpoch = epoch
        polling = Task { [weak self] in
            defer { if self?.pollingEpoch == epoch { self?.polling = nil } }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                guard let self, self.pollingEpoch == epoch, self.state.pending != nil, self.transport?.online == true, !self.suspended else { return }
                await self.pollDecision()
            }
        }
    }

    private func failed(_ error: RelayFailure) {
        stopCoreMonitor()
        if suspended { status = .offline; return }
        stopCore(purge: ["AUTH_FAILED", "DEVICE_REVOKED", "IDENTITY_CHANGED"].contains(error.code))
        status = .failed
        hasHost = false
        hostStatus = state.host == nil ? "Not paired" : "Host unavailable"
        errorMessage = error.localizedDescription
        let fatal = ["AUTH_FAILED", "DEVICE_REVOKED", "TLS_FAILED", "INVALID_CHALLENGE", "INVALID_IDENTITY",
                     "KEYCHAIN_UNAVAILABLE", "INVALID_SERVER_MESSAGE", "IDENTITY_CHANGED"].contains(error.code)
        fatalAuthorizationLoss = fatal
        guard networkingEnabled, !suspended, !fatal else { return }
        reconnect?.cancel()
        let delay = min(30.0, min(30, 0.5 * pow(2, Double(min(attempts, 6)))) * Double.random(in: 0.75...1.25))
        attempts += 1
        reconnect = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self, !self.suspended else { return }
            await self.connect()
        }
    }
}

public enum RelayDiagnostics {
    public static func failureCode(_ error: Error) -> String { (error as? RelayFailure)?.code ?? "DIAGNOSTIC_FAILED" }
    /// Exercises device-only storage using an isolated disposable record, never the app identity.
    @MainActor public static func checkDeviceStorage() throws {
        let account = "diagnostic-" + UUID().uuidString
        defer { RelayKeychain.removeDiagnostic(account) }
        let identity = try RelayIdentity.generate()
        try RelayKeychain.write(JSONEncoder().encode(identity), account: account, replacing: false)
        guard let stored = try RelayKeychain.read(account) else { throw RelayFailure("KEYCHAIN_UNAVAILABLE") }
        let restored = try JSONDecoder().decode(RelayIdentity.self, from: stored)
        try restored.validate()
        guard restored.certificate == identity.certificate else { throw RelayFailure("INVALID_IDENTITY") }
    }

    /// Uses a disposable in-memory identity. Never provisions a host or claims an invitation.
    @MainActor public static func checkPublicEndpoint() async throws -> String {
        let client = RelayTransport(identity: try RelayIdentity.generate())
        defer { client.disconnect() }
        let role = try await client.connect()
        let list = try await client.request("grant.list")
        guard role == "candidate", list["grants"].array?.isEmpty == true else { throw RelayFailure("INVALID_MESSAGE") }
        return "Trusted TLS, WebSocket subprotocol, signed challenge, candidate authentication, and empty scoped grants verified."
    }

    /// Explicit operator diagnostic for a disposable, approved observer. Never
    /// reads the app Keychain identity, caches history, claims input or executes.
    @MainActor public static func observeCore(code: String, expectedHost: String, expectedSession: String,
        progress: (CoreJSONValue) -> Void) async throws -> CoreJSONValue {
        guard code.hasPrefix("BZZY-PAIR-"), (try? RelayWire.decoded(String(code.dropFirst(10)), count: 32)) != nil,
              (try? RelayWire.decoded(expectedHost, count: 32)) != nil, UUID(uuidString: expectedSession) != nil else { throw CoreApplicationError("INVALID_REQUEST") }
        let identity = try RelayIdentity.generate()
        let transport = RelayTransport(identity: identity)
        defer { transport.disconnect() }
        progress(.object(["stage": .string("identity"), "fingerprint": .string(identity.certificate.id)]))
        _ = try await transport.connect()
        let claim = try await transport.request("invite.claim", fields: ["code": .string(code)])
        guard let claimID = claim["claimId"].string else { throw CoreApplicationError("INVALID_RESPONSE") }
        progress(.object(["stage": .string("pending"), "claimId": .string(claimID)]))
        let deadline = Date().addingTimeInterval(90)
        var approved: WireValue?
        while Date() < deadline {
            let decision = try await transport.request("invite.status", fields: ["claimId": .string(claimID)])
            if decision["state"].string == "approved" { approved = decision["grant"]; break }
            guard decision["state"].string == "pending" else { throw CoreApplicationError("FORBIDDEN") }
            try await Task.sleep(for: .milliseconds(750))
        }
        guard let grant = approved, let grantID = grant["id"].string, let resource = grant["spec"]["resource"].string,
              grant["spec"]["kind"].string == "PAIR", grant["spec"]["mode"].string == "pair",
              grant["spec"]["actions"].array == [.string("observe")], grant["hostId"].string == expectedHost,
              grant["recipientId"].string == identity.certificate.id else { throw CoreApplicationError("FORBIDDEN") }
        let host = try RelayCertificate.parse(grant["peer"])
        guard host.id == expectedHost else { throw CoreApplicationError("FORBIDDEN") }
        try transport.trust(host)
        progress(.object(["stage": .string("paired"), "grantId": .string(grantID)]))
        let client = CoreRelayClient(transport: transport, hostID: host.id, grantID: grantID, resource: resource)
        transport.onPayload = { from, grant, frame in try? client.receive(from: from, grantID: grant, payload: frame) }
        let snapshot = try await client.request("session.get")
        guard snapshot["session"]["id"].string == expectedSession,
              snapshot["capabilities"]["permissions"].array == [.string("observe")],
              snapshot["capabilities"]["sessionAccess"].bool != true, snapshot["capabilities"]["agentAccess"].bool != true else { throw CoreApplicationError("FORBIDDEN") }
        let metrics = try await client.request("host.metrics")
        _ = try CoreHostMetrics(metrics)
        let events = try await client.request("events.list", params: ["limit": .number(50)])
        let types = Set((events["events"].array ?? []).compactMap { $0["type"].string }).sorted()
        return .object(["stage": .string("complete"), "grantId": .string(grantID), "sessionId": .string(expectedSession),
            "metrics": metrics, "eventCount": .number(Double(events["events"].array?.count ?? 0)), "eventTypes": .array(types.map(CoreJSONValue.string)),
            "operations": .array(["session.get", "host.metrics", "events.list"].map(CoreJSONValue.string))])
    }
}
