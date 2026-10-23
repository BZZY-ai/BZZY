import XCTest
@testable import RelayKit

final class CoreConnectionHealthTests: XCTestCase {
    func testRelayPresenceAloneCannotUnlockCoreAndAHeartbeatExpires() {
        var health = CoreConnectionHealth()
        let now = Date(timeIntervalSince1970: 1000)
        let epoch = health.begin(scope: "approved-session")
        XCTAssertEqual(health.phase, .connecting)
        XCTAssertFalse(health.isOnline(at: now), "Relay connection/presence is not a Core response")
        XCTAssertTrue(health.confirm(epoch, scope: "approved-session", at: now))
        XCTAssertTrue(health.isOnline(at: now.addingTimeInterval(7)))
        XCTAssertFalse(health.isOnline(at: now.addingTimeInterval(9)), "Missing heartbeats must lock stale sessions")
        XCTAssertFalse(health.isOnline(at: now.addingTimeInterval(-1)), "A backward wall-clock change cannot extend readiness")
    }
    func testStopDisconnectOrBackgroundCannotBeUndoneByALateHeartbeat() {
        for _ in ["operator stop", "Relay disconnect", "background"] {
            var health = CoreConnectionHealth()
            let epoch = health.begin(scope: "session")
            XCTAssertTrue(health.confirm(epoch, scope: "session"))
            health.disconnect()
            XCTAssertFalse(health.confirm(epoch, scope: "session"))
            XCTAssertEqual(health.phase, .offline)
            XCTAssertFalse(health.isOnline())
            let reconnect = health.begin(scope: "session")
            XCTAssertFalse(health.confirm(epoch, scope: "session"))
            XCTAssertFalse(health.isOnline(), "Foreground/reconnect requires a new authoritative response")
            XCTAssertTrue(health.confirm(reconnect, scope: "session"))
        }
    }
    func testNewSessionOrPairGenerationRejectsPreviousScopeResponses() {
        var health = CoreConnectionHealth()
        let first = health.begin(scope: "host-one-session")
        let second = health.begin(scope: "host-two-session")
        XCTAssertFalse(health.confirm(first, scope: "host-one-session"))
        XCTAssertFalse(health.confirm(second, scope: "host-one-session"))
        XCTAssertFalse(health.isOnline())
        XCTAssertTrue(health.confirm(second, scope: "host-two-session"))
    }
    #if DEBUG
    @MainActor func testPairedOfflineConnectionPreservesPairButRejectsEveryCoreMutation() async throws {
        let relay = try RelayConnection.pairedOfflinePreview()
        XCTAssertTrue(relay.corePairAuthorized)
        XCTAssertEqual(relay.status, .connected, "Fixture deliberately distinguishes Relay from Core")
        XCTAssertFalse(relay.coreActionsAvailable)
        XCTAssertEqual(relay.coreConnectionLabel, "Core offline")
        let attempts = [
            await relay.sendCoreMessage("Do not execute"), await relay.resumeCoreGoal(),
            await relay.controlCore("pause"), await relay.controlCore("cancel"),
            await relay.claimCoreInput(takeover: true), await relay.openCoreSession(UUID().uuidString),
            await relay.openCoreAgent(UUID().uuidString),
            await relay.mutateCoreAgent("agents.create", params: ["name": .string("Blocked")]),
            await relay.mutateCoreAgent("agents.archive", params: ["agentId": .string(UUID().uuidString)])
        ]
        XCTAssertTrue(attempts.allSatisfy { !$0 }, "Every offline control/creation path must reject before dispatch")
        do { _ = try await relay.requestCoreShare("share.create", sessionID: UUID().uuidString, requestID: UUID().uuidString); XCTFail("Offline sharing") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "FORBIDDEN") }
        for operation in ["agents.status", "agents.providers"] {
            do { _ = try await relay.readCoreAgent(operation); XCTFail("Offline Agent catalog") }
            catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "FORBIDDEN") }
        }
        do { _ = try await relay.readCoreAgentModels("fixture"); XCTFail("Offline models") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "FORBIDDEN") }
        let notificationStatus = await relay.synchronizeCoreNotifications(token: nil, environment: nil, enabled: true)
        XCTAssertEqual(notificationStatus, "Waiting for authorized Core connection")
        do { try await relay.beginCoreAgentImport(code: "unused", sourceFingerprint: "unused", provider: "unused", model: "default", effort: "default"); XCTFail("Offline import") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "FORBIDDEN") }
        do { _ = try await relay.refreshCoreAgentImport(); XCTFail("Offline import status") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "FORBIDDEN") }
        XCTAssertFalse(relay.coreAgentImportPending)
        await relay.refreshCoreSessions()
        await relay.refreshCoreAgents()
        await relay.reconcileNotificationResource("untrusted-notification", sessionID: UUID().uuidString)
        XCTAssertFalse(relay.coreAgentMutationPending)
        XCTAssertFalse(relay.coreSessionAttachmentPending)
        XCTAssertNil(relay.hostMetrics)
        relay.pause()
        XCTAssertTrue(relay.corePairAuthorized, "Backgrounding preserves the approved pairing")
        XCTAssertFalse(relay.coreActionsAvailable)
        await relay.resume()
        XCTAssertTrue(relay.corePairAuthorized)
        XCTAssertFalse(relay.coreActionsAvailable, "Resuming alone never fabricates Core readiness")
    }
    #endif
}
