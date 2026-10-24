import Foundation

/// A local label for a pinned Core identity. Authorization remains private in
/// device-only Keychain; these values never supply owner/provider credentials.
public struct CoreHostSummary: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let fingerprint: String
    public let isOnline: Bool
    public let isDefault: Bool
    public let isPaired: Bool
}

struct SavedCoreHost: Codable {
    let id: String
    var name: String
    var state: SavedRelayState
    var sessions: [CoreJSONValue] = []
    var agents: [CoreJSONValue] = []
    // Display catalogs live in protected cache files, outside the compact
    // authorization/receipt Keychain record.
    private enum CodingKeys: String, CodingKey { case id, name, state }
}

struct CoreHostCatalogCache: Codable {
    var sessions: [CoreJSONValue]
    var agents: [CoreJSONValue]

    private static func url(directory: URL, hostID: String) throws -> URL {
        _ = try RelayWire.decoded(hostID, count: 32)
        return directory.appendingPathComponent("HostProfiles", isDirectory: true).appendingPathComponent(hostID + ".json")
    }
    static func load(directory: URL, hostID: String) throws -> Self? {
        let url = try url(directory: directory, hostID: hostID)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        guard data.count <= 2_000_000 else { throw RelayFailure("CAPACITY") }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.sessions.count <= 500, value.agents.count <= 200 else { throw RelayFailure("CAPACITY") }
        return value
    }
    func save(directory: URL, hostID: String) throws {
        let url = try Self.url(directory: directory, hostID: hostID), data = try JSONEncoder().encode(self)
        guard data.count <= 2_000_000, sessions.count <= 500, agents.count <= 200 else { throw RelayFailure("CAPACITY") }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        #endif
    }
    static func purge(directory: URL, hostID: String) throws {
        let url = try url(directory: directory, hostID: hostID)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
}

/// One atomic Keychain value replaces the v1 single-host value. The phone
/// identity stays in its original independent record through this migration.
struct SavedCoreHosts: Codable {
    var version = 2
    var profiles: [SavedCoreHost] = []
    var activeHostID: String?
    var defaultHostID: String?
    var unpairedState: SavedRelayState?

    static func decode(_ data: Data) throws -> SavedCoreHosts {
        let decoder = JSONDecoder()
        let marker = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        if marker?["version"] != nil {
            let value = try decoder.decode(Self.self, from: data)
            guard value.version == 2, value.profiles.count <= 64,
                  Set(value.profiles.map(\.id)).count == value.profiles.count,
                  value.profiles.allSatisfy({ $0.state.host == nil || $0.state.host?.certificate.id == $0.id }),
                  value.defaultHostID == nil || value.profiles.contains(where: { $0.id == value.defaultHostID }),
                  value.activeHostID == nil || value.profiles.contains(where: { $0.id == value.activeHostID }) else {
                throw RelayFailure("INVALID_IDENTITY")
            }
            for profile in value.profiles {
                _ = try RelayWire.decoded(profile.id, count: 32)
                try profile.state.host?.certificate.verify()
            }
            return value
        }
        let legacy = try decoder.decode(SavedRelayState.self, from: data)
        guard let host = legacy.host else { return SavedCoreHosts(unpairedState: legacy) }
        try host.certificate.verify()
        return SavedCoreHosts(profiles: [SavedCoreHost(id: host.certificate.id, name: "Test Mac", state: legacy)],
                              activeHostID: host.certificate.id, defaultHostID: host.certificate.id)
    }
}
