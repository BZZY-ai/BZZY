import SwiftUI

struct VoiceView: View {
    @Bindable var store: WorkspaceStore
    var conversationID: String? = nil
    var agentName: String? = nil
    var onReview: ((String) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var capture = VoiceCapture()
    @AppStorage(SpeechLanguage.recognitionKey, store: SpeechLanguage.preferences) private var locale = SpeechLanguage.preferred.rawValue
    @State private var selectedAgentID: UUID?
    @State private var recordingTask: Task<Void, Never>?

    private var targetID: String? { conversationID ?? selectedAgentID?.uuidString }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    HStack {
                        Text("›").bzzyFont(20, weight: .semibold).foregroundStyle(BZZYTheme.accent).accessibilityHidden(true)
                        Text("Voice").bzzyFont(20, weight: .semibold)
                        Spacer()
                        Picker("Speech language", selection: $locale) {
                            Text("EN").tag("en-US")
                            Text("ES").tag("es-ES")
                        }.pickerStyle(.menu).disabled(capture.isBusy)
                    }
                    if BZZYTheme.showsMascot {
                        FlyEyes(mood: capture.isRecording ? .listening : .curious)
                            .frame(maxWidth: 340).padding(.vertical, 18)
                    }
                    if capture.isRecording {
                        Text("Listening").bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                    } else if capture.isFinishing {
                        Text("Finishing transcript…").bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                    }
                    Button {
                        BZZYTheme.haptic()
                        if capture.isRecording {
                            capture.stop()
                        } else {
                            recordingTask = Task { await capture.start(locale: locale) }
                        }
                    } label: {
                        Image(systemName: capture.isRecording ? "stop.fill" : "mic")
                            .bzzyFont(27, weight: .light)
                            .foregroundStyle(BZZYTheme.accent)
                            .frame(width: 82, height: 82)
                            .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius))
                            .overlay(RoundedRectangle(cornerRadius: BZZYTheme.controlRadius).stroke(BZZYTheme.accent.opacity(0.6), lineWidth: 1))
                    }.buttonStyle(.plain).disabled(capture.isStarting || capture.isFinishing)
                        .accessibilityLabel(capture.isRecording ? "Stop recording" : "Start on-device recording")
                    if let error = capture.error {
                        Text(error).bzzyFont(12).lineSpacing(4).foregroundStyle(BZZYTheme.amber)
                            .multilineTextAlignment(.center)
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        TextField("Transcript", text: $capture.transcript, axis: .vertical)
                            .bzzyFont(15).lineLimit(3...6).textFieldStyle(.plain)
                            .disabled(capture.isBusy)
                    }.panel()
                    if let agentName {
                        Label(agentName, systemImage: "square.stack.3d.up")
                            .bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                    } else {
                        Picker("Save for", selection: $selectedAgentID) {
                            Text("Choose an agent").tag(nil as UUID?)
                            ForEach(store.agents) { agent in Text(agent.name).tag(agent.id as UUID?) }
                        }.tint(BZZYTheme.accent)
                    }
                    AccentButton(title: onReview == nil ? "Save draft" : "Use transcript", symbol: "arrow.down") {
                        guard let targetID else { return }
                        capture.stop()
                        if let onReview { onReview(capture.transcript) }
                        else { store.saveDraft(capture.transcript, conversationID: targetID) }
                        dismiss()
                    }.disabled(targetID == nil || capture.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || capture.isBusy)
                        .opacity(targetID == nil || capture.transcript.isEmpty ? 0.35 : 1)
                    Text("On device")
                        .bzzyFont(10).foregroundStyle(BZZYTheme.muted).lineSpacing(4).multilineTextAlignment(.center)
                }.padding(16)
            }.scrollIndicators(.hidden).bzzyScreen()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
            .onChange(of: scenePhase) {
                if scenePhase != .active { recordingTask?.cancel(); capture.cancel() }
            }
            .onDisappear { recordingTask?.cancel(); capture.cancel() }
    }
}
