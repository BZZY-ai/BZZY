import Foundation

@main
struct ChatChecks {
    @MainActor static func main() throws {
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
        print("PASS: rich message examples, nested styles, tables, escapes, code, malformed/untrusted markup rejection, demo isolation, smooth gaze")
    }
    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) { precondition(condition(), message) }
}
