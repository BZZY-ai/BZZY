import AppKit
import SwiftUI
import RelayKit

@main
struct RenderPreview {
    @MainActor static func main() throws {
        guard CommandLine.arguments.count >= 2 else {
            print("Usage: render-preview OUTPUT_DIRECTORY")
            return
        }
        NSApplication.shared.setActivationPolicy(.prohibited)
        let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let source = Bundle.module.url(forResource: "FlyMotion", withExtension: "metal") {
            let air = folder.appendingPathComponent("fly-motion.air"), library = folder.appendingPathComponent("fly-motion.metallib")
            for arguments in [["-sdk", "macosx", "metal", "-c", source.path, "-o", air.path], ["-sdk", "macosx", "metallib", air.path, "-o", library.path]] {
                let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun"); process.arguments = arguments
                try process.run(); process.waitUntilExit()
                guard process.terminationStatus == 0 else { throw CocoaError(.executableLoad) }
            }
            FlyEyes.previewShaderURL = library
        }
        let terminal = WorkspaceStore()
        try render("terminal", view: WorkspaceView(store: terminal), folder: folder)
        try render("terminal-small", view: WorkspaceView(store: WorkspaceStore()), folder: folder, width: 375, height: 667)
        try render("terminal-large-text", view: WorkspaceView(store: WorkspaceStore()).environment(\.dynamicTypeSize, .accessibility2), folder: folder)
        let assessment = WorkspaceStore()
        try render("core-assessment-chat", view: NavigationStack { CoreChatView(store: assessment) }, folder: folder)
        try render("core-assessment-chat-large", view: NavigationStack { CoreChatView(store: assessment) }.environment(\.dynamicTypeSize, .accessibility2), folder: folder, width: 375)
        let goalTerminals = WorkspaceStore(includeSamples: false)
        let now = Date()
        let statuses: [(String, String, String, String?, String, Double)] = [
            ("starbucks-japan", "complete", "idle", nil, "/Users/demo/code/starbucks-japan", 240),
            ("Research", "blocked", "idle", nil, "/Users/demo/research/notes", 3_600),
            ("Current work", "active", "running", nil, "/Users/demo/code/bzzy", 20),
            ("Paused project", "paused", "paused", "user_pause", "/Users/demo/code/paused-project", 7_200),
            ("Review request", "active", "waiting_for_input", nil, "/Users/demo/code/review", 90)]
        let iso = ISO8601DateFormatter()
        goalTerminals.applyLiveTerminalCatalog(try JSONSerialization.data(withJSONObject: statuses.map { name, goal, execution, reason, cwd, age in
            ["id": UUID().uuidString, "alias": name, "cwd": cwd, "goalStatus": goal, "model": "gpt-5.5",
             "executionState": execution, "goalReason": reason as Any? ?? NSNull(),
             "updatedAt": iso.string(from: now.addingTimeInterval(-age))] as [String: Any]
        }))
        try render("terminal-goal-status", view: WorkspaceView(store: goalTerminals), folder: folder)
        try render("terminal-goal-status-large", view: WorkspaceView(store: goalTerminals).environment(\.dynamicTypeSize, .accessibility2), folder: folder, width: 375)
        try render("terminal-chat", view: NavigationStack { TerminalConversationView(store: terminal, session: TerminalPreview.samples[0]) }, folder: folder)
        let chat = ConversationCanvas(store: terminal, conversationID: TerminalPreview.samples[0].id,
            title: "starbucks-japan", subtitle: "~/code/starbucks-japan", assistantName: TerminalPreview.samples[0].model)
        try render("terminal-header", view: NavigationStack { chat }, folder: folder)
        try render("terminal-header-large", view: NavigationStack { chat }.environment(\.dynamicTypeSize, .accessibility2), folder: folder, width: 375)
        try render("research-chat", view: NavigationStack { TerminalConversationView(store: terminal, session: TerminalPreview.samples[1]) }, folder: folder)
        let live = WorkspaceStore(includeSamples: false), sessionID = UUID().uuidString.lowercased()
        live.applyLiveSnapshot(try JSONSerialization.data(withJSONObject: ["session": ["id": sessionID, "alias": "PersistenceTest", "provider": "codex",
            "model": "gpt-5.5", "cwd": "/Users/demo/code/persistence", "goal": ["status": "active", "objective": "Keep chat boundaries"]]]))
        let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("BZZY-CORE/test/fixtures/chat-message-boundaries.json")
        let fixture = (try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures)) as! [[String: Any]])[0]
        let events = try (fixture["events"] as! [[String: Any]]).enumerated().map { index, event in
            try JSONSerialization.data(withJSONObject: ["version": 1, "id": "\(sessionID):\(index + 1)", "seq": index + 1,
                "sessionId": sessionID, "createdAt": "2026-10-23T12:00:00Z", "type": event["type"]!, "data": event["data"]!])
        }
        live.applyLiveEvents(events)
        try render("live-reply-boundaries", view: NavigationStack { ConversationCanvas(store: live, conversationID: sessionID,
            title: "PersistenceTest", subtitle: "~/code/persistence", assistantName: "gpt-5.5", remoteSession: true) }, folder: folder)
        try render("session-details", view: LiveSessionDetailsView(store: live), folder: folder)
        try render("chat-large-text", view: NavigationStack { TerminalConversationView(store: terminal, session: TerminalPreview.samples[0]) }
            .environment(\.dynamicTypeSize, .accessibility2), folder: folder)
        try render("voice", view: VoiceView(store: terminal, conversationID: TerminalPreview.samples[0].id, agentName: TerminalPreview.samples[0].name), folder: folder)
        try render("voice-only", view: VoiceChatView(), folder: folder)
        try render("settings-voice", view: SettingsView().environment(NotificationStore()), folder: folder)
        try render("activity", view: ActivityView(), folder: folder)
        try render("share", view: ShareResourceView(target: .terminal(TerminalPreview.samples[0]))
            .environment(DemoTransferStore()).environment(RelayConnection(networkingEnabled: false)), folder: folder)
        try render("import", view: ImportResourceView(store: terminal, kind: .terminal).environment(DemoTransferStore()), folder: folder)
        try render("connect", view: ConnectView(required: true), folder: folder)
        let expressions: [(String, FlyMood, Double)] = [("idle", .idle, 0), ("glance", .curious, 3), ("antennae", .idle, 5.86), ("resting", .resting, 6), ("happy", .happy, 4), ("thinking", .thinking, 4)]
        for expression in expressions {
            let renderer = ImageRenderer(content: FlyEyes(mood: expression.1, interactive: false, frozenTime: expression.2)
                .frame(width: 552, height: 310).padding(35).background(BZZYTheme.background))
            renderer.scale = 2
            try write(renderer.cgImage, to: folder.appendingPathComponent("eyes-\(expression.0).png"))
        }
        if let icon = Bundle.module.url(forResource: "AppIcon", withExtension: "png", subdirectory: "Assets.xcassets/AppIcon.appiconset") {
            let destination = folder.appendingPathComponent("AppIcon.png")
            if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
            try FileManager.default.copyItem(at: icon, to: destination)
        }
        print("Rendered native layouts, 6 artwork previews, and the single-eye app icon into \(folder.path)")
    }

    @MainActor private static func render<V: View>(_ name: String, view: V, folder: URL, width: CGFloat = 393, height: CGFloat = 852) throws {
        let content = VStack(spacing: 0) {
            HStack {
                Text("9:41").font(.system(size: 14, weight: .semibold))
                Spacer()
                HStack(spacing: 5) {
                    Image(systemName: "cellularbars")
                    Image(systemName: "wifi")
                    Image(systemName: "battery.100percent")
                }.font(.system(size: 12))
            }.padding(.horizontal, 31).frame(height: 49).foregroundStyle(BZZYTheme.text)
            view.frame(maxWidth: .infinity, maxHeight: .infinity)
            Capsule().fill(BZZYTheme.text.opacity(0.8)).frame(width: 126, height: 4)
                .frame(height: 21)
        }.frame(width: width, height: height).background(BZZYTheme.background)
            .environment(\.colorScheme, .dark)
            .environment(\.scenePhase, .active)
            .environment(RelayConnection(networkingEnabled: false))
        // ScrollView and native text controls need a hosting view, not ImageRenderer.
        let hosting = NSHostingView(rootView: content)
        let rect = NSRect(x: 0, y: 0, width: width, height: height)
        let window = NSWindow(contentRect: rect, styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = hosting
        window.isReleasedWhenClosed = false
        window.orderBack(nil)
        hosting.frame = rect
        hosting.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: rect) else { throw CocoaError(.fileWriteUnknown) }
        hosting.cacheDisplay(in: rect, to: bitmap)
        try write(bitmap.cgImage, to: folder.appendingPathComponent(name + ".png"))
        window.orderOut(nil)
        window.close()
    }

    private static func write(_ image: CGImage?, to url: URL) throws {
        guard let image else { throw CocoaError(.fileWriteUnknown) }
        let representation = NSBitmapImageRep(cgImage: image)
        guard let data = representation.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
        try data.write(to: url)
    }
}
