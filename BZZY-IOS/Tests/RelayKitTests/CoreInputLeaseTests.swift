import XCTest
@testable import RelayKit

final class CoreInputLeaseTests: XCTestCase {
    func testSnapshotStartedBeforeHandoffCannotUndoAcceptedControl() {
        var lease = CoreInputLeaseState()
        let snapshot = lease.generation, claim = lease.beginClaim()
        XCTAssertTrue(lease.accept(owner: "phone", at: claim))
        XCTAssertFalse(lease.observe(owner: "cli", at: snapshot))
        XCTAssertEqual(lease.ownerID, "phone")
    }
    func testOldRenewalFailureCannotRevokeNewerControl() {
        var lease = CoreInputLeaseState()
        let first = lease.beginClaim(); lease.accept(owner: "phone", at: first)
        let renewal = lease.generation
        let next = lease.beginClaim(); lease.accept(owner: "new-phone", at: next)
        XCTAssertFalse(lease.fail(at: renewal, viewing: true))
        XCTAssertEqual(lease.ownerID, "new-phone")
        XCTAssertFalse(lease.viewing)
    }
    func testResetInvalidatesLateClaimsAndCoreOwnershipRemainsObservable() {
        var lease = CoreInputLeaseState()
        let pending = lease.beginClaim(); lease.reset()
        XCTAssertFalse(lease.accept(owner: "old-client", at: pending))
        lease.observeCore(owner: "phone", ownedByDevice: true, at: lease.generation)
        XCTAssertEqual(lease.ownerID, "phone")
        XCTAssertTrue(lease.observeCore(owner: "cli", ownedByDevice: false, at: lease.generation))
        XCTAssertNil(lease.ownerID); XCTAssertTrue(lease.viewing)
    }
}
