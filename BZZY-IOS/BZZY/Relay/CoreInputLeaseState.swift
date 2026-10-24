import Foundation

/// Core owns the lease. This projection prevents older asynchronous replies
/// from changing a newer local control decision; it never grants permission.
public struct CoreInputLeaseState: Equatable, Sendable {
    public private(set) var generation: UInt64 = 0
    public private(set) var ownerID: String?
    public private(set) var claimPending = false
    public private(set) var viewing = false

    public init() {}

    public mutating func beginClaim() -> UInt64 {
        generation &+= 1; claimPending = true
        return generation
    }

    @discardableResult public mutating func accept(owner: String, at requestGeneration: UInt64) -> Bool {
        guard generation == requestGeneration else { return false }
        generation &+= 1; claimPending = false; ownerID = owner; viewing = false
        return true
    }

    @discardableResult public mutating func fail(at requestGeneration: UInt64, viewing: Bool) -> Bool {
        guard generation == requestGeneration else { return false }
        generation &+= 1; claimPending = false; ownerID = nil; self.viewing = viewing
        return true
    }

    /// A snapshot started before a claim cannot revoke that claim. Observation
    /// is independent of ownership and remains available after a transfer.
    @discardableResult public mutating func observe(owner: String?, at requestGeneration: UInt64) -> Bool {
        guard generation == requestGeneration, !claimPending else { return false }
        if let ownerID, ownerID != owner { return fail(at: requestGeneration, viewing: owner != nil) }
        if ownerID == nil { viewing = owner != nil }
        return false
    }

    public mutating func reset() {
        generation &+= 1; ownerID = nil; claimPending = false; viewing = false
    }

    @discardableResult public mutating func observeCore(owner: String?, ownedByDevice: Bool, at requestGeneration: UInt64) -> Bool {
        guard generation == requestGeneration, !claimPending else { return false }
        if ownedByDevice, let owner {
            if ownerID != owner { generation &+= 1 }
            ownerID = owner; viewing = false; return false
        }
        return observe(owner: owner, at: requestGeneration)
    }
}
