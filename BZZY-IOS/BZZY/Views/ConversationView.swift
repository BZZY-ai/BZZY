import SwiftUI
import RelayKit
#if canImport(UIKit)
import UIKit
#endif

struct ConversationView: View {
    @Bindable var store: WorkspaceStore
    let agent: AgentProfile
    var body: some View {
        ConversationCanvas(store: store, conversationID: agent.id.uuidString, title: agent.name,
                           subtitle: agent.isSample ? "Demo" : "Draft · \(agent.mode.rawValue)", agent: agent,
                           shareTarget: .agent(agent))
    }
}

struct ConversationCanvas: View {
    @Bindable var store: WorkspaceStore
    let conversationID: String
    let title: String
    let subtitle: String
    var agent: AgentProfile? = nil
    var assistantName: String? = nil
    var shareTarget: ShareTarget? = nil
    var instructions: String? = nil
    var remoteSession = false
    @Environment(\.dismiss) private var dismiss
    @Environment(RelayConnection.self) private var relay
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var draft = ""
    @State private var pendingSubmittedDraft: String?
    @State private var goalToReplace: String?
    @State private var replacementDraft: String?
    @State private var showReplaceGoal = false
    @State private var retryGoalMessageID: String?
    @State private var showShare = false
    @State private var voice = VoiceCapture()
    @AppStorage(SpeechLanguage.recognitionKey, store: SpeechLanguage.preferences) private var recognitionLanguage = SpeechLanguage.preferred.rawValue
    @State private var voiceDraft: VoiceDraft?
    @State private var recordingTask: Task<Void, Never>?
    @GestureState private var voiceHeld = false
    @State private var showDetails = false
    @State private var showActivity = false
    @State private var composerCaretRequest = 0
    @State private var visibleMessageLimit = 200
    @State private var pagingHistory = false
    @State private var followingLatest = true
    @State private var initialPositioned = false
    @State private var scrollViewportHeight: CGFloat = 0
    #if canImport(UIKit)
    @State private var composerFocused = false
    #else
    @FocusState private var composerFocused: Bool
    #endif
    private var isDemo: Bool { store.demoConversation(conversationID) != nil }
    private var isLive: Bool { remoteSession || store.liveSession?.id == conversationID }
    private var canSubmit: Bool {
        voiceDraft == nil && !voice.isBusy && !voiceHeld && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        (!isLive || relay.isCoreSessionReady(conversationID) && relay.corePermissions.contains("execute") && !relay.isCoreSessionBusy(conversationID) && !relay.hasUncertainCoreCommand(sessionID: conversationID))
    }
    private func submit(_ submitted: String, replacing goalID: String? = nil) {
        prepareForSubmission()
        pendingSubmittedDraft = submitted
        Task {
            if await relay.sendCoreMessage(submitted, sessionID: conversationID, replaceGoalID: goalID), draft == submitted {
                draft = ""; pendingSubmittedDraft = nil; composerFocused = false
            }
        }
    }
    private var canDictate: Bool {
        !isLive || relay.isCoreSessionReady(conversationID) && relay.corePermissions.contains("execute")
    }
    private var canSetGoal: Bool {
        voiceDraft == nil && !voice.isBusy && !voiceHeld && (!isLive || relay.isCoreSessionReady(conversationID)
            && relay.coreGoalSubmission && relay.corePermissions.contains("execute") && !relay.isCoreSessionBusy(conversationID) && !relay.hasUncertainCoreCommand(sessionID: conversationID))
    }
    private var messages: [LocalMessage] {
        if remoteSession { return store.liveSession?.id == conversationID ? store.liveMessages : [] }
        return store.conversationMessages(conversationID)
    }

    private var visibleMessages: [LocalMessage] { Array(messages.suffix(visibleMessageLimit)) }
    private var hasEarlierMessages: Bool {
        messages.count > visibleMessageLimit || isLive && relay.coreSessionID == conversationID && relay.coreHistoryHasOlder
    }
    private var chatConnectionStatus: String {
        guard isLive else { return isDemo ? "Demo · On device" : "Not connected" }
        guard relay.isCoreSessionReady(conversationID) else {
            return relay.coreError ?? (relay.coreConnected ? "Opening conversation…" : "Reconnecting to Core…")
        }
        if let error = relay.coreError { return error }
        if relay.hasUncertainCoreCommand(sessionID: conversationID) { return "Checking message delivery…" }
        if !relay.coreCommandStatus.isEmpty { return relay.coreCommandStatus }
        return relay.coreInputStatus ?? (relay.corePermissions.contains("execute") ? "Connected to Core" : "Observer · Read only")
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                RoundButton(symbol: "chevron.left", label: "Back") { dismiss() }
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).bzzyFont(16, weight: .medium).lineLimit(1)
                    Text(subtitle).bzzyFont(9, design: .monospaced).foregroundStyle(BZZYTheme.secondary)
                        .accessibilityIdentifier("conversation-mode")
                }
                Spacer(minLength: 0)
                if isLive && relay.coreSharingAllowed && relay.coreSessionID == conversationID {
                    RoundButton(symbol: "square.and.arrow.up", label: relay.coreIsAgent ? "Share agent project and context" : "Share terminal project and context") { showShare = true }
                        .disabled(!relay.isCoreSessionReady(conversationID))
                        .accessibilityIdentifier(relay.coreIsAgent ? "share-live-agent" : "share-live-terminal")
                } else if shareTarget != nil {
                    RoundButton(symbol: "square.and.arrow.up", label: "Share \(shareTarget?.kind.title.lowercased() ?? "workspace")") { showShare = true }
                        .accessibilityIdentifier("share-resource")
                }
                if isLive {
                    RoundButton(symbol: "list.bullet", label: "Live activity") { showActivity = true }
                        .disabled(relay.coreSessionID != conversationID)
                        .accessibilityIdentifier("live-session-activity")
                }
                RoundButton(symbol: "ellipsis", label: "Workspace details") { showDetails = true }
                    .disabled(isLive && relay.coreSessionID != conversationID)
            }.padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 14)
            Rectangle().fill(BZZYTheme.line.opacity(0.65)).frame(height: 0.5)

            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if hasEarlierMessages {
                            Button { Task { await loadEarlierHistory(reader) } } label: {
                                HStack(spacing: 8) {
                                    if pagingHistory || relay.coreHistoryLoading { ProgressView().controlSize(.small) }
                                    else { Image(systemName: "arrow.up") }
                                    Text("Earlier messages").bzzyFont(11, weight: .medium)
                                }.frame(maxWidth: .infinity, minHeight: 40)
                            }.buttonStyle(BZZYPressStyle()).foregroundStyle(BZZYTheme.accent)
                                .disabled(pagingHistory || relay.coreHistoryLoading || (messages.count <= visibleMessageLimit && !relay.isCoreSessionReady(conversationID)))
                                .accessibilityIdentifier("load-earlier-messages")
                                .id(visibleMessages.first?.id)
                                .onAppear {
                                    if initialPositioned && !followingLatest { Task { await loadEarlierHistory(reader) } }
                                }
                        }
                        if messages.isEmpty {
                            FlyEyes(interactive: false).frame(width: 160)
                                .frame(maxWidth: .infinity).padding(.vertical, 70)
                        }
                        ForEach(visibleMessages) { message in
                            ChatBubble(message: message, showsDraft: !isDemo && !isLive && message.isUser,
                                       speaker: message.isUser ? "You" : (message.speaker ?? assistantName ?? title))
                                .id(message.id)
                        }
                        if isLive, relay.coreSessionID == conversationID {
                            ForEach(relay.coreOutgoingMessages) { outgoing in
                                OutgoingMessageBubble(message: outgoing, retryEnabled: relay.isCoreSessionReady(conversationID) && !relay.isCoreSessionBusy(conversationID)) {
                                    prepareForSubmission()
                                    if outgoing.status == .failed, CoreGoalDraft.isNewGoal(outgoing.text),
                                       CoreGoalDraft.needsReplacement(status: relay.coreGoalStatus), let goalID = relay.coreGoalID,
                                       outgoing.params["replaceGoalId"]?.string != goalID {
                                        retryGoalMessageID = outgoing.id; goalToReplace = goalID; showReplaceGoal = true
                                    } else { Task { await relay.retryOutgoingMessage(outgoing.id) } }
                                }.contextMenu {
                                    if outgoing.status == .failed {
                                        Button("Remove failed message", role: .destructive) { relay.removeFailedOutgoingMessage(outgoing.id) }
                                    }
                                }
                            }
                        }
                        Color.clear.frame(height: 1).id("bottom")
                            .background(GeometryReader { geometry in
                                Color.clear.preference(key: ConversationBottomPreference.self,
                                    value: geometry.frame(in: .named("conversation-scroll")).maxY)
                            })
                    }.padding(.horizontal, 20).padding(.top, 24).padding(.bottom, 16)
                }.scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
                    .coordinateSpace(name: "conversation-scroll")
                    .background(GeometryReader { geometry in
                        Color.clear.onAppear { scrollViewportHeight = geometry.size.height }
                            .onChange(of: geometry.size.height) { _, height in scrollViewportHeight = height }
                    })
                    .onPreferenceChange(ConversationBottomPreference.self) { bottom in
                        guard initialPositioned, !pagingHistory, let bottom, scrollViewportHeight > 0 else { return }
                        followingLatest = bottom >= 0 && bottom <= scrollViewportHeight + 72
                    }
                    .defaultScrollAnchor(.bottom)
                    .task(id: conversationID) {
                        visibleMessageLimit = 200; followingLatest = true; initialPositioned = false
                        await Task.yield()
                        scrollToLatest(reader)
                        initialPositioned = true
                    }
                    .onChange(of: relay.coreOutgoingMessages.map(\.id)) { previous, current in
                        if current.contains(where: { !previous.contains($0) }) {
                            prepareForSubmission()
                            scrollToLatest(reader, force: true)
                        }
                    }
                    .onChange(of: messages.last?.text) { scrollToLatest(reader) }
                    .onChange(of: messages.last?.id) { scrollToLatest(reader) }
                    .onChange(of: composerFocused) {
                        if composerFocused { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { reader.scrollTo("bottom", anchor: .bottom) } }
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if !followingLatest || isLive && relay.coreHistoryHasNewer {
                            Button {
                                Task {
                                    if isLive { relay.showLatestCoreHistory(sessionID: conversationID) }
                                    visibleMessageLimit = 200; followingLatest = true
                                    await Task.yield()
                                    scrollToLatest(reader, force: true)
                                }
                            } label: {
                                Label("Latest", systemImage: "arrow.down").bzzyFont(11, weight: .semibold)
                                    .padding(.horizontal, 14).frame(minHeight: 40)
                                    .background(BZZYTheme.surface, in: Capsule())
                                    .overlay(Capsule().stroke(BZZYTheme.accent.opacity(0.5), lineWidth: 0.7))
                            }.buttonStyle(BZZYPressStyle()).foregroundStyle(BZZYTheme.accent)
                                .padding(16).accessibilityIdentifier("chat-jump-to-latest")
                        }
                    }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .bzzyScreen().toolbar(.hidden)
        .onChange(of: relay.coreCommandStatus) { _, status in
            if isLive, status.hasPrefix("Accepted"), let submitted = pendingSubmittedDraft, draft == submitted {
                draft = ""; pendingSubmittedDraft = nil
            }
        }
        .onChange(of: relay.coreOutgoingMessages.map(\.id)) {
            if let submitted = pendingSubmittedDraft, draft == submitted,
               relay.coreOutgoingMessages.contains(where: { $0.text == submitted.trimmingCharacters(in: .whitespacesAndNewlines) }) {
                draft = ""; pendingSubmittedDraft = nil
            }
        }
        .sheet(isPresented: $showActivity) { ActivityView(store: store, sessionID: conversationID) }
        .sheet(isPresented: $showShare) {
            if isLive { LiveTerminalShareView(sessionID: conversationID, title: title, directory: store.liveSession?.directory, kind: relay.coreIsAgent ? .agent : .terminal) }
            else if let shareTarget { ShareResourceView(target: shareTarget) }
        }
        .onChange(of: voiceHeld) { _, held in
            if held { startDictation() } else { finishDictation() }
        }
        .onChange(of: voice.transcript) { _, text in
            if let voiceDraft { draft = voiceDraft.text(with: text) }
        }
        .onChange(of: voice.isBusy) { _, busy in
            if !busy, let voiceDraft {
                draft = voiceDraft.text(with: voice.transcript)
                self.voiceDraft = nil
            }
        }
        .onChange(of: canDictate) { _, allowed in if !allowed { cancelDictation() } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { cancelDictation() } }
        .onChange(of: conversationID) { cancelDictation() }
        .onDisappear { cancelDictation() }
        .alert("Replace current goal?", isPresented: $showReplaceGoal) {
            Button("No", role: .cancel) { replacementDraft = nil; goalToReplace = nil; retryGoalMessageID = nil }
            Button("Yes, replace goal", role: .destructive) {
                if let retryID = retryGoalMessageID, let goalID = goalToReplace {
                    Task { await relay.retryOutgoingMessage(retryID, replacementGoalID: goalID) }
                } else if let submitted = replacementDraft, let goalID = goalToReplace { submit(submitted, replacing: goalID) }
                replacementDraft = nil; goalToReplace = nil; retryGoalMessageID = nil
            }
        } message: {
            Text("Replace the current goal with this objective? Its active run will stop.")
        }
        .sheet(isPresented: $showDetails) {
            if isLive { LiveSessionDetailsView(store: store).coreAvailabilityGate() }
            else { WorkspaceDetailsView(title: title, subtitle: subtitle, agent: agent, instructions: instructions).coreAvailabilityGate() }
        }
    }

    private var composer: some View {
        VStack(spacing: 10) {
            if isLive, relay.coreSessionID == conversationID {
                HStack {
                    if let status = store.liveSession?.goalStatus {
                        GoalPhasePill(status: status, reason: relay.coreGoalReason)
                    }
                    Spacer(minLength: 6)
                    Button {
                        let pending = store.liveSession?.questions.first(where: { $0.kind == "approval" })
                        Task { await relay.setCoreYolo(!relay.coreYoloEnabled, questionID: pending?.id, sessionID: conversationID) }
                        BZZYTheme.haptic()
                    } label: {
                        Text(relay.coreYoloEnabled ? "YOLO ON" : "YOLO OFF").bzzyFont(11, weight: .bold, design: .monospaced)
                            .padding(.horizontal, 13).frame(minHeight: 38)
                            .foregroundStyle(relay.coreYoloEnabled ? BZZYTheme.background : BZZYTheme.secondary)
                            .background(relay.coreYoloEnabled ? BZZYTheme.yolo : BZZYTheme.elevated, in: Capsule())
                    }.buttonStyle(BZZYPressStyle())
                        .disabled(!relay.isCoreSessionReady(conversationID) || !relay.coreYoloControl || relay.isCoreSessionBusy(conversationID) || relay.hasUncertainCoreCommand(sessionID: conversationID))
                        .accessibilityLabel(relay.coreYoloEnabled ? "Disable YOLO" : "Enable YOLO")
                        .accessibilityIdentifier("chat-yolo")
                }
                if let session = store.liveSession, session.id == conversationID {
                    ScrollView {
                        VStack(spacing: 8) { ForEach(session.questions) { question in LiveQuestionView(question: question, sessionID: conversationID) } }
                    }.scrollIndicators(.hidden).frame(maxHeight: session.questions.isEmpty ? 0 : 260)
                }
                if let error = relay.coreError { Text(error).bzzyFont(11).foregroundStyle(BZZYTheme.danger) }
            }
            HStack(spacing: 8) {
                goalShortcut("Set goal", icon: "scope", id: "set-goal", enabled: canSetGoal) {
                    draft = CoreGoalDraft.settingGoal(draft)
                    composerCaretRequest &+= 1; composerFocused = true
                    BZZYTheme.haptic()
                }
                goalShortcut("Resume goal", icon: "play.fill", id: "resume-goal",
                             enabled: isLive && relay.isCoreSessionReady(conversationID) && relay.canResumeStalledGoal && !voice.isBusy && voiceDraft == nil) {
                    prepareForSubmission()
                    Task { await relay.resumeStalledCoreGoal(sessionID: conversationID) }
                    BZZYTheme.haptic()
                }
                Spacer(minLength: 0)
            }
            HStack(alignment: .bottom, spacing: 10) {
                #if canImport(UIKit)
                GoalMessageEditor(text: $draft, focused: Binding(get: { composerFocused }, set: { composerFocused = $0 }), caretAtEndRequest: composerCaretRequest)
                    .padding(.vertical, 14).padding(.leading, 16)
                    .disabled(voiceDraft != nil || voice.isBusy || voiceHeld)
                #else
                TextField("Message", text: $draft, axis: .vertical)
                    .bzzyFont(14).lineLimit(1...5).textFieldStyle(.plain)
                    .focused($composerFocused).padding(.vertical, 14).padding(.leading, 16)
                    .accessibilityIdentifier("message-draft")
                    .disabled(voiceDraft != nil || voice.isBusy || voiceHeld)
                #endif
                Image(systemName: voice.isRecording ? "waveform" : "mic.fill").bzzyFont(19)
                    .foregroundStyle(voice.isBusy ? BZZYTheme.accent : BZZYTheme.secondary)
                    .frame(width: 40, height: 46).contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0).updating($voiceHeld) { _, held, _ in held = true })
                    .allowsHitTesting(canDictate && !voice.isFinishing)
                    .opacity(canDictate ? 1 : 0.35)
                    .accessibilityElement().accessibilityAddTraits(.isButton)
                    .accessibilityLabel(voice.isBusy ? "Finish dictation" : "Hold to talk")
                    .accessibilityHint("Hold while speaking. Release to finish. Review the text, then press Send.")
                    .accessibilityIdentifier("voice-record")
                    .accessibilityAction {
                        if voice.isBusy { finishDictation() } else { startDictation() }
                    }
                Button {
                    if isLive {
                        let submitted = draft
                        if CoreGoalDraft.isNewGoal(submitted.trimmingCharacters(in: .whitespacesAndNewlines)),
                           CoreGoalDraft.needsReplacement(status: relay.coreGoalStatus), let goalID = relay.coreGoalID {
                            replacementDraft = submitted; goalToReplace = goalID; showReplaceGoal = true
                        } else { submit(submitted) }
                    } else {
                        if isDemo { store.sendDemoMessage(draft, conversationID: conversationID) }
                        else { store.saveDraft(draft, conversationID: conversationID) }
                        draft = ""; composerFocused = false
                    }
                    BZZYTheme.haptic()
                } label: {
                    Image(systemName: "arrow.up").bzzyFont(16, weight: .semibold)
                        .foregroundStyle(BZZYTheme.background).frame(width: 40, height: 40)
                        .background(BZZYTheme.accent, in: RoundedRectangle(cornerRadius: 14))
                }.buttonStyle(.plain).padding(5)
                    .disabled(!canSubmit)
                    .opacity(canSubmit ? 1 : 0.3)
                    .accessibilityLabel(isLive ? "Send message to Core" : isDemo ? "Send demo message" : "Save message draft on this device")
                    .accessibilityIdentifier("save-message")
            }.background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: 21))
                .overlay(RoundedRectangle(cornerRadius: 21).stroke(BZZYTheme.line, lineWidth: 0.7))
            HStack(spacing: 10) {
                Text(voice.error ?? (voice.isStarting ? "Allow speech access, then hold again" : voice.isRecording ? "Listening · Release to finish" : voice.isFinishing ? "Finishing transcript…" : chatConnectionStatus))
                    .bzzyFont(10).foregroundStyle(voice.error == nil ? BZZYTheme.muted : BZZYTheme.amber)
                if voice.isBusy {
                    Button("Cancel") { cancelDictation() }.bzzyFont(10).buttonStyle(.plain)
                        .foregroundStyle(BZZYTheme.secondary).accessibilityLabel("Cancel dictation and keep draft")
                }
            }
        }.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 10).background(BZZYTheme.background)
    }

    private func prepareForSubmission() {
        if isLive { relay.showLatestCoreHistory(sessionID: conversationID) }
        visibleMessageLimit = 200; followingLatest = true
    }

    private func scrollToLatest(_ reader: ScrollViewProxy, force: Bool = false) {
        guard !pagingHistory, followingLatest || force else { return }
        if force { followingLatest = true }
        var transaction = Transaction(); transaction.disablesAnimations = true
        withTransaction(transaction) { reader.scrollTo("bottom", anchor: .bottom) }
    }

    private func loadEarlierHistory(_ reader: ScrollViewProxy) async {
        guard !pagingHistory, !relay.coreHistoryLoading, hasEarlierMessages else { return }
        pagingHistory = true; followingLatest = false
        let anchor = visibleMessages.first?.id
        let previousCount = messages.count
        if messages.count > visibleMessageLimit { visibleMessageLimit += 200 }
        else if isLive {
            await relay.loadOlderCoreHistory(sessionID: conversationID)
            visibleMessageLimit += max(0, messages.count - previousCount)
        }
        await Task.yield()
        if let anchor {
            var transaction = Transaction(); transaction.disablesAnimations = true
            withTransaction(transaction) { reader.scrollTo(anchor, anchor: .top) }
        }
        pagingHistory = false
    }

    private func goalShortcut(_ title: String, icon: String, id: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon).bzzyFont(11, weight: .semibold)
                .padding(.horizontal, 11).frame(minHeight: 34)
                .foregroundStyle(enabled ? BZZYTheme.accent : BZZYTheme.muted)
                .background(enabled ? BZZYTheme.accent.opacity(0.10) : BZZYTheme.elevated, in: Capsule())
                .overlay(Capsule().stroke(enabled ? BZZYTheme.accent.opacity(0.3) : BZZYTheme.line, lineWidth: 0.7))
                .frame(minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(BZZYPressStyle()).disabled(!enabled).accessibilityIdentifier(id)
    }

    private func startDictation() {
        guard canDictate, !voice.isBusy, voiceDraft == nil else { return }
        composerFocused = false
        voice.transcript = ""
        voiceDraft = VoiceDraft(original: draft)
        recordingTask = Task {
            guard !Task.isCancelled else { return }
            await voice.start(locale: SpeechLanguage.resolve(recognitionLanguage).rawValue)
        }
    }

    private func finishDictation() {
        recordingTask?.cancel(); recordingTask = nil
        voice.stop()
        if !voice.isBusy { voiceDraft = nil }
    }

    private func cancelDictation() {
        if let voiceDraft { draft = voiceDraft.text(with: voice.transcript) }
        recordingTask?.cancel(); recordingTask = nil
        voice.cancel(); voiceDraft = nil
    }
}

private struct ConversationBottomPreference: PreferenceKey {
    static var defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
}

private struct GoalPhasePill: View {
    let status: String
    var reason: String? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var active: Bool { ["active", "verifying"].contains(status) }
    private var stalled: Bool { CoreGoalDraft.isStalled(status: status, reason: reason) }
    private var tone: Color { status == "complete" ? BZZYTheme.success : stalled ? BZZYTheme.danger : active ? BZZYTheme.accent : BZZYTheme.secondary }
    var body: some View {
        HStack(spacing: 7) {
            if active && !reduceMotion { ProgressView().controlSize(.mini).tint(tone) }
            else { Image(systemName: status == "complete" ? "checkmark.circle.fill" : stalled ? "xmark.circle.fill" : "circle.dotted") }
            Text(status == "complete" ? "Goal achieved" : stalled ? "Goal stalled" : active ? status == "verifying" ? "Verifying goal..." : "Pursuing goal..." : "Goal \(status)").lineLimit(1)
        }.bzzyFont(11, weight: .semibold).foregroundStyle(tone).padding(.horizontal, 10).padding(.vertical, 8)
            .background(tone.opacity(0.13), in: Capsule()).accessibilityIdentifier("chat-goal-status")
    }
}

private struct OutgoingMessageBubble: View {
    let message: CoreOutgoingMessage
    let retryEnabled: Bool
    let retry: () -> Void
    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 7) {
                Text(verbatim: message.text).bzzyFont(15).lineSpacing(4).textSelection(.enabled)
                    .foregroundStyle(message.status == .accepted ? BZZYTheme.background : BZZYTheme.text.opacity(0.65))
                    .padding(.horizontal, 16).padding(.vertical, 14)
                    .background(message.status == .accepted ? BZZYTheme.accent : BZZYTheme.elevated,
                        in: UnevenRoundedRectangle(topLeadingRadius: 21, bottomLeadingRadius: 21, bottomTrailingRadius: 6, topTrailingRadius: 21))
                HStack(spacing: 8) {
                    if message.status == .sending { ProgressView().controlSize(.mini) }
                    Text(message.status == .sending ? "Sending…" : message.status == .accepted ? "Sent" : message.status == .uncertain ? "Not confirmed" : "Not sent")
                        .bzzyFont(10).foregroundStyle(message.status == .failed ? BZZYTheme.danger : BZZYTheme.secondary)
                    if [.failed, .uncertain].contains(message.status) {
                        Button(action: retry) { Label("Retry", systemImage: "arrow.clockwise").bzzyFont(11, weight: .semibold) }
                            .buttonStyle(BZZYPressStyle()).foregroundStyle(BZZYTheme.accent).disabled(!retryEnabled)
                            .padding(.horizontal, 10).frame(minHeight: 32)
                            .background(BZZYTheme.accent.opacity(0.12), in: Capsule())
                            .accessibilityIdentifier("retry-message-\(message.id)")
                    }
                }
            }.accessibilityIdentifier("outgoing-message-\(message.id)")
        }
    }
}

private struct ChatBubble: View {
    let message: LocalMessage
    let showsDraft: Bool
    let speaker: String
    @Environment(\.dynamicTypeSize) private var dynamicType
    private var content: ChatContent { ChatContent.parse(message.text) }
    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if message.isUser { Spacer(minLength: dynamicType.isAccessibilitySize ? 24 : 48) }
            VStack(alignment: message.isUser ? .trailing : .leading, spacing: 7) {
                Group {
                    if message.isUser {
                        Text(verbatim: message.text).bzzyFont(15).lineSpacing(4).textSelection(.enabled)
                            .foregroundStyle(BZZYTheme.background)
                    } else {
                        ChatRichText(content: content).foregroundStyle(BZZYTheme.text)
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 14)
                .background(message.isUser ? BZZYTheme.accent : BZZYTheme.surface,
                            in: UnevenRoundedRectangle(topLeadingRadius: 21, bottomLeadingRadius: message.isUser ? 21 : 6,
                                                       bottomTrailingRadius: message.isUser ? 6 : 21, topTrailingRadius: 21))
                .overlay {
                    if !message.isUser {
                        UnevenRoundedRectangle(topLeadingRadius: 21, bottomLeadingRadius: 6, bottomTrailingRadius: 21, topTrailingRadius: 21)
                            .stroke(BZZYTheme.line.opacity(0.7), lineWidth: 0.6)
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat-\(message.isUser ? "user" : "assistant")-\(message.id.uuidString)")
                .accessibilityHint(message.isUser ? "Your message" : "\(speaker)'s reply")
                if showsDraft {
                    Label("Draft", systemImage: "iphone").bzzyFont(10).foregroundStyle(BZZYTheme.secondary)
                        .accessibilityIdentifier("saved-draft")
                }
            }
            if !message.isUser { Spacer(minLength: dynamicType.isAccessibilitySize ? 24 : 48) }
        }
    }
}

struct WorkspaceDetailsView: View {
    let title: String
    let subtitle: String
    var agent: AgentProfile? = nil
    var instructions: String? = nil
    @State private var showActivity = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 25) {
                    Text(title).bzzyFont(32, weight: .medium).tracking(-1)
                    detail("Execution", "Inactive", "pause.circle")
                    detail("Permissions", "None", "hand.raised")
                    detail("Type", agent?.mode.rawValue ?? "On demand", "clock")
                    if let schedule = agent?.schedule { detail("Repeat", schedule.label, "repeat") }
                    if let purpose = agent?.purpose ?? instructions { detail("Instructions", purpose, "text.alignleft") }
                    Button { showActivity = true } label: {
                        Label("Activity", systemImage: "list.bullet").bzzyFont(14)
                            .frame(maxWidth: .infinity, alignment: .leading).panel()
                    }.buttonStyle(.plain).foregroundStyle(BZZYTheme.accent)
                }.padding(25)
            }.bzzyScreen().toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
                .sheet(isPresented: $showActivity) { ActivityView() }
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
    }
    private func detail(_ label: String, _ value: String, _ icon: String) -> some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: icon).foregroundStyle(BZZYTheme.accent).frame(width: 22)
            VStack(alignment: .leading, spacing: 8) {
                Text(label).bzzyFont(14, weight: .medium)
                Text(value).bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).panel()
    }
}

#if canImport(UIKit)
/// Keep one native editor and one selection while applying command styling.
/// No view identity or keyboard-focus transition is tied to slash recognition.
private struct GoalMessageEditor: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    var caretAtEndRequest = 0
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.font = .systemFont(ofSize: 14)
        view.textColor = UIColor(BZZYTheme.text)
        view.tintColor = UIColor(BZZYTheme.accent)
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false
        view.accessibilityIdentifier = "message-draft"
        view.accessibilityLabel = "Message"
        let placeholder = UILabel()
        placeholder.text = "Message"; placeholder.font = view.font
        placeholder.textColor = UIColor(BZZYTheme.muted)
        placeholder.tag = 731; placeholder.isUserInteractionEnabled = false
        view.addSubview(placeholder)
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        view.isEditable = context.environment.isEnabled
        if view.text != text, view.markedTextRange == nil {
            let selection = view.selectedRange
            view.text = text
            view.selectedRange = NSRange(location: min(selection.location, text.utf16.count), length: 0)
        }
        context.coordinator.style(view)
        if context.coordinator.caretRequest != caretAtEndRequest, view.markedTextRange == nil {
            context.coordinator.caretRequest = caretAtEndRequest
            view.selectedRange = NSRange(location: view.text.utf16.count, length: 0)
        }
        if focused && !view.isFirstResponder && view.isEditable { view.becomeFirstResponder() }
        if !focused && view.isFirstResponder { view.resignFirstResponder() }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 200
        let measured = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let line = uiView.font?.lineHeight ?? 18
        uiView.isScrollEnabled = measured.height > line * 5
        return CGSize(width: width, height: min(max(line, measured.height), line * 5))
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: GoalMessageEditor
        var caretRequest = 0
        init(_ parent: GoalMessageEditor) { self.parent = parent }
        func style(_ view: UITextView) {
            guard view.markedTextRange == nil else { return }
            let selection = view.selectedRange
            let defaults: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 14), .foregroundColor: UIColor(BZZYTheme.text)]
            view.textStorage.beginEditing()
            view.textStorage.setAttributes(defaults, range: NSRange(location: 0, length: view.text.utf16.count))
            if CoreGoalDraft.isGoal(view.text) {
                view.textStorage.addAttributes([.foregroundColor: UIColor(BZZYTheme.success), .backgroundColor: UIColor(BZZYTheme.success).withAlphaComponent(0.18)], range: NSRange(location: 0, length: 5))
            }
            view.textStorage.endEditing()
            view.typingAttributes = defaults; view.selectedRange = selection
            if let placeholder = view.viewWithTag(731) as? UILabel { placeholder.isHidden = !view.text.isEmpty; placeholder.sizeToFit() }
        }
        func textViewDidChange(_ view: UITextView) { parent.text = view.text; style(view); view.invalidateIntrinsicContentSize() }
        func textViewDidBeginEditing(_ view: UITextView) { if !parent.focused { parent.focused = true } }
        func textViewDidEndEditing(_ view: UITextView) { if parent.focused { parent.focused = false } }
    }
}
#endif
