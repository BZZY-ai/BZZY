import Foundation

@main
struct ChatChecks {
    @MainActor static func main() throws {
        checkHistoryWindow()
        try checkInvocationTranscript()
        for demo in DemoConversation.samples.values {
            require(demo.messages.contains(where: \.isUser) && demo.messages.contains(where: { !$0.isUser }), "Demos need both speakers")
            for message in demo.messages where !message.isUser {
                require(ChatContent.parse(message.text).isFormatted, "Every sample response must use valid supported markup")
            }
            for reply in demo.replies { require(ChatContent.parse(reply).isFormatted, "Interactive demo replies must render") }
        }
        let styled = ChatContent.parse("<message version=\"1\"><p size=\"large\">A <b><span color=\"mint\">clear</span></b> answer<br/>with &lt;data&gt; &amp; context.</p></message>")
        guard case .paragraph(let spans) = styled.blocks.first else { fatalError("Missing paragraph") }
        require(spans.contains { $0.text == "clear" && $0.style.bold && $0.style.size == .large && $0.style.color == .mint }, "Nested formatting must inherit font size and retain bold/color")
        require(styled.plainText == "A clear answer\nwith <data> & context.", "Escapes and line breaks must preserve readable text")
        let table = ChatContent.parse("<message version=\"1\"><table><tr><th>Name</th><th>Status</th></tr><tr><td>Example</td><td><b>Ready</b></td></tr></table></message>")
        guard case .table(let grid) = table.blocks.first else { fatalError("Missing table") }
        require(grid.headers.count == 2 && grid.rows.count == 1 && grid.rows[0][1][0].style.bold, "Tables retain header/row structure and cell formatting")
        let code = ChatContent.parse("<message version=\"1\"><pre language=\"swift\"><code>if a &lt; b {\n  print(a)\n}</code></pre></message>")
        require(code.blocks == [.code("swift", "if a < b {\n  print(a)\n}")], "Code must remain literal with whitespace intact")
        for invalid in [
            "<message version=\"2\"><p>No</p></message>",
            "<message version=\"1\"><script>run()</script></message>",
            "<message version=\"1\"><p onclick=\"run()\">No</p></message>",
            "<message version=\"1\"><p><span color=\"#00E5CB\">No</span></p></message>",
            "<message version=\"1\"><table><tr><th>A</th><th>B</th></tr><tr><td>Short row</td></tr></table></message>",
            "<message version=\"1\"><p>Unclosed</message>",
            "<!DOCTYPE message [<!ENTITY item SYSTEM 'file:///private/not-a-real-file'>]><message version=\"1\"><p>&item;</p></message>",
            "<message version=\"1\"><p>" + String(repeating: "<b>", count: 20) + "deep" + String(repeating: "</b>", count: 20) + "</p></message>"
        ] { require(!ChatContent.parse(invalid).isFormatted, "Unsupported or malformed markup must fall back to plain text") }
        require(!ChatContent.parse(String(repeating: "a", count: 65_537)).isFormatted, "Oversized content stays bounded plain text")

        let store = WorkspaceStore()
        let cool = AgentProfile.samples[0].id.uuidString
        let fixtureIDs = store.conversationMessages(cool).map(\.id)
        require(store.sendDemoMessage("Show a next step", conversationID: cool), "Sample chats accept local sends")
        require(store.messages[cool]?.map(\.kind) == [.user, .assistant], "A demo send must create right and left messages in order")
        require(store.conversationMessages(cool).prefix(fixtureIDs.count).map(\.id) == fixtureIDs, "Sample history has stable identities")
        let realDraft = store.createAgent(name: "New", purpose: "A real draft", symbol: "leaf")!
        require(!store.sendDemoMessage("Ask", conversationID: realDraft.id.uuidString), "Created agents must never receive fake sample answers")
        require(store.messages[realDraft.id.uuidString] == nil, "Rejected demo sends must not alter a real draft")
        require(store.messages["session-design"] == nil, "Sending in COOL must not modify a terminal")

        let demoFile = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(".build/demo-persistence-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: demoFile) }
        let persistent = WorkspaceStore(persistenceURL: demoFile)
        persistent.sendDemoMessage("Keep this conversation", conversationID: cool)
        let relaunched = WorkspaceStore(persistenceURL: demoFile)
        require(relaunched.messages[cool]?.map(\.kind) == [.user, .assistant], "Both speakers must survive relaunch")
        require(relaunched.conversationMessages(cool).count == fixtureIDs.count + 2, "Relaunch must not duplicate sample history")

        var motion = GazeMotion()
        for frame in 0..<150 { motion.advance(toward: CGPoint(x: -1, y: 0), time: Double(frame) / 30) }
        let left = motion.position.x
        motion.advance(toward: CGPoint(x: 1, y: 0), time: 5)
        require(motion.position.x < 0 && motion.position.x - left <= 0.056, "An opposite-side touch must not teleport the eyes")
        for frame in 151...195 { motion.advance(toward: CGPoint(x: 1, y: 0), time: Double(frame) / 30) }
        require(motion.position.x > 0.9 && motion.position.x <= 1, "The gaze eases toward its target without overshoot")
        let beforePause = motion.position.x
        motion.pause(); motion.advance(toward: CGPoint(x: -1, y: 0), time: 1000)
        require(beforePause - motion.position.x <= 0.056, "Resuming cannot fast-forward into a jump")
        var clock = FlyAnimationClock()
        var alert = GazeMotion()
        let alertTarget = FlyAnimationPose(time: 0.8, mood: .idle, touchAge: 100, touch: .zero, still: false)
        require(alertTarget.scanning, "Idle eyes use deliberate quick scans")
        for frame in 0...5 { alert.advance(toward: alertTarget.target, time: Double(frame) / 30, rapid: true) }
        require(hypot(alert.position.x - alertTarget.target.x, alert.position.y - alertTarget.target.y) < 0.01, "A gaze dart finishes in under 200 milliseconds")
        let hold = FlyAnimationPose(time: 1.25, mood: .idle, touchAge: 100, touch: .zero, still: false)
        require(hold.target == alertTarget.target, "A quick move is followed by a real stationary pause")
        let next = FlyAnimationPose(time: 1.75, mood: .idle, touchAge: 100, touch: .zero, still: false)
        require(next.target != hold.target, "The next quick scan checks another direction")
        require(!FlyAnimationPose(time: 1, mood: .idle, touchAge: 0, touch: .zero, still: false).scanning, "Touch retains smooth tracking rather than idle darts")
        clock.advance(10); let firstFrame = clock.elapsed
        clock.pause(); clock.advance(1000)
        require(clock.elapsed - firstFrame < 0.04, "Background time must not advance antenna or eye motion")
        for mood in FlyMood.allCases {
            for frame in 0...390 {
                let pose = FlyAnimationPose(time: Double(frame) / 30, mood: mood, touchAge: 100, touch: .zero, still: false)
                require(pose.target.x.isFinite && pose.target.y.isFinite && abs(pose.target.x) <= 1 && abs(pose.target.y) <= 1, "Every mood keeps pupil tracking bounded")
                let reduced = FlyAnimationPose(time: Double(frame), mood: mood, touchAge: 0, touch: CGPoint(x: 1, y: 1), still: true)
                require(reduced.target == .zero && reduced.energy == 0, "Reduce Motion holds the reference artwork still")
            }
        }
        let spectrum = VoiceFrequencyAnalyzer(), sampleRate = 48000.0
        func peak(_ frequency: Double) -> Int {
            let signal = (0..<2048).map { Float(sin(Double($0) * 2 * .pi * frequency / sampleRate) * 0.4) }
            let levels = spectrum.levels(signal, sampleRate: sampleRate)!
            require(levels.allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 1 }, "Spectrum energy must stay finite and bounded")
            return levels.indices.max(by: { levels[$0] < levels[$1] })!
        }
        require(peak(4000) > peak(500), "Actual higher microphone frequencies must light higher bands")
        require(spectrum.levels(Array(repeating: 0, count: 2048), sampleRate: sampleRate)!.allSatisfy { $0 == 0 }, "Silence must never display invented voice activity")
        require(VoiceFrequencyAnalyzer.bandCount == 64, "The spectrum has 64 actual frequency bands")
        var fluid = VoiceSpectrumSmoother()
        fluid.advance(toward: Array(repeating: 1, count: 64), time: 0)
        require(fluid.levels.allSatisfy { $0 > 0 && $0 < 1 }, "Real audio samples ease into place without jumping")
        for frame in 1...100 { fluid.advance(toward: Array(repeating: 0, count: 64), time: Double(frame) / 60) }
        require(fluid.levels.allSatisfy { $0 == 0 }, "Display smoothing returns silence to an exact flat line")
        var release = VoiceReleaseIntent()
        release.begin(); release.audioStarted(); release.release()
        require(release.consume("final words", busy: true, failed: false, allowed: true) == nil, "Release briefly waits for final recognition")
        require(release.consume("final words", busy: false, failed: false, allowed: true) == "final words", "Deliberate release sends the completed words")
        require(release.consume("final words", busy: false, failed: false, allowed: true) == nil, "A release can submit only once")
        release.begin(); release.release()
        require(release.consume("late permission", busy: false, failed: false, allowed: true) == nil, "Release during permission setup cannot send")
        release.begin(); release.audioStarted(); release.cancel(); release.release()
        require(release.consume("background", busy: false, failed: false, allowed: true) == nil, "Navigation/background cancellation never sends speech")
        release.begin(); release.audioStarted(); release.release()
        require(release.consume("failed recognition", busy: false, failed: true, allowed: true) == nil, "Failed recognition needs an explicit retry")
        require(SpeechLanguage.resolve("es-ES") == .spanish && SpeechLanguage.resolve("en-US") == .english, "Listening and speaking preferences resolve independently")
        let live = WorkspaceStore(), sessionID = UUID().uuidString.lowercased(), approvalID = UUID().uuidString.lowercased()
        live.applyLiveSnapshot(try JSONSerialization.data(withJSONObject: ["session": ["id": sessionID], "questions": [], "capabilities": [:]] as [String: Any]))
        func event(_ seq: Int, _ type: String, _ data: [String: Any]) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["id": "\(sessionID):\(seq)", "sessionId": sessionID, "seq": seq, "type": type, "data": data])
        }
        live.applyLiveEvents([
            try event(1, "question", ["id": approvalID, "kind": "approval", "question": "Fixture command"]),
            try event(2, "question.answered", ["id": approvalID, "answer": "yes"]),
            try event(3, "message.user", ["text": "Real user message"])
        ])
        require(live.liveMessages.map(\.text) == ["Real user message"], "Approval choices stay in activity, without fake yes/no chat messages")
        require(live.liveActivity.count == 2, "Original approval events remain in the activity projection")
        var streamed = [try event(10, "message.user", ["text": "Streamed question"])]
        live.applyLiveEvents(streamed)
        for index in 11...110 {
            streamed.append(try event(index, "text", ["text": "\(index) ", "itemId": "reply-a", "turnId": "turn-a"]))
            live.applyLiveEvents(streamed)
        }
        streamed.append(try event(111, "tool", ["name": "inspection"]))
        streamed.append(try event(112, "text", ["text": "Separate reply", "itemId": "reply-b", "turnId": "turn-a"]))
        live.applyLiveEvents(streamed)
        let streamedMessages = live.liveMessages
        let rebuilt = WorkspaceStore()
        rebuilt.applyLiveSnapshot(try JSONSerialization.data(withJSONObject: ["session": ["id": sessionID]]))
        rebuilt.applyLiveEvents(streamed)
        require(streamedMessages == rebuilt.liveMessages, "Incremental deltas preserve exactly the same message boundaries and IDs as replay")
        require(streamedMessages.count == 3, "A tool boundary creates a separate assistant bubble during streaming")
        live.applyLiveEvents(streamed)
        require(live.liveMessages == streamedMessages, "Repeated cache publication never duplicates text")
        let backfilled = [try event(8, "message.user", ["text": "Older question"]), try event(9, "text", ["text": "Older answer"])] + streamed
        live.applyLiveEvents(backfilled)
        require(live.liveMessages.suffix(3) == streamedMessages[...], "Prepending history preserves the IDs and bodies of visible messages")
        live.applyLiveEvents(streamed)
        require(live.liveMessages == streamedMessages, "A bounded cache-window shift rebuilds without retaining stale older entries")
        live.clearLiveConversation()
        rebuilt.applyLiveEvents([])
        require(live.liveMessages.isEmpty && rebuilt.liveMessages.isEmpty, "Clearing a scope removes its projected history")
        print("PASS: rich message examples, nested styles, tables, escapes, code, malformed/untrusted markup rejection, demo isolation, smooth gaze, approval projection")
    }
    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) { precondition(condition(), message) }
}

@MainActor private func checkHistoryWindow() {
    func require(_ condition: @autoclosure () -> Bool, _ message: String) { precondition(condition(), message) }
    func message(_ number: Int) -> LocalMessage {
        .init(id: UUID(), text: "Message \(number)", kind: .assistant, createdAt: Date(timeIntervalSince1970: Double(number)))
    }
    let initial = (1...225).map(message), incoming = (226...235).map(message)
    var window = ConversationHistoryWindow()
    require(window.visible(in: initial).map(\.text) == Array(initial.suffix(50)).map(\.text), "Opening history shows exactly the latest 50 cached messages")
    window.freeze(in: initial)
    require(window.visible(in: initial + incoming) == Array(initial.suffix(50)), "Incoming messages cannot shift the older reading window")
    require(window.revealEarlier(in: initial + incoming) && window.count == 100, "Earlier loads one 50-message page")
    require(window.visible(in: initial + incoming).first?.id == initial[125].id && window.visible(in: initial + incoming).last?.id == initial.last?.id, "Paging preserves the original tail boundary and stable IDs")
    let earlier = (-40 ... -1).map(message), backfilled = earlier + initial + incoming
    require(window.revealEarlier(in: backfilled) && window.visible(in: backfilled).first?.id == initial[75].id, "Prepending Core events does not invalidate the visible anchor")
    for _ in 0..<20 { window.revealEarlier(in: backfilled) }
    require(window.count <= 200 && window.visible(in: backfilled).first?.id == earlier.first?.id, "Backward browsing stays bounded while reaching the earliest message")
    require(!window.includesLatest(in: backfilled), "A bounded older window cannot claim to be at the latest reply")
    window.showLatest()
    require(window.visible(in: backfilled) == Array(backfilled.suffix(50)), "Latest returns to the newest 50 messages")
    print("PASS: 50-message windows, anchored live updates, older paging, bounded rendering and Latest")
}

@MainActor private func checkInvocationTranscript() throws {
    let store = WorkspaceStore(includeSamples: false), session = UUID().uuidString.lowercased()
    let job = UUID().uuidString.lowercased(), otherJob = UUID().uuidString.lowercased()
    func event(_ sequence: Int, _ type: String, _ data: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["version": 1, "id": "\(session):\(sequence)", "seq": sequence,
            "sessionId": session, "createdAt": "2026-10-25T12:00:00Z", "type": type, "data": data])
    }
    try store.applyLiveSnapshot(JSONSerialization.data(withJSONObject: ["session": ["id": session]]))
    let original = "<message version=\"1\"><p>Original <b>HTTP</b> reply Ω.</p></message>"
    let firstReport = "The returned response preserved its security headers.\nEvidence remains unchanged."
    let secondReport = "The follow-up checked the supplied negative control."
    let events = try [
        event(1, "message.user", ["text": "Check supplied responses"]), event(2, "text", ["text": original]),
        event(3, "core.usage", ["id": "receipt-1", "kind": "skill", "name": "header-checks", "sessionId": session]),
        event(4, "assignment.created", ["id": job, "parentSessionId": session, "subagentDefinition": ["name": "http-reviewer"]]),
        event(5, "assignment.started", ["id": job, "round": 1]),
        event(6, "core.usage", ["id": "receipt-1", "kind": "skill", "name": "header-checks", "sessionId": UUID().uuidString, "rootSessionId": session]),
        event(7, "assignment.finished", ["id": job, "round": 1, "state": "awaiting_review", "report": ["summary": firstReport]]),
        event(8, "assignment.followup", ["id": job, "round": 2]),
        event(9, "assignment.finished", ["id": job, "round": 2, "state": "awaiting_review", "report": ["summary": secondReport]]),
        event(10, "assignment.reviewed", ["id": job, "round": 2, "outcome": "accepted"]),
        event(11, "assignment.started", ["id": job, "round": 1]),
        event(12, "text", ["text": "The main assistant's actual final response."]),
        event(13, "core.usage", ["id": "foreign-receipt", "kind": "skill", "name": "foreign-skill", "sessionId": UUID().uuidString]),
        event(14, "assignment.created", ["id": otherJob, "parentSessionId": session, "subagentDefinition": ["name": "android-reviewer"]]),
        event(15, "assignment.failed", ["id": otherJob, "round": 1, "error": "The supplied artifact was unavailable."])
    ]
    for count in 1...events.count { store.applyLiveEvents(Array(events.prefix(count))) }
    let messages = store.liveMessages, steps = messages.compactMap(\.invocation)
    precondition(steps.filter { $0.kind == .skill }.count == 1, "Skill receipts deduplicate across forwarded worker events")
    precondition(steps.filter { $0.kind == .agent }.count == 2 && Set(steps.filter { $0.kind == .agent }.map(\.accentIndex)).count == 2, "Agents keep stable separate identities and colors")
    precondition(steps.first { $0.id == job }?.state == "accepted" && steps.first { $0.id == job }?.round == 2, "Late worker lifecycle events cannot regress a reviewed outcome")
    precondition(messages.contains { $0.text == original } && messages.contains { $0.text == firstReport } && messages.contains { $0.text == secondReport }, "Main replies and actual returned agent text remain verbatim")
    precondition(!steps.contains { $0.name == "foreign-skill" }, "Foreign skill scope cannot leak into this terminal")
    store.applyLiveEvents(events + events)
    precondition(store.liveMessages == messages, "Replay cannot duplicate invocation steps or returned messages")
    let partial = WorkspaceStore(includeSamples: false)
    try partial.applyLiveSnapshot(JSONSerialization.data(withJSONObject: ["session": ["id": session]]))
    partial.applyLiveEvents(Array(events[6...9]))
    precondition(partial.liveMessages.contains { $0.text == firstReport } && partial.liveMessages.contains { $0.text == secondReport }, "A recent page retains returned text even when creation is outside the cache")
    precondition(partial.liveMessages.compactMap(\.invocation).first?.name.hasPrefix("Worker ") == true, "Missing cached names use an honest worker label")
    precondition(Set(partial.liveMessages.map(\.id)).count == partial.liveMessages.count, "Fallback steps and returned messages have distinct stable IDs")
    let partialStepID = partial.liveMessages.first { $0.invocation?.id == job }?.id
    partial.applyLiveEvents(Array(events.prefix(10)))
    precondition(partial.liveMessages.compactMap(\.invocation).first { $0.kind == .agent }?.name == "http-reviewer", "Older creation history restores the actual agent name")
    precondition(partial.liveMessages.first { $0.invocation?.id == job }?.id == partialStepID, "Filling missing creation metadata preserves the reading anchor")
    try store.applyLiveSnapshot(JSONSerialization.data(withJSONObject: ["session": ["id": UUID().uuidString.lowercased()]]))
    store.applyLiveEvents(events)
    precondition(store.liveMessages.isEmpty, "Changing conversation scope cannot retain old invocation rows")
    print("PASS: skill/agent steps, receipt replay, follow-ups, stable colors, exact messages and scope isolation")
}
