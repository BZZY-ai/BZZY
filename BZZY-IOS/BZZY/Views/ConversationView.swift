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
                           shareTarget: .agent(agent)).id(agent.id)
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
    @State private var draftHostID: String?
    @State private var pendingSubmittedDraft: String?
    @State private var goalToReplace: String?
    @State private var replacementDraft: String?
    @State private var showReplaceGoal = false
    @State private var showPauseConfirmation = false
    @State private var pauseHostID: String?
    @State private var pauseGoalID: String?
    @State private var retryGoalMessageID: String?
    @State private var showShare = false
    @State private var showImport = false
    @State private var showDefaults = false
    @State private var voice = VoiceCapture()
    @AppStorage(SpeechLanguage.recognitionKey, store: SpeechLanguage.preferences) private var recognitionLanguage = SpeechLanguage.preferred.rawValue
    @State private var voiceDraft: VoiceDraft?
    @State private var recordingTask: Task<Void, Never>?
    @GestureState private var voiceHeld = false
    @State private var showModelSettings = false
    @State private var showDetails = false
    @State private var showActivity = false
    @State private var composerCaretRequest = 0
    @State private var historyWindow = ConversationHistoryWindow()
    @State private var pagingHistory = false
    @State private var historyPagingRevision = 0
    @State private var scrollState = ConversationScrollState()
    @State private var scrollViewportHeight: CGFloat = 0
    @State private var bottomPosition: CGFloat?
    #if canImport(UIKit)
    @State private var composerFocused = false
    #else
    @FocusState private var composerFocused: Bool
    #endif
    private var isDemo: Bool { store.demoConversation(conversationID) != nil }
    private var isLive: Bool { remoteSession || store.liveSession?.id == conversationID }
    private var canSubmit: Bool {
        voiceDraft == nil && !voice.isBusy && !voiceHeld && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        (!isLive || draftHostID == relay.activeHostID && relay.isCoreSessionReady(conversationID) && relay.corePermissions.contains("execute") && !relay.isCoreSessionBusy(conversationID) && !relay.hasUncertainCoreCommand(sessionID: conversationID))
    }
    private func submit(_ submitted: String, replacing goalID: String? = nil) {
        prepareForSubmission()
        pendingSubmittedDraft = submitted
        let submissionHostID = draftHostID
        relay.performHostAction {
            guard submissionHostID == relay.activeHostID else { return }
            if await relay.sendCoreMessage(submitted, sessionID: conversationID, replaceGoalID: goalID), draft == submitted {
                draft = ""; pendingSubmittedDraft = nil; composerFocused = false
            }
        }
    }
    private var canDictate: Bool {
        !isLive || draftHostID == relay.activeHostID && relay.isCoreSessionReady(conversationID) && relay.corePermissions.contains("execute")
    }
    private var canSetGoal: Bool {
        voiceDraft == nil && !voice.isBusy && !voiceHeld && (!isLive || draftHostID == relay.activeHostID && relay.isCoreSessionReady(conversationID)
            && relay.coreGoalSubmission && relay.corePermissions.contains("execute") && !relay.isCoreSessionBusy(conversationID) && !relay.hasUncertainCoreCommand(sessionID: conversationID))
    }
    private var messages: [LocalMessage] {
        if remoteSession { return store.liveSession?.id == conversationID ? store.liveMessages : [] }
        return store.conversationMessages(conversationID)
    }

    private var visibleMessages: [LocalMessage] { historyWindow.visible(in: messages) }
    private func startsSpeakerGroup(_ message: LocalMessage) -> Bool {
        guard !message.isUser, let index = visibleMessages.firstIndex(where: { $0.id == message.id }),
              let previous = visibleMessages[..<index].last(where: { $0.invocation == nil }) else { return true }
        return previous.isUser || previous.speaker != message.speaker || previous.accentIndex != message.accentIndex
    }
    private var hasEarlierMessages: Bool {
        historyWindow.hasEarlier(in: messages) || isLive && relay.coreSessionID == conversationID && relay.coreHistoryHasOlder
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
            HStack(spacing: 4) {
                Button { composerFocused = false; cancelDictation(); persistComposerDraft(); dismiss() } label: {
                    Image(systemName: "chevron.left").bzzyFont(17, weight: .medium)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }.buttonStyle(BZZYPressStyle()).foregroundStyle(BZZYTheme.accent)
                    .accessibilityLabel("Back").accessibilityIdentifier("chat-back")
                Text(title).bzzyFont(14, weight: .semibold).lineLimit(1).truncationMode(.middle)
                    .accessibilityIdentifier("conversation-title")
                modePicker.fixedSize(horizontal: true, vertical: false).layoutPriority(1)
                Spacer(minLength: 0)
                Menu {
                    if isLive && relay.coreSharingAllowed && relay.coreSessionID == conversationID {
                        Button { showShare = true } label: { Label("Share project and context", systemImage: "square.and.arrow.up") }
                            .disabled(!relay.isCoreSessionReady(conversationID))
                            .accessibilityIdentifier(relay.coreIsAgent ? "share-live-agent" : "share-live-terminal")
                    } else if shareTarget != nil {
                        Button { showShare = true } label: { Label("Share", systemImage: "square.and.arrow.up") }
                            .accessibilityIdentifier("share-resource")
                    }
                    Button { showImport = true } label: { Label("Import", systemImage: "square.and.arrow.down") }
                        .disabled(isLive && !relay.coreActionsAvailable)
                    if isLive {
                        Button { showActivity = true } label: { Label("Activity", systemImage: "list.bullet") }
                            .disabled(relay.coreSessionID != conversationID).accessibilityIdentifier("live-session-activity")
                        if relay.coreSelectionControl {
                            Button { showModelSettings = true } label: { Label("Model and effort", systemImage: "slider.horizontal.3") }
                                .disabled(!relay.isCoreSessionReady(conversationID) || relay.coreExecutionState != "paused")
                                .accessibilityIdentifier("session-model")
                        }
                        if relay.coreModeControl { Button("Mode defaults") { showDefaults = true } }
                        if relay.coreYoloControl {
                            Toggle("YOLO", isOn: Binding(get: { relay.coreYoloEnabled }, set: { enabled in
                                let pending = store.liveSession?.questions.first(where: { $0.kind == "approval" })
                                relay.performHostAction { await relay.setCoreYolo(enabled, questionID: pending?.id, sessionID: conversationID) }
                            })).disabled(!relay.isCoreSessionReady(conversationID) || relay.coreBusy).accessibilityIdentifier("chat-yolo")
                        }
                    }
                    Button { draft = CoreGoalDraft.settingGoal(draft); composerCaretRequest &+= 1; composerFocused = true } label: { Label("Set goal", systemImage: "scope") }
                        .disabled(!canSetGoal).accessibilityIdentifier("set-goal")
                    Button { showDetails = true } label: { Label("Details", systemImage: "info.circle") }
                        .disabled(isLive && relay.coreSessionID != conversationID)
                } label: {
                    Image(systemName: "gearshape").bzzyFont(18).frame(width: 44, height: 44)
                        .foregroundStyle(BZZYTheme.secondary).contentShape(Rectangle())
                }.menuIndicator(.hidden).buttonStyle(BZZYPressStyle())
                    .accessibilityLabel("Chat settings").accessibilityIdentifier("chat-settings")
            }.padding(.horizontal, 8).padding(.vertical, 2)
            Rectangle().fill(BZZYTheme.line.opacity(0.65)).frame(height: 0.5)

            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if hasEarlierMessages {
                            Button { Task { await loadEarlierHistory(reader) } } label: {
                                HStack(spacing: 8) {
                                    if pagingHistory || relay.coreHistoryLoading { ProgressView().controlSize(.small) }
                                    else { Image(systemName: "arrow.up") }
                                    Text("Earlier messages").bzzyFont(11, weight: .medium)
                                }.frame(maxWidth: .infinity, minHeight: 44)
                            }.buttonStyle(BZZYPressStyle()).foregroundStyle(BZZYTheme.accent)
                                .disabled(pagingHistory || relay.coreHistoryLoading || (!historyWindow.hasEarlier(in: messages) && !relay.isCoreSessionReady(conversationID)))
                                .accessibilityIdentifier("load-earlier-messages")
                                .id("earlier-\(visibleMessages.first?.id.uuidString ?? "empty")")
                        }
                        if isLive && store.liveSession?.id == conversationID && store.cachedPresentationOmittedMessageCount > 0 {
                            Text("Some large entries are available from Core when connected.")
                                .bzzyFont(10).foregroundStyle(BZZYTheme.muted)
                                .accessibilityIdentifier("chat-cache-omitted")
                        }
                        if messages.isEmpty {
                            if isLive {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(relay.isCoreSessionReady(conversationID) ? "No messages yet" : "No saved messages on this iPhone yet")
                                        .bzzyFont(12, weight: .medium)
                                    Text(relay.isCoreSessionReady(conversationID) ? "Write a message or set a goal." : "Core will load this conversation when connected.")
                                        .bzzyFont(11).foregroundStyle(BZZYTheme.secondary)
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 28)
                                    .accessibilityElement(children: .combine).accessibilityIdentifier("chat-empty-state")
                            } else if BZZYTheme.showsMascot {
                                FlyEyes(interactive: false).frame(width: 160)
                                    .frame(maxWidth: .infinity).padding(.vertical, 70)
                            } else {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("› \(title)").bzzyFont(14, weight: .semibold).foregroundStyle(BZZYTheme.accent)
                                    Text("Write a message or set a goal.").bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 28)
                                    .accessibilityElement(children: .combine).accessibilityIdentifier("chat-empty-state")
                            }
                        }
                        ForEach(visibleMessages) { message in
                            TranscriptMessageRow(message: message, showsDraft: !isDemo && !isLive && message.isUser,
                                       speaker: message.isUser ? "You" : (message.speaker ?? assistantName ?? title),
                                       showsSpeaker: startsSpeakerGroup(message))
                                .id(message.id)
                        }
                        if isLive, relay.coreSessionID == conversationID {
                            ForEach(relay.coreOutgoingMessages) { outgoing in
                                OutgoingMessageRow(message: outgoing, retryEnabled: relay.isCoreSessionReady(conversationID) && !relay.isCoreSessionBusy(conversationID)) {
                                    prepareForSubmission()
                                    if outgoing.status == .failed, CoreGoalDraft.isNewGoal(outgoing.text),
                                       CoreGoalDraft.needsReplacement(status: relay.coreGoalStatus), let goalID = relay.coreGoalID,
                                       outgoing.params["replaceGoalId"]?.string != goalID {
                                        retryGoalMessageID = outgoing.id; goalToReplace = goalID; showReplaceGoal = true
                                    } else { relay.performHostAction { await relay.retryOutgoingMessage(outgoing.id) } }
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
                    }.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 12)
                }.scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
                    .accessibilityIdentifier("conversation-history").accessibilityValue("\(visibleMessages.count) messages")
                    .coordinateSpace(name: "conversation-scroll")
                    .background(GeometryReader { geometry in
                        Color.clear.onAppear { scrollViewportHeight = geometry.size.height }
                            .onChange(of: geometry.size.height) { _, height in scrollViewportHeight = height }
                    })
                    .modifier(ConversationScrollInteraction { scrollState.setUserScrolling($0) })
                    .onPreferenceChange(ConversationBottomPreference.self) { bottom in
                        bottomPosition = bottom
                        guard !messages.isEmpty, !pagingHistory, let bottom, scrollViewportHeight > 0 else { return }
                        let atLatest = bottom >= 0 && bottom <= scrollViewportHeight + 72
                        let includesLatest = historyWindow.includesLatest(in: messages) && !(isLive && relay.coreHistoryHasNewer)
                        switch scrollState.observeViewport(atLatest: atLatest, includesLatest: includesLatest) {
                        case .followLatest:
                            historyWindow.showLatest()
                            if isLive { relay.showLatestCoreHistory(sessionID: conversationID) }
                            scrollToLatest(reader)
                        case .holdEarlier:
                            historyWindow.freeze(in: messages)
                            if isLive { relay.holdCoreHistory(sessionID: conversationID) }
                        case .none: break
                        }
                    }
                    .modifier(ConversationInitialScrollAnchor())
                    .task(id: conversationID) {
                        historyWindow.showLatest(); scrollState.showLatest()
                        if isLive { relay.showLatestCoreHistory(sessionID: conversationID) }
                        await Task.yield()
                        scrollToLatest(reader)
                    }
                    .task(id: messages.last) {
                        // Cached rows, late bootstrap and streamed text all get a
                        // layout pass before positioning. A reader in history stays put.
                        await Task.yield()
                        guard !Task.isCancelled else { return }
                        scrollToLatest(reader)
                    }
                    .task(id: scrollViewportHeight) {
                        await Task.yield()
                        guard !Task.isCancelled else { return }
                        scrollToLatest(reader)
                    }
                    .task(id: bottomPosition) {
                        // Interleaved tool/worker rows can grow before the last
                        // message. Follow their resulting layout as well.
                        guard let bottomPosition, bottomPosition > scrollViewportHeight + 1 else { return }
                        await Task.yield()
                        guard !Task.isCancelled else { return }
                        scrollToLatest(reader)
                    }
                    .onChange(of: relay.coreOutgoingMessages.map(\.id)) { previous, current in
                        if isLive, relay.coreSessionID == conversationID, current.contains(where: { !previous.contains($0) }) {
                            prepareForSubmission()
                            scrollToLatest(reader, force: true)
                        }
                    }
                    .onChange(of: composerFocused) {
                        if composerFocused && scrollState.followingLatest { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { reader.scrollTo("bottom", anchor: .bottom) } }
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if !scrollState.followingLatest {
                            Button {
                                Task {
                                    prepareForSubmission()
                                    await Task.yield()
                                    scrollToLatest(reader, force: true)
                                }
                            } label: {
                                Label("Latest", systemImage: "arrow.down").bzzyFont(11, weight: .semibold)
                                    .padding(.horizontal, 14).frame(minHeight: 44)
                                    .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius))
                                    .overlay(RoundedRectangle(cornerRadius: BZZYTheme.controlRadius).stroke(BZZYTheme.accent.opacity(0.5), lineWidth: 0.7))
                            }.buttonStyle(BZZYPressStyle()).foregroundStyle(BZZYTheme.accent)
                                .padding(16).accessibilityIdentifier("chat-jump-to-latest")
                        }
                    }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .bzzyScreen().toolbar(.hidden)
        #if canImport(UIKit)
        .background(ChatBackGesture().frame(width: 0, height: 0))
        #endif
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
        .sheet(isPresented: $showModelSettings) { CoreDefaultsEditor(sessionID: conversationID) }
        .sheet(isPresented: $showDefaults) { CoreDefaultsEditor() }
        .sheet(isPresented: $showImport) {
            let kind: SharedResourceKind = agent != nil || shareTarget?.kind == .agent || isLive && relay.coreIsAgent ? .agent : .terminal
            if kind == .agent && !store.showsDemoContent { LiveAgentImportView(store: store).coreAvailabilityGate() }
            else { ImportResourceView(store: store, kind: kind).coreAvailabilityGate() }
        }
        .sheet(isPresented: $showActivity) { ActivityView(store: store, sessionID: conversationID) }
        .sheet(isPresented: $showShare) {
            if isLive { LiveTerminalShareView(sessionID: conversationID, title: title, directory: store.liveSession?.directory, kind: relay.coreIsAgent ? .agent : .terminal) }
            else if let shareTarget { ShareResourceView(target: shareTarget) }
        }
        .onChange(of: voiceHeld) { _, held in
            if held { startDictation() } else { finishDictation() }
        }
        .onChange(of: [showShare, showImport, showDetails, showActivity, showDefaults, showModelSettings]) { _, presented in
            if presented.contains(true) { composerFocused = false; cancelDictation(); persistComposerDraft() }
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
        .onAppear {
            if isLive, draftHostID == nil, let hostID = relay.activeHostID {
                draftHostID = hostID
                draft = store.composerDraft(hostID: hostID, conversationID: conversationID)
            } else if !isLive { draft = store.localComposerDrafts[conversationID] ?? "" }
        }
        .onChange(of: draft) { _, text in
            if let hostID = draftHostID, relay.hosts.contains(where: { $0.id == hostID && $0.isPaired }) { store.saveComposerDraft(text, hostID: hostID, conversationID: conversationID) }
            else if !isLive { store.localComposerDrafts[conversationID] = text.isEmpty ? nil : text }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { cancelDictation(); persistComposerDraft() }
        }
        .onChange(of: conversationID) { cancelDictation() }
        .onChange(of: relay.coreConversationRemovalID) {
            if isLive && relay.coreRemovedSessionID == conversationID { cancelDictation(); dismiss() }
        }
        .onDisappear { composerFocused = false; cancelDictation(); persistComposerDraft() }
        .confirmationDialog("Pause this conversation?", isPresented: $showPauseConfirmation, titleVisibility: .visible) {
            Button("Pause") {
                guard canPause, pauseHostID == relay.activeHostID, pauseGoalID == relay.coreGoalID else { return }
                relay.performHostAction { await relay.controlCore("pause", sessionID: conversationID) }
            }
            Button("Keep running", role: .cancel) {}
        }
        .alert("Replace current goal?", isPresented: $showReplaceGoal) {
            Button("No", role: .cancel) { replacementDraft = nil; goalToReplace = nil; retryGoalMessageID = nil }
            Button("Yes, replace goal", role: .destructive) {
                if let retryID = retryGoalMessageID, let goalID = goalToReplace {
                    relay.performHostAction { await relay.retryOutgoingMessage(retryID, replacementGoalID: goalID) }
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

    private var canPause: Bool {
        isLive && relay.isCoreSessionReady(conversationID) && relay.corePermissions.contains("pause") && relay.coreExecutionState != "paused"
            && !relay.coreBusy && !relay.coreCommandUncertain
    }
    private var modeTitle: String {
        guard isLive else { return isDemo ? "Solo" : "Draft" }
        guard relay.coreSessionID == conversationID else { return "…" }
        return relay.coreIsAgent ? "Agent" : relay.coreSessionMode == "debate" ? "Validate" : relay.coreSessionMode.capitalized
    }
    private var modePicker: some View {
        Menu {
            if relay.coreExecutionState != "paused" {
                Button("Pause to change mode", systemImage: "pause.fill") {
                    requestPauseConfirmation()
                }.disabled(!canPause)
            }
            ForEach(["solo", "delegate", "debate", "parallel", "besties"], id: \.self) { mode in
                Button {
                    relay.performHostAction { _ = await relay.changeCoreSessionMode(mode, sessionID: conversationID) }
                } label: {
                    if relay.coreSessionMode == mode { Label(mode == "debate" ? "Validate" : mode.capitalized, systemImage: "checkmark") }
                    else { Text(mode == "debate" ? "Validate" : mode.capitalized) }
                }.disabled(relay.coreExecutionState != "paused" || relay.coreSessionMode == mode || relay.coreBusy || relay.coreCommandUncertain)
            }
        } label: {
            HStack(spacing: 4) {
                Text(modeTitle.uppercased()).tracking(0.6)
                if isLive && relay.coreModeControl { Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold)) }
            }.bzzyFont(10, weight: .semibold).foregroundStyle(BZZYTheme.accent)
                .padding(.horizontal, 8).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }.menuIndicator(.hidden).buttonStyle(.plain)
            .disabled(!isLive || !relay.coreModeControl || !relay.isCoreSessionReady(conversationID))
            .accessibilityLabel("Chat mode").accessibilityValue(modeTitle).accessibilityIdentifier("conversation-mode")
    }

    private func persistComposerDraft() {
        if let hostID = draftHostID, relay.hosts.contains(where: { $0.id == hostID && $0.isPaired }) {
            store.saveComposerDraft(draft, hostID: hostID, conversationID: conversationID, persist: true)
        } else if !isLive { store.localComposerDrafts[conversationID] = draft.isEmpty ? nil : draft }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if isLive, relay.coreSessionID == conversationID {
                HStack {
                    if let status = store.liveSession?.goalStatus {
                        GoalPhasePill(status: status, reason: relay.coreGoalReason)
                    }
                    Spacer(minLength: 6)
                    if relay.canResumeCoreGoal {
                        goalShortcut("Resume", icon: "play.fill", id: "resume-goal", enabled: relay.isCoreSessionReady(conversationID) && !relay.coreBusy && !relay.coreCommandUncertain) {
                            prepareForSubmission(); relay.performHostAction { await relay.resumeStalledCoreGoal(sessionID: conversationID) }
                        }
                    } else {
                        Button {
                            requestPauseConfirmation()
                        } label: {
                            Image(systemName: "pause.fill").bzzyFont(14).frame(width: 44, height: 44)
                        }.buttonStyle(.plain).foregroundStyle(canPause ? BZZYTheme.accent : BZZYTheme.muted)
                            .disabled(!canPause).accessibilityLabel("Pause conversation").accessibilityIdentifier("pause-goal")
                    }
                }
                if let session = store.liveSession, session.id == conversationID {
                    ScrollView {
                        VStack(spacing: 8) { ForEach(session.questions) { question in LiveQuestionView(question: question, sessionID: conversationID) } }
                    }.scrollIndicators(.hidden).frame(maxHeight: session.questions.isEmpty ? 0 : 260)
                }
                if let error = relay.coreError { Text(error).bzzyFont(11).foregroundStyle(BZZYTheme.danger) }
            }
            if let model = isLive && store.liveSession?.id == conversationID ? store.liveSession?.model : assistantName, !model.isEmpty {
                HStack(spacing: 6) {
                    Text(model).bzzyFont(11, weight: .medium).foregroundStyle(BZZYTheme.accent)
                        .lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                }.accessibilityIdentifier("chat-current-model")
            }
            HStack(alignment: .bottom, spacing: 10) {
                Text("›").bzzyFont(19, weight: .semibold).foregroundStyle(BZZYTheme.accent)
                    .frame(height: 48).padding(.leading, 10).accessibilityHidden(true)
                #if canImport(UIKit)
                GoalMessageEditor(text: $draft, focused: Binding(get: { composerFocused }, set: { composerFocused = $0 }), caretAtEndRequest: composerCaretRequest)
                    .padding(.vertical, 14)
                    .disabled(voiceDraft != nil || voice.isBusy || voiceHeld)
                #else
                TextField("Message", text: $draft, axis: .vertical)
                    .bzzyFont(14).lineLimit(1...5).textFieldStyle(.plain)
                    .focused($composerFocused).padding(.vertical, 14)
                    .accessibilityIdentifier("message-draft")
                    .disabled(voiceDraft != nil || voice.isBusy || voiceHeld)
                #endif
                Image(systemName: voice.isRecording ? "waveform" : "mic.fill").bzzyFont(19)
                    .foregroundStyle(voice.isBusy ? BZZYTheme.accent : BZZYTheme.secondary)
                    .frame(width: 44, height: 46).contentShape(Rectangle())
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
                    HStack(spacing: 4) {
                        Text("Send").bzzyFont(11, weight: .semibold)
                        Image(systemName: "return").bzzyFont(10, weight: .semibold)
                    }.foregroundStyle(BZZYTheme.background).frame(minWidth: 58, minHeight: 44)
                        .background(BZZYTheme.accent, in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius))
                }.buttonStyle(.plain).padding(4)
                    .disabled(!canSubmit)
                    .opacity(canSubmit ? 1 : 0.3)
                    .accessibilityLabel(isLive ? "Send message to Core" : isDemo ? "Send demo message" : "Save message draft on this device")
                    .accessibilityIdentifier("save-message")
            }.background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius))
                .overlay(RoundedRectangle(cornerRadius: BZZYTheme.controlRadius).stroke(BZZYTheme.line, lineWidth: 0.7))
            HStack(spacing: 10) {
                Text(voice.error ?? (voice.isStarting ? "Allow speech access, then hold again" : voice.isRecording ? "Listening · Release to finish" : voice.isFinishing ? "Finishing transcript…" : chatConnectionStatus))
                    .bzzyFont(10).foregroundStyle(voice.error == nil ? BZZYTheme.muted : BZZYTheme.amber)
                if voice.isBusy {
                    Button("Cancel") { cancelDictation() }.bzzyFont(10).buttonStyle(.plain)
                        .foregroundStyle(BZZYTheme.secondary).accessibilityLabel("Cancel dictation and keep draft")
                }
            }
        }.padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 8).background(BZZYTheme.background)
            .overlay(alignment: .top) { Rectangle().fill(BZZYTheme.line).frame(height: 0.5) }
    }

    private func prepareForSubmission() {
        historyPagingRevision &+= 1; pagingHistory = false
        if isLive { relay.showLatestCoreHistory(sessionID: conversationID) }
        historyWindow.showLatest(); scrollState.showLatest()
    }

    private func scrollToLatest(_ reader: ScrollViewProxy, force: Bool = false) {
        guard (!pagingHistory || force), (!scrollState.userScrolling || force), scrollState.followingLatest || force else { return }
        if force { scrollState.showLatest() }
        var transaction = Transaction(); transaction.disablesAnimations = true
        withTransaction(transaction) { reader.scrollTo("bottom", anchor: .bottom) }
    }

    private func loadEarlierHistory(_ reader: ScrollViewProxy) async {
        guard !pagingHistory, !relay.coreHistoryLoading, hasEarlierMessages else { return }
        historyPagingRevision &+= 1
        let revision = historyPagingRevision
        pagingHistory = true; scrollState.showEarlier()
        defer { if historyPagingRevision == revision { pagingHistory = false } }
        historyWindow.freeze(in: messages)
        if isLive { relay.holdCoreHistory(sessionID: conversationID) }
        let anchor = visibleMessages.first?.id
        let host = relay.activeHostID
        if !historyWindow.revealEarlier(in: messages), isLive {
            for _ in 0..<3 {
                guard relay.isCoreSessionReady(conversationID), relay.coreHistoryHasOlder else { break }
                await relay.loadOlderCoreHistory(sessionID: conversationID)
                if historyPagingRevision != revision {
                    if scrollState.followingLatest && relay.activeHostID == host {
                        relay.showLatestCoreHistory(sessionID: conversationID)
                        await Task.yield()
                        scrollToLatest(reader, force: true)
                    }
                    return
                }
                guard !Task.isCancelled, relay.activeHostID == host else { return }
                if historyWindow.revealEarlier(in: messages) { break }
            }
        }
        await Task.yield()
        guard historyPagingRevision == revision else { return }
        if let anchor {
            var transaction = Transaction(); transaction.disablesAnimations = true
            withTransaction(transaction) { reader.scrollTo(anchor, anchor: .top) }
        }
    }

    private func goalShortcut(_ title: String, icon: String, id: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon).bzzyFont(11, weight: .semibold)
                .padding(.horizontal, 11).frame(minHeight: 34)
                .foregroundStyle(enabled ? BZZYTheme.accent : BZZYTheme.muted)
                .background(enabled ? BZZYTheme.accent.opacity(0.10) : BZZYTheme.elevated, in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius))
                .overlay(RoundedRectangle(cornerRadius: BZZYTheme.controlRadius).stroke(enabled ? BZZYTheme.accent.opacity(0.3) : BZZYTheme.line, lineWidth: 0.7))
                .frame(minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(BZZYPressStyle()).disabled(!enabled).accessibilityIdentifier(id)
    }

    private func startDictation() {
        guard canDictate, !voice.isBusy, voiceDraft == nil else { return }
        composerFocused = false
        voice.transcript = ""
        voiceDraft = VoiceDraft(original: draft)
        let originHostID = draftHostID
        recordingTask = Task {
            guard !Task.isCancelled, !isLive || originHostID == relay.activeHostID else { return }
            await voice.start(locale: SpeechLanguage.resolve(recognitionLanguage).rawValue)
        }
    }

    private func requestPauseConfirmation() {
        pauseHostID = relay.activeHostID; pauseGoalID = relay.coreGoalID
        composerFocused = false; showPauseConfirmation = true
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

struct ConversationInitialScrollAnchor: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            content.defaultScrollAnchor(.bottom, for: .initialOffset)
        } else {
            content.defaultScrollAnchor(.bottom)
        }
    }
}

struct ConversationScrollInteraction: ViewModifier {
    let changed: (Bool) -> Void
    @State private var settlingTask: Task<Void, Never>?

    func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            content.onScrollPhaseChange { _, phase in
                changed(phase == .interacting || phase == .decelerating)
            }
        } else {
            content.simultaneousGesture(DragGesture(minimumDistance: 8)
                .onChanged { value in
                    guard abs(value.translation.height) > abs(value.translation.width) else { return }
                    settlingTask?.cancel(); changed(true)
                }
                .onEnded { _ in
                    // iOS 17 has no scroll-phase callback. Let the final layout
                    // from a flick arrive before closing this user interaction.
                    settlingTask?.cancel()
                    settlingTask = Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(350))
                        guard !Task.isCancelled else { return }
                        changed(false)
                    }
                })
                .onDisappear { settlingTask?.cancel(); changed(false) }
        }
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
            .background(tone.opacity(0.13), in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius)).accessibilityIdentifier("chat-goal-status")
    }
}

private struct TranscriptBlock<Content: View>: View {
    let speaker: String
    var isUser = false
    var pending = false
    var accent: Color? = nil
    var showsSpeaker = true
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if showsSpeaker { HStack(spacing: 7) {
                Text(isUser ? "YOU" : "AGENT")
                if !isUser { Text("·"); Text(speaker).lineLimit(1).truncationMode(.middle) }
            }.bzzyFont(11, weight: .semibold)
                .foregroundStyle(isUser ? BZZYTheme.user : accent ?? BZZYTheme.agent)
                .accessibilityHidden(true) }
            content().frame(maxWidth: .infinity, alignment: .leading)
        }.padding(.horizontal, 12).padding(.vertical, 10)
            .overlay(alignment: .leading) {
                Rectangle().fill(isUser ? BZZYTheme.user.opacity(pending ? 0.35 : 0.85) : (accent ?? BZZYTheme.agent).opacity(0.8)).frame(width: 2)
            }
    }
}

private struct OutgoingMessageRow: View {
    let message: CoreOutgoingMessage
    let retryEnabled: Bool
    let retry: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            TranscriptBlock(speaker: "you", isUser: true, pending: message.status != .accepted) {
                Text(verbatim: message.text).bzzyFont(15).lineSpacing(4).textSelection(.enabled)
                    .foregroundStyle(message.status == .accepted ? BZZYTheme.userText : BZZYTheme.userText.opacity(0.65))
            }
            HStack(spacing: 8) {
                if message.status == .sending { ProgressView().controlSize(.mini) }
                Text(message.status == .sending ? "Sending…" : message.status == .accepted ? "Sent" : message.status == .uncertain ? "Not confirmed" : "Not sent")
                    .bzzyFont(10).foregroundStyle(message.status == .failed ? BZZYTheme.danger : BZZYTheme.secondary)
                if [.failed, .uncertain].contains(message.status) {
                    Button(action: retry) { Label("Retry", systemImage: "arrow.clockwise").bzzyFont(11, weight: .semibold) }
                        .buttonStyle(BZZYPressStyle()).foregroundStyle(BZZYTheme.accent).disabled(!retryEnabled)
                        .padding(.horizontal, 10).frame(minHeight: 44)
                        .background(BZZYTheme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius))
                        .accessibilityIdentifier("retry-message-\(message.id)")
                }
            }
        }.accessibilityIdentifier("outgoing-message-\(message.id)")
    }
}

private struct TranscriptMessageRow: View {
    let message: LocalMessage
    let showsDraft: Bool
    let speaker: String
    var showsSpeaker = true
    private var content: ChatContent { ChatContent.parse(message.text) }
    var body: some View {
        if let step = message.invocation {
            let tint = step.kind == .skill ? BZZYTheme.accent : invocationColor(step.accentIndex)
            (Text("\(step.kind == .skill ? "◆ Skill" : "◇ Agent") · \(step.name)").foregroundColor(tint)
             + Text(" · \(step.label)").foregroundColor(BZZYTheme.secondary))
                .bzzyFont(11, weight: .medium).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                .accessibilityIdentifier("chat-invocation-\(step.id)")
        } else {
        VStack(alignment: .leading, spacing: 7) {
            TranscriptBlock(speaker: message.isUser ? "you" : speaker, isUser: message.isUser,
                            accent: message.accentIndex.map(invocationColor), showsSpeaker: showsSpeaker) {
                if message.isUser {
                    Text(verbatim: message.text).bzzyFont(15).lineSpacing(4).textSelection(.enabled)
                        .foregroundStyle(BZZYTheme.userText)
                } else {
                    ChatRichText(content: content).foregroundStyle(BZZYTheme.text)
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
        }
    }
}

private func invocationColor(_ index: Int) -> Color {
    let colors = [BZZYTheme.accent, BZZYTheme.success, BZZYTheme.amber, BZZYTheme.agent, BZZYTheme.yolo, Color(hex: 0x8EBAFF)]
    return colors[(index % colors.count + colors.count) % colors.count]
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
// Keep UIKit's native interactive pop transition with the custom chat header.
// The delegate belongs only to this visible destination and rejects a root or
// in-flight transition; SwiftUI keeps its navigation-controller delegate.
private struct ChatBackGesture: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Controller { Controller() }
    func updateUIViewController(_ controller: Controller, context: Context) { controller.enableAfterLayout() }
    static func dismantleUIViewController(_ controller: Controller, coordinator: ()) { controller.restore() }

    final class Controller: UIViewController, UIGestureRecognizerDelegate {
        private weak var installedNavigation: UINavigationController?
        private weak var previousDelegate: UIGestureRecognizerDelegate?
        private var previouslyEnabled = false

        override func loadView() {
            view = UIView(); view.backgroundColor = .clear; view.isUserInteractionEnabled = false
        }
        override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); enableAfterLayout() }
        override func viewDidDisappear(_ animated: Bool) { super.viewDidDisappear(animated); restore() }
        func enableAfterLayout() {
            DispatchQueue.main.async { [weak self] in self?.enable() }
        }
        private func enable() {
            guard view.window != nil, let navigation = navigationController,
                  navigation.viewControllers.count > 1, let gesture = navigation.interactivePopGestureRecognizer else { return }
            if let transition = navigation.transitionCoordinator {
                transition.animate(alongsideTransition: nil) { [weak self] _ in self?.enableAfterLayout() }
                return
            }
            if gesture.delegate !== self {
                installedNavigation = navigation
                previousDelegate = gesture.delegate; previouslyEnabled = gesture.isEnabled
                gesture.delegate = self
            }
            if !gesture.isEnabled { gesture.isEnabled = true }
        }
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let navigation = installedNavigation else { return false }
            return view.window != nil && navigation.viewControllers.count > 1
                && navigation.transitionCoordinator == nil && navigation.presentedViewController == nil
        }
        func restore() {
            guard let navigation = installedNavigation, let gesture = navigation.interactivePopGestureRecognizer,
                  gesture.delegate === self else { return }
            gesture.delegate = previousDelegate
            gesture.isEnabled = previouslyEnabled && navigation.viewControllers.count > 1
            installedNavigation = nil; previousDelegate = nil
        }
    }
}

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
        view.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 14, weight: .regular))
        view.adjustsFontForContentSizeCategory = true
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
            let defaults: [NSAttributedString.Key: Any] = [.font: UIFontMetrics(forTextStyle: .body).scaledFont(for: UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)), .foregroundColor: UIColor(BZZYTheme.text)]
            view.textStorage.beginEditing()
            view.textStorage.setAttributes(defaults, range: NSRange(location: 0, length: view.text.utf16.count))
            if CoreGoalDraft.isGoal(view.text) {
                view.textStorage.addAttributes([.foregroundColor: UIColor(BZZYTheme.success), .backgroundColor: UIColor(BZZYTheme.success).withAlphaComponent(0.18)], range: NSRange(location: 0, length: 5))
            }
            view.textStorage.endEditing()
            view.typingAttributes = defaults; view.selectedRange = selection
            if let placeholder = view.viewWithTag(731) as? UILabel {
                placeholder.font = defaults[.font] as? UIFont
                placeholder.isHidden = !view.text.isEmpty; placeholder.sizeToFit()
            }
        }
        func textViewDidChange(_ view: UITextView) { parent.text = view.text; style(view); view.invalidateIntrinsicContentSize() }
        func textViewDidBeginEditing(_ view: UITextView) { if !parent.focused { parent.focused = true } }
        func textViewDidEndEditing(_ view: UITextView) { if parent.focused { parent.focused = false } }
    }
}
#endif
