import Foundation

/// Relay presence cannot establish Core readiness. Only an authenticated Core
/// roundtrip for the current connection generation refreshes this short lease.
struct CoreConnectionHealth: Sendable {
    enum Phase: String, Sendable { case offline, connecting, online }
    private(set) var phase: Phase = .offline
    private(set) var generation = UUID()
    private(set) var scope: String?
    private(set) var verifiedAt: Date?
    static let maximumAge: TimeInterval = 8

    @discardableResult mutating func begin(scope: String) -> UUID {
        generation = UUID(); self.scope = scope; phase = .connecting; verifiedAt = nil
        return generation
    }
    @discardableResult mutating func confirm(_ generation: UUID, scope: String, at date: Date = Date()) -> Bool {
        guard self.generation == generation, self.scope == scope, phase != .offline else { return false }
        phase = .online; verifiedAt = date; return true
    }
    mutating func disconnect() {
        generation = UUID(); scope = nil; verifiedAt = nil; phase = .offline
    }
    func isOnline(at date: Date = Date()) -> Bool {
        guard phase == .online, let verifiedAt else { return false }
        return (0...Self.maximumAge).contains(date.timeIntervalSince(verifiedAt))
    }
}
