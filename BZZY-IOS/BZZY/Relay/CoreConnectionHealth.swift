import Foundation

/// Relay presence cannot establish Core readiness. Only an authenticated Core
/// roundtrip for the current connection generation refreshes this short lease.
struct CoreConnectionHealth: Sendable {
    enum Phase: String, Sendable { case offline, connecting, online }
    private(set) var phase: Phase = .offline
    private(set) var generation = UUID()
    private(set) var scope: String?
    private(set) var verifiedAt: Date?
    private var verifiedUptime: TimeInterval?
    static let maximumAge: TimeInterval = 8
    func needsProbe(after seconds: TimeInterval = 3) -> Bool {
        guard let verifiedUptime else { return true }
        return ProcessInfo.processInfo.systemUptime - verifiedUptime >= seconds
    }

    @discardableResult mutating func begin(scope: String) -> UUID {
        generation = UUID(); self.scope = scope; phase = .connecting; verifiedAt = nil; verifiedUptime = nil
        return generation
    }
    @discardableResult mutating func confirm(_ generation: UUID, scope: String, at date: Date = Date()) -> Bool {
        guard self.generation == generation, self.scope == scope, phase != .offline else { return false }
        phase = .online; verifiedAt = date; verifiedUptime = ProcessInfo.processInfo.systemUptime; return true
    }
    mutating func disconnect() {
        generation = UUID(); scope = nil; verifiedAt = nil; verifiedUptime = nil; phase = .offline
    }
    func isOnline(at date: Date? = nil) -> Bool {
        guard phase == .online, let verifiedAt else { return false }
        let age = date.map { $0.timeIntervalSince(verifiedAt) } ?? (ProcessInfo.processInfo.systemUptime - (verifiedUptime ?? -.infinity))
        return (0...Self.maximumAge).contains(age)
    }
}
