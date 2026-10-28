import Foundation
import CryptoKit

/// Identity only. A cached transcript never supplies authorization or a replay cursor.
struct TerminalPresentationScope: Codable, Equatable, Hashable {
    let hostID: String
    let resource: String
    let sessionID: String
    let authorizationID: String

    fileprivate var isValid: Bool {
        UUID(uuidString: sessionID) != nil && [hostID, resource, authorizationID].allSatisfy {
            !$0.isEmpty && $0.utf8.count <= 4_096
        }
    }
}

/// Deliberately excludes capabilities, input ownership, questions and live execution state.
struct TerminalPresentationMetadata: Codable, Equatable {
    let title: String
    let hasAlias: Bool
    let provider: String
    let model: String
    let directory: String?

    fileprivate var isValid: Bool {
        title.utf8.count <= 1_024 && provider.utf8.count <= 1_024 && model.utf8.count <= 1_024
            && (directory?.utf8.count ?? 0) <= 16_384
    }
}

struct CachedTerminalPresentation: Codable, Equatable {
    fileprivate let version: Int
    let scope: TerminalPresentationScope
    let metadata: TerminalPresentationMetadata
    let messages: [LocalMessage]
    let savedAt: Date
    /// Whole entries excluded from the recent window because of the byte budget.
    /// Bodies are never truncated or replaced with invented transcript messages.
    let omittedMessageCount: Int
}

/// A small, disposable, private display cache alongside the durable raw-event/ACK store.
/// Access is serialized by WorkspaceStore on the main actor; no network state lives here.
final class TerminalPresentationCache {
    static let maximumMessages = 100
    static let maximumMessageBytes = 256 * 1_024
    static let maximumSessionBytes = 1 * 1_024 * 1_024
    static let maximumTotalBytes = 16 * 1_024 * 1_024
    static let maximumSessions = 32

    private let directory: URL
    private let files = FileManager.default
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    init(directory: URL) { self.directory = directory }

    func load(scope: TerminalPresentationScope) -> CachedTerminalPresentation? {
        guard scope.isValid else { return nil }
        let file = fileURL(scope)
        guard let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size <= Self.maximumSessionBytes,
              let data = try? Data(contentsOf: file),
              let saved = try? JSONDecoder().decode(CachedTerminalPresentation.self, from: data),
              saved.version == 1, saved.scope == scope, saved.metadata.isValid,
              saved.savedAt.timeIntervalSince1970.isFinite,
              saved.messages.count <= Self.maximumMessages,
              (0...Self.maximumMessages).contains(saved.omittedMessageCount),
              Set(saved.messages.map(\.id)).count == saved.messages.count,
              saved.messages.allSatisfy({ message in
                  message.createdAt.timeIntervalSince1970.isFinite
                      && ((try? encoder.encode(message).count) ?? Int.max) <= Self.maximumMessageBytes
              }) else { return nil }
        // Access time affects eviction only; it cannot change transcript age or authority.
        try? files.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
        return saved
    }

    @discardableResult
    func save(scope: TerminalPresentationScope, metadata: TerminalPresentationMetadata,
              messages: [LocalMessage], now: Date = Date()) throws -> CachedTerminalPresentation {
        guard scope.isValid, metadata.isValid, now.timeIntervalSince1970.isFinite else {
            throw CocoaError(.coderInvalidValue)
        }
        let candidates = Array(messages.suffix(Self.maximumMessages))
        guard Set(candidates.map(\.id)).count == candidates.count else { throw CocoaError(.coderInvalidValue) }
        var retained: [LocalMessage] = []
        var omitted = 0
        // Reserve enough room for scope, metadata, JSON separators and the omission count.
        let empty = CachedTerminalPresentation(version: 1, scope: scope, metadata: metadata,
            messages: [], savedAt: now, omittedMessageCount: Self.maximumMessages)
        var bytes = try encoder.encode(empty).count
        for message in candidates.reversed() {
            let size = try encoder.encode(message).count
            guard message.createdAt.timeIntervalSince1970.isFinite,
                  size <= Self.maximumMessageBytes, bytes + size + 1 <= Self.maximumSessionBytes else {
                omitted += 1
                continue
            }
            retained.append(message)
            bytes += size + 1
        }
        let saved = CachedTerminalPresentation(version: 1, scope: scope, metadata: metadata,
            messages: retained.reversed(), savedAt: now, omittedMessageCount: omitted)
        let data = try encoder.encode(saved)
        guard data.count <= Self.maximumSessionBytes else { throw CocoaError(.fileWriteOutOfSpace) }
        let file = fileURL(scope)
        try prepareDirectory(file.deletingLastPathComponent())
        #if os(iOS)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: file, options: .atomic)
        #endif
        try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        var protectedFile = file
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try protectedFile.setResourceValues(values)
        try prune(except: file)
        return saved
    }

    /// Called for confirmed deletion, unpair, grant replacement and revocation.
    func remove(hostID: String, authorizationID: String? = nil, sessionID: String? = nil) {
        let host = directory.appendingPathComponent(hash(hostID), isDirectory: true)
        let base = authorizationID.map { host.appendingPathComponent(hash($0), isDirectory: true) } ?? host
        guard let sessionID else { try? files.removeItem(at: base); return }
        for file in cacheFiles(under: base) {
            guard let values = try? file.resourceValues(forKeys: [.fileSizeKey]),
                  (values.fileSize ?? Int.max) <= Self.maximumSessionBytes,
                  let data = try? Data(contentsOf: file),
                  let saved = try? JSONDecoder().decode(CachedTerminalPresentation.self, from: data),
                  saved.scope.hostID == hostID, saved.scope.sessionID == sessionID else { continue }
            try? files.removeItem(at: file)
        }
    }

    func retainHosts(_ hostIDs: Set<String>) {
        let allowed = Set(hostIDs.map(hash))
        guard let children = try? files.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
        for child in children where !allowed.contains(child.lastPathComponent) { try? files.removeItem(at: child) }
    }

    private func fileURL(_ scope: TerminalPresentationScope) -> URL {
        let key = (try? encoder.encode(scope)) ?? Data()
        return directory.appendingPathComponent(hash(scope.hostID), isDirectory: true)
            .appendingPathComponent(hash(scope.authorizationID), isDirectory: true)
            .appendingPathComponent(SHA256.hash(data: key).map { String(format: "%02x", $0) }.joined() + ".json")
    }

    private func hash(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func prepareDirectory(_ leaf: URL) throws {
        try files.createDirectory(at: leaf, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var current = leaf
        while current.path.hasPrefix(directory.path) {
            let values = try current.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else { throw CocoaError(.fileWriteInvalidFileName) }
            try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: current.path)
            #if os(iOS)
            try files.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: current.path)
            #endif
            var excluded = URLResourceValues()
            excluded.isExcludedFromBackup = true
            try current.setResourceValues(excluded)
            if current == directory { break }
            current.deleteLastPathComponent()
        }
    }

    private func cacheFiles(under base: URL) -> [URL] {
        guard let enumerator = files.enumerator(at: base,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]) else { return [] }
        return enumerator.compactMap { item -> URL? in
            guard let url = item as? URL, url.pathExtension == "json",
                  let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
                  values.isRegularFile == true, values.isSymbolicLink != true else { return nil }
            return url
        }
    }

    private func prune(except protectedFile: URL) throws {
        let records = cacheFiles(under: directory).compactMap { url -> (URL, Int, Date)? in
            guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]), let size = values.fileSize else { return nil }
            return (url, size, values.contentModificationDate ?? .distantPast)
        }.sorted { $0.2 < $1.2 }
        var total = records.reduce(0) { $0 + $1.1 }
        var count = records.count
        for (url, size, _) in records where url != protectedFile {
            guard total > Self.maximumTotalBytes || count > Self.maximumSessions else { break }
            try files.removeItem(at: url)
            total -= size
            count -= 1
        }
    }
}
