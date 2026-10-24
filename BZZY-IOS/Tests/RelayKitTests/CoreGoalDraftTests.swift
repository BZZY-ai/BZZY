import XCTest
@testable import RelayKit

final class CoreGoalDraftTests: XCTestCase {
    func testGoalPillKeepsCanonicalDraftAndEditableObjective() {
        XCTAssertTrue(CoreGoalDraft.isGoal("/goal"))
        XCTAssertTrue(CoreGoalDraft.isGoal("/goal\ttell me Messi age"))
        XCTAssertFalse(CoreGoalDraft.isGoal("/goals"))
        XCTAssertEqual(CoreGoalDraft.body("/goal tell me Messi age"), "tell me Messi age")
        XCTAssertEqual(CoreGoalDraft.replacingBody(" tell me Messi age"), "/goal tell me Messi age")
        XCTAssertTrue(CoreGoalDraft.isNewGoal("/goal tell me Messi age"))
        for command in ["/goal", "/goal status", "/goal resume", "/goal cancel"] {
            XCTAssertFalse(CoreGoalDraft.isNewGoal(command))
        }
    }
    func testReplacementOnlyPromptsForUnfinishedGoals() {
        for status in ["active", "verifying", "paused"] { XCTAssertTrue(CoreGoalDraft.needsReplacement(status: status)) }
        for status in ["complete", "blocked", "awaiting_review", "cancelled"] { XCTAssertFalse(CoreGoalDraft.needsReplacement(status: status)) }
    }
    func testReplacementIdentityMustBeAValidUUID() throws {
        let params: [String: CoreJSONValue] = ["owner": .string("phone"), "prompt": .string("New objective"), "goal": .bool(true), "replaceGoalId": .string(UUID().uuidString)]
        _ = try CoreApplicationProtocol.request(op: "execution.execute", params: params, id: "goal-request", resource: "approved")
        var invalid = params; invalid["replaceGoalId"] = .string("not-a-goal-id")
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "execution.execute", params: invalid, id: "goal-request", resource: "approved"))
    }
}
