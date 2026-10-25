import SwiftUI
import RelayKit

struct TerminalView: View {
    @Environment(RelayConnection.self) private var relay
    @Bindable var store: WorkspaceStore
    @State private var showConnection = false
    @State private var notificationTerminal: LiveTerminalRecord?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { sessionsHeading; Spacer(minLength: 8); hostStatus }
                    VStack(alignment: .leading, spacing: 4) { sessionsHeading; hostStatus }
                }
                Rectangle().fill(BZZYTheme.line).frame(height: 0.5)

                if relay.coreCatalogAvailable || !store.liveTerminals.isEmpty {
                    HStack(alignment: .firstTextBaseline) {
                        Text(relay.coreCatalogAvailable ? "Your terminals" : "Saved terminals · Offline").bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                        Spacer()
                        Button { relay.performHostAction { await relay.refreshCoreSessions() } } label: {
                            Label(relay.coreCatalogRefreshing ? "Checking…" : "Refresh", systemImage: "arrow.clockwise")
                        }.bzzyFont(12).disabled(!relay.coreActionsAvailable || relay.coreCatalogRefreshing).accessibilityIdentifier("refresh-terminals")
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
                                sessionRow(name: terminal.title, symbol: "terminal", activity: terminal.activity)
                            }.buttonStyle(.plain)
                                .disabled(!relay.coreActionsAvailable || !relay.coreCatalogReady || relay.coreBusy)
                                .accessibilityIdentifier("terminal-host-\(terminal.id)")
                            Rectangle().fill(BZZYTheme.line.opacity(0.6)).frame(height: 0.5)
                        }
                    }
                }
                if !relay.coreCatalogAvailable, let session = store.liveSession, session.hasAlias, !store.liveTerminals.contains(where: { $0.id == session.id }) {
                    VStack(spacing: 0) {
                        NavigationLink {
                            ConversationCanvas(store: store, conversationID: session.id, title: session.title,
                                subtitle: "\(session.model) · \(store.liveAvailable ? session.execution : "Disconnected")", assistantName: session.model, remoteSession: true).id(session.id)
                        } label: {
                            sessionRow(name: session.title, symbol: "terminal", activity: .init(goal: session.goalStatus, reason: nil, execution: session.execution))
                        }.buttonStyle(.plain).disabled(!relay.coreActionsAvailable).accessibilityIdentifier("terminal-live")
                    }
                }
                if !store.terminalDrafts.isEmpty {
                    Eyebrow(text: "Local drafts")
                    VStack(spacing: 0) {
                        ForEach(store.terminalDrafts) { draft in
                            NavigationLink {
                                ConversationCanvas(store: store, conversationID: draft.conversationID, title: draft.name,
                                                   subtitle: "Draft · Inactive", shareTarget: .init(id: draft.id.uuidString, kind: .terminal, name: draft.name, isDemo: false),
                                                   instructions: draft.instructions).id(draft.conversationID)
                            } label: {
                                sessionRow(name: draft.name, symbol: draft.symbol)
                            }.buttonStyle(.plain).accessibilityIdentifier("terminal-draft-\(draft.id.uuidString)")
                            Rectangle().fill(BZZYTheme.line.opacity(0.6)).frame(height: 0.5)
                        }
                    }
                }
                if store.showsDemoContent {
                Eyebrow(text: "Sample sessions")
                VStack(spacing: 0) {
                    ForEach(TerminalPreview.samples) { session in
                        NavigationLink {
                            TerminalConversationView(store: store, session: session)
                        } label: {
                            sessionRow(name: session.name, symbol: session.symbol)
                        }.buttonStyle(.plain).accessibilityIdentifier("terminal-\(session.id)")
                        Rectangle().fill(BZZYTheme.line.opacity(0.6)).frame(height: 0.5)
                    }
                }
                }
                if let message = relay.coreError {
                    Text(message).bzzyFont(11).foregroundStyle(BZZYTheme.amber).accessibilityIdentifier("terminal-status-message")
                }
            }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 16)
        }.scrollIndicators(.hidden)
            .task { if relay.coreCatalogAvailable { await relay.refreshCoreSessions() } }
            .sheet(isPresented: $showConnection) { ConnectView() }
            .navigationDestination(item: $notificationTerminal) { terminal in RemoteTerminalConversationView(store: store, terminal: terminal) }
            .onChange(of: store.notificationTerminalID) { _, id in
                if let id, let terminal = store.liveTerminals.first(where: { $0.id == id }) { notificationTerminal = terminal; store.notificationTerminalID = nil }
            }
    }

    private var sessionsHeading: some View {
        Text("› sessions").bzzyFont(14, weight: .semibold).foregroundStyle(BZZYTheme.accent)
            .fixedSize(horizontal: true, vertical: false).accessibilityAddTraits(.isHeader)
    }

    private var hostStatus: some View {
        Button { showConnection = true } label: {
            Label(relay.shortStatus, systemImage: "desktopcomputer")
                .bzzyFont(11).foregroundStyle(BZZYTheme.secondary).frame(minHeight: 44)
        }.buttonStyle(.plain).accessibilityIdentifier("host-status")
    }

    private func sessionRow(name: String, symbol: String, activity: TerminalGoalActivity? = nil) -> some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 10))
        return layout {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: "chevron.right").bzzyFont(12, weight: .semibold)
                    .foregroundStyle(BZZYTheme.accent).frame(minWidth: 12).accessibilityHidden(true)
                Text(name).bzzyFont(15, weight: .medium).foregroundStyle(BZZYTheme.text)
            }
            if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
            if let activity { TerminalGoalIndicator(activity: activity, online: relay.coreActionsAvailable) }
        }.padding(.vertical, 12).frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
    }
}

private struct TerminalGoalIndicator: View {
    let activity: TerminalGoalActivity
    let online: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: 7) {
            if activity == .running && online && !reduceMotion {
                ProgressView().controlSize(.mini).tint(BZZYTheme.accent)
            } else {
                Circle().fill(color).frame(width: 8, height: 8)
            }
            Text(activity.rawValue.uppercased()).bzzyFont(10, weight: .medium).foregroundStyle(color)
        }.opacity(online ? 1 : 0.5)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(online ? activity.rawValue : "Last known: \(activity.rawValue), Core offline")
    }
    private var color: Color {
        switch activity {
        case .achieved: BZZYTheme.success
        case .stalled: BZZYTheme.danger
        case .paused, .waiting: BZZYTheme.amber
        case .running: BZZYTheme.accent
        case .idle, .cancelled: BZZYTheme.muted
        }
    }
}

struct TerminalConversationView: View {
    @Bindable var store: WorkspaceStore
    let session: TerminalPreview
    var body: some View {
        ConversationCanvas(store: store, conversationID: session.id, title: session.name,
                           subtitle: "\(session.model) · Demo", assistantName: session.model, shareTarget: .terminal(session)).id(session.id)
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
                        Text(session.title).bzzyFont(20, weight: .semibold)
                        Text("\(session.provider) · \(session.model)").bzzyFont(13)
                        if let directory = session.directory { Text(directory).bzzyFont(12, design: .monospaced).textSelection(.enabled) }
                        Text("Execution: \(session.execution)").bzzyFont(13)
                        if let goal = session.goalStatus { Text("Goal: \(goal)").bzzyFont(13) }
                        if relay.coreInputSubmission {
                            Text("Live session · Core coordinates input").bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                        } else {
                        Text("Permissions: \(session.permissions.sorted().joined(separator: ", "))").bzzyFont(12)
                        Text(relay.coreOwnsInput ? "Input: this device" : session.inputOwner == nil ? "Input: available" : "Input: another client").bzzyFont(12)
                        if relay.corePermissions.contains("claim") {
                            Button(relay.coreOwnsInput ? "Release input" : "Claim input") {
                                relay.performHostAction { if relay.coreOwnsInput { await relay.releaseCoreInput() } else { _ = await relay.claimCoreInput() } }
                            }.disabled(!relay.coreActionsAvailable || relay.coreBusy)
                        }
                        if relay.corePermissions.contains("takeover") && !relay.coreOwnsInput {
                            Button("Take over input") { confirmTakeover = true }.disabled(!relay.coreActionsAvailable)
                        }
                        }
                        HStack(spacing: 20) {
                            if relay.corePermissions.contains("pause") {
                                Button("Pause") { relay.performHostAction { await relay.controlCore("pause", sessionID: session.id) } }
                            }
                            if relay.corePermissions.contains("execute"), ["paused", "blocked"].contains(session.goalStatus ?? "") {
                                Button("Resume goal") { relay.performHostAction { await relay.resumeCoreGoal(sessionID: session.id) } }
                            }
                            if relay.corePermissions.contains("cancel") { Button("Cancel", role: .destructive) { confirmCancel = true } }
                        }.disabled(!relay.coreActionsAvailable || relay.coreBusy || relay.coreCommandUncertain)
                        if session.activeSteering && relay.corePermissions.contains("steer") {
                            TextField("Steering instruction", text: $steering, axis: .vertical).textFieldStyle(.roundedBorder)
                            Button("Send steering") { relay.performHostAction { if await relay.controlCore("steer", text: steering, sessionID: session.id) { steering = "" } } }
                                .disabled(!relay.coreActionsAvailable || relay.coreBusy || steering.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                        ForEach(session.questions) { question in
                            LiveQuestionView(question: question, sessionID: session.id)
                        }
                    }
                    if !relay.coreTaskStatus.isEmpty { Text(relay.coreTaskStatus).bzzyFont(12) }
                    if !relay.coreCommandStatus.isEmpty { Text(relay.coreCommandStatus).bzzyFont(12) }
                    if let error = relay.coreError { Text(error).bzzyFont(12).foregroundStyle(BZZYTheme.amber) }
                    Button("Refresh authoritative state") {
                        let origin = HostActionContext(hostID: relay.activeHostID)
                        relay.performHostAction { await relay.refresh(); if origin.permits(relay.activeHostID) { await relay.refreshCore() } }
                    }
                    if relay.coreCommandUncertain {
                        Button("Check command status") { relay.performHostAction { await relay.reconcileCoreCommand() } }
                        Button("Retry saved command") { confirmRetry = true }.disabled(!relay.coreActionsAvailable || relay.coreBusy)
                    }
                    Text("Activity").bzzyFont(16, weight: .medium)
                    ForEach(store.liveActivity.reversed()) { item in
                        DisclosureGroup(item.type) {
                            Text(verbatim: item.details).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        }.bzzyFont(12)
                    }
                }.padding(16)
            }.bzzyScreen().toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
                .confirmationDialog("Transfer input from the current client?", isPresented: $confirmTakeover, titleVisibility: .visible) {
                    Button("Take over") { relay.performHostAction { await relay.claimCoreInput(takeover: true) } }
                }
                .confirmationDialog("Cancel host execution?", isPresented: $confirmCancel, titleVisibility: .visible) {
                    Button("Cancel execution", role: .destructive) {
                        if let sessionID = store.liveSession?.id { relay.performHostAction { await relay.controlCore("cancel", sessionID: sessionID) } }
                    }
                }
                .confirmationDialog("Retry the exact saved command with its original request ID?", isPresented: $confirmRetry, titleVisibility: .visible) {
                    Button("Retry saved command") { relay.performHostAction { await relay.retryCoreCommand() } }
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
            if question.kind == "approval" {
                Label("Permission requested", systemImage: "lock.shield").bzzyFont(13, weight: .semibold).foregroundStyle(BZZYTheme.amber)
                Text(question.text.components(separatedBy: "\nAllow once?").first ?? question.text)
                    .bzzyFont(12, design: .monospaced).foregroundStyle(BZZYTheme.secondary).lineLimit(2)
                DisclosureGroup("Review action") {
                    Text(question.text.replacingOccurrences(of: "\nAllow once? [y/N] ", with: ""))
                        .bzzyFont(12, design: .monospaced).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }.bzzyFont(12).tint(BZZYTheme.accent)
            } else {
                Text(question.text).bzzyFont(14)
                Text(question.kind).bzzyFont(10).foregroundStyle(BZZYTheme.secondary)
            }
            if !question.options.isEmpty { Text(question.options.joined(separator: " · ")).bzzyFont(12) }
            if relay.corePermissions.contains("answer") {
                if question.kind == "approval" {
                    HStack(spacing: 10) {
                        approvalButton("Approve once", symbol: "checkmark", answer: "yes", tone: BZZYTheme.success)
                        approvalButton("Deny", symbol: "xmark", answer: "no", tone: BZZYTheme.danger)
                    }.disabled(!relay.coreActionsAvailable || relay.coreBusy || relay.coreCommandUncertain)
                } else {
                    TextField("Answer", text: $answer, axis: .vertical).textFieldStyle(.roundedBorder)
                    Button("Submit answer") { relay.performHostAction { if await relay.answerCoreQuestion(question.id, answer: answer, sessionID: sessionID) { answer = "" } } }
                        .disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !relay.coreActionsAvailable || relay.coreBusy || relay.coreCommandUncertain)
                }
            }
        }.panel()
    }
    private func approvalButton(_ title: String, symbol: String, answer: String, tone: Color) -> some View {
        Button { relay.performHostAction { await relay.answerCoreQuestion(question.id, answer: answer, sessionID: sessionID) }; BZZYTheme.haptic() } label: {
            Label(title, systemImage: symbol).bzzyFont(13, weight: .semibold).frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(BZZYTheme.background).background(tone, in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius))
        }.buttonStyle(BZZYPressStyle()).accessibilityIdentifier(answer == "yes" ? "approve-once" : "deny-approval")
    }
}

private struct RemoteTerminalConversationView: View {
    @Environment(RelayConnection.self) private var relay
    @Bindable var store: WorkspaceStore
    let terminal: LiveTerminalRecord
    var body: some View {
        ConversationCanvas(store: store, conversationID: terminal.id, title: terminal.title,
            subtitle: terminal.directory, assistantName: terminal.model, remoteSession: true)
            .id(terminal.id)
            .task(id: terminal.id) { await relay.observeCoreSession(terminal.id) }
    }
}
