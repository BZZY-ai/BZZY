import Foundation

@main
struct ModelChecks {
    @MainActor static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("model-check-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("workspace.json")
        let store = WorkspaceStore(persistenceURL: file)
        let production = WorkspaceStore(includeSamples: false)
        checkDelayedHostActionIsolation()
        production.saveComposerDraft("Test machine draft", hostID: "test-host", conversationID: "same-session", persist: true)
        require(production.composerDraft(hostID: "real-host", conversationID: "same-session").isEmpty, "Identical session IDs on other computers cannot inherit unsent text")
        production.saveComposerDraft("Real machine draft", hostID: "real-host", conversationID: "same-session")
        production.clearLiveSession()
        require(production.composerDraft(hostID: "test-host", conversationID: "same-session") == "Test machine draft", "Switching computers preserves each scoped draft")
        production.retainHostDrafts(["real-host"])
        require(production.composerDraft(hostID: "test-host", conversationID: "same-session").isEmpty && production.composerDraft(hostID: "real-host", conversationID: "same-session") == "Real machine draft", "Removing a computer purges only its drafts")
        let scopedDraftStore = WorkspaceStore(persistenceURL: root.appendingPathComponent("scoped-drafts.json"), includeSamples: false)
        scopedDraftStore.saveComposerDraft("Persisted Test text", hostID: "test-host", conversationID: "same-session", persist: true)
        let restoredScopedDrafts = WorkspaceStore(persistenceURL: root.appendingPathComponent("scoped-drafts.json"), includeSamples: false)
        require(restoredScopedDrafts.composerDraft(hostID: "test-host", conversationID: "same-session") == "Persisted Test text" && restoredScopedDrafts.composerDraft(hostID: "real-host", conversationID: "same-session").isEmpty, "Computer-scoped drafts retain isolation after a cold launch")
        try checkReplyBoundaries()
        require(production.agents.isEmpty && !production.showsDemoContent && production.demoConversation("session-design") == nil, "Production must not expose synthetic agent or terminal workspaces")
        require(!production.sendDemoMessage("Hello", conversationID: AgentProfile.samples[0].id.uuidString), "Production cannot fabricate sample assistant replies")
        require(store.createAgent(name: "  ", purpose: "Purpose", symbol: "leaf") == nil, "Empty agent names must be rejected")
        require(store.createAgent(name: "Agent", purpose: " \n ", symbol: "leaf") == nil, "Empty purposes must be rejected")
        let agent = store.createAgent(name: "  My project  ", purpose: "  Inspect authorized evidence  ", symbol: "leaf")!
        require(!agent.isSample && agent.name == "My project", "New agents must be independent local drafts")
        store.saveDraft(" First thought ", conversationID: agent.id.uuidString)
        store.saveDraft("Other session", conversationID: "terminal-session")
        store.saveDraft(" \n ", conversationID: agent.id.uuidString)

        require(store.createAgent(name: "Invalid", purpose: "Task", symbol: "clock", mode: .scheduled) == nil, "Scheduled drafts require an interval")
        require(store.createAgent(name: "Invalid", purpose: "Task", symbol: "clock", mode: .scheduled, schedule: .init(interval: 0, unit: .hours)) == nil, "Intervals must be positive")
        require(store.createAgent(name: "Invalid", purpose: "Task", symbol: "clock", schedule: .init(interval: 1, unit: .hours)) == nil, "On demand must not carry a timer")
        let scheduled = store.createAgent(name: "Daily", purpose: "Review authorized changes", symbol: "clock", mode: .scheduled, schedule: .init(interval: 2, unit: .days))!
        let restored = WorkspaceStore(persistenceURL: file)
        require(restored.agents.contains(agent), "Agent identity and purpose must survive restart")
        require(restored.messages[agent.id.uuidString]?.count == 1, "Whitespace must not create an extra message")
        require(restored.messages[agent.id.uuidString]?.first?.text == "First thought", "Drafts must survive restart")
        require(restored.messages["terminal-session"]?.first?.text == "Other session", "Separate sessions must retain separate drafts")
        require(restored.agents.last == scheduled && scheduled.schedule?.label == "Every 2 days", "Scheduled draft type and interval survive restart")
        let legacy = Data("{\"id\":\"00000000-0000-4000-8000-000000000009\",\"name\":\"Legacy\",\"subtitle\":\"\",\"purpose\":\"Task\",\"symbol\":\"leaf\",\"isSample\":false}".utf8)
        let migrated = try JSONDecoder().decode(AgentProfile.self, from: legacy)
        require(migrated.mode == .onDemand, "Existing drafts migrate to On demand")
        checkNotificationHostHints()
        require(NotificationHint(["bzzy": ["v": 1, "eventId": "new-version", "destination": "updates"]])?.destination == .updates, "Update notifications open Settings without executing")
        require(NotificationHint(["bzzy": ["v": 1, "eventId": "new-version", "destination": "updates", "command": "install"]]) == nil, "Update notifications cannot carry an install command")
        require(NotificationHint(["bzzy": ["v": 1, "eventId": "test-event", "destination": "terminal"]])?.destination == .terminal, "Push hints may select an allowlisted screen")
        require(NotificationHint(["bzzy": ["v": 1, "eventId": "event", "destination": "https://example.com"]]) == nil, "Push must reject arbitrary destinations")
        require(NotificationHint(["bzzy": ["v": 1, "eventId": "event", "destination": "terminal", "command": "run"]]) == nil, "Push cannot carry commands")
        require(NotificationHint(["bzzy": ["v": 1, "eventId": "safe-event", "destination": "terminal", "resource": "approved-resource", "sessionId": "12345678-1234-4234-8234-123456789abc"]])?.sessionID != nil, "Push may carry an opaque session navigation hint")
        require(NotificationHint(["bzzy": ["v": 1, "eventId": "safe-event", "destination": "terminal", "resource": "https://example.com"]]) == nil, "Push resource must not be a link or executable target")
        require(NotificationHint(["bzzy": ["v": 1, "eventId": "safe-event", "destination": "terminal", "resource": "approved", "sessionId": "run-command"]]) == nil, "Push session hints must be valid opaque session UUIDs")
        require(NotificationHint(["bzzy": ["v": 1, "eventId": "agent-event", "destination": "agents", "resource": "approved", "sessionId": "12345678-1234-4234-8234-123456789abc", "agentId": "12345678-1234-4234-8234-123456789aaa"]])?.agentID != nil, "Agent push hints contain only opaque IDs for authorized read-only reconciliation")
        require(NotificationHint(["bzzy": ["v": 1, "eventId": "agent-event", "destination": "agents", "agentId": "12345678-1234-4234-8234-123456789aaa"]]) == nil, "Agent hints require resource/session scope")
        restored.deleteAgent(agent.id)
        let afterDelete = WorkspaceStore(persistenceURL: file)
        require(!afterDelete.agents.contains { $0.id == agent.id }, "Local removal must persist")
        require(afterDelete.messages[agent.id.uuidString] == nil, "Deleted agent drafts must be removed")
        require(afterDelete.messages["terminal-session"]?.count == 1, "Removing an agent must not remove another conversation")
        try checkSharing(root: root)
        try checkLiveProjection()
        checkVoiceDraft()
        await checkUnavailableVoice()

        let damaged = Data("not a workspace".utf8)
        try damaged.write(to: file)
        let recovered = WorkspaceStore(persistenceURL: file)
        require(recovered.storageError != nil, "Damaged storage must be disclosed")
        recovered.saveDraft("Do not overwrite damaged data", conversationID: "new")
        let preserved = try Data(contentsOf: file)
        require(preserved == damaged, "Damaged storage must be preserved")
        print("PASS: draft validation, restart persistence, conversation isolation, scoped deletion, corrupt-file preservation")
    }

    @MainActor private static func checkDelayedHostActionIsolation() {
        // A copied Core database can contain exactly the same session UUID.
        // Queue intents from both computers before changing the selected host.
        let clonedSessionID = "12345678-1234-4234-8234-123456789abc"
        var selectedHostID: String? = "test-host"
        var writes: [String] = []
        func queuedWrite() -> () -> Void {
            let origin = HostActionContext(hostID: selectedHostID)
            return {
                guard origin.permits(selectedHostID) else { return }
                writes.append("\(selectedHostID!):\(clonedSessionID)")
            }
        }
        let testIntent = queuedWrite()
        selectedHostID = "real-host"
        let realIntent = queuedWrite()
        testIntent(); realIntent()
        require(writes == ["real-host:\(clonedSessionID)"], "An old queued permission/send/update intent cannot reach a different computer with the same session UUID")
        selectedHostID = nil
        let unpairedIntent = queuedWrite()
        realIntent(); unpairedIntent()
        require(writes.count == 1, "Unpaired and detached contexts cannot authorize delayed Core writes")
        selectedHostID = "test-host"; testIntent()
        require(writes.last == "test-host:\(clonedSessionID)", "A host context allows an intent only on its original computer")
    }

    @MainActor private static func checkNotificationHostHints() {
        let firstHost = String(repeating: "H", count: 43), secondHost = String(repeating: "R", count: 43)
        let sessionID = "12345678-1234-4234-8234-123456789abc"
        let agentID = "12345678-1234-4234-8234-123456789aaa"
        let terminal: [String: Any] = ["v": 1, "eventId": "shared-event", "hostId": firstHost,
            "destination": "terminal", "resource": "approved", "sessionId": sessionID]
        require(NotificationHint(["bzzy": terminal])?.hostID == firstHost, "Goal notifications preserve their public Core routing hint")
        require(NotificationHint(["bzzy": ["v": 1, "eventId": "update", "hostId": firstHost, "destination": "updates"]])?.hostID == firstHost, "Update alerts preserve their originating Core without carrying commands")
        require(NotificationHint(["bzzy": ["v": 1, "eventId": "agent", "hostId": firstHost, "destination": "agents", "resource": "approved", "sessionId": sessionID, "agentId": agentID]])?.hostID == firstHost, "Agent notifications carry the same scoped host hint")
        require(NotificationHint(["bzzy": ["v": 1, "eventId": "legacy", "destination": "terminal"]])?.hostID == nil, "Legacy alerts remain distinguishable and cannot invent a host")
        for invalid: Any in ["", String(repeating: "H", count: 42), String(repeating: "H", count: 44), "https://example.com/core", "run command", 17, NSNull()] {
            var payload = terminal; payload["hostId"] = invalid
            require(NotificationHint(["bzzy": payload]) == nil, "Malformed host hints must be rejected")
        }
        let notices = NotificationStore()
        notices.receiveTap(["bzzy": terminal])
        require(notices.destinationHostID == firstHost && notices.destinationSessionID == sessionID, "Tap retains host and session together for authorized routing")
        notices.destination = nil
        notices.receiveTap(["bzzy": terminal])
        require(notices.destination == nil, "Duplicate events from the same host do not navigate twice")
        var other = terminal; other["hostId"] = secondHost
        notices.receiveTap(["bzzy": other])
        require(notices.destination == .terminal && notices.destinationHostID == secondHost, "Equal event IDs from different hosts cannot suppress one another")
        notices.destination = nil
        var legacy = terminal; legacy.removeValue(forKey: "hostId")
        notices.receiveTap(["bzzy": legacy])
        require(notices.destination == .terminal && notices.destinationHostID == nil, "Legacy taps clear the previous host hint")
        // Parsing an unknown but valid fingerprint does not add a pairing or
        // assert authorization. Only the saved profile resolver may select it.
        let unknown = String(repeating: "X", count: 43)
        var unknownPayload = terminal; unknownPayload["hostId"] = unknown
        require(NotificationHint(["bzzy": unknownPayload])?.hostID == unknown, "An unknown fingerprint remains an unauthenticated navigation hint")
        let token = Data(repeating: 0xab, count: 32)
        notices.registeredForPush(token)
        require(notices.pushToken != nil, "A device callback makes its private token available for authorized host registration")
        let enabledRevision = notices.registrationRevision
        notices.alertsEnabled = false
        require(notices.pushToken == nil && notices.registrationRevision > enabledRevision, "Disabling phone alerts immediately drops the token even when every Core is offline")
        notices.registeredForPush(token)
        require(notices.pushToken == nil, "A late Apple registration callback cannot re-enable disabled alerts")
        notices.alertsEnabled = true
        require(notices.pushToken == nil, "Re-enabling waits for a fresh Apple registration callback before enabling host delivery")
        let waitingRevision = notices.registrationRevision
        notices.registeredForPush(token)
        require(notices.pushToken != nil && notices.registrationRevision > waitingRevision, "A fresh device callback triggers renewed registration on all authorized hosts")
    }

    @MainActor private static func checkLiveProjection() throws {
        let store = WorkspaceStore()
        let sessionID = "12345678-1234-4234-8234-123456789abc"
        let snapshot: [String: Any] = ["session": ["id": sessionID, "alias": "Project chat", "provider": "fixture", "model": "fixture-v1", "executionState": "idle", "cwd": "/projects/nasa", "goal": ["status": "paused"]],
            "execution": ["state": "finished"], "questions": [["id": "12345678-1234-4234-8234-123456789def", "question": "Approve?", "kind": "approval"]],
            "capabilities": ["permissions": ["observe"], "activeSteering": false], "inputOwner": NSNull()]
        store.applyLiveSnapshot(try JSONSerialization.data(withJSONObject: snapshot))
        require(store.liveSession?.id == sessionID && store.liveSession?.permissions == ["observe"], "Live sessions use actual host identity and capabilities")
        require(store.liveSession?.execution == "finished" && store.liveSession?.goalStatus == "paused", "Execution completion must remain distinct from goal completion")
        require(store.liveSession?.directory == "/projects/nasa", "Phone displays the actual authorized CLI directory without moving projects")
        let olderID = "12345678-1234-4234-8234-123456789001"
        let catalog: [[String: Any]] = [
            ["id": olderID, "cwd": "/projects/older", "alias": "  Older  ", "updatedAt": "2026-10-21T21:00:00-03:00"],
            ["id": sessionID, "cwd": "/projects/nasa", "provider": "fixture", "model": "fixture-v1", "executionState": "idle", "goalStatus": "complete", "alias": "NASA", "updatedAt": "2026-10-23T00:00:00.100Z"],
            ["id": UUID().uuidString, "cwd": "/projects/test", "alias": "  \n"],
            ["id": UUID().uuidString, "cwd": "/projects/test", "alias": ""],
            ["id": UUID().uuidString, "cwd": "/projects/test"],
            ["id": UUID().uuidString, "cwd": "/projects/test", "alias": NSNull()]]
        store.applyLiveTerminalCatalog(try JSONSerialization.data(withJSONObject: catalog))
        require(store.liveTerminals.first?.directory == "/projects/nasa" && store.liveTerminals.first?.id == sessionID, "Authorized terminal discovery keeps actual directory and session identity")
        require(store.liveTerminals.map(\.title) == ["NASA", "Older"], "Only actual trimmed aliases appear, newest activity first regardless of catalog order")
        require(store.liveTerminals.first?.activity == .achieved, "Saved goal outcome is shown beside its alias")
        require(TerminalGoalActivity(goal: nil, reason: nil, execution: "finished") == .idle, "An execution ending cannot turn the dot green")
        require(TerminalGoalActivity(goal: "paused", reason: "turn_limit", execution: "paused") == .stalled, "Turn limits need attention")
        require(TerminalGoalActivity(goal: "paused", reason: "context_no_progress", execution: "paused") == .stalled, "A compaction loop needs attention rather than an achievement badge")
        require(TerminalGoalActivity(goal: "paused", reason: "user_pause", execution: "paused") == .paused, "An explicit pause is distinct from a stall")
        require(TerminalGoalActivity(goal: "active", reason: nil, execution: "waiting_for_input") == .waiting, "Questions stop the running animation")
        require(TerminalGoalActivity(goal: "active", reason: nil, execution: "running") == .running, "Active goals animate")
        var olderSnapshot = snapshot
        olderSnapshot["session"] = ["id": olderID, "alias": "Older", "cwd": "/projects/older", "updatedAt": "2026-10-24T00:00:00Z"]
        store.applyLiveSnapshot(try JSONSerialization.data(withJSONObject: olderSnapshot))
        require(store.liveTerminals.first?.id == olderID, "Fresh activity moves an existing aliased terminal to the top")
        store.applyLiveSnapshot(try JSONSerialization.data(withJSONObject: snapshot))
        require(store.liveTerminals.first(where: { $0.id == sessionID })?.activity == .paused, "Live snapshot updates a catalog indicator without opening the list again")
        require(store.liveSession?.questions.first?.text == "Approve?", "Only actual pending host questions appear")
        let agentID = "12345678-1234-4234-8234-123456789aaa"
        let hostAgent: [[String: Any]] = [["id": agentID, "name": "Real agent", "provider": "fixture", "model": "fixture-v1", "effort": "default", "cwd": "/agents/real", "sessionId": sessionID, "revision": 2, "state": "idle"]]
        store.applyHostAgents(try JSONSerialization.data(withJSONObject: hostAgent))
        store.applyHostAgentStatus(try JSONSerialization.data(withJSONObject: ["configured": true, "workspaceRoot": ["path": "/agents"], "scheduling": false]))
        require(store.hostAgents.first?.id == agentID && store.hostAgents.first?.revision == 2, "Host agent identity and revision come from Core, separately from local drafts")
        require(store.hostAgentsConfigured && store.hostAgentWorkspace == "/agents" && store.liveMessages.isEmpty, "Listing an idle host agent must not fabricate a reply or start execution")
        let body = "<message version=\"1\"><p><b>Actual host body</b></p></message>"
        func event(_ seq: Int, _ type: String, _ data: [String: Any], session: String = sessionID) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["version": 1, "id": "\(session):\(seq)", "seq": seq,
                "sessionId": session, "type": type, "createdAt": "2026-10-22T00:00:00.000Z", "data": data])
        }
        let events = try [event(1, "message.user", ["text": "Hello"]), event(3, "text", ["text": body]),
            event(4, "text", ["text": "tail"]), event(8, "future.event", ["provenance": "model-reported"]),
            event(9, "execution.finished", ["id": "fixture", "exitCode": 0]), event(10, "text", ["text": "unrelated"], session: UUID().uuidString)]
        store.applyLiveEvents(events + [events[1]])
        require(store.liveMessages.count == 2 && store.liveMessages[1].text == body + "tail", "Live bodies retain canonical formatting and contiguous deltas, deduplicating replay")
        require(store.liveActivity.count == 2 && store.liveActivity[0].details.contains("model-reported"), "Unknown events and provenance remain inspectable without becoming chat or verified success")
        require(store.conversationMessages(sessionID) == store.liveMessages, "Live session chat is authoritative host history")
        store.saveDraft("Private local note", conversationID: sessionID)
        require(store.conversationMessages(sessionID).count == 2, "Local notes never pretend they were sent to Core")
        store.setLiveAvailability(false, status: "Disconnected")
        require(!store.liveAvailable && store.liveMessages.count == 2, "Disconnect preserves explicitly stale authorized observation")
        var unnamedSnapshot = snapshot
        unnamedSnapshot["session"] = ["id": sessionID, "alias": " \n", "cwd": "/projects/nasa"]
        store.applyLiveSnapshot(try JSONSerialization.data(withJSONObject: unnamedSnapshot))
        require(store.liveSession?.hasAlias == false && !store.liveTerminals.contains { $0.id == sessionID }, "Removing an alias hides both catalog and selected-session fallback without deleting host data")
        store.clearLiveSession()
        require(store.liveSession == nil && store.liveMessages.isEmpty && store.liveActivity.isEmpty && store.liveTerminals.isEmpty && store.hostAgents.isEmpty, "Revocation/forget clears private in-memory projections")
        require(store.demoConversation("session-design") != nil, "Live state never replaces or authorizes demo workspaces")
        print("PASS: live session grants, raw body projection, replay deduplication, execution/goal separation, unknown event provenance and revocation clearing")
    }

    private static func checkVoiceDraft() {
        let draft = VoiceDraft(original: "Please check")
        require(draft.text(with: "my email") == "Please check my email", "Dictation preserves existing typed text")
        require(draft.text(with: "my emails today") == "Please check my emails today", "Revised partials replace dictated words instead of appending duplicates")
        require(draft.text(with: " \n") == "Please check", "No speech preserves the original draft")
        require(VoiceDraft(original: "Note:\n").text(with: "hello") == "Note:\nhello", "Existing whitespace stays intact")
        var state = VoiceCaptureLifecycle()
        let early = state.begin()!
        require(state.begin() == nil, "Overlapping recordings are refused")
        state.finish()
        require(state.phase == .idle && !state.didStart(early), "Release during permissions prevents a late microphone start")
        let current = state.begin()!
        require(state.didStart(current), "Current generation may record")
        require(!state.complete(early) && state.phase == .recording, "Old permission/callback cleanup cannot stop a newer recording")
        state.finish()
        require(state.phase == .finishing && state.id == current, "Release retains the recognition generation for final words")
        require(state.complete(current) && state.phase == .idle, "Final result or bounded timeout unlocks editing and Send")
        let cancelled = state.begin()!
        state.cancel()
        require(!state.didStart(cancelled) && !state.complete(cancelled), "Background/navigation cancellation rejects late callbacks")
        print("PASS: live dictation draft replacement, typed-text preservation, permission-release race, finalization and stale-generation isolation")
    }

    @MainActor private static func checkUnavailableVoice() async {
        #if !os(iOS)
        let capture = VoiceCapture()
        capture.transcript = "Keep this edited transcript"
        await capture.start(locale: "en-US")
        require(!capture.isBusy && capture.error != nil && capture.transcript == "Keep this edited transcript", "Unavailable speech must preserve edited text and unlock typing")
        let cancelled = VoiceCapture()
        cancelled.transcript = "Existing text"
        let task = Task { await cancelled.start(locale: "en-US") }
        task.cancel(); await task.value
        require(!cancelled.isBusy && cancelled.error == nil && cancelled.transcript == "Existing text", "A cancelled start never begins capture or clears a draft")
        capture.cancel(); capture.cancel()
        require(!capture.isBusy && capture.transcript == "Keep this edited transcript", "Repeated cancellation preserves the transcript")
        print("PASS: actual voice-capture unavailable/cancelled-start draft retention without microphone access")
        #endif
    }

    @MainActor private static func checkReplyBoundaries() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("BZZY-CORE/test/fixtures/chat-message-boundaries.json")
        let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [[String: Any]]
        for fixture in fixtures {
            let store = WorkspaceStore(includeSamples: false), sessionID = UUID().uuidString.lowercased()
            try store.applyLiveSnapshot(JSONSerialization.data(withJSONObject: ["session": ["id": sessionID]]))
            let events = try (fixture["events"] as! [[String: Any]]).enumerated().map { index, event in
                try JSONSerialization.data(withJSONObject: ["version": 1, "id": "\(sessionID):\(index + 1)", "seq": index + 1,
                    "sessionId": sessionID, "createdAt": "2026-10-23T12:00:00Z", "type": event["type"]!, "data": event["data"]!])
            }
            for count in 1...events.count {
                store.applyLiveEvents(Array(events.prefix(count)))
                let partial = store.liveMessages
                store.applyLiveEvents(Array(events.prefix(count)) + Array(events.prefix(count)))
                require(store.liveMessages == partial, "Replayed deltas must retain bubble IDs and content")
            }
            require(store.liveMessages.map(\.text) == fixture["messages"] as! [String], "CLI/iOS reply boundaries: \(fixture["name"]!)")
            let before = store.liveMessages
            store.setLiveAvailability(false, status: "Offline")
            store.applyLiveSnapshot(try JSONSerialization.data(withJSONObject: ["session": ["id": sessionID]]))
            store.applyLiveEvents(events)
            require(store.liveMessages == before, "Reconnect must preserve reply identities, content and separation")
        }
        print("PASS: shared CLI/iOS message boundaries, streamed chunks, tools, rich bodies, peer interleaving and replay")
    }

    @MainActor private static func checkSharing(root: URL) throws {
        var now = Date(timeIntervalSince1970: 1_000)
        let transfers = DemoTransferStore(now: { now })
        let file = root.appendingPathComponent("imports.json")
        let store = WorkspaceStore(persistenceURL: file)
        let target = ShareTarget.agent(AgentProfile.samples[0])
        let ticket = try transfers.issue(target)
        require(ticket.code.hasPrefix("BZZY-DEMO-AGENT-"), "Demo invitations must never resemble redeemable Relay codes")
        require(ticket.code.count == "BZZY-DEMO-AGENT-".count + 43, "Demo capabilities need 32 random bytes")
        let fromQR = try transfers.preview(ticket.qrText, kind: .agent)
        require(fromQR.code == ticket.code, "QR and typed code must identify the same ticket")
        mustFail { _ = try transfers.preview(ticket.code, kind: .terminal) }
        mustFail { _ = try DemoTransferStore().preview(ticket.code, kind: .agent) }

        // The store owns the definition. A forged UI preview must not replace it on redemption.
        let substituted = DemoShareTicket(code: ticket.code, expiresAt: ticket.expiresAt,
            definition: .init(kind: .agent, name: "Private", instructions: "Private data", symbol: "key", access: []))
        let importedName = try transfers.importCopy(substituted, into: store)
        require(importedName == "COOL 2", "Redeem only the authoritative immutable definition")
        let imported = store.agents.last!
        require(imported.id != AgentProfile.samples[0].id && !imported.isSample && imported.schedule == nil && imported.mode == .onDemand, "An imported copy is a fresh inactive draft")
        require(imported.purpose == AgentProfile.samples[0].purpose && store.conversationMessages(imported.id.uuidString).isEmpty, "Copies contain behavior without conversations")
        require(!store.sendDemoMessage("Hello", conversationID: imported.id.uuidString), "Imported drafts must never receive fake agent answers")
        mustFail { _ = try transfers.importCopy(ticket, into: store) }
        mustFail { _ = try transfers.issue(.agent(imported)) }
        let editedTarget = ShareTarget(id: target.id, kind: .agent, name: "Private draft text", isDemo: true)
        let immutable = try transfers.issue(editedTarget)
        require(immutable.definition.name == "COOL", "Demo exports ignore mutable names or private draft content")
        transfers.revoke(immutable)
        mustFail { _ = try transfers.preview(immutable.code, kind: .agent) }

        let terminal = try transfers.issue(.terminal(TerminalPreview.samples[0]))
        let terminalName = try transfers.importCopy(terminal, into: store)
        require(terminalName == "Design review", "Terminal copies must import independently")
        let draft = store.terminalDrafts[0]
        require(store.conversationMessages(draft.conversationID).isEmpty, "Terminal imports exclude history")
        store.saveDraft("Local message", conversationID: draft.conversationID)
        let restored = WorkspaceStore(persistenceURL: file)
        require(restored.terminalDrafts == [draft] && restored.agents.last == imported, "Both kinds of imported draft survive relaunch")
        require(restored.conversationMessages(draft.conversationID).first?.text == "Local message", "Imported terminal chats retain their own local drafts")

        let expiry = try transfers.issue(target)
        now = expiry.expiresAt
        mustFail { _ = try transfers.preview(expiry.code, kind: .agent) }
        let limit = DemoTransferStore(now: { now })
        for _ in 0..<32 { _ = try limit.issue(target) }
        mustFail { _ = try limit.issue(target) }

        let blocker = root.appendingPathComponent("not-a-folder")
        try Data("Block folder creation".utf8).write(to: blocker)
        let brokenStore = WorkspaceStore(persistenceURL: blocker.appendingPathComponent("workspace.json"))
        let retry = try transfers.issue(.terminal(TerminalPreview.samples[1]))
        mustFail { _ = try transfers.importCopy(retry, into: brokenStore) }
        require(brokenStore.terminalDrafts.isEmpty, "Failed writes roll back imported drafts")
        let retryPreview = try transfers.preview(retry.code, kind: .terminal)
        require(retryPreview.code == retry.code, "A failed write must not consume an invitation")
        print("PASS: share/import type isolation, immutable definitions, expiry, revocation, single use, draft persistence and save rollback")
    }

    private static func mustFail(_ operation: () throws -> Void) {
        do { try operation(); preconditionFailure("Expected operation to be rejected") }
        catch { /* Fixed failures only; never log invitation capabilities. */ }
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) {
        precondition(condition(), message)
    }
}
