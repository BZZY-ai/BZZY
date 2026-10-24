import SwiftUI
import RelayKit

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
    @State private var showShare = false
    @State private var voice = VoiceCapture()
    @AppStorage(SpeechLanguage.recognitionKey, store: SpeechLanguage.preferences) private var recognitionLanguage = SpeechLanguage.preferred.rawValue
    @State private var voiceDraft: VoiceDraft?
    @State private var recordingTask: Task<Void, Never>?
    @GestureState private var voiceHeld = false
    @State private var showDetails = false
    @State private var showActivity = false
    @FocusState private var composerFocused: Bool
    private var isDemo: Bool { store.demoConversation(conversationID) != nil }
    private var isLive: Bool { remoteSession || store.liveSession?.id == conversationID }
    private var canSubmit: Bool {
        voiceDraft == nil && !voice.isBusy && !voiceHeld && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        (!isLive || relay.coreConnected && relay.coreSessionID == conversationID && relay.corePermissions.contains("execute") && !relay.coreBusy && !relay.coreCommandUncertain)
    }
    private var composerText: Binding<String> {
        Binding(get: { CoreGoalDraft.body(draft) }, set: { draft = CoreGoalDraft.isGoal(draft) ? CoreGoalDraft.replacingBody($0) : $0 })
    }
    private func submit(_ submitted: String, replacing goalID: String? = nil) {
        pendingSubmittedDraft = submitted
        Task {
            if await relay.sendCoreMessage(submitted, sessionID: conversationID, replaceGoalID: goalID), draft == submitted {
                draft = ""; pendingSubmittedDraft = nil; composerFocused = false
            }
        }
    }
    private var canDictate: Bool {
        !isLive || relay.coreActionsAvailable && relay.coreSessionID == conversationID && relay.corePermissions.contains("execute")
    }
    private var messages: [LocalMessage] {
        if remoteSession { return store.liveSession?.id == conversationID ? store.liveMessages : [] }
        return store.conversationMessages(conversationID)
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
                        .disabled(!relay.coreActionsAvailable)
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
                        if messages.isEmpty {
                            FlyEyes(interactive: false).frame(width: 160)
                                .frame(maxWidth: .infinity).padding(.vertical, 70)
                        }
                        ForEach(messages) { message in
                            ChatBubble(message: message, showsDraft: !isDemo && !isLive && message.isUser,
                                       speaker: message.isUser ? "You" : (assistantName ?? title))
                                .id(message.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }.padding(.horizontal, 20).padding(.top, 24).padding(.bottom, 16)
                }.scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
                    .defaultScrollAnchor(.bottom)
                    .task(id: conversationID) {
                        // Lazy children and restored remote history may arrive
                        // after appearance. Place the first frame at the latest
                        // entry without animating through the entire history.
                        await Task.yield()
                        var transaction = Transaction(); transaction.disablesAnimations = true
                        withTransaction(transaction) { reader.scrollTo("bottom", anchor: .bottom) }
                    }
                    .onChange(of: messages.count) {
                        var transaction = Transaction(); transaction.disablesAnimations = true
                        withTransaction(transaction) { reader.scrollTo("bottom", anchor: .bottom) }
                    }
                    .onChange(of: composerFocused) {
                        if composerFocused { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { reader.scrollTo("bottom", anchor: .bottom) } }
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
            Button("No", role: .cancel) { replacementDraft = nil; goalToReplace = nil }
            Button("Yes, replace goal", role: .destructive) {
                if let submitted = replacementDraft, let goalID = goalToReplace { submit(submitted, replacing: goalID) }
                replacementDraft = nil; goalToReplace = nil
            }
        } message: {
            Text("Take control of this session and replace the current goal with the new objective?")
        }
        .sheet(isPresented: $showDetails) {
            if isLive { LiveSessionDetailsView(store: store).coreAvailabilityGate() }
            else { WorkspaceDetailsView(title: title, subtitle: subtitle, agent: agent, instructions: instructions).coreAvailabilityGate() }
        }
        .coreAvailabilityGate()
    }

    private var composer: some View {
        VStack(spacing: 10) {
            if isLive, relay.coreSessionID == conversationID {
                HStack {
                    if let status = store.liveSession?.goalStatus {
                        GoalPhasePill(status: status)
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
                        .disabled(!relay.coreActionsAvailable || !relay.coreYoloControl || relay.coreBusy || relay.coreCommandUncertain)
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
            HStack(alignment: .bottom, spacing: 10) {
                if CoreGoalDraft.isGoal(draft) {
                    Button { draft = CoreGoalDraft.body(draft) } label: {
                        HStack(spacing: 5) {
                            Text("/goal").bzzyFont(12, weight: .bold, design: .monospaced)
                            Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                        }.foregroundStyle(BZZYTheme.success).padding(.horizontal, 10).padding(.vertical, 9)
                            .background(BZZYTheme.success.opacity(0.14), in: Capsule())
                            .overlay(Capsule().stroke(BZZYTheme.success.opacity(0.4), lineWidth: 0.7))
                    }.buttonStyle(BZZYPressStyle()).padding(.leading, 10).padding(.bottom, 10)
                        .accessibilityLabel("Remove goal command").accessibilityIdentifier("goal-command-pill")
                }
                TextField(CoreGoalDraft.isGoal(draft) ? "Goal objective" : "Message", text: composerText, axis: .vertical)
                    .id(CoreGoalDraft.isGoal(draft))
                    .bzzyFont(14).lineLimit(1...5).textFieldStyle(.plain)
                    .focused($composerFocused).padding(.vertical, 14).padding(.leading, CoreGoalDraft.isGoal(draft) ? 0 : 16)
                    .accessibilityIdentifier("message-draft")
                    .disabled(voiceDraft != nil || voice.isBusy || voiceHeld)
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
                .onChange(of: CoreGoalDraft.isGoal(draft)) { _, _ in
                    guard voiceDraft == nil, !voice.isBusy else { return }
                    composerFocused = false
                    Task { @MainActor in
                        await Task.yield()
                        composerFocused = true
                    }
                }
            HStack(spacing: 10) {
                Text(voice.error ?? (voice.isStarting ? "Allow speech access, then hold again" : voice.isRecording ? "Listening · Release to finish" : voice.isFinishing ? "Finishing transcript…" : isLive ? (relay.coreError ?? (!relay.coreCommandStatus.isEmpty ? relay.coreCommandStatus : relay.coreConnected ? relay.corePermissions.contains("execute") ? "Connected to Core" : "Observer · Read only" : store.liveStatus)) : isDemo ? "Demo · On device" : "Not connected"))
                    .bzzyFont(10).foregroundStyle(voice.error == nil ? BZZYTheme.muted : BZZYTheme.amber)
                if voice.isBusy {
                    Button("Cancel") { cancelDictation() }.bzzyFont(10).buttonStyle(.plain)
                        .foregroundStyle(BZZYTheme.secondary).accessibilityLabel("Cancel dictation and keep draft")
                }
            }
        }.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 10).background(BZZYTheme.background)
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

private struct GoalPhasePill: View {
    let status: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var active: Bool { ["active", "verifying"].contains(status) }
    private var stalled: Bool { ["blocked", "budget_limited", "usage_limited", "awaiting_review"].contains(status) }
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
