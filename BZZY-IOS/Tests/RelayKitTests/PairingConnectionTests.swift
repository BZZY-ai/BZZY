import XCTest
@testable import RelayKit

final class PairingConnectionTests: XCTestCase {
    @MainActor func testCoreChatRecoversDurableReadOnlyReplyAfterBackgroundWithoutResending() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, coreChat: true)
    }

    @MainActor func testSemanticCacheCallbacksFollowFastNavigationAndDeletionWithFreshReadySnapshot() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, semanticCache: true)
    }
    @MainActor func testCLIDeletionSynchronizesCatalogAndCacheWithoutLosingPhonePairing() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, deletionSync: true)
    }

    @MainActor func testLegacyReceiptInAnotherSessionCannotBlockVisibleTerminalOrReplayWork() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, resourceJournal: true)
    }

    @MainActor func testPhoneGoalDispatchRequiresReplacementAndUsesCoreGoalLifecycle() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, goals: true)
    }
    @MainActor func testConfirmedGoalCannotTakeCLIOwnershipWithoutHostTakeoverPermission() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, goals: true, allowTakeover: false)
    }
    @MainActor func testVoiceUsesCoreDefaultAndRecoversAfterBackgroundWithoutSendingAgain() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, voiceChat: true)
    }
    @MainActor func testNotificationCenterRoundtripKeepsAuthorizedCoreOnline() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, overlayResume: true)
    }

    @MainActor func testOwnPhoneCanConfigureHostUpdatesWithoutStartingInstallation() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, updatePreferences: true)
    }

    @MainActor func testOwnPhonePairingUnlocksWithoutConfiguredCoordinator() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false)
    }

    @MainActor func testPollingApprovalDoesNotCancelInitialCoreConnection() async throws {
        try await checkPairing(ignoreDecisionEvent: true, backgroundBeforeApproval: false)
    }

    @MainActor func testPendingPairingCompletesAfterBackgroundAndForeground() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: true)
    }

    @MainActor func testClosingCLILeavesPairedCoreSessionOnline() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, closeCLI: true)
    }

    @MainActor func testUnavailableMetricsUsesAuthorizedSessionHeartbeat() async throws {
        try await checkPairing(ignoreDecisionEvent: false, backgroundBeforeApproval: false, failMetrics: true)
    }

    @MainActor private func checkPairing(ignoreDecisionEvent: Bool, backgroundBeforeApproval: Bool,
                                        closeCLI: Bool = false, failMetrics: Bool = false, overlayResume: Bool = false, updatePreferences: Bool = false, voiceChat: Bool = false, goals: Bool = false, allowTakeover: Bool = true, resourceJournal: Bool = false, deletionSync: Bool = false, coreChat: Bool = false, semanticCache: Bool = false) async throws {
        let fixture = try PairingConnectionFixture()
        defer { fixture.shutdown() }
        let identity = try RelayIdentity.generate()
        var start: [String: WireValue] = ["op": .string("start"), "certificate": try RelayWire.object(identity.certificate), "allowTakeover": .bool(allowTakeover)]
        if deletionSync { start["alias"] = .string("Deleted fixture terminal") }
        if coreChat || semanticCache { start["alias"] = .string("Cached fixture terminal") }
        let configuration = try fixture.request(start)
        XCTAssertEqual(configuration["coordinatorConfigured"].bool, false)
        let endpoint = try XCTUnwrap(URL(string: try XCTUnwrap(configuration["endpoint"].string)))
        let transport = try RelayTransport(identity: identity, loopbackEndpoint: endpoint)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("bzzy-pair-projection-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var savedAuthorization: Data?
        let connection = try RelayConnection(isolatedIdentity: identity, loopbackTransport: transport,
            projectionDirectory: directory, loadAuthorization: { savedAuthorization }, saveAuthorization: { savedAuthorization = $0 })
        defer { connection.pause() }
        var streamed: [CoreJSONValue] = [], deliveryStates: [CoreOutgoingMessage.Status] = []
        var terminals: [CoreJSONValue] = []
        connection.onCoreSessions = { data in terminals = (try? JSONDecoder().decode([CoreJSONValue].self, from: data)) ?? [] }
        connection.onCoreEvents = { [weak connection] data in
            streamed = data.compactMap { try? JSONDecoder().decode(CoreJSONValue.self, from: $0) }
            deliveryStates += connection?.coreOutgoingMessages.map(\.status) ?? []
        }
        var presentations: [[String]: String] = [:], presentationSaves: [[String]] = [], presentationRestores: [[String]] = []
        var presentationPurges: [(String, String?, String?)] = [], paintedPresentation: String?, snapshotAliases: [String] = []
        var cancelPreview: (() -> Void)?
        if semanticCache {
            connection.onCoreSnapshot = { data in
                if let snapshot = try? JSONDecoder().decode(CoreJSONValue.self, from: data), let alias = snapshot["session"]["alias"].string { snapshotAliases.append(alias) }
            }
            connection.onCorePresentationSave = { host, resource, session, grant in
                let scope = [host, resource, session, grant]
                presentationSaves.append(scope)
                presentations[scope] = streamed.compactMap { $0["data"]["text"].string }.last ?? "Empty saved transcript"
            }
            connection.onCorePresentationRestore = { host, resource, session, grant in
                let scope = [host, resource, session, grant]
                guard let cached = presentations[scope] else { return false }
                presentationRestores.append(scope); paintedPresentation = cached; cancelPreview?()
                return true
            }
            connection.onCorePresentationPurge = { host, grant, session in
                presentationPurges.append((host, grant, session))
                presentations = presentations.filter { scope, _ in
                    !(scope[0] == host && (grant == nil || scope[3] == grant) && (session == nil || scope[2] == session))
                }
            }
        }
        var availabilityFailures: [String] = []
        connection.onCoreAvailability = { available, message in
            if !available && message.hasPrefix("Core session unavailable") { availabilityFailures.append(message) }
        }
        await connection.connect()
        XCTAssertEqual(connection.status, .connected)
        if ignoreDecisionEvent {
            let handler = transport.onEvent
            transport.onEvent = { event, payload in if event != "invite.decided" { handler?(event, payload) } }
        }
        if backgroundBeforeApproval {
            connection.previewPairing(try XCTUnwrap(configuration["code"].string),
                expectedFingerprint: try XCTUnwrap(configuration["host"]["id"].string))
        } else {
            connection.previewPairing(try XCTUnwrap(configuration["qr"].string))
        }
        XCTAssertTrue(connection.hasPairingPreview)
        await connection.claimConfirmedHost()
        XCTAssertEqual(connection.pairingStatus, "Pending approval")
        XCTAssertFalse(connection.corePairAuthorized)
        XCTAssertFalse(connection.coreActionsAvailable)
        XCTAssertNotNil(savedAuthorization, "The claimed invitation must survive app suspension")
        try await eventually {
            try fixture.request(["op": .string("state")])["pendingCount"].integer == 1
        }
        if backgroundBeforeApproval { connection.pause() }
        XCTAssertEqual(try fixture.request(["op": .string("approve")])["approved"].bool, true)
        if backgroundBeforeApproval { await connection.resume() }
        try await eventually { connection.coreActionsAvailable }
        XCTAssertTrue(connection.hasHost)
        XCTAssertTrue(connection.corePairAuthorized, "The real onboarding gate must unlock after scoped Core responses")
        XCTAssertEqual(connection.pairingStatus, "Paired")
        XCTAssertTrue(connection.coreCatalogReady)
        XCTAssertTrue(connection.coreCatalogAvailable)
        XCTAssertTrue(connection.coreAgentsAvailable)
        XCTAssertTrue(connection.coreSharingAllowed)
        XCTAssertFalse(connection.coreIsAssistant, "A terminal pair must not depend on coordinator setup")
        XCTAssertEqual(connection.corePermissions, Set(["observe", "claim", "takeover", "execute", "answer", "pause", "cancel", "steer"].filter { allowTakeover || $0 != "takeover" }))
        XCTAssertTrue(availabilityFailures.isEmpty, "Approval must not cancel its own initial Core read: \(availabilityFailures)")
        if coreChat {
            await connection.prepareCoreChat()
            XCTAssertFalse(connection.chatConfigured); XCTAssertEqual(connection.chatErrorCode, "ASSISTANT_SETUP_REQUIRED")
            let seed = try fixture.request(["op": .string("goal-seed")])
            _ = try fixture.request(["op": .string("chat-configure")])
            await connection.prepareCoreChat(); XCTAssertTrue(connection.chatConfigured)
            XCTAssertEqual(try fixture.request(["op": .string("state")])["assessmentTurnCount"].integer, 0)
            let originalSession = connection.coreSessionID
            let accepted = await connection.sendCoreChatText("SYNTHETIC_READ_ONLY_ASSESSMENT")
            XCTAssertTrue(accepted)
            XCTAssertEqual(connection.chatMessages.filter(\.isUser).map(\.text), ["SYNTHETIC_READ_ONLY_ASSESSMENT"])
            XCTAssertFalse(String(data: savedAuthorization ?? Data(), encoding: .utf8)?.contains("SYNTHETIC_READ_ONLY_ASSESSMENT") ?? true)
            connection.pause(); await connection.resume()
            try await eventually { connection.coreActionsAvailable }
            await connection.prepareCoreChat()
            try await eventually { connection.chatPhase == "idle" && connection.chatMessages.contains { !$0.isUser } }
            let reply = try XCTUnwrap(connection.chatMessages.last { !$0.isUser })
            XCTAssertEqual(reply.text, "{\"lessons\":[],\"skills\":[],\"profiles\":[]}")
            XCTAssertNotNil(reply.observedAt)
            XCTAssertEqual(connection.coreSessionID, originalSession); XCTAssertFalse(connection.coreIsAssistant)
            let state = try fixture.request(["op": .string("state")])
            XCTAssertEqual(state["chatSendRequests"].integer, 1); XCTAssertEqual(state["assessmentTurnCount"].integer, 1)
            XCTAssertEqual(state["executionCount"].integer, 0); XCTAssertEqual(state["inputClaimRequests"].integer, 0)
            let goal = try fixture.request(["op": .string("goal-state")])
            XCTAssertEqual(goal["goalID"].string, seed["goalID"].string)
            XCTAssertEqual(goal["status"].string, "active"); XCTAssertEqual(goal["objective"].string, "Previous unfinished goal")
            connection.pause()
            let restoredTransport = try RelayTransport(identity: identity, loopbackEndpoint: endpoint)
            let restored = try RelayConnection(isolatedIdentity: identity, loopbackTransport: restoredTransport,
                projectionDirectory: directory, loadAuthorization: { savedAuthorization }, saveAuthorization: { savedAuthorization = $0 })
            defer { restored.pause() }
            try restored.restoreSavedHosts()
            XCTAssertEqual(restored.chatMessages, connection.chatMessages, "Reopening restores complete private Chat rows before networking")
            XCTAssertFalse(restored.coreActionsAvailable, "Cached Chat is never proof of Core readiness")
            await restored.connect(); try await eventually { restored.coreActionsAvailable }
            await restored.prepareCoreChat()
            XCTAssertEqual(restored.chatMessages.last { !$0.isUser }?.id, reply.id)
            XCTAssertEqual(try fixture.request(["op": .string("state")])["chatSendRequests"].integer, 1, "Background/reopen must poll or read, never resend")
            _ = try fixture.request(["op": .string("chat-hide-sources")])
            let rejected = await restored.sendCoreChatText("SYNTHETIC_REJECTED_QUESTION")
            XCTAssertFalse(rejected, "A definite source rejection must retain the editable question")
            XCTAssertEqual(restored.chatPhase, "failed")
            XCTAssertEqual(restored.chatErrorCode, "CHAT_SOURCE_UNAVAILABLE")
            XCTAssertFalse(restored.chatWaiting, "A rejected question must not become an unresolved receipt")
            XCTAssertEqual(try fixture.request(["op": .string("state")])["assessmentTurnCount"].integer, 1, "Rejected input starts no model work")
            return
        }
        if semanticCache {
            let firstID = connection.coreSessionID
            _ = try fixture.request(["op": .string("cache-seed"), "text": .string("SEMANTIC_A_REPLY")])
            try await eventually { streamed.contains { $0["data"]["text"].string == "SEMANTIC_A_REPLY" } }
            try await eventually { presentationSaves.contains { $0[2] == firstID } }
            let second = try fixture.request(["op": .string("second-session")]), secondID = try XCTUnwrap(second["sessionId"].string)
            _ = try fixture.request(["op": .string("cache-seed"), "sessionId": .string(secondID), "text": .string("SEMANTIC_B_REPLY")])
            await connection.refreshCoreSessions()
            let visitSecond = Task { await connection.observeCoreSession(secondID) }
            try await eventually { connection.isCoreSessionReady(secondID) }
            try await eventually { presentationSaves.contains { $0[2] == secondID } }
            visitSecond.cancel(); await visitSecond.value
            let visitFirst = Task { await connection.observeCoreSession(firstID) }
            try await eventually { connection.isCoreSessionReady(firstID) }
            visitFirst.cancel(); await visitFirst.value
            XCTAssertTrue(connection.isCoreSessionReady(firstID))
            // A rapid B preview is cancelled before attachment can replace the
            // still-authorized A client. Returning to A must hydrate its cached
            // tail and then refresh metadata from that exact ready client.
            var preview: Task<Void, Never>?
            cancelPreview = { preview?.cancel() }
            let restoredBefore = presentationRestores.count
            preview = Task { await connection.observeCoreSession(secondID) }
            try await eventually { presentationRestores.count > restoredBefore }
            await preview?.value; cancelPreview = nil
            XCTAssertTrue(connection.isCoreSessionReady(firstID))
            XCTAssertEqual(paintedPresentation, "SEMANTIC_B_REPLY")
            _ = try fixture.request(["op": .string("session-alias"), "alias": .string("Fresh ready alias")])
            let snapshotCount = snapshotAliases.count, restoreCount = presentationRestores.count
            let returnFirst = Task { await connection.observeCoreSession(firstID) }
            defer { returnFirst.cancel() }
            try await eventually(seconds: 2) { presentationRestores.count > restoreCount && paintedPresentation == "SEMANTIC_A_REPLY" }
            try await eventually(seconds: 2) { snapshotAliases.dropFirst(snapshotCount).contains("Fresh ready alias") }
            XCTAssertTrue(connection.isCoreSessionReady(firstID))
            XCTAssertTrue(presentationSaves.allSatisfy { $0[0] == configuration["host"]["id"].string && !$0[1].isEmpty && !$0[3].isEmpty })
            _ = try fixture.request(["op": .string("session-delete")])
            try await eventually { presentationPurges.contains { $0.2 == firstID } }
            XCTAssertFalse(presentations.keys.contains { $0[2] == firstID })
            XCTAssertTrue(connection.corePairAuthorized)
            await connection.forgetHost()
            XCTAssertTrue(presentationPurges.contains { $0.2 == nil })
            XCTAssertTrue(presentations.isEmpty); XCTAssertFalse(connection.corePairAuthorized)
            XCTAssertEqual(try fixture.request(["op": .string("state")])["executionCount"].integer, 0)
            return
        }
        if deletionSync {
            let originalID = connection.coreSessionID
            let viewing = Task { await connection.observeCoreSession(originalID) }
            defer { viewing.cancel() }
            let other = try fixture.request(["op": .string("second-session")])
            let otherID = try XCTUnwrap(other["sessionId"].string)
            await connection.refreshCoreSessions()
            XCTAssertTrue(terminals.contains { $0["id"].string == otherID })
            XCTAssertEqual(try fixture.request(["op": .string("session-delete"), "sessionId": .string(otherID)])["state"].string, "deleted")
            // Metrics can keep the connection lease fresh. Catalog revision
            // observation must still remove the other chat without manual refresh.
            try await eventually { !terminals.contains { $0["id"].string == otherID } }
            XCTAssertTrue(connection.corePairAuthorized); XCTAssertTrue(connection.coreActionsAvailable)
            XCTAssertEqual(try fixture.request(["op": .string("deletion-seed")])["seeded"].bool, true)
            try await eventually { streamed.contains { $0["data"]["text"].string == "DELETION_SYNTHETIC_ANSWER" } }
            XCTAssertEqual(try fixture.request(["op": .string("deletion-advisory")])["appended"].bool, true)
            try await eventually { streamed.contains { $0["type"].string == "session.deleted" } }
            XCTAssertFalse(connection.coreSessionDeleted, "A historical deletion marker cannot replace Core's actual tombstone state")
            XCTAssertTrue(streamed.contains { $0["data"]["text"].string == "DELETION_SYNTHETIC_ANSWER" })
            XCTAssertEqual(try fixture.request(["op": .string("session-delete")])["state"].string, "deleted")
            try await eventually { connection.coreSessionDeleted && connection.coreRemovedSessionID == originalID && !terminals.contains { $0["id"].string == originalID } }
            XCTAssertTrue(connection.corePairAuthorized, "Deleting the pairing anchor must preserve its host authorization")
            XCTAssertTrue(connection.coreActionsAvailable, "Catalog-only Core remains online after its chat is deleted")
            XCTAssertFalse(connection.isCoreSessionReady(originalID))
            XCTAssertNil(connection.desiredCoreSessionID, "Deleted view intent cannot reopen the chat")
            XCTAssertTrue(streamed.isEmpty)
            let cacheFiles = try XCTUnwrap(FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.isRegularFileKey]))
            for case let file as URL in cacheFiles {
                guard try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { continue }
                let contents = String(data: try Data(contentsOf: file), encoding: .utf8) ?? ""
                XCTAssertFalse(contents.contains("DELETION_SYNTHETIC_ANSWER"), "Deleted chat bodies cannot remain in its phone cache")
            }
            let replacement = try fixture.request(["op": .string("second-session")])
            let replacementID = try XCTUnwrap(replacement["sessionId"].string)
            await connection.refreshCoreSessions()
            let replacementView = Task { await connection.observeCoreSession(replacementID) }
            defer { replacementView.cancel() }
            try await eventually { connection.isCoreSessionReady(replacementID) }
            let accepted = await connection.sendCoreMessage("SYNTHETIC_AFTER_DELETION", sessionID: replacementID)
            XCTAssertTrue(accepted)
            try await eventually { try fixture.request(["op": .string("state")])["executionCount"].integer == 1 }
            XCTAssertTrue(connection.corePairAuthorized)
            return
        }
        if resourceJournal {
            var journalPhase = "create second session"
            var journalDiagnostics: () -> String = { "not restored" }
            do {
            let firstID = connection.coreSessionID
            let second = try fixture.request(["op": .string("second-session")])
            let secondID = try XCTUnwrap(second["sessionId"].string)
            XCTAssertTrue(second["catalogEligible"].bool == true, "Disposable second session must be catalog-eligible")
            XCTAssertEqual(second["sessionCount"].integer, 2)
            connection.pause()
            let collection = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(savedAuthorization)) as? [String: Any])
            let firstProfile = try XCTUnwrap((collection["profiles"] as? [[String: Any]])?.first)
            var saved = try XCTUnwrap(firstProfile["state"] as? [String: Any])
            let scope = try XCTUnwrap(saved["coreCacheScope"] as? [String: Any])
            let unknownID = UUID().uuidString
            // Restore the old on-device schema with an unresolved request in A.
            // No command with this ID was executed by the disposable fixture.
            saved["pendingCoreCommand"] = ["hostID": try XCTUnwrap(scope["hostID"] as? String),
                "resource": try XCTUnwrap(scope["resource"] as? String), "id": unknownID,
                "op": "execution.execute", "params": ["owner": UUID().uuidString, "prompt": "Unsent fixture input", "goal": false]]
            savedAuthorization = try JSONSerialization.data(withJSONObject: saved)
            let restoredTransport = try RelayTransport(identity: identity, loopbackEndpoint: endpoint)
            let restored = try RelayConnection(isolatedIdentity: identity, loopbackTransport: restoredTransport,
                projectionDirectory: directory, loadAuthorization: { savedAuthorization }, saveAuthorization: { savedAuthorization = $0 })
            defer { restored.pause() }
            var restoredAvailability: [String] = []
            restored.onCoreAvailability = { available, message in
                if !available, restoredAvailability.last != message { restoredAvailability.append(message) }
            }
            journalDiagnostics = { [weak restored] in
                guard let restored else { return "released" }
                return "online=\(restored.connectionOnline) connected=\(restored.coreConnected) busy=\(restored.coreBusy) attaching=\(restored.coreAttaching) catalog=\(restored.coreCatalogReady)/\(restored.coreCatalogAvailable) target=\(restored.coreSessionID == secondID) pair=\(restored.corePairAuthorized) relay=\(restored.status.rawValue) failures=\(restoredAvailability) error=\(restored.coreError ?? "none")"
            }
            journalPhase = "restore first connection"
            await restored.connect()
            try await eventually { restored.isCoreSessionReady(firstID) }
            XCTAssertTrue(restored.hasUncertainCoreCommand(sessionID: firstID))
            // Refresh and opening overlap deliberately: the visible attachment
            // must wait/retry through startup rather than fail once and go blank.
            journalPhase = "attach second session"
            var catalogContainsSecond = false
            restored.onCoreSessions = { data in
                guard let entries = try? JSONDecoder().decode([CoreJSONValue].self, from: data) else { return }
                catalogContainsSecond = entries.contains { $0["id"].string == secondID }
            }
            let refresh = Task { await restored.refreshCoreSessions() }
            let viewing = Task { await restored.observeCoreSession(secondID) }
            defer { viewing.cancel() }
            do { try await eventually { restored.isCoreSessionReady(secondID) } }
            catch { print("JOURNAL attachment before cleanup:", journalDiagnostics(), "catalogContainsTarget=", catalogContainsSecond); throw error }
            await refresh.value
            XCTAssertTrue(restored.connectionOnline)
            XCTAssertFalse(restored.hasUncertainCoreCommand(sessionID: secondID))
            XCTAssertFalse(restored.isCoreSessionBusy(secondID))
            journalPhase = "send second session"
            let accepted = await restored.sendCoreMessage("SYNTHETIC_SECOND_SESSION", sessionID: secondID)
            XCTAssertTrue(accepted, "An unresolved receipt in A cannot disable input in B")
            try await eventually { try fixture.request(["op": .string("state")])["executionCount"].integer == 1 }
            let migratedCollection = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(savedAuthorization)) as? [String: Any])
            let migratedProfile = try XCTUnwrap((migratedCollection["profiles"] as? [[String: Any]])?.first)
            let migrated = try XCTUnwrap(migratedProfile["state"] as? [String: Any])
            XCTAssertNil(migrated["pendingCoreCommand"], "The legacy field is migrated on the next journal write")
            let journal = try XCTUnwrap(migrated["pendingCoreCommands"] as? [[String: Any]])
            XCTAssertTrue(journal.contains { $0["id"] as? String == unknownID }, "Unknown receipts retain their original request identity")
            restored.pause()
            try await Task.sleep(for: .milliseconds(600))
            XCTAssertFalse(restored.coreActionsAvailable, "A surviving view task cannot undo actual app suspension")
            journalPhase = "resume visible second session"
            await restored.resume()
            try await eventually { restored.isCoreSessionReady(secondID) }
            XCTAssertEqual(try fixture.request(["op": .string("state")])["executionCount"].integer, 1, "Recovery never replays either input")
            viewing.cancel()
            return
            } catch { print("JOURNAL regression phase:", journalPhase, "error:", String(describing: error), journalDiagnostics()); throw error }
        }
        if goals {
            var phase = "seed"
            do {
            let seed = try fixture.request(["op": .string("goal-seed")])
            XCTAssertEqual(try fixture.request(["op": .string("cli-attach")])["ownsInput"].bool, true)
            await connection.refreshCore()
            XCTAssertTrue(connection.coreGoalSubmission)
            XCTAssertEqual(connection.coreGoalID, seed["goalID"].string)
            let rejected = await connection.sendCoreMessage("/goal New mobile objective")
            XCTAssertFalse(rejected)
            XCTAssertEqual(try fixture.request(["op": .string("goal-state")])["executionCount"].integer, 0)
            XCTAssertEqual(try fixture.request(["op": .string("goal-state")])["inputHeldByCLI"].bool, true, "An unconfirmed goal never takes input")
            phase = "goal acceptance"
            let accepted = await connection.sendCoreMessage("/goal New mobile objective", replaceGoalID: seed["goalID"].string)
            XCTAssertEqual(accepted, allowTakeover)
            if allowTakeover {
                try await eventually { try fixture.request(["op": .string("goal-state")])["status"].string == "complete" }
                let result = try fixture.request(["op": .string("goal-state")])
                XCTAssertEqual(result["objective"].string, "New mobile objective")
                XCTAssertEqual(result["goalExecution"].bool, true)
                XCTAssertEqual(result["executionCount"].integer, 1)
                XCTAssertEqual(result["notificationCount"].integer, 1)
                XCTAssertEqual(result["inputHeldByCLI"].bool, false)
                XCTAssertNotEqual(result["goalID"].string, seed["goalID"].string)
                XCTAssertTrue(connection.coreOwnsInput)
                try await eventually { streamed.contains(where: { $0["type"].string == "text" && ($0["data"]["text"].string ?? "").contains("Verified the full objective") }) }
                XCTAssertTrue(deliveryStates.contains(.sending))
                XCTAssertTrue(connection.coreOutgoingMessages.isEmpty)
                // Cross both clients' former lease/heartbeat boundaries while
                // the actual CLI stays attached and receives the full reply.
                phase = "watch after completion"
                try await Task.sleep(for: .seconds(16))
                let watched = try fixture.request(["op": .string("goal-state")])
                XCTAssertEqual(watched["cliFinished"].bool, false)
                XCTAssertEqual(watched["cliMode"].string, "VIEW")
                XCTAssertTrue(watched["cliText"].string?.contains("Verified the full objective") == true)
                XCTAssertNil(connection.coreError)
                phase = "CLI followup"
                XCTAssertEqual(try fixture.request(["op": .string("cli-send"), "text": .string("CLI_STREAM_FOLLOWUP")])["sent"].bool, true)
                try await eventually {
                    let progress = try fixture.request(["op": .string("goal-state")])
                    return progress["executionCount"].integer == 2 && progress["latestExecution"]["state"].string == "finished"
                }
                try await Task.sleep(for: .seconds(16))
                XCTAssertTrue(connection.coreActionsAvailable); XCTAssertNil(connection.coreError)
                XCTAssertFalse(connection.coreOwnsInput)
                XCTAssertTrue(streamed.contains { $0["type"].string == "message.user" && $0["data"]["text"].string == "CLI_STREAM_FOLLOWUP" })
                phase = "phone followup"
                let followup = await connection.sendCoreMessage("PHONE_STREAM_FOLLOWUP")
                XCTAssertTrue(followup)
                try await eventually {
                    let progress = try fixture.request(["op": .string("goal-state")])
                    return progress["executionCount"].integer == 3 && progress["latestExecution"]["state"].string == "finished"
                }
                XCTAssertEqual(try fixture.request(["op": .string("goal-state")])["cliFinished"].bool, false)
                XCTAssertEqual(try fixture.request(["op": .string("state")])["inputClaimRequests"].integer, 0, "The phone submits to Core; it never preclaims a lease")
                try await eventually { connection.coreOutgoingMessages.isEmpty }
            } else {
                let result = try fixture.request(["op": .string("goal-state")])
                XCTAssertEqual(result["goalID"].string, seed["goalID"].string)
                XCTAssertEqual(result["executionCount"].integer, 0)
                XCTAssertEqual(result["inputHeldByCLI"].bool, true)
                XCTAssertFalse(connection.coreOwnsInput)
                let failed = try XCTUnwrap(connection.coreOutgoingMessages.first)
                XCTAssertEqual(failed.status, .failed)
                await connection.retryOutgoingMessage(failed.id)
                let retried = try XCTUnwrap(connection.coreOutgoingMessages.first)
                XCTAssertEqual(retried.id, failed.id, "Retry preserves the same visible bubble")
                XCTAssertNotEqual(retried.requestID, failed.requestID, "A definitive rejection needs a new admission ID")
                XCTAssertEqual(retried.status, .failed, "Retry cannot manufacture missing grant permissions")
                XCTAssertEqual(try fixture.request(["op": .string("goal-state")])["executionCount"].integer, 0)
                XCTAssertEqual(try fixture.request(["op": .string("goal-state")])["inputHeldByCLI"].bool, true)
            }
            phase = "close CLI viewer"
            _ = try fixture.request(["op": .string("cli-close")])
            XCTAssertEqual(connection.coreOwnsInput, allowTakeover, "Closing CLI cannot release the phone's transferred lease")
            } catch { print("HANDOFF failure phase:", phase, "error:", String(describing: error)); throw error }
        }
        if voiceChat {
            await connection.prepareVoiceChat()
            XCTAssertFalse(connection.voiceConfigured)
            XCTAssertEqual(connection.voiceErrorCode, "ASSISTANT_SETUP_REQUIRED")
            _ = try fixture.request(["op": .string("voice-configure")])
            await connection.prepareVoiceChat()
            XCTAssertTrue(connection.voiceConfigured)
            XCTAssertEqual(try fixture.request(["op": .string("state")])["executionCount"].integer, 0, "Checking voice readiness never starts work")
            let accepted = await connection.sendVoiceText("SYNTHETIC_NATIVE_VOICE")
            XCTAssertTrue(accepted)
            XCTAssertFalse(String(data: savedAuthorization ?? Data(), encoding: .utf8)?.contains("SYNTHETIC_NATIVE_VOICE") ?? true, "Only the request receipt is saved on the phone")
            connection.pause()
            await connection.resume()
            try await eventually { connection.coreActionsAvailable }
            await connection.prepareVoiceChat()
            try await eventually { connection.voicePhase == "answered" }
            XCTAssertTrue(connection.voiceReply.contains("First pass"))
            XCTAssertFalse(connection.coreIsAssistant, "Voice must not replace the selected terminal resource")
            XCTAssertEqual(try fixture.request(["op": .string("state")])["executionCount"].integer, 1)
        }
        if updatePreferences {
            await connection.refreshCoreUpdates()
            XCTAssertEqual(connection.coreUpdateSnapshot?["remoteUpdatesEnabled"].bool, false)
            await connection.configureCoreUpdates(["remoteUpdatesEnabled": .bool(true), "notificationsEnabled": .bool(false), "monitoringEnabled": .bool(false)])
            XCTAssertEqual(connection.coreUpdateSnapshot?["remoteUpdatesEnabled"].bool, true)
            XCTAssertEqual(connection.coreUpdateSnapshot?["notificationsEnabled"].bool, false)
            await connection.refreshCoreUpdates()
            XCTAssertEqual(connection.coreUpdateSnapshot?["remoteUpdatesEnabled"].bool, true)
            XCTAssertEqual(try fixture.request(["op": .string("state")])["executionCount"].integer, 0)
        }
        if overlayResume {
            var outages: [String] = []
            connection.onCoreAvailability = { available, message in if !available { outages.append(message) } }
            for _ in 0..<3 { await connection.resume(); XCTAssertTrue(connection.coreActionsAvailable) }
            XCTAssertTrue(outages.isEmpty, "Inactive overlays must preserve the healthy scoped connection")
            XCTAssertEqual(try fixture.request(["op": .string("state")])["subscriptions"].integer, 1)
        }
        if closeCLI || failMetrics {
            var outages: [String] = []
            connection.onCoreAvailability = { available, message in if !available { outages.append(message) } }
            if closeCLI {
                let attached = try fixture.request(["op": .string("cli-attach")])
                XCTAssertEqual(attached["attached"].bool, true)
                XCTAssertEqual(attached["ownsInput"].bool, true)
                let closed = try fixture.request(["op": .string("cli-close")])
                XCTAssertEqual(closed["closed"].bool, true)
                XCTAssertEqual(closed["ownsInput"].bool, false, "The real CLI close path releases its own lease")
            }
            if failMetrics { _ = try fixture.request(["op": .string("metrics-failure")]) }
            // Cross both heartbeat expiry (8s) and the normal session refresh
            // interval (12s), so a cached healthy state cannot pass this check.
            let deadline = Date().addingTimeInterval(13)
            while Date() < deadline {
                try await Task.sleep(for: .milliseconds(100))
                guard connection.coreActionsAvailable && outages.isEmpty else {
                    XCTFail("Healthy scoped Core lost readiness: \(outages), \(connection.coreError ?? "no error")")
                    break
                }
            }
            let state = try fixture.request(["op": .string("state")])
            XCTAssertEqual(state["gateway"].string, "ready")
            XCTAssertEqual(state["subscriptions"].integer, 1)
            XCTAssertEqual(state["activeGrants"].integer, 1)
            XCTAssertEqual(state["executionCount"].integer, 0)
            XCTAssertTrue(connection.coreActionsAvailable)
            XCTAssertTrue(outages.isEmpty)
            if failMetrics {
                XCTAssertGreaterThanOrEqual(state["metricsFailures"].integer ?? 0, 2)
                XCTAssertNil(connection.hostMetrics, "Missing metrics must remain honest while a session heartbeat proves readiness")
            }
        }
        connection.pause()
        XCTAssertTrue(connection.corePairAuthorized)
        XCTAssertFalse(connection.coreActionsAvailable)
        await connection.resume()
        do { try await eventually { connection.coreActionsAvailable } }
        catch { print("HANDOFF reconnect failed:", connection.coreError ?? "none", connection.hostStatus, connection.status, connection.errorMessage ?? "none"); throw error }
        let state = try fixture.request(["op": .string("state")])
        XCTAssertEqual(state["executionCount"].integer, goals && allowTakeover ? 3 : voiceChat ? 1 : 0, "Pairing and reconnecting observe only")
        XCTAssertEqual(state["coordinatorConfigured"].bool, voiceChat)
        XCTAssertEqual(state["activeGrants"].integer, 1)
        if goals && allowTakeover {
            XCTAssertFalse(connection.canResumeStalledGoal, "A completed goal keeps the shortcut disabled")
            let stalled = try fixture.request(["op": .string("goal-stall")])
            await connection.refreshCore()
            try await eventually { connection.canResumeStalledGoal }
            XCTAssertEqual(connection.coreGoalID, stalled["goalID"].string)
            let accepted = await connection.resumeStalledCoreGoal(sessionID: connection.coreSessionID)
            XCTAssertTrue(accepted)
            try await eventually { try fixture.request(["op": .string("goal-state")])["status"].string == "complete" }
            await connection.refreshCore()
            XCTAssertFalse(connection.canResumeStalledGoal)
            let resumed = try fixture.request(["op": .string("goal-state")])
            XCTAssertEqual(resumed["goalID"].string, stalled["goalID"].string)
            XCTAssertEqual(resumed["executionCount"].integer, 4, "A shortcut continues the saved goal exactly once")
        }
        if failMetrics {
            XCTAssertEqual(try fixture.request(["op": .string("core-stop")])["stopped"].bool, true)
            try await eventually { !connection.coreActionsAvailable }
            XCTAssertEqual(connection.status, .connected, "Relay can remain online while Core is explicitly stopped")
            XCTAssertTrue(connection.corePairAuthorized, "An offline Core does not revoke the valid pairing")
            XCTAssertFalse(connection.coreActionsAvailable, "A failed fallback must lock Core-dependent actions")
            XCTAssertFalse(connection.connectionOnline, "Relay availability cannot make the bottom indicator green")
            await connection.refreshCoreSessions()
            XCTAssertFalse(connection.connectionOnline)
            XCTAssertEqual(try fixture.request(["op": .string("core-restart")])["restarted"].bool, true)
            try await eventually { connection.connectionOnline }
            XCTAssertTrue(connection.coreActionsAvailable, "Actions reactivate automatically after a fresh Core response")
            await connection.refreshCoreSessions()
            XCTAssertNil(connection.coreError)
        }
    }

    @MainActor private func eventually(seconds: TimeInterval = 15, _ condition: () throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if try condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw CoreApplicationError("PAIRING_FIXTURE_TIMEOUT")
    }
}

private final class PairingConnectionFixture {
    private let process = Process(), input = Pipe(), output = Pipe(), errors = Pipe()
    private var buffer = Data(), stopped = false
    init() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [ProcessInfo.processInfo.environment["BZZY_TEST_NODE"] ?? "node", root.appendingPathComponent("tools/pairing-connection-fixture.mjs").path]
        let allowed = Set(["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "SHELL", "USER", "LOGNAME"])
        process.environment = ProcessInfo.processInfo.environment.filter { allowed.contains($0.key) }
        let version = Process(), versionOutput = Pipe()
        version.executableURL = process.executableURL; version.arguments = [process.arguments![0], "--version"]
        version.environment = process.environment; version.standardOutput = versionOutput; version.standardError = FileHandle.nullDevice
        try version.run(); version.waitUntilExit()
        let text = String(decoding: versionOutput.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard version.terminationStatus == 0, let major = Int(text.dropFirst().split(separator: ".").first ?? ""), major >= 24 else {
            throw XCTSkip("Pairing integration requires Node.js 24+; set BZZY_TEST_NODE and PATH")
        }
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        try process.run()
    }
    func request(_ fields: [String: WireValue]) throws -> WireValue {
        try input.fileHandleForWriting.write(contentsOf: WireValue.object(fields).data() + Data([10]))
        while !buffer.contains(10) {
            let next = output.fileHandleForReading.availableData
            guard !next.isEmpty, buffer.count + next.count <= 65_536 else { throw CoreApplicationError("PAIRING_FIXTURE_PROCESS_FAILED") }
            buffer.append(next)
        }
        let newline = buffer.firstIndex(of: 10)!
        let data = buffer.prefix(upTo: newline); buffer.removeSubrange(...newline)
        let frame = try WireValue.parse(Data(data))
        guard frame["ok"].bool == true else { throw CoreApplicationError("PAIRING_FIXTURE_" + (frame["error"].string ?? "FAILED")) }
        return frame["result"]
    }
    func shutdown() {
        guard !stopped else { return }; stopped = true
        if process.isRunning {
            _ = try? request(["op": .string("stop")])
            try? input.fileHandleForWriting.close(); process.waitUntilExit()
        }
    }
    deinit { if process.isRunning { process.terminate() } }
}
