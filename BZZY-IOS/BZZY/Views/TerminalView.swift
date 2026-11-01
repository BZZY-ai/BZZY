import SwiftUI
import RelayKit

/// Home: the named terminal sessions of the selected computer.
struct TerminalView: View {
    @Environment(RelayConnection.self) private var relay
    @Bindable var store: WorkspaceStore
    @State private var notificationTerminal: LiveTerminalRecord?
    @State private var offlineNoticeVisible = false

    private var online: Bool { relay.coreActionsAvailable }
    /// The last opened terminal stays readable from this iPhone's cache while
    /// Core cannot list sessions.
    private var cachedLiveSession: LiveSessionState? {
        guard !relay.coreCatalogAvailable, let session = store.liveSession, session.hasAlias,
              !store.liveTerminals.contains(where: { $0.id == session.id }) else { return nil }
        return session
    }
    private var sessionCount: Int { store.liveTerminals.count + (cachedLiveSession == nil ? 0 : 1) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                titleRow
                if offlineNoticeVisible && relay.corePairAuthorized && !online { offlineNotice }
                if relay.coreSessionAttachmentPending {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small).tint(BZZYTheme.accent)
                        Text("Opening a terminal…").bzzyFont(13).foregroundStyle(BZZYTheme.secondary)
                        Spacer(minLength: 4)
                        Button("Cancel") { relay.cancelCoreSessionAttachment() }.bzzyFont(13, weight: .semibold)
                    }.padding(.horizontal, 14).padding(.vertical, 6).hiveCard()
                }
                ForEach(store.liveTerminals) { terminal in
                    NavigationLink {
                        RemoteTerminalConversationView(store: store, terminal: terminal)
                    } label: {
                        TerminalSessionCard(title: terminal.title, symbol: "terminal",
                            detail: DisplayPath.short(terminal.directory),
                            meta: terminal.model, updatedAt: RelativeTime.date(terminal.updatedAt),
                            activity: terminal.activity, online: online)
                    }.buttonStyle(BZZYCardStyle())
                        .disabled(!relay.corePairAuthorized || relay.coreBusy)
                        .accessibilityIdentifier("terminal-host-\(terminal.id)")
                }
                if let session = cachedLiveSession {
                    NavigationLink {
                        ConversationCanvas(store: store, conversationID: session.id, title: session.title,
                            subtitle: "\(session.model) · \(store.liveAvailable ? session.execution : "Disconnected")", assistantName: session.model, remoteSession: true).id(session.id)
                    } label: {
                        TerminalSessionCard(title: session.title, symbol: "terminal",
                            detail: session.directory.map(DisplayPath.short), meta: session.model,
                            activity: .init(goal: session.goalStatus, reason: nil, execution: session.execution), online: online)
                    }.buttonStyle(BZZYCardStyle()).disabled(!relay.corePairAuthorized && !AppLaunchMode.allowsPreviewNavigation)
                        .accessibilityIdentifier("terminal-live")
                }
                if sessionCount == 0 && !store.showsDemoContent { emptyState }
                if !store.terminalDrafts.isEmpty {
                    Eyebrow(text: "On this iPhone").padding(.top, 14).padding(.leading, 4)
                    ForEach(store.terminalDrafts) { draft in
                        NavigationLink {
                            ConversationCanvas(store: store, conversationID: draft.conversationID, title: draft.name,
                                               subtitle: "Draft · Inactive", shareTarget: .init(id: draft.id.uuidString, kind: .terminal, name: draft.name, isDemo: false),
                                               instructions: draft.instructions).id(draft.conversationID)
                        } label: {
                            TerminalSessionCard(title: draft.name, symbol: draft.symbol, meta: "Local draft · Inactive",
                                                tint: BZZYTheme.secondary, online: online)
                        }.buttonStyle(BZZYCardStyle()).accessibilityIdentifier("terminal-draft-\(draft.id.uuidString)")
                    }
                }
                if store.showsDemoContent {
                    Eyebrow(text: "Samples").padding(.top, 14).padding(.leading, 4)
                    ForEach(TerminalPreview.samples) { session in
                        NavigationLink {
                            TerminalConversationView(store: store, session: session)
                        } label: {
                            TerminalSessionCard(title: session.name, symbol: session.symbol,
                                                meta: "\(session.model) · \(session.time) ago · Demo", tint: BZZYTheme.agent, online: online)
                        }.buttonStyle(BZZYCardStyle()).accessibilityIdentifier("terminal-\(session.id)")
                    }
                }
                if let message = relay.coreError {
                    Label(message, systemImage: "exclamationmark.triangle.fill").bzzyFont(12)
                        .foregroundStyle(BZZYTheme.amber).padding(.top, 4)
                        .accessibilityIdentifier("terminal-status-message")
                }
            }.padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 24)
        }.scrollIndicators(.hidden)
            .refreshable { await relay.refreshCoreSessions() }
            .task { if relay.coreCatalogAvailable { await relay.refreshCoreSessions() } }
            .task(id: online) {
                // Do not flash an offline notice during the first connection attempt.
                offlineNoticeVisible = false
                guard !online else { return }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                offlineNoticeVisible = !relay.coreActionsAvailable
            }
            .navigationDestination(item: $notificationTerminal) { terminal in RemoteTerminalConversationView(store: store, terminal: terminal) }
            .onChange(of: store.notificationTerminalID) { _, id in
                if let id, let terminal = store.liveTerminals.first(where: { $0.id == id }) { notificationTerminal = terminal; store.notificationTerminalID = nil }
            }
    }

    private var titleRow: some View {
        HStack(alignment: .center, spacing: 10) {
            Text("Terminals").bzzyFont(30, weight: .bold).tracking(-0.4)
                .accessibilityAddTraits(.isHeader)
            if sessionCount > 0 {
                Text("\(sessionCount)").bzzyFont(13, weight: .bold, design: .rounded)
                    .foregroundStyle(BZZYTheme.accent)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(BZZYTheme.accent.opacity(0.14), in: Capsule())
                    .accessibilityLabel("\(sessionCount) sessions")
            }
            Spacer(minLength: 8)
            if relay.coreCatalogAvailable || !store.liveTerminals.isEmpty {
                Button { relay.performHostAction { await relay.refreshCoreSessions() } } label: {
                    Group {
                        if relay.coreCatalogRefreshing { ProgressView().controlSize(.small).tint(BZZYTheme.secondary) }
                        else { Image(systemName: "arrow.clockwise").font(.system(size: 15, weight: .semibold)) }
                    }.frame(width: 44, height: 44).contentShape(Rectangle())
                }.buttonStyle(BZZYPressStyle()).foregroundStyle(BZZYTheme.secondary)
                    .disabled(!online || relay.coreCatalogRefreshing)
                    .accessibilityLabel("Refresh terminals").accessibilityIdentifier("refresh-terminals")
            }
        }.padding(.top, 4).padding(.bottom, 2)
    }

    private var offlineNotice: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "bolt.horizontal.circle.fill").font(.system(size: 18))
                .foregroundStyle(BZZYTheme.danger).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text("Core is offline").bzzyFont(14, weight: .semibold)
                Text("Saved conversations stay readable. Sending and controls unlock when Core responds.")
                    .bzzyFont(12).foregroundStyle(BZZYTheme.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }.padding(14)
            .background(BZZYTheme.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: BZZYTheme.panelRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: BZZYTheme.panelRadius, style: .continuous).stroke(BZZYTheme.danger.opacity(0.3), lineWidth: 0.7))
            .accessibilityElement(children: .combine).accessibilityIdentifier("core-offline-notice")
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            IconTile(symbol: relay.coreCatalogAvailable ? "terminal" : "antenna.radiowaves.left.and.right",
                     tint: relay.coreCatalogAvailable ? BZZYTheme.accent : BZZYTheme.muted, size: 52)
            VStack(spacing: 6) {
                Text(relay.coreCatalogAvailable ? "No named terminals yet" : "Waiting for Core")
                    .bzzyFont(17, weight: .semibold)
                Text(relay.coreCatalogAvailable ? "Name a session in the BZZY CLI and it appears here."
                     : "Your named terminals appear here once Core responds.")
                    .bzzyFont(13).foregroundStyle(BZZYTheme.secondary).multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if relay.coreCatalogAvailable {
                Text("/alias My Project").bzzyFont(13, weight: .medium, design: .monospaced)
                    .foregroundStyle(BZZYTheme.accent)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(BZZYTheme.elevated, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .textSelection(.enabled)
            }
        }.frame(maxWidth: .infinity).padding(.vertical, 28).padding(.horizontal, 20)
            .hiveCard()
            .accessibilityElement(children: .combine).accessibilityIdentifier("terminal-empty-state")
    }
}

/// One session in the home list: alias, live status and a single line of context.
private struct TerminalSessionCard: View {
    let title: String
    let symbol: String
    var detail: String? = nil
    var meta: String? = nil
    var updatedAt: Date? = nil
    var activity: TerminalGoalActivity? = nil
    var tint: Color = BZZYTheme.accent
    let online: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            IconTile(symbol: symbol, tint: online || activity == nil ? tint : BZZYTheme.muted)
            VStack(alignment: .leading, spacing: 6) {
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                    : AnyLayout(HStackLayout(alignment: .center, spacing: 8))
                layout {
                    Text(title).bzzyFont(16, weight: .semibold).foregroundStyle(BZZYTheme.text)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                    if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 4) }
                    if let activity, activity != .idle { TerminalActivityBadge(activity: activity, online: online) }
                }
                if let detail, !detail.isEmpty {
                    Text(detail).bzzyFont(12, design: .monospaced).foregroundStyle(BZZYTheme.secondary)
                        .lineLimit(1).truncationMode(.head)
                }
                if meta != nil || updatedAt != nil {
                    TimelineView(.everyMinute) { context in
                        Text([meta, updatedAt.map { RelativeTime.short($0, now: context.date) }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                            .bzzyFont(12).foregroundStyle(BZZYTheme.muted).lineLimit(1)
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                .foregroundStyle(BZZYTheme.muted).padding(.top, 11).accessibilityHidden(true)
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .hiveCard(highlight: activity == .running && online ? BZZYTheme.accent
                      : activity == .waiting && online ? BZZYTheme.user : nil)
            .contentShape(RoundedRectangle(cornerRadius: BZZYTheme.panelRadius, style: .continuous))
    }
}

private struct TerminalActivityBadge: View {
    let activity: TerminalGoalActivity
    let online: Bool
    var body: some View {
        StatusPill(text: label, tone: online ? tone : BZZYTheme.muted, active: activity == .running && online)
            .fixedSize()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(online ? activity.rawValue : "Last known: \(activity.rawValue), Core offline")
    }
    private var label: String {
        switch activity {
        case .achieved: "Achieved"
        case .stalled: "Stalled"
        case .running: "Running"
        case .paused: "Paused"
        case .waiting: "Needs input"
        case .cancelled: "Cancelled"
        case .idle: "Idle"
        }
    }
    private var tone: Color {
        switch activity {
        case .achieved: BZZYTheme.success
        case .stalled: BZZYTheme.danger
        case .paused: BZZYTheme.amber
        case .waiting: BZZYTheme.user
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
                VStack(alignment: .leading, spacing: 16) {
                    if let session = store.liveSession {
                        SheetTitle(title: session.title, subtitle: "\(session.provider) · \(session.model)")
                        VStack(alignment: .leading, spacing: 0) {
                            if let directory = session.directory {
                                detailRow("folder", "Directory") {
                                    Text(DisplayPath.short(directory)).bzzyFont(12, design: .monospaced).textSelection(.enabled)
                                }
                                Divider().overlay(BZZYTheme.line)
                            }
                            detailRow("bolt.horizontal", "Execution") { Text(session.execution.replacingOccurrences(of: "_", with: " ").capitalized).bzzyFont(13) }
                            if let goal = session.goalStatus {
                                Divider().overlay(BZZYTheme.line)
                                detailRow("scope", "Goal") { Text(goal.replacingOccurrences(of: "_", with: " ").capitalized).bzzyFont(13) }
                            }
                        }.padding(.horizontal, 14).hiveCard()
                        VStack(alignment: .leading, spacing: 12) {
                            Eyebrow(text: "Input")
                            if relay.coreInputSubmission {
                                Text("Live session · Core coordinates input").bzzyFont(13).foregroundStyle(BZZYTheme.secondary)
                            } else {
                                Text(relay.coreOwnsInput ? "This iPhone holds input" : session.inputOwner == nil ? "Input is available" : "Another client holds input")
                                    .bzzyFont(13)
                                Text("Permissions: \(session.permissions.sorted().joined(separator: ", "))").bzzyFont(11)
                                    .foregroundStyle(BZZYTheme.muted).fixedSize(horizontal: false, vertical: true)
                                HStack(spacing: 10) {
                                    if relay.corePermissions.contains("claim") {
                                        Button(relay.coreOwnsInput ? "Release input" : "Claim input") {
                                            relay.performHostAction { if relay.coreOwnsInput { await relay.releaseCoreInput() } else { _ = await relay.claimCoreInput() } }
                                        }.disabled(!relay.coreActionsAvailable || relay.coreBusy)
                                    }
                                    if relay.corePermissions.contains("takeover") && !relay.coreOwnsInput {
                                        Button("Take over") { confirmTakeover = true }.disabled(!relay.coreActionsAvailable)
                                    }
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).panel()
                        if relay.corePermissions.contains("pause") || relay.corePermissions.contains("cancel") || relay.corePermissions.contains("execute") {
                            VStack(alignment: .leading, spacing: 12) {
                                Eyebrow(text: "Controls")
                                HStack(spacing: 10) {
                                    if relay.corePermissions.contains("pause") {
                                        Button { relay.performHostAction { await relay.controlCore("pause", sessionID: session.id) } } label: {
                                            Label("Pause", systemImage: "pause.fill")
                                        }
                                    }
                                    if relay.corePermissions.contains("execute"), ["paused", "blocked"].contains(session.goalStatus ?? "") {
                                        Button { relay.performHostAction { await relay.resumeCoreGoal(sessionID: session.id) } } label: {
                                            Label("Resume goal", systemImage: "play.fill")
                                        }
                                    }
                                    if relay.corePermissions.contains("cancel") {
                                        Button(role: .destructive) { confirmCancel = true } label: { Label("Cancel", systemImage: "stop.fill") }
                                    }
                                }.disabled(!relay.coreActionsAvailable || relay.coreBusy || relay.coreCommandUncertain)
                            }.frame(maxWidth: .infinity, alignment: .leading).panel()
                        }
                        if session.activeSteering && relay.corePermissions.contains("steer") {
                            VStack(alignment: .leading, spacing: 12) {
                                Eyebrow(text: "Steer")
                                TextField("Steering instruction", text: $steering, axis: .vertical)
                                    .bzzyFont(14).textFieldStyle(.plain).hiveField()
                                Button("Send steering") { relay.performHostAction { if await relay.controlCore("steer", text: steering, sessionID: session.id) { steering = "" } } }
                                    .disabled(!relay.coreActionsAvailable || relay.coreBusy || steering.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }.frame(maxWidth: .infinity, alignment: .leading).panel()
                        }
                        ForEach(session.questions) { question in
                            LiveQuestionView(question: question, sessionID: session.id)
                        }
                    }
                    if !relay.coreTaskStatus.isEmpty { Text(relay.coreTaskStatus).bzzyFont(12).foregroundStyle(BZZYTheme.secondary) }
                    if !relay.coreCommandStatus.isEmpty { Text(relay.coreCommandStatus).bzzyFont(12).foregroundStyle(BZZYTheme.secondary) }
                    if let error = relay.coreError { Text(error).bzzyFont(12).foregroundStyle(BZZYTheme.amber) }
                    Button {
                        let origin = HostActionContext(hostID: relay.activeHostID)
                        relay.performHostAction { await relay.refresh(); if origin.permits(relay.activeHostID) { await relay.refreshCore() } }
                    } label: { Label("Refresh authoritative state", systemImage: "arrow.clockwise") }
                    if relay.coreCommandUncertain {
                        HStack(spacing: 10) {
                            Button("Check command status") { relay.performHostAction { await relay.reconcileCoreCommand() } }
                            Button("Retry saved command") { confirmRetry = true }.disabled(!relay.coreActionsAvailable || relay.coreBusy)
                        }
                    }
                    if !store.liveActivity.isEmpty {
                        Eyebrow(text: "Activity").padding(.top, 8)
                        ForEach(store.liveActivity.reversed()) { item in
                            DisclosureGroup {
                                Text(verbatim: item.details).font(.system(.caption, design: .monospaced))
                                    .textSelection(.enabled).padding(.top, 8).frame(maxWidth: .infinity, alignment: .leading)
                            } label: {
                                Text(item.type).bzzyFont(13, weight: .medium, design: .monospaced).foregroundStyle(BZZYTheme.text)
                            }.padding(.horizontal, 14).padding(.vertical, 10).hiveCard()
                        }
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

    private func detailRow<Value: View>(_ icon: String, _ label: String, @ViewBuilder value: () -> Value) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: icon).font(.system(size: 13, weight: .semibold)).foregroundStyle(BZZYTheme.accent)
                .frame(width: 20).accessibilityHidden(true)
            Text(label).bzzyFont(13).foregroundStyle(BZZYTheme.secondary)
            Spacer(minLength: 12)
            value().multilineTextAlignment(.trailing)
        }.padding(.vertical, 12)
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
                Label("Permission requested", systemImage: "lock.shield.fill").bzzyFont(13, weight: .semibold).foregroundStyle(BZZYTheme.amber)
                Text(question.text.components(separatedBy: "\nAllow once?").first ?? question.text)
                    .bzzyFont(12, design: .monospaced).foregroundStyle(BZZYTheme.secondary).lineLimit(2)
                DisclosureGroup("Review action") {
                    Text(question.text.replacingOccurrences(of: "\nAllow once? [y/N] ", with: ""))
                        .bzzyFont(12, design: .monospaced).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }.bzzyFont(12).tint(BZZYTheme.accent)
            } else {
                Label("Input needed", systemImage: "questionmark.bubble.fill").bzzyFont(13, weight: .semibold).foregroundStyle(BZZYTheme.user)
                Text(question.text).bzzyFont(14).fixedSize(horizontal: false, vertical: true)
            }
            if !question.options.isEmpty { Text(question.options.joined(separator: " · ")).bzzyFont(12).foregroundStyle(BZZYTheme.secondary) }
            if relay.corePermissions.contains("answer") {
                if question.kind == "approval" {
                    HStack(spacing: 10) {
                        approvalButton("Approve once", symbol: "checkmark", answer: "yes", tone: BZZYTheme.success)
                        approvalButton("Deny", symbol: "xmark", answer: "no", tone: BZZYTheme.danger)
                    }.disabled(!relay.coreActionsAvailable || relay.coreBusy || relay.coreCommandUncertain)
                } else {
                    TextField("Answer", text: $answer, axis: .vertical).bzzyFont(14).textFieldStyle(.plain).hiveField()
                    Button("Submit answer") { relay.performHostAction { if await relay.answerCoreQuestion(question.id, answer: answer, sessionID: sessionID) { answer = "" } } }
                        .disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !relay.coreActionsAvailable || relay.coreBusy || relay.coreCommandUncertain)
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
            .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: BZZYTheme.panelRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: BZZYTheme.panelRadius, style: .continuous)
                .stroke((question.kind == "approval" ? BZZYTheme.amber : BZZYTheme.user).opacity(0.4), lineWidth: 0.8))
    }
    private func approvalButton(_ title: String, symbol: String, answer: String, tone: Color) -> some View {
        Button { relay.performHostAction { await relay.answerCoreQuestion(question.id, answer: answer, sessionID: sessionID) }; BZZYTheme.haptic() } label: {
            Label(title, systemImage: symbol).bzzyFont(14, weight: .semibold).frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(BZZYTheme.background).background(tone, in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius, style: .continuous))
        }.buttonStyle(BZZYPressStyle()).accessibilityIdentifier(answer == "yes" ? "approve-once" : "deny-approval")
    }
}

private struct RemoteTerminalConversationView: View {
    @Environment(RelayConnection.self) private var relay
    @Bindable var store: WorkspaceStore
    let terminal: LiveTerminalRecord
    var body: some View {
        ConversationCanvas(store: store, conversationID: terminal.id, title: terminal.title,
            subtitle: DisplayPath.short(terminal.directory), assistantName: terminal.model, remoteSession: true)
            .id(terminal.id)
            .task(id: terminal.id) { await relay.observeCoreSession(terminal.id) }
    }
}
