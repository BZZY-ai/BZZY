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
    }
    private var saved: Saved
    private let file: URL
    private let maximumEvents = 20_000
    private let maximumBytes = 32 * 1024 * 1024
    public var events: [CoreEvent] { saved.events }
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
                saved = existing
            } else { try persist(saved) }
        } catch let error as CoreApplicationError { throw error }
        catch { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }
    }

    /// Replayed equal IDs are harmless. Changed contents under an existing ID or
    /// session/resource mismatches fail before persistence or acknowledgment.
    public func apply(_ batch: CoreEventBatch) throws {
        guard batch.resource == saved.resource, batch.sessionId == saved.sessionID else { throw CoreApplicationError("FORBIDDEN") }
        var next = saved
        let existing = Dictionary(uniqueKeysWithValues: next.events.map { ($0.id, $0) })
        for event in batch.events {
            try event.validate(sessionID: saved.sessionID)
            if let old = existing[event.id] { guard old == event else { throw CoreApplicationError("CONFLICT") } }
            else { guard event.seq > next.cursor else { throw CoreApplicationError("INVALID_CURSOR") }; next.events.append(event); next.cursor = event.seq }
        }
        guard batch.events.last?.seq == batch.nextCursor, next.events.count <= maximumEvents else { throw CoreApplicationError("PROJECTION_CAPACITY") }
        pruneDelivered(&next)
        try persist(next); saved = next
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
