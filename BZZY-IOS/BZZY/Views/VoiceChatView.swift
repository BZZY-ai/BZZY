import SwiftUI
import RelayKit

/// Deliberately has no visible transcript, status labels or message list.
/// Accessibility labels and spoken notices remain available to VoiceOver.
struct VoiceChatView: View {
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var capture = VoiceCapture()
    @State private var speech = NativeSpeechOutput()
    @State private var recording: Task<Void, Never>?
    @State private var lastReply = ""
    @State private var intent = VoiceReleaseIntent()
    @State private var submitting = false
    @State private var sendingTask: Task<Void, Never>?
    @State private var originHost: HostActionContext?
    @AppStorage(SpeechLanguage.recognitionKey, store: SpeechLanguage.preferences) private var recognitionLanguage = SpeechLanguage.preferred.rawValue
    @AppStorage(SpeechLanguage.synthesisKey, store: SpeechLanguage.preferences) private var synthesisLanguage = SpeechLanguage.preferred.rawValue
    @GestureState private var held = false
    private var spokenLanguage: SpeechLanguage { .resolve(synthesisLanguage) }
    private var hasDraft: Bool { !capture.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !capture.isBusy && !intent.held && !intent.pending }
    private func say(_ text: String) {
        #if DEBUG
        guard !CommandLine.arguments.contains("--ui-testing") else { return }
        #endif
        speech.speak(text, language: spokenLanguage)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                RoundButton(symbol: "xmark", label: "Close voice chat") { dismiss() }
                Spacer()
                RoundButton(symbol: "arrow.clockwise", label: "Check voice connection") { relay.performHostAction { await relay.prepareVoiceChat() } }
            }.padding(.top, 18)
            Spacer(minLength: 35)
            VoiceFrequencyView(levels: capture.isRecording ? capture.spectrum : Array(repeating: 0, count: VoiceFrequencyAnalyzer.bandCount))
                .frame(height: 180).padding(.horizontal, 12).accessibilityHidden(true)
            Spacer(minLength: 35)
            ZStack {
                Circle().stroke(BZZYTheme.accent.opacity(capture.isRecording ? 0.55 : 0.13), lineWidth: 1)
                    .frame(width: 118, height: 118)
                if relay.voiceWaiting || submitting {
                    control("stop.fill", label: "Stop assistant response") { speech.stop(); relay.performHostAction { await relay.stopVoiceTurn() } }
                } else if speech.isSpeaking {
                    control("stop.fill", label: "Stop speaking") { speech.stop() }
                } else if hasDraft {
                    control("arrow.up", label: "Send voice message") {
                        submit(capture.transcript)
                    }.disabled(!relay.coreActionsAvailable || !relay.voiceConfigured)
                } else {
                    Button {} label: { Image(systemName: capture.isFinishing ? "ellipsis" : "mic.fill")
                        .font(.system(size: 31, weight: .medium)).foregroundStyle(BZZYTheme.background)
                        .frame(width: 94, height: 94).background(BZZYTheme.accent, in: Circle())
                        .scaleEffect(capture.isRecording && !reduceMotion ? 1.035 : 1)
                        .contentShape(Circle()) }
                        .buttonStyle(BZZYPressStyle())
                        .simultaneousGesture(DragGesture(minimumDistance: 0).updating($held) { _, held, _ in held = true })
                        .disabled(!relay.coreActionsAvailable || !relay.voiceConfigured || capture.isFinishing)
                        .opacity(relay.coreActionsAvailable && relay.voiceConfigured ? 1 : 0.35)
                        .accessibilityLabel(capture.isRecording ? "Release to send" : "Hold to talk, release to send")
                        .accessibilityIdentifier("voice-chat-record")
                        .accessibilityAction { if capture.isRecording { finishRecording() } else { beginRecording() } }
                }
            }.frame(height: 130)
            HStack {
                if hasDraft { RoundButton(symbol: "trash", label: "Discard recording") { intent.cancel(); capture.cancel(); capture.transcript = "" } }
                Spacer()
                if !lastReply.isEmpty { RoundButton(symbol: "speaker.wave.2", label: "Replay assistant reply") { say(lastReply) }.disabled(relay.voiceWaiting || capture.isBusy || submitting) }
            }.frame(height: 54).padding(.top, 20)
            Spacer(minLength: 25)
        }.padding(.horizontal, 28)
            .background(BZZYTheme.background.ignoresSafeArea()).preferredColorScheme(.dark)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("voice-only-chat")
            .onAppear { originHost = HostActionContext(hostID: relay.activeHostID) }
            .task { guard originHost?.permits(relay.activeHostID) == true else { return }; await relay.prepareVoiceChat() }
            .onChange(of: held) { _, held in if held { beginRecording() } else { finishRecording() } }
            .onChange(of: capture.isRecording) { _, active in if active { intent.audioStarted() } }
            .onChange(of: capture.isBusy) { _, _ in sendReleasedRecording() }
            .onChange(of: relay.voicePhase) { _, phase in
                if phase == "answered", !relay.voiceReply.isEmpty, scenePhase == .active, originHost?.permits(relay.activeHostID) == true {
                    capture.transcript = ""
                    lastReply = relay.voiceReply; say(lastReply)
                }
            }
            .onChange(of: relay.voiceErrorCode) { _, code in
                if let code, scenePhase == .active, originHost?.permits(relay.activeHostID) == true { say(NativeSpeechOutput.explanation(code, language: spokenLanguage)) }
            }
            .onChange(of: capture.error) { _, error in
                if let error, scenePhase == .active, !capture.isBusy {
                    say(NativeSpeechOutput.captureExplanation(error, language: spokenLanguage))
                }
            }
            .onChange(of: relay.coreActionsAvailable) { _, available in
                if !available { stopAudio(); if scenePhase == .active, originHost?.permits(relay.activeHostID) == true { say(NativeSpeechOutput.explanation("OFFLINE", language: spokenLanguage)) } }
                else if scenePhase == .active, originHost?.permits(relay.activeHostID) == true { relay.performHostAction { await relay.prepareVoiceChat() } }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { stopAudio(); if originHost?.permits(relay.activeHostID) == true { relay.stopVoiceObservation() } }
                else if originHost?.permits(relay.activeHostID) == true { relay.performHostAction { await relay.prepareVoiceChat() } }
            }
            .onChange(of: relay.activeHostID) { _, _ in stopAudio() }
            .onDisappear { stopAudio(); if originHost?.permits(relay.activeHostID) == true { relay.stopVoiceObservation() } }
    }
    private func control(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button { BZZYTheme.haptic(); action() } label: {
            Image(systemName: symbol).font(.system(size: 31, weight: .medium))
                .foregroundStyle(BZZYTheme.background).frame(width: 94, height: 94)
                .background(BZZYTheme.accent, in: Circle())
        }.buttonStyle(BZZYPressStyle()).accessibilityLabel(label)
    }
    private func beginRecording() {
        guard originHost?.permits(relay.activeHostID) == true, !capture.isBusy, !relay.voiceWaiting, !submitting, relay.coreActionsAvailable, relay.voiceConfigured else { return }
        speech.stop(); capture.transcript = ""; intent.begin(); BZZYTheme.haptic()
        let origin = originHost
        recording = Task {
            guard !Task.isCancelled, origin?.permits(relay.activeHostID) == true else { return }
            await capture.start(locale: SpeechLanguage.resolve(recognitionLanguage).rawValue)
        }
    }
    private func finishRecording() {
        if capture.isRecording { intent.audioStarted() }
        intent.release(); recording?.cancel(); recording = nil
        capture.stop(finalizationSeconds: 0.65)
        sendReleasedRecording()
    }
    private func sendReleasedRecording() {
        if let text = intent.consume(capture.transcript, busy: capture.isBusy, failed: capture.error != nil,
                                     allowed: scenePhase == .active && relay.coreActionsAvailable && relay.voiceConfigured) { submit(text) }
    }
    private func submit(_ text: String) {
        guard originHost?.permits(relay.activeHostID) == true, !submitting, !relay.voiceWaiting else { return }
        submitting = true
        sendingTask = relay.performHostAction {
            guard !Task.isCancelled, scenePhase == .active, relay.coreActionsAvailable else { submitting = false; return }
            let accepted = await relay.sendVoiceText(text)
            if accepted || relay.voiceWaiting { capture.transcript = "" }
            submitting = false
        }
    }
    private func stopAudio() { intent.cancel(); recording?.cancel(); recording = nil; sendingTask?.cancel(); capture.cancel(); speech.stop() }
}

extension View {
    func voiceChatScreen(isPresented: Binding<Bool>) -> some View {
        #if os(iOS)
        self.fullScreenCover(isPresented: isPresented) { VoiceChatView() }
        #else
        self.sheet(isPresented: isPresented) { VoiceChatView() }
        #endif
    }
}

private struct VoiceFrequencyView: View {
    let levels: [Float]
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var smoothed = VoiceSpectrumSmoother()
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60, paused: scenePhase != .active)) { frame in
        let displayed = reduceMotion ? levels : smoothed.levels
        Canvas { context, size in
            let step = size.width / CGFloat(max(1, displayed.count)), width = max(1.4, step * 0.55)
            for (index, value) in displayed.enumerated() {
                let amplitude = CGFloat(min(1, max(0, value))), height = 2 + amplitude * (size.height - 4)
                let rect = CGRect(x: CGFloat(index) * step + (step - width) / 2, y: (size.height - height) / 2, width: width, height: height)
                context.fill(Path(roundedRect: rect, cornerRadius: width / 2), with: .color(BZZYTheme.accent.opacity(0.25 + Double(amplitude) * 0.75)))
            }
        }
        .onChange(of: frame.date) { _, date in smoothed.advance(toward: levels, time: date.timeIntervalSinceReferenceDate) }
        }.onChange(of: scenePhase) { _, phase in if phase != .active { smoothed.reset() } }
    }
}
