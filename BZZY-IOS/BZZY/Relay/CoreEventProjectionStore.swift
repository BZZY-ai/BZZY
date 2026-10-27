import Foundation
import CryptoKit

/// One host/resource/session projection and its processed cursor are replaced
/// atomically before the caller sends an application events.ack.
public final class CoreEventProjectionStore {
    private struct Saved: Codable {
        let version: Int
        let hostID: String
        let resource: String
        let sessionID: String
        let consumerID: String
        let ownerID: String
        var cursor: Int64
        var events: [CoreEvent]
        var outgoing: [CoreOutgoingMessage]?
        var historyInitialized: Bool?
        var hasOlder: Bool?
        var bootstrapToken: String?
        var snapshot: CoreJSONValue?
    }
    private var saved: Saved
    private let file: URL
    private let maximumEvents = 20_000 // Legacy decoding bound.
    private let recentEvents = 10_000
    private let recentBytes = 16 * 1024 * 1024
    private let visibleEvents = 10_000
    private let visibleBytes = 16 * 1024 * 1024
    private var displayed: [CoreEvent] = []
    private var olderAvailable = false
    private var browsingHistory = false
    private var encodedSizes: [Int64: Int] = [:]
    public private(set) var historyWindowShifted = false
    private let maximumBytes = 64 * 1024 * 1024 // One 16 MiB wire event may expand during JSON escaping, beside the bounded outbox.
    public var events: [CoreEvent] { displayed }
    public var firstCursor: Int64 { displayed.first?.seq ?? 0 }
    public var hasOlderHistory: Bool { olderAvailable }
    public var hasNewerHistory: Bool { (displayed.last?.seq ?? 0) < saved.cursor }
    public var historyInitialized: Bool { saved.historyInitialized ?? (saved.cursor > 0) }
    public var bootstrapToken: String? { saved.bootstrapToken }
    /// Cached metadata is presentation only and never establishes connectivity,
    /// current permissions, a pending question, or permission to execute.
    public var cachedSnapshot: CoreJSONValue? { saved.snapshot }
    public var cursor: Int64 { saved.cursor }
    public var consumerID: String { saved.consumerID }
    public var ownerID: String { saved.ownerID }
    public var outgoing: [CoreOutgoingMessage] { saved.outgoing ?? [] }

    public init(directory: URL, hostID: String, resource: String, sessionID: String) throws {
        file = try Self.fileURL(directory: directory, hostID: hostID, resource: resource, sessionID: sessionID)
        saved = Saved(version: 1, hostID: hostID, resource: resource, sessionID: sessionID,
                      consumerID: UUID().uuidString, ownerID: UUID().uuidString, cursor: 0, events: [])
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if FileManager.default.fileExists(atPath: file.path) {
                let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
                guard (attributes[.size] as? NSNumber)?.intValue ?? Int.max <= maximumBytes else { throw CoreApplicationError("PROJECTION_CAPACITY") }
                var existing = try JSONDecoder().decode(Saved.self, from: Data(contentsOf: file))
                guard existing.version == 1, existing.hostID == hostID, existing.resource == resource,
                      existing.sessionID == sessionID, existing.cursor >= 0, existing.events.count <= maximumEvents else { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }
                try CoreApplicationProtocol.opaque(existing.consumerID); try CoreApplicationProtocol.opaque(existing.ownerID)
                var previous: Int64 = 0
                for event in existing.events { try event.validate(sessionID: sessionID); guard event.seq > previous else { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }; previous = event.seq }
                guard previous == existing.cursor else { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }
                let outgoing = existing.outgoing ?? []
                guard outgoing.count <= 128, Set(outgoing.map(\.id)).count == outgoing.count else { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }
                for message in outgoing {
                    guard ["execution.execute", "task.submit"].contains(message.operation), UUID(uuidString: message.id) != nil,
                          !message.text.isEmpty, message.text.utf8.count <= 16 * 1024 else { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }
                    _ = try CoreApplicationProtocol.request(op: message.operation, params: message.params, id: message.requestID, resource: resource)
                }
                existing.outgoing = existing.outgoing?.map { message in
                    var recovered = message
                    if recovered.status == .sending { recovered.status = .uncertain }
                    return recovered
                }
                if let token = existing.bootstrapToken { try CoreApplicationProtocol.opaque(token) }
                if let snapshot = existing.snapshot { try validateSnapshot(snapshot) }
                existing.historyInitialized = existing.historyInitialized ?? (existing.cursor > 0)
                olderAvailable = existing.hasOlder ?? false
                displayed = existing.events
                boundRecent(&existing)
                saved = existing
            } else { try persist(saved) }
            if displayed.isEmpty { displayed = saved.events }
            boundVisible()
        } catch let error as CoreApplicationError { throw error }
        catch { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }
    }

    /// Replayed retained IDs must be byte-equivalent JSON values. Already
    /// processed evicted IDs cannot alter the projection or move its cursor.
    public func apply(_ batch: CoreEventBatch) throws {
        guard batch.resource == saved.resource, batch.sessionId == saved.sessionID else { throw CoreApplicationError("FORBIDDEN") }
        var next = saved
        var visible = displayed
        let existing = Dictionary((saved.events + visible).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for event in batch.events {
            try event.validate(sessionID: saved.sessionID)
            if let old = existing[event.id] { guard old == event else { throw CoreApplicationError("CONFLICT") } }
            else if event.seq > next.cursor { next.events.append(event); visible.append(event); next.cursor = event.seq }
            // A lost ACK may replay an event outside the retained cache. Its
            // sequence is already durably processed; do not insert it anew.
        }
        guard batch.events.last?.seq == batch.nextCursor else { throw CoreApplicationError("INVALID_CURSOR") }
        next.historyInitialized = true
        pruneDelivered(&next)
        boundRecent(&next)
        try persist(next); saved = next
        if !browsingHistory { displayed = visible; boundVisible() }
    }

    /// Start a new consumer at an explicitly disclosed recent tail. The scoped
    /// Core token is kept until subscription acceptance, so interruption never
    /// converts a partial local write into a skipped live interval.
    public func bootstrap(_ page: CoreEventHistoryPage) throws {
        guard !historyInitialized, saved.cursor == 0, saved.events.isEmpty,
              page.sessionID == saved.sessionID, let token = page.bootstrapToken else { throw CoreApplicationError("INVALID_CURSOR") }
        var next = saved
        next.events = page.events; next.cursor = page.nextCursor
        next.hasOlder = page.hasOlder; next.historyInitialized = true; next.bootstrapToken = token
        pruneDelivered(&next); boundRecent(&next)
        try persist(next); saved = next; displayed = page.events; olderAvailable = page.hasOlder
        boundVisible()
    }

    /// An expired initial disclosure proof can be refreshed before attachment.
    /// Use a fresh observation consumer so a possibly accepted earlier baseline
    /// is never advanced past unseen work under the same durable cursor.
    public func refreshBootstrap(_ page: CoreEventHistoryPage) throws {
        guard saved.bootstrapToken != nil, page.sessionID == saved.sessionID,
              let token = page.bootstrapToken else { throw CoreApplicationError("INVALID_CURSOR") }
        var next = Saved(version: 1, hostID: saved.hostID, resource: saved.resource, sessionID: saved.sessionID,
                         consumerID: UUID().uuidString, ownerID: saved.ownerID, cursor: page.nextCursor, events: page.events,
                         outgoing: saved.outgoing, historyInitialized: true, hasOlder: page.hasOlder,
                         bootstrapToken: token, snapshot: saved.snapshot)
        pruneDelivered(&next); boundRecent(&next)
        try persist(next); saved = next; displayed = page.events; olderAvailable = page.hasOlder; browsingHistory = false
        boundVisible()
    }

    /// Historical reads never change the forward subscription cursor or ACK.
    public func prepend(_ page: CoreEventHistoryPage) throws {
        guard page.sessionID == saved.sessionID, page.bootstrapToken == nil,
              page.events.allSatisfy({ $0.seq < firstCursor || displayed.contains($0) }) else { throw CoreApplicationError("INVALID_CURSOR") }
        let merged = try merge(page.events, displayed)
        var next = saved
        next.events = try merge(page.events, next.events)
        next.hasOlder = page.hasOlder
        boundRecent(&next)
        try persist(next); saved = next; displayed = merged; olderAvailable = page.hasOlder
        browsingHistory = true; boundVisible(keepingOldest: true)
    }

    public func markSubscribed() throws {
        guard saved.bootstrapToken != nil else { return }
        var next = saved; next.bootstrapToken = nil
        try persist(next); saved = next
    }

    public func showLatestHistory() {
        browsingHistory = false; displayed = saved.events; olderAvailable = saved.hasOlder ?? false
        historyWindowShifted = false
    }
    public func holdHistoryWindow() { browsingHistory = true }

    public func clearHistoryWindowShifted() { historyWindowShifted = false }

    public func saveSnapshot(_ snapshot: CoreJSONValue) throws {
        try validateSnapshot(snapshot)
        guard snapshot != saved.snapshot else { return }
        var next = saved; next.snapshot = snapshot
        try persist(next); saved = next
    }

    private func validateSnapshot(_ snapshot: CoreJSONValue) throws {
        guard snapshot["session"]["id"].string == saved.sessionID,
              try JSONEncoder().encode(snapshot).count <= 64 * 1024 else { throw CoreApplicationError("FORBIDDEN") }
        try snapshot.record(["session", "execution", "questions", "inputOwner", "capabilities"], required: ["session", "questions", "capabilities"])
    }

    private func merge(_ first: [CoreEvent], _ second: [CoreEvent]) throws -> [CoreEvent] {
        var values: [Int64: CoreEvent] = [:]
        // Both inputs already consist of validated immutable envelopes: the
        // page initializer validates new reads and retained values were checked
        // at insertion/load. Re-encoding thousands of old events here makes a
        // single history prepend stall the UI without adding a trust boundary.
        for event in first + second {
            if let old = values[event.seq], old != event { throw CoreApplicationError("CONFLICT") }
            values[event.seq] = event
        }
        return values.values.sorted { $0.seq < $1.seq }
    }

    private func boundedSuffix(_ events: [CoreEvent], count: Int, bytes: Int) -> [CoreEvent] {
        var size = 0, index = events.endIndex
        while index > events.startIndex, events.endIndex - index < count {
            let previous = index - 1
            let event = events[previous]
            let amount: Int
            if let known = encodedSizes[event.seq] { amount = known }
            else { amount = (try? JSONEncoder().encode(event).count) ?? maximumBytes; encodedSizes[event.seq] = amount }
            if size + amount > bytes && index < events.endIndex { break }
            size += amount; index = previous
        }
        return Array(events[index...])
    }

    private func boundRecent(_ value: inout Saved) {
        let recent = boundedSuffix(value.events, count: recentEvents, bytes: recentBytes)
        if recent.count < value.events.count { value.hasOlder = true }
        value.events = recent
    }

    private func boundVisible(keepingOldest: Bool = false) {
        let visible = keepingOldest
            ? Array(boundedSuffix(Array(displayed.reversed()), count: visibleEvents, bytes: visibleBytes).reversed())
            : boundedSuffix(displayed, count: visibleEvents, bytes: visibleBytes)
        if visible.count < displayed.count { if !keepingOldest { olderAvailable = true }; historyWindowShifted = true }
        displayed = visible
        if encodedSizes.count > visibleEvents * 2 {
            let retained = Set((saved.events + displayed).map(\.seq))
            encodedSizes = encodedSizes.filter { retained.contains($0.key) }
        }
    }

    public func putOutgoing(_ message: CoreOutgoingMessage) throws {
        guard ["execution.execute", "task.submit"].contains(message.operation), UUID(uuidString: message.id) != nil,
              !message.text.isEmpty, message.text.utf8.count <= 16 * 1024 else { throw CoreApplicationError("INVALID_REQUEST") }
        _ = try CoreApplicationProtocol.request(op: message.operation, params: message.params, id: message.requestID, resource: saved.resource)
        var next = saved
        var messages = next.outgoing ?? []
        if let index = messages.firstIndex(where: { $0.id == message.id }) { messages[index] = message }
        else { guard messages.count < 128 else { throw CoreApplicationError("PROJECTION_CAPACITY") }; messages.append(message) }
        next.outgoing = messages; pruneDelivered(&next)
        try persist(next); saved = next
    }

    public func removeFailedOutgoing(_ id: String) throws {
        var next = saved
        next.outgoing = next.outgoing?.filter { $0.id != id || $0.status != .failed }
        try persist(next); saved = next
    }

    private func pruneDelivered(_ value: inout Saved) {
        let delivered = Set(value.events.filter { $0.type == "message.user" }.compactMap { $0.data["executionId"].string })
        value.outgoing = value.outgoing?.filter { message in
            if let actor = message.actor, value.events.contains(where: {
                $0.type == "input.accepted" && $0.data["actor"].string == actor && $0.data["requestId"].string == message.requestID
                || $0.type == "message.user" && $0.data["channel"]["actor"].string == actor && $0.data["channel"]["requestId"].string == message.requestID
            }) { return false }
            guard message.status == .accepted, let executionID = message.executionID else { return true }
            return !delivered.contains(executionID)
        }
    }

    /// Forgetting/revoking a host removes its private local projection. Reusing
    /// this store afterwards is invalid; a new projection gets a new consumer ID.
    public func purge() throws {
        do {
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
            displayed = []; olderAvailable = false; browsingHistory = false; historyWindowShifted = false
            saved = Saved(version: 1, hostID: saved.hostID, resource: saved.resource, sessionID: saved.sessionID,
                          consumerID: UUID().uuidString, ownerID: UUID().uuidString, cursor: 0, events: [])
        } catch { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }
    }

    /// Revocation must also remove a cache that cannot be decoded or loaded.
    /// The exact private scope determines the filename without reading contents.
    public static func purge(directory: URL, hostID: String, resource: String, sessionID: String) throws {
        let file = try fileURL(directory: directory, hostID: hostID, resource: resource, sessionID: sessionID)
        do {
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        } catch { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }
    }

    private static func fileURL(directory: URL, hostID: String, resource: String, sessionID: String) throws -> URL {
        try CoreApplicationProtocol.opaque(hostID); try CoreApplicationProtocol.opaque(resource)
        _ = try CoreApplicationProtocol.uuid(sessionID)
        let digest = SHA256.hash(data: try JSONEncoder().encode([hostID, resource, sessionID]))
        return directory.appendingPathComponent(digest.map { String(format: "%02x", $0) }.joined() + ".json")
    }

    private func persist(_ value: Saved) throws {
        do {
            let bytes = try JSONEncoder().encode(value)
            guard bytes.count <= maximumBytes else { throw CoreApplicationError("PROJECTION_CAPACITY") }
            #if os(iOS)
            try bytes.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try bytes.write(to: file, options: .atomic)
            #endif
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch let error as CoreApplicationError { throw error }
        catch { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }
    }
}
