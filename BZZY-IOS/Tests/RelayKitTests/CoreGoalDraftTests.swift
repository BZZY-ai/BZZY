import XCTest
@testable import RelayKit

final class CoreGoalDraftTests: XCTestCase {
    func testSetGoalKeepsTypedTextAndNeverDuplicatesTheCommand() {
        XCTAssertEqual(CoreGoalDraft.settingGoal(""), "/goal ")
        XCTAssertEqual(CoreGoalDraft.settingGoal("tell me Messi age"), "/goal tell me Messi age")
        XCTAssertEqual(CoreGoalDraft.settingGoal("/goal"), "/goal ")
        XCTAssertEqual(CoreGoalDraft.settingGoal("/goal tell me Messi age"), "/goal tell me Messi age")
    }
    func testResumeShortcutOnlyEnablesForAnIdleStalledGoal() {
        for status in ["blocked", "usage_limited", "budget_limited", "awaiting_review"] {
            XCTAssertTrue(CoreGoalDraft.canResumeStalled(status: status, executionState: "finished"))
            for execution in ["queued", "launching", "running"] { XCTAssertFalse(CoreGoalDraft.canResumeStalled(status: status, executionState: execution)) }
        }
        for status in ["active", "verifying", "complete", "cancelled", "paused", "unknown"] { XCTAssertFalse(CoreGoalDraft.canResumeStalled(status: status)) }
        XCTAssertFalse(CoreGoalDraft.canResumeStalled(status: nil))
        XCTAssertTrue(CoreGoalDraft.canResumeStalled(status: "paused", reason: "turn_limit"))
        XCTAssertTrue(CoreGoalDraft.canResumeStalled(status: "paused", reason: "recovery_required"))
        XCTAssertFalse(CoreGoalDraft.canResumeStalled(status: "paused", reason: "user_pause"))
    }
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
    func testStalledResumeCarriesTheExactGoalIdentity() throws {
        let params: [String: CoreJSONValue] = ["owner": .string("phone"), "prompt": .string("Continue"), "goal": .bool(true),
            "resumeGoal": .bool(true), "resumeGoalId": .string(UUID().uuidString)]
        _ = try CoreApplicationProtocol.request(op: "execution.execute", params: params, id: "resume-request", resource: "approved")
        var invalid = params; invalid["resumeGoalId"] = .string("not-a-goal-id")
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "execution.execute", params: invalid, id: "resume-request", resource: "approved"))
        invalid = params; invalid["resumeGoal"] = .bool(false)
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "execution.execute", params: invalid, id: "resume-request", resource: "approved"))
    }
    func testPausedResumeRequiresAnExactGoalAndPausedState() throws {
        var params: [String: CoreJSONValue] = ["owner": .string("phone"), "prompt": .string("Continue"), "goal": .bool(true),
            "resumeGoal": .bool(true), "resumeGoalId": .string(UUID().uuidString), "resumeGoalStatus": .string("paused")]
        XCTAssertNoThrow(try CoreApplicationProtocol.request(op: "execution.execute", params: params, id: "resume", resource: "resource"))
        params.removeValue(forKey: "resumeGoalId")
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "execution.execute", params: params, id: "resume", resource: "resource"))
    }

}
