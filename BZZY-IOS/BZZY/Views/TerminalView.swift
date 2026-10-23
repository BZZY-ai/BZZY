import SwiftUI
import RelayKit

struct TerminalView: View {
    @Environment(RelayConnection.self) private var relay
    @Bindable var store: WorkspaceStore
    @State private var showConnection = false
    @State private var notificationTerminal: LiveTerminalRecord?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                Button { showConnection = true } label: {
                    Label(relay.shortStatus, systemImage: "desktopcomputer")
                        .bzzyFont(12).foregroundStyle(BZZYTheme.muted)
                        .frame(minHeight: 44)
                }.buttonStyle(.plain).accessibilityIdentifier("host-status")

                if relay.coreCatalogAvailable {
                    HStack {
                        Text("Your terminals").bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                        Spacer()
                        Button("Refresh") { Task { await relay.refreshCoreSessions() } }.bzzyFont(12)
                            .disabled(!relay.coreCatalogReady)
                    }
                    if relay.coreSessionAttachmentPending {
                        Button("Cancel pending attachment") { relay.cancelCoreSessionAttachment() }.bzzyFont(12)
                    }
                    if store.liveTerminals.isEmpty {
                        Text("Name a terminal in the CLI with /alias My Project.")
                            .bzzyFont(13).foregroundStyle(BZZYTheme.muted)
                    }
                    VStack(spacing: 0) {
                        ForEach(store.liveTerminals) { terminal in
                            NavigationLink {
                                RemoteTerminalConversationView(store: store, terminal: terminal)
                            } label: {
                                sessionRow(name: terminal.title, subtitle: "\(terminal.directory)\n\(terminal.model) · \(terminal.execution)", symbol: "terminal")
                            }.buttonStyle(.plain)
                                .disabled(!relay.coreCatalogReady || relay.coreBusy || relay.coreCommandUncertain)
                                .accessibilityIdentifier("terminal-host-\(terminal.id)")
                            Rectangle().fill(BZZYTheme.line.opacity(0.6)).frame(height: 0.5)
                        }
                    }
                }
                if let session = store.liveSession, session.hasAlias, !store.liveTerminals.contains(where: { $0.id == session.id }) {
                    VStack(spacing: 0) {
                        NavigationLink {
                            ConversationCanvas(store: store, conversationID: session.id, title: session.title,
                                subtitle: "\(session.model) · \(store.liveAvailable ? session.execution : "Disconnected")", assistantName: session.model, remoteSession: true)
                        } label: {
                            sessionRow(name: session.title, subtitle: "\(session.provider) · \(store.liveStatus)", symbol: "terminal")
                        }.buttonStyle(.plain).accessibilityIdentifier("terminal-live")
                        Text("Host-approved session").bzzyFont(10).foregroundStyle(BZZYTheme.muted)
                    }
                }
                if !store.terminalDrafts.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(store.terminalDrafts) { draft in
                            NavigationLink {
                                ConversationCanvas(store: store, conversationID: draft.conversationID, title: draft.name,
                                                   subtitle: "Draft · Inactive", shareTarget: .init(id: draft.id.uuidString, kind: .terminal, name: draft.name, isDemo: false),
                                                   instructions: draft.instructions)
                            } label: {
                                sessionRow(name: draft.name, subtitle: "Draft", symbol: draft.symbol)
                            }.buttonStyle(.plain).accessibilityIdentifier("terminal-draft-\(draft.id.uuidString)")
                            Rectangle().fill(BZZYTheme.line.opacity(0.6)).frame(height: 0.5)
                        }
                    }
                }
                if store.showsDemoContent {
                VStack(spacing: 0) {
                    ForEach(TerminalPreview.samples) { session in
                        NavigationLink {
                            TerminalConversationView(store: store, session: session)
                        } label: {
                            sessionRow(name: session.name, subtitle: session.model, symbol: session.symbol)
                        }.buttonStyle(.plain).accessibilityIdentifier("terminal-\(session.id)")
                        Rectangle().fill(BZZYTheme.line.opacity(0.6)).frame(height: 0.5)
                    }
                }
                Text("Sample sessions").bzzyFont(10).foregroundStyle(BZZYTheme.muted)
                }
            }.padding(.horizontal, 25).padding(.top, 26).padding(.bottom, 20)
        }.scrollIndicators(.hidden)
            .sheet(isPresented: $showConnection) { ConnectView() }
            .navigationDestination(item: $notificationTerminal) { terminal in RemoteTerminalConversationView(store: store, terminal: terminal) }
            .onChange(of: store.notificationTerminalID) { _, id in
                if let id, let terminal = store.liveTerminals.first(where: { $0.id == id }) { notificationTerminal = terminal; store.notificationTerminalID = nil }
            }
    }
    private func sessionRow(name: String, subtitle: String, symbol: String) -> some View {
        HStack(spacing: 17) {
            Image(systemName: symbol).font(.system(size: 21, weight: .light))
                .foregroundStyle(BZZYTheme.secondary).frame(width: 30)
            VStack(alignment: .leading, spacing: 6) {
                Text(name).bzzyFont(15, weight: .medium).foregroundStyle(BZZYTheme.text)
                Text(subtitle).bzzyFont(11).foregroundStyle(BZZYTheme.muted)
            }
            Spacer()
            Image(systemName: "arrow.up.right").font(.system(size: 12)).foregroundStyle(BZZYTheme.muted)
        }.padding(.vertical, 21).contentShape(Rectangle())
    }
}

struct TerminalConversationView: View {
    @Bindable var store: WorkspaceStore
    let session: TerminalPreview
    var body: some View {
        ConversationCanvas(store: store, conversationID: session.id, title: session.name,
                           subtitle: "\(session.model) · Demo", assistantName: session.model, shareTarget: .terminal(session))
    }
}

struct LiveSessionDetailsView: View {
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: WorkspaceStore
    @State private var confirmTakeover = false
    @State private var confirmCancel = false
    @State private var confirmRetry = false
    @State private var steering = ""
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let session = store.liveSession {
                        Text(session.title).bzzyFont(25, weight: .medium)
                        Text("\(session.provider) · \(session.model)").bzzyFont(13)
                        if let directory = session.directory { Text(directory).bzzyFont(12, design: .monospaced).textSelection(.enabled) }
                        Text("Execution: \(session.execution)").bzzyFont(13)
                        if let goal = session.goalStatus { Text("Goal: \(goal)").bzzyFont(13) }
                        Text("Permissions: \(session.permissions.sorted().joined(separator: ", "))").bzzyFont(12)
                        Text(relay.coreOwnsInput ? "Input: this device" : session.inputOwner == nil ? "Input: available" : "Input: another client").bzzyFont(12)
                        if relay.corePermissions.contains("claim") {
                            Button(relay.coreOwnsInput ? "Release input" : "Claim input") {
                                Task { if relay.coreOwnsInput { await relay.releaseCoreInput() } else { _ = await relay.claimCoreInput() } }
                            }.disabled(!relay.coreConnected || relay.coreBusy)
                        }
                        if relay.corePermissions.contains("takeover") && !relay.coreOwnsInput {
                            Button("Take over input") { confirmTakeover = true }.disabled(!relay.coreConnected)
                        }
                        HStack(spacing: 20) {
                            if relay.corePermissions.contains("pause") {
                                Button("Pause") { Task { await relay.controlCore("pause", sessionID: session.id) } }
                            }
                            if relay.corePermissions.contains("execute"), ["paused", "blocked"].contains(session.goalStatus ?? "") {
                                Button("Resume goal") { Task { await relay.resumeCoreGoal(sessionID: session.id) } }
                            }
                            if relay.corePermissions.contains("cancel") { Button("Cancel", role: .destructive) { confirmCancel = true } }
                        }.disabled(!relay.coreConnected || relay.coreBusy || relay.coreCommandUncertain)
                        if session.activeSteering && relay.corePermissions.contains("steer") {
                            TextField("Steering instruction", text: $steering, axis: .vertical).textFieldStyle(.roundedBorder)
                            Button("Send steering") { Task { if await relay.controlCore("steer", text: steering, sessionID: session.id) { steering = "" } } }
                                .disabled(!relay.coreConnected || relay.coreBusy || steering.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                        ForEach(session.questions) { question in
                            LiveQuestionView(question: question, sessionID: session.id)
                        }
                    }
                    if !relay.coreTaskStatus.isEmpty { Text(relay.coreTaskStatus).bzzyFont(12) }
                    if !relay.coreCommandStatus.isEmpty { Text(relay.coreCommandStatus).bzzyFont(12) }
                    if let error = relay.coreError { Text(error).bzzyFont(12).foregroundStyle(BZZYTheme.amber) }
                    Button("Refresh authoritative state") { Task { await relay.refresh(); await relay.refreshCore() } }
                    if relay.coreCommandUncertain {
                        Button("Check command status") { Task { await relay.reconcileCoreCommand() } }
                        Button("Retry saved command") { confirmRetry = true }.disabled(!relay.coreConnected || relay.coreBusy)
                    }
                    Text("Activity").bzzyFont(16, weight: .medium)
                    ForEach(store.liveActivity.reversed()) { item in
                        DisclosureGroup(item.type) {
                            Text(verbatim: item.details).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        }.bzzyFont(12)
                    }
                }.padding(25)
            }.bzzyScreen().toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
                .confirmationDialog("Transfer input from the current client?", isPresented: $confirmTakeover, titleVisibility: .visible) {
                    Button("Take over") { Task { await relay.claimCoreInput(takeover: true) } }
                }
                .confirmationDialog("Cancel host execution?", isPresented: $confirmCancel, titleVisibility: .visible) {
                    Button("Cancel execution", role: .destructive) { Task { await relay.controlCore("cancel", sessionID: store.liveSession?.id) } }
                }
                .confirmationDialog("Retry the exact saved command with its original request ID?", isPresented: $confirmRetry, titleVisibility: .visible) {
                    Button("Retry saved command") { Task { await relay.retryCoreCommand() } }
                }
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
    }
}

struct LiveQuestionView: View {
    @Environment(RelayConnection.self) private var relay
    let question: LiveQuestion
    let sessionID: String
    @State private var answer = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(question.text).bzzyFont(14)
            Text(question.kind).bzzyFont(10).foregroundStyle(BZZYTheme.secondary)
            if !question.options.isEmpty { Text(question.options.joined(separator: " · ")).bzzyFont(12) }
            if relay.corePermissions.contains("answer") {
                TextField("Answer", text: $answer, axis: .vertical).textFieldStyle(.roundedBorder)
                Button("Submit answer") { Task { if await relay.answerCoreQuestion(question.id, answer: answer, sessionID: sessionID) { answer = "" } } }
                    .disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !relay.coreConnected || relay.coreBusy || relay.coreCommandUncertain)
            }
        }.panel()
    }
}

private struct RemoteTerminalConversationView: View {
    @Environment(RelayConnection.self) private var relay
    @Bindable var store: WorkspaceStore
    let terminal: LiveTerminalRecord
    @State private var openFailed = false
    var body: some View {
        ConversationCanvas(store: store, conversationID: terminal.id, title: terminal.title,
            subtitle: terminal.directory, assistantName: terminal.model, remoteSession: true)
            .task(id: terminal.id) {
                if !relay.coreConnected || relay.coreSessionID != terminal.id {
                    openFailed = !(await relay.openCoreSession(terminal.id))
                }
            }
            .alert("Terminal unavailable", isPresented: $openFailed) {
                Button("Retry attachment") { Task { openFailed = !(await relay.openCoreSession(terminal.id)) } }
                Button("Close", role: .cancel) { }
            } message: { Text(relay.coreError ?? "The terminal could not be opened. No execution was started.") }
    }
}
