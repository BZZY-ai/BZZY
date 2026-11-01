import SwiftUI
import RelayKit

/// Core's separate assessment conversation. Its transport exposes no session mutation actions.
struct CoreChatView: View {
    @Bindable var store: WorkspaceStore
    @Environment(RelayConnection.self) private var relay
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
    private let suggestedQuestions = ["Which sessions need my attention?", "What is my session’s goal status?", "Which sessions are paused?"]

    private var visibleMessages: [CoreChatMessage] { Array(relay.chatMessages.suffix(100)) }
    private var canDictate: Bool { draftHostID != nil && draftHostID == relay.activeHostID && relay.coreActionsAvailable }
    private var canSend: Bool {
        canDictate && relay.chatConfigured && !relay.chatWaiting && !["checking", "uncertain"].contains(relay.chatPhase)
            && voiceDraft == nil && !voice.isBusy && !voiceHeld && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            transcript
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) { status; composer }
                .background(BZZYTheme.background)
                .overlay(alignment: .top) { Rectangle().fill(BZZYTheme.line.opacity(0.7)).frame(height: 0.5) }
        }
        .bzzyScreen().toolbar(.hidden)
        #if canImport(UIKit)
        .background(ChatBackGesture().frame(width: 0, height: 0))
        #endif
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

    private var header: some View {
        HStack(spacing: 6) {
            Button { focused = false; cancelDictation(); persistDraft(); dismiss() } label: { RoundIcon(symbol: "chevron.left") }
                .buttonStyle(BZZYPressStyle()).accessibilityLabel("Back").accessibilityIdentifier("core-chat-back")
            VStack(alignment: .leading, spacing: 1) {
                Text("Ask Core").bzzyFont(16, weight: .semibold).accessibilityAddTraits(.isHeader)
                Text("Session assessment · read only").bzzyFont(11).foregroundStyle(BZZYTheme.muted).lineLimit(1)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 2)
            Button { reconcile() } label: { RoundIcon(symbol: "arrow.clockwise", tint: BZZYTheme.secondary) }
                .buttonStyle(BZZYPressStyle())
                .disabled(!relay.coreActionsAvailable || relay.chatPhase == "checking")
                .accessibilityLabel("Refresh assessment chat").accessibilityIdentifier("core-chat-refresh")
        }.padding(.horizontal, 8).padding(.vertical, 2)
            .background(BZZYTheme.background)
            .overlay(alignment: .bottom) { Rectangle().fill(BZZYTheme.line.opacity(0.7)).frame(height: 0.5) }
    }

    private var transcript: some View {
        GeometryReader { viewport in
            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        if visibleMessages.isEmpty { suggestions }
                        ForEach(visibleMessages) { message in assessmentRow(message).id(message.id) }
                        Color.clear.frame(height: 1).id("core-chat-bottom")
                            .background(GeometryReader { geometry in
                                Color.clear.preference(key: CoreChatBottomPreference.self,
                                    value: geometry.frame(in: .named("core-chat-scroll")).maxY)
                            })
                    }.padding(.horizontal, 16).padding(.vertical, 16)
                }.coordinateSpace(name: "core-chat-scroll")
                    .scrollIndicators(.hidden)
                    .scrollDismissesKeyboard(.interactively)
                    .modifier(ConversationScrollInteraction { scrollState.setUserScrolling($0) })
                    .onPreferenceChange(CoreChatBottomPreference.self) { bottom in
                        guard let bottom else { return }
                        _ = scrollState.observeViewport(atLatest: bottom <= viewport.size.height + 36, includesLatest: true)
                    }
                    .task(id: visibleMessages.last) { await Task.yield(); followLatest(reader) }
                    .overlay(alignment: .bottom) {
                        if !scrollState.followingLatest {
                            Button { scrollState.showLatest(); followLatest(reader) } label: {
                                Image(systemName: "arrow.down").font(.system(size: 15, weight: .bold))
                                    .foregroundStyle(BZZYTheme.text)
                                    .frame(width: 40, height: 40)
                                    .background(BZZYTheme.elevated, in: Circle())
                                    .overlay(Circle().stroke(BZZYTheme.accent.opacity(0.45), lineWidth: 0.8))
                                    .shadow(color: .black.opacity(0.45), radius: 10, y: 4)
                                    .frame(width: 44, height: 44).contentShape(Rectangle())
                            }.buttonStyle(BZZYPressStyle()).padding(.bottom, 12)
                                .accessibilityLabel("Latest").accessibilityIdentifier("core-chat-latest")
                        }
                    }
            }
        }
    }

    private var suggestions: some View {
        VStack(alignment: .leading, spacing: 14) {
            IconTile(symbol: "sparkles", size: 48)
            Text("Ask Core about your sessions").bzzyFont(21, weight: .bold).fixedSize(horizontal: false, vertical: true)
            Text("Core checks recorded session status. Asking here does not start, resume or change a session or goal.")
                .bzzyFont(14).foregroundStyle(BZZYTheme.secondary).fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 8) {
                ForEach(suggestedQuestions, id: \.self) { question in
                    Button { draft = question; focused = true } label: {
                        HStack(spacing: 10) {
                            Text(question).bzzyFont(14, weight: .medium).foregroundStyle(BZZYTheme.text)
                                .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 6)
                            Image(systemName: "arrow.up.left").font(.system(size: 12, weight: .bold)).foregroundStyle(BZZYTheme.accent)
                                .accessibilityHidden(true)
                        }.padding(.horizontal, 14).padding(.vertical, 12).frame(minHeight: 48).hiveCard()
                            .contentShape(Rectangle())
                    }.buttonStyle(BZZYCardStyle())
                }
            }.padding(.top, 6)
        }.padding(.vertical, 12).accessibilityIdentifier("core-chat-suggestions")
    }

    @ViewBuilder private func assessmentRow(_ message: CoreChatMessage) -> some View {
        if message.isUser {
            UserBubble(text: message.text)
                .frame(maxWidth: .infinity, alignment: .trailing).padding(.leading, 48)
                .accessibilityElement(children: .contain).accessibilityIdentifier("core-chat-message-\(message.id)")
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles").font(.system(size: 11, weight: .bold))
                    Text("Core").bzzyFont(12, weight: .semibold)
                }.foregroundStyle(BZZYTheme.accent).accessibilityHidden(true)
                ChatRichText(content: ChatContent.parse(message.text)).foregroundStyle(BZZYTheme.text)
                if let observed = message.observedAt, let checked = RelativeTime.date(observed) {
                    Label("Checked \(checked.formatted(date: .abbreviated, time: .shortened))", systemImage: "checkmark.seal")
                        .bzzyFont(11).foregroundStyle(BZZYTheme.muted).accessibilityIdentifier("core-chat-checked-at")
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .contain).accessibilityIdentifier("core-chat-message-\(message.id)")
        }
    }

    @ViewBuilder private var status: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !relay.coreActionsAvailable {
                Text("Core offline · saved replies remain readable").bzzyFont(12, weight: .medium).foregroundStyle(BZZYTheme.amber)
                    .accessibilityIdentifier("core-chat-offline")
            }
            if relay.chatPhase == "uncertain" {
                Text("The previous question is not confirmed. Check its status before asking again.")
                    .bzzyFont(12).foregroundStyle(BZZYTheme.amber).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Button("Check status") { reconcile() }.bzzyFont(12, weight: .semibold)
                        .disabled(!relay.coreActionsAvailable)
                        .accessibilityIdentifier("core-chat-reconcile")
                    Button("Dismiss unfinished question") { relay.dismissCoreChatQuestion() }.bzzyFont(12)
                        .accessibilityHint("Removes this phone’s pending receipt. Does not cancel or replay the question on Core.")
                        .accessibilityIdentifier("core-chat-dismiss-question")
                }
            } else if relay.chatErrorCode == "CHAT_DISMISSED" {
                Text("Unfinished question dismissed. A new question will not replay it.")
                    .bzzyFont(12).foregroundStyle(BZZYTheme.secondary).accessibilityIdentifier("core-chat-question-dismissed")
            } else if relay.coreActionsAvailable && (relay.chatPhase == "checking" || relay.chatWaiting) {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small).tint(BZZYTheme.accent)
                    Text("Checking session status…").bzzyFont(12).foregroundStyle(BZZYTheme.accent)
                }.accessibilityElement(children: .combine).accessibilityLabel("Checking session status")
                    .accessibilityIdentifier("core-chat-checking")
            } else if relay.coreActionsAvailable && ["UNKNOWN_OPERATION", "OPERATION_DENIED", "UNSUPPORTED_OPERATION", "NOT_IMPLEMENTED"].contains(relay.chatErrorCode ?? "") {
                Text("Update Core to use Chat.").bzzyFont(12).foregroundStyle(BZZYTheme.amber)
                    .accessibilityIdentifier("core-chat-update-required")
            } else if relay.coreActionsAvailable && !relay.chatConfigured {
                Text(relay.chatErrorCode == "ASSISTANT_SETUP_REQUIRED" ? "Set up the Core assistant model in Settings to ask questions."
                    : relay.chatErrorCode == nil ? "Checking Core Chat readiness…" : "Core Chat readiness could not be confirmed. Refresh to check again.")
                    .bzzyFont(12).foregroundStyle(BZZYTheme.secondary).accessibilityIdentifier("core-chat-unconfigured")
            } else if relay.coreActionsAvailable && (relay.chatPhase == "failed" || relay.chatErrorCode != nil) {
                Text(failureMessage)
                    .bzzyFont(12).foregroundStyle(BZZYTheme.amber).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("core-chat-error")
                if let code = relay.chatErrorCode, code.range(of: "^[A-Z_]{1,64}$", options: .regularExpression) != nil {
                    Text("Support code: \(code)").bzzyFont(11, design: .monospaced).foregroundStyle(BZZYTheme.muted)
                        .textSelection(.enabled).accessibilityIdentifier("core-chat-error-code")
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.top, 8)
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
            HStack(alignment: .bottom, spacing: 8) {
                HStack(alignment: .bottom, spacing: 2) {
                    TextField("Ask about session status", text: $draft, axis: .vertical)
                        .bzzyFont(16).textFieldStyle(.plain).lineLimit(1...5).focused($focused)
                        .padding(.vertical, 12).padding(.leading, 16)
                        .disabled(voiceDraft != nil || voice.isBusy || voiceHeld).accessibilityIdentifier("core-chat-draft")
                    Image(systemName: voice.isRecording ? "waveform" : "mic.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .symbolEffect(.variableColor.iterative, isActive: voice.isRecording && !reduceMotion)
                        .foregroundStyle(voice.isBusy ? BZZYTheme.accentInk : BZZYTheme.secondary)
                        .frame(width: 34, height: 34)
                        .background(voice.isBusy ? BZZYTheme.accent : Color.clear, in: Circle())
                        .frame(width: 44, height: 46).contentShape(Rectangle())
                        .gesture(DragGesture(minimumDistance: 0).updating($voiceHeld) { _, held, _ in held = true })
                        .allowsHitTesting(canDictate && !voice.isFinishing).opacity(canDictate ? 1 : 0.35)
                        .accessibilityElement().accessibilityAddTraits(.isButton)
                        .accessibilityLabel(voice.isBusy ? "Finish dictation" : "Hold to talk")
                        .accessibilityHint("Release to finish. Review your question, then press Send.")
                        .accessibilityIdentifier("core-chat-dictate")
                        .accessibilityAction { if voice.isBusy { finishDictation() } else { startDictation() } }
                }.background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: 23, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 23, style: .continuous)
                        .stroke(voice.isBusy ? BZZYTheme.accent.opacity(0.7) : focused ? BZZYTheme.accent.opacity(0.4) : BZZYTheme.line, lineWidth: 0.8))
                Button { send() } label: {
                    Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold))
                        .foregroundStyle(canSend ? BZZYTheme.accentInk : BZZYTheme.muted)
                        .frame(width: 44, height: 44)
                        .background(canSend ? BZZYTheme.accent : BZZYTheme.elevated, in: Circle())
                        .overlay(Circle().stroke(canSend ? Color.clear : BZZYTheme.line, lineWidth: 0.6))
                        .padding(.bottom, 1)
                }.buttonStyle(.plain).disabled(!canSend)
                    .accessibilityIdentifier("core-chat-send").accessibilityLabel("Ask Core to assess session status")
            }
            if voice.error != nil || voice.isBusy {
                HStack(spacing: 10) {
                    Text(voice.error ?? (voice.isRecording ? "Listening · Release to finish" : voice.isFinishing ? "Finishing transcript…" : "Allow speech access, then hold again"))
                        .bzzyFont(11).foregroundStyle(voice.error == nil ? BZZYTheme.accent : BZZYTheme.amber)
                    Spacer(minLength: 0)
                    if voice.isBusy { Button("Cancel") { cancelDictation() }.bzzyFont(11, weight: .semibold).foregroundStyle(BZZYTheme.secondary).buttonStyle(.plain) }
                }.padding(.horizontal, 6)
            }
        }.padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 8)
    }

    private func send() {
        guard canSend else { return }
        let submitted = draft
        let host = draftHostID
        focused = false
        scrollState.showLatest()
        BZZYTheme.haptic()
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
}

private struct CoreChatBottomPreference: PreferenceKey {
    static var defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
}
