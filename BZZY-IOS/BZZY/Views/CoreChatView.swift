import SwiftUI
import RelayKit

/// Core's separate assessment conversation. Its transport exposes no session mutation actions.
struct CoreChatView: View {
    @Bindable var store: WorkspaceStore
    @Environment(RelayConnection.self) private var relay
    @Environment(\.scenePhase) private var scenePhase
    @State private var draft = ""
    @State private var draftHostID: String?
    @State private var voice = VoiceCapture()
    @State private var voiceDraft: VoiceDraft?
    @State private var recordingTask: Task<Void, Never>?
    @GestureState private var voiceHeld = false
    @FocusState private var focused: Bool
    @AppStorage(SpeechLanguage.recognitionKey, store: SpeechLanguage.preferences) private var recognitionLanguage = SpeechLanguage.preferred.rawValue
    @State private var scrollState = ConversationScrollState()
    private let draftID = "core-assessment-chat"

    private var visibleMessages: [CoreChatMessage] { Array(relay.chatMessages.suffix(100)) }
    private var canDictate: Bool { draftHostID != nil && draftHostID == relay.activeHostID && relay.coreActionsAvailable }
    private var canSend: Bool {
        canDictate && relay.chatConfigured && !relay.chatWaiting && !["checking", "uncertain"].contains(relay.chatPhase)
            && voiceDraft == nil && !voice.isBusy && !voiceHeld && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                Image(systemName: "text.bubble").foregroundStyle(BZZYTheme.accent)
                Text("Session assessment · read only").bzzyFont(12, weight: .medium)
                Spacer(minLength: 0)
                Button { reconcile() } label: {
                    Image(systemName: "arrow.clockwise").frame(width: 44, height: 44).contentShape(Rectangle())
                }.buttonStyle(BZZYPressStyle()).foregroundStyle(BZZYTheme.accent)
                    .disabled(!relay.coreActionsAvailable || relay.chatPhase == "checking")
                    .accessibilityLabel("Refresh assessment chat").accessibilityIdentifier("core-chat-refresh")
            }.padding(.leading, 16).padding(.trailing, 4)
            Rectangle().fill(BZZYTheme.line).frame(height: 0.5)
            transcript
            status
            composer
        }.background(BZZYTheme.background)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("core-chat")
            .task(id: relay.activeHostID) {
                changeHost()
                await relay.prepareCoreChat()
            }
            .onChange(of: draft) { _, text in
                if let host = draftHostID, relay.hosts.contains(where: { $0.id == host && $0.isPaired }) {
                    store.saveComposerDraft(text, hostID: host, conversationID: draftID)
                }
            }
            .onChange(of: voiceHeld) { _, held in if held { startDictation() } else { finishDictation() } }
            .onChange(of: voice.transcript) { _, text in if let voiceDraft { draft = voiceDraft.text(with: text) } }
            .onChange(of: voice.isBusy) { _, busy in
                if !busy, let voiceDraft { draft = voiceDraft.text(with: voice.transcript); self.voiceDraft = nil }
            }
            .onChange(of: canDictate) { _, allowed in if !allowed { cancelDictation() } }
            .onChange(of: relay.coreActionsAvailable) { _, available in if available { reconcile() } }
            .onChange(of: scenePhase) { _, phase in if phase != .active { cancelDictation(); persistDraft() } }
            .onDisappear { focused = false; cancelDictation(); persistDraft() }
    }

    private var transcript: some View {
        GeometryReader { viewport in
            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if visibleMessages.isEmpty { suggestions }
                        ForEach(visibleMessages) { message in assessmentRow(message).id(message.id) }
                        Color.clear.frame(height: 1).id("core-chat-bottom")
                            .background(GeometryReader { geometry in
                                Color.clear.preference(key: CoreChatBottomPreference.self,
                                    value: geometry.frame(in: .named("core-chat-scroll")).maxY)
                            })
                    }.padding(.horizontal, 16).padding(.vertical, 18)
                }.coordinateSpace(name: "core-chat-scroll")
                    .scrollDismissesKeyboard(.interactively)
                    .modifier(ConversationScrollInteraction { scrollState.setUserScrolling($0) })
                    .onPreferenceChange(CoreChatBottomPreference.self) { bottom in
                        guard let bottom else { return }
                        _ = scrollState.observeViewport(atLatest: bottom <= viewport.size.height + 36, includesLatest: true)
                    }
                    .task(id: visibleMessages.last) { await Task.yield(); followLatest(reader) }
                    .overlay(alignment: .bottomTrailing) {
                        if !scrollState.followingLatest {
                            Button { scrollState.showLatest(); followLatest(reader) } label: {
                                Label("Latest", systemImage: "arrow.down").bzzyFont(11, weight: .semibold)
                                    .padding(12).background(BZZYTheme.surface)
                                    .overlay(Rectangle().stroke(BZZYTheme.line, lineWidth: 0.7))
                            }.buttonStyle(BZZYPressStyle()).foregroundStyle(BZZYTheme.accent)
                                .padding(12).accessibilityIdentifier("core-chat-latest")
                        }
                    }
            }
        }
    }

    private var suggestions: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Ask Core about your sessions").bzzyFont(14, weight: .medium)
            Text("Core checks recorded session status. Asking here does not start, resume or change a session or goal.")
                .bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
            ForEach(["Which sessions need my attention?", "What is my session’s goal status?", "Which sessions are paused?"], id: \.self) { question in
                Button { draft = question; focused = true } label: {
                    Text(question).bzzyFont(12).foregroundStyle(BZZYTheme.accent)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }.buttonStyle(BZZYPressStyle())
            }
        }.padding(.vertical, 10).accessibilityIdentifier("core-chat-suggestions")
    }

    private func assessmentRow(_ message: CoreChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message.isUser ? "YOU" : "CORE").bzzyFont(11, weight: .semibold)
                .foregroundStyle(message.isUser ? BZZYTheme.user : BZZYTheme.agent)
            if message.isUser {
                Text(verbatim: message.text).bzzyFont(15).lineSpacing(4).textSelection(.enabled).foregroundStyle(BZZYTheme.userText)
            } else {
                ChatRichText(content: ChatContent.parse(message.text)).foregroundStyle(BZZYTheme.text)
                if let observed = message.observedAt, let checked = date(observed) {
                    Text("Checked \(checked.formatted(date: .abbreviated, time: .shortened))")
                        .bzzyFont(10).foregroundStyle(BZZYTheme.muted).accessibilityIdentifier("core-chat-checked-at")
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 10)
            .overlay(alignment: .leading) {
                Rectangle().fill(message.isUser ? BZZYTheme.user.opacity(0.85) : BZZYTheme.agent.opacity(0.8)).frame(width: 2)
            }.accessibilityElement(children: .contain).accessibilityIdentifier("core-chat-message-\(message.id)")
    }

    @ViewBuilder private var status: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !relay.coreActionsAvailable {
                Text("Core offline · saved replies remain readable").bzzyFont(11).foregroundStyle(BZZYTheme.amber)
                    .accessibilityIdentifier("core-chat-offline")
            }
            if relay.chatPhase == "uncertain" {
                Text("The previous question is not confirmed. Check its status before asking again.")
                    .bzzyFont(11).foregroundStyle(BZZYTheme.amber)
                Button("Check status") { reconcile() }.bzzyFont(11, weight: .medium)
                    .foregroundStyle(BZZYTheme.accent).buttonStyle(BZZYPressStyle()).frame(minHeight: 44)
                    .disabled(!relay.coreActionsAvailable)
                    .accessibilityIdentifier("core-chat-reconcile")
                Button("Dismiss unfinished question") { relay.dismissCoreChatQuestion() }.bzzyFont(11)
                    .foregroundStyle(BZZYTheme.secondary).buttonStyle(BZZYPressStyle()).frame(minHeight: 44)
                    .accessibilityHint("Removes this phone’s pending receipt. Does not cancel or replay the question on Core.")
                    .accessibilityIdentifier("core-chat-dismiss-question")
            } else if relay.chatErrorCode == "CHAT_DISMISSED" {
                Text("Unfinished question dismissed. A new question will not replay it.")
                    .bzzyFont(11).foregroundStyle(BZZYTheme.secondary).accessibilityIdentifier("core-chat-question-dismissed")
            } else if relay.coreActionsAvailable && (relay.chatPhase == "checking" || relay.chatWaiting) {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small).tint(BZZYTheme.accent)
                    Text("Checking session status…").bzzyFont(11).foregroundStyle(BZZYTheme.accent)
                }.accessibilityElement(children: .combine).accessibilityLabel("Checking session status")
                    .accessibilityIdentifier("core-chat-checking")
            } else if relay.coreActionsAvailable && ["UNKNOWN_OPERATION", "OPERATION_DENIED", "UNSUPPORTED_OPERATION", "NOT_IMPLEMENTED"].contains(relay.chatErrorCode ?? "") {
                Text("Update Core to use Chat.").bzzyFont(11).foregroundStyle(BZZYTheme.amber)
                    .accessibilityIdentifier("core-chat-update-required")
            } else if relay.coreActionsAvailable && !relay.chatConfigured {
                Text(relay.chatErrorCode == "ASSISTANT_SETUP_REQUIRED" ? "Set up the Core assistant model in Settings to ask questions."
                    : relay.chatErrorCode == nil ? "Checking Core Chat readiness…" : "Core Chat readiness could not be confirmed. Refresh to check again.")
                    .bzzyFont(11).foregroundStyle(BZZYTheme.secondary).accessibilityIdentifier("core-chat-unconfigured")
            } else if relay.coreActionsAvailable && (relay.chatPhase == "failed" || relay.chatErrorCode != nil) {
                Text(failureMessage)
                    .bzzyFont(11).foregroundStyle(BZZYTheme.amber).accessibilityIdentifier("core-chat-error")
                if let code = relay.chatErrorCode, code.range(of: "^[A-Z_]{1,64}$", options: .regularExpression) != nil {
                    Text("Support code: \(code)").bzzyFont(10).foregroundStyle(BZZYTheme.muted)
                        .textSelection(.enabled).accessibilityIdentifier("core-chat-error-code")
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 8)
    }

    private var failureMessage: String {
        switch relay.chatErrorCode {
        case "CHAT_BACKEND_VERSION_CHECK", "CHAT_BACKEND_PROCESS_START":
            return "Core could not start its model backend. Check the backend installation on that computer, then try again."
        case "CHAT_BACKEND_CONFIGURATION":
            return "The Core model connection needs attention. Check its provider setup on that computer, then try again."
        case "CHAT_BACKEND_INITIALIZATION", "CHAT_BACKEND_THREAD_START":
            return "Core’s model backend could not initialize. Update Core and its backend on that computer, then try again."
        case "CHAT_BACKEND_PERMISSION_PROFILE", "CHAT_BACKEND_PERMISSION_ACTIVATION":
            return "Core could not establish read-only access. Update its model backend, then try again."
        case "CHAT_BACKEND_BUDGET", "DOCUMENT_BUDGET":
            return "This check exceeded its allowance. Try asking about one session."
        case "CHAT_SOURCE_UNAVAILABLE":
            return "No terminal is available to assess. Open a named terminal on that computer, then try again."
        case "CHAT_FINALIZATION_FAILED":
            return "Core could not finalize this check safely. Share the support code for diagnosis."
        case "CHAT_NOT_SENT":
            return "Core did not accept the previous question. You can ask it again."
        default:
            return "Core could not complete this check. Try again, or share the support code below."
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .bottom, spacing: 7) {
                Text("›").bzzyFont(19, weight: .semibold).foregroundStyle(BZZYTheme.accent).frame(height: 48).padding(.leading, 10)
                TextField("Ask about session status", text: $draft, axis: .vertical)
                    .bzzyFont(14).textFieldStyle(.plain).lineLimit(1...5).focused($focused).padding(.vertical, 14)
                    .disabled(voiceDraft != nil || voice.isBusy || voiceHeld).accessibilityIdentifier("core-chat-draft")
                Image(systemName: voice.isRecording ? "waveform" : "mic.fill").bzzyFont(19)
                    .foregroundStyle(voice.isBusy ? BZZYTheme.accent : BZZYTheme.secondary)
                    .frame(width: 44, height: 46).contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0).updating($voiceHeld) { _, held, _ in held = true })
                    .allowsHitTesting(canDictate && !voice.isFinishing).opacity(canDictate ? 1 : 0.35)
                    .accessibilityElement().accessibilityAddTraits(.isButton)
                    .accessibilityLabel(voice.isBusy ? "Finish dictation" : "Hold to talk")
                    .accessibilityHint("Release to finish. Review your question, then press Send.")
                    .accessibilityIdentifier("core-chat-dictate")
                    .accessibilityAction { if voice.isBusy { finishDictation() } else { startDictation() } }
                Button { send() } label: {
                    Text("Send").bzzyFont(11, weight: .semibold).foregroundStyle(BZZYTheme.background)
                        .frame(minWidth: 54, minHeight: 44).background(BZZYTheme.accent)
                }.buttonStyle(.plain).padding(4).disabled(!canSend).opacity(canSend ? 1 : 0.3)
                    .accessibilityIdentifier("core-chat-send").accessibilityLabel("Ask Core to assess session status")
            }.background(BZZYTheme.surface).overlay(Rectangle().stroke(BZZYTheme.line, lineWidth: 0.7))
            if voice.error != nil || voice.isBusy {
                HStack(spacing: 10) {
                    Text(voice.error ?? (voice.isRecording ? "Listening · release to finish" : voice.isFinishing ? "Finishing transcript…" : "Allow speech access, then hold again"))
                        .bzzyFont(10).foregroundStyle(voice.error == nil ? BZZYTheme.muted : BZZYTheme.amber)
                    if voice.isBusy { Button("Cancel") { cancelDictation() }.bzzyFont(10).foregroundStyle(BZZYTheme.secondary).buttonStyle(.plain) }
                }
            }
        }.padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 8)
            .overlay(alignment: .top) { Rectangle().fill(BZZYTheme.line).frame(height: 0.5) }
    }

    private func send() {
        guard canSend else { return }
        let submitted = draft
        let host = draftHostID
        focused = false
        scrollState.showLatest()
        Task { @MainActor in
            guard host == relay.activeHostID else { return }
            if await relay.sendCoreChatText(submitted), host == relay.activeHostID, draftHostID == host, draft == submitted {
                draft = ""; persistDraft()
            }
        }
    }

    private func reconcile() { Task { await relay.prepareCoreChat() } }
    private func followLatest(_ reader: ScrollViewProxy) {
        guard scrollState.followingLatest else { return }
        var transaction = Transaction(); transaction.disablesAnimations = true
        withTransaction(transaction) { reader.scrollTo("core-chat-bottom", anchor: .bottom) }
    }
    private func changeHost() {
        cancelDictation(); persistDraft()
        draftHostID = relay.activeHostID
        draft = draftHostID.map { store.composerDraft(hostID: $0, conversationID: draftID) } ?? ""
        scrollState.showLatest()
    }
    private func persistDraft() {
        guard let host = draftHostID, relay.hosts.contains(where: { $0.id == host && $0.isPaired }) else { return }
        store.saveComposerDraft(draft, hostID: host, conversationID: draftID, persist: true)
    }
    private func startDictation() {
        guard canDictate, !voice.isBusy, voiceDraft == nil else { return }
        focused = false; voice.transcript = ""; voiceDraft = VoiceDraft(original: draft)
        let origin = draftHostID
        recordingTask = Task {
            guard !Task.isCancelled, origin == relay.activeHostID else { return }
            await voice.start(locale: SpeechLanguage.resolve(recognitionLanguage).rawValue)
        }
    }
    private func finishDictation() {
        recordingTask?.cancel(); recordingTask = nil; voice.stop()
        if !voice.isBusy { voiceDraft = nil }
    }
    private func cancelDictation() {
        if let voiceDraft { draft = voiceDraft.text(with: voice.transcript) }
        recordingTask?.cancel(); recordingTask = nil; voice.cancel(); voiceDraft = nil
    }
    private func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

private struct CoreChatBottomPreference: PreferenceKey {
    static var defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
}
