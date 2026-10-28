import Foundation
import CryptoKit

public struct CoreChatMessage: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let text: String
    public let isUser: Bool
    public let createdAt: String
    public let observedAt: String?
}

/// Display data only; no grants, pending questions, tools or execution cursors.
struct CoreChatHistory: Codable {
    let hostID: String
    let grantID: String
    var messages: [CoreChatMessage]
    private static let maximumBytes = 512 * 1024
    private func validate() throws {
        guard !hostID.isEmpty, hostID.utf8.count <= 80, !grantID.isEmpty, grantID.utf8.count <= 80,
              messages.count <= 100, Set(messages.map(\.id)).count == messages.count,
              messages.allSatisfy({ $0.text.utf8.count <= 32768 && !$0.id.isEmpty && $0.id.utf8.count <= 100 }) else { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }
    }
    private static func url(_ directory: URL, _ host: String, _ grant: String) -> URL {
        let hash = SHA256.hash(data: Data((host + ":" + grant).utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("AssessmentChat", isDirectory: true).appendingPathComponent(hash + ".json")
    }
    static func load(directory: URL, hostID: String, grantID: String) throws -> Self {
        let file = url(directory, hostID, grantID)
        let folder = file.deletingLastPathComponent()
        if FileManager.default.fileExists(atPath: folder.path) {
            let attrs = try folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard attrs.isDirectory == true, attrs.isSymbolicLink != true else { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }
        }
        guard FileManager.default.fileExists(atPath: file.path) else { return .init(hostID: hostID, grantID: grantID, messages: []) }
        let attrs = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard attrs.isRegularFile == true, attrs.isSymbolicLink != true, (attrs.fileSize ?? Int.max) <= maximumBytes else { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }
        let value = try JSONDecoder().decode(Self.self, from: Data(contentsOf: file))
        try value.validate()
        guard value.hostID == hostID, value.grantID == grantID else { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }
        return value
    }
    mutating func save(directory: URL) throws {
        messages = Array(messages.suffix(100))
        try validate()
        let encoder = JSONEncoder()
        var data = try encoder.encode(self)
        while data.count > Self.maximumBytes, !messages.isEmpty {
            messages.removeFirst(); data = try encoder.encode(self)
        }
        let file = Self.url(directory, hostID, grantID), folder = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let values = try folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else { throw CoreApplicationError("PROJECTION_UNAVAILABLE") }
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: folder.path)
        #endif
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file.path)
        #endif
        var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
        var protected = file; try protected.setResourceValues(excluded)
    }
    static func purge(directory: URL, hostID: String, grantID: String) throws {
        let file = url(directory, hostID, grantID)
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
    }
}
