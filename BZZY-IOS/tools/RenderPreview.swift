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
        let agents = WorkspaceStore()
        let terminal = WorkspaceStore()
        terminal.selectedTab = .terminal
        try render("agents", view: WorkspaceView(store: agents), folder: folder)
        try render("terminal", view: WorkspaceView(store: terminal), folder: folder)
        try render("conversation", view: ConversationView(store: agents, agent: agents.agents[0]), folder: folder)
        try render("subscriptions-chat", view: ConversationView(store: agents, agent: agents.agents[2]), folder: folder)
        try render("terminal-chat", view: TerminalConversationView(store: terminal, session: TerminalPreview.samples[0]), folder: folder)
        try render("research-chat", view: TerminalConversationView(store: terminal, session: TerminalPreview.samples[1]), folder: folder)
        try render("chat-large-text", view: ConversationView(store: agents, agent: agents.agents[0]).environment(\.dynamicTypeSize, .accessibility2), folder: folder)
        try render("voice", view: VoiceView(store: agents, conversationID: agents.agents[0].id.uuidString, agentName: "COOL"), folder: folder)
        try render("voice-only", view: VoiceChatView(), folder: folder)
        try render("settings-voice", view: SettingsView().environment(NotificationStore()), folder: folder)
        try render("activity", view: ActivityView(), folder: folder)
        try render("share", view: ShareResourceView(target: .agent(agents.agents[0]))
            .environment(DemoTransferStore()).environment(RelayConnection(networkingEnabled: false)), folder: folder)
        try render("import", view: ImportResourceView(store: agents, kind: .agent).environment(DemoTransferStore()), folder: folder)
        try render("agents-small", view: WorkspaceView(store: WorkspaceStore()), folder: folder, width: 375, height: 667)
        try render("agents-large-text", view: WorkspaceView(store: WorkspaceStore()).environment(\.dynamicTypeSize, .accessibility2), folder: folder)
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
        print("Rendered 15 native layouts, 6 artwork previews, and the single-eye app icon into \(folder.path)")
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
