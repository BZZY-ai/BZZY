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
    @GestureState private var held = false
    private var hasDraft: Bool { !capture.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !capture.isBusy }
    private func say(_ text: String) {
        #if DEBUG
        guard !CommandLine.arguments.contains("--ui-testing") else { return }
        #endif
        speech.speak(text)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                RoundButton(symbol: "xmark", label: "Close voice chat") { dismiss() }
                Spacer()
                RoundButton(symbol: "arrow.clockwise", label: "Check voice connection") { Task { await relay.prepareVoiceChat() } }
            }.padding(.top, 18)
            Spacer(minLength: 35)
            VoiceFrequencyView(levels: capture.isRecording ? capture.spectrum : Array(repeating: 0, count: 32))
                .frame(height: 180).padding(.horizontal, 12).accessibilityHidden(true)
            Spacer(minLength: 35)
            ZStack {
                Circle().stroke(BZZYTheme.accent.opacity(capture.isRecording ? 0.55 : 0.13), lineWidth: 1)
                    .frame(width: 118, height: 118)
                if relay.voiceWaiting {
                    control("stop.fill", label: "Stop assistant response") { speech.stop(); Task { await relay.stopVoiceTurn() } }
                } else if speech.isSpeaking {
                    control("stop.fill", label: "Stop speaking") { speech.stop() }
                } else if hasDraft {
                    control("arrow.up", label: "Send voice message") {
                        Task { if await relay.sendVoiceText(capture.transcript) { capture.transcript = "" } }
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
                        .accessibilityLabel(capture.isRecording ? "Finish recording" : "Hold to talk")
                        .accessibilityIdentifier("voice-chat-record")
                        .accessibilityAction { if capture.isRecording { finishRecording() } else { beginRecording() } }
                }
            }.frame(height: 130)
            HStack {
                if hasDraft { RoundButton(symbol: "trash", label: "Discard recording") { capture.cancel(); capture.transcript = "" } }
                Spacer()
                if !lastReply.isEmpty { RoundButton(symbol: "speaker.wave.2", label: "Replay assistant reply") { speech.speak(lastReply) }.disabled(relay.voiceWaiting || capture.isBusy) }
            }.frame(height: 54).padding(.top, 20)
            Spacer(minLength: 25)
        }.padding(.horizontal, 28)
            .background(BZZYTheme.background.ignoresSafeArea()).preferredColorScheme(.dark)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("voice-only-chat")
            .task { await relay.prepareVoiceChat() }
            .onChange(of: held) { _, held in if held { beginRecording() } else { finishRecording() } }
            .onChange(of: relay.voicePhase) { _, phase in
                if phase == "answered", !relay.voiceReply.isEmpty, scenePhase == .active {
                    lastReply = relay.voiceReply; say(lastReply)
                }
            }
            .onChange(of: relay.voiceErrorCode) { _, code in
                if let code, scenePhase == .active { say(NativeSpeechOutput.explanation(code)) }
            }
            .onChange(of: capture.error) { _, error in
                if let error, scenePhase == .active, !capture.isBusy {
                    say(error.replacingOccurrences(of: "You can still type your message.", with: "Please check speech permissions and try again.")
                        .replacingOccurrences(of: "Your transcript is ready to edit.", with: "Your recording is ready. Tap send when you are ready.")
                        .replacingOccurrences(of: "or type your message", with: "and try again"))
                }
            }
            .onChange(of: relay.coreActionsAvailable) { _, available in
                if !available { stopAudio(); if scenePhase == .active { say(NativeSpeechOutput.explanation("OFFLINE")) } }
                else if scenePhase == .active { Task { await relay.prepareVoiceChat() } }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { stopAudio(); relay.stopVoiceObservation() }
                else { Task { await relay.prepareVoiceChat() } }
            }
            .onDisappear { stopAudio(); relay.stopVoiceObservation() }
    }
    private func control(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button { BZZYTheme.haptic(); action() } label: {
            Image(systemName: symbol).font(.system(size: 31, weight: .medium))
                .foregroundStyle(BZZYTheme.background).frame(width: 94, height: 94)
                .background(BZZYTheme.accent, in: Circle())
        }.buttonStyle(BZZYPressStyle()).accessibilityLabel(label)
    }
    private func beginRecording() {
        guard !capture.isBusy, !relay.voiceWaiting, relay.coreActionsAvailable, relay.voiceConfigured else { return }
        speech.stop(); capture.transcript = ""; BZZYTheme.haptic()
        recording = Task { await capture.start(locale: Locale.preferredLanguages.first ?? "en-US") }
    }
    private func finishRecording() { recording?.cancel(); recording = nil; capture.stop() }
    private func stopAudio() { recording?.cancel(); recording = nil; capture.cancel(); speech.stop() }
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
    var body: some View {
        Canvas { context, size in
            let step = size.width / CGFloat(max(1, levels.count)), width = max(2, step * 0.42)
            for (index, value) in levels.enumerated() {
                let amplitude = CGFloat(min(1, max(0, value))), height = 2 + amplitude * (size.height - 4)
                let rect = CGRect(x: CGFloat(index) * step + (step - width) / 2, y: (size.height - height) / 2, width: width, height: height)
                context.fill(Path(roundedRect: rect, cornerRadius: width / 2), with: .color(BZZYTheme.accent.opacity(0.25 + Double(amplitude) * 0.75)))
            }
        }
    }
}
