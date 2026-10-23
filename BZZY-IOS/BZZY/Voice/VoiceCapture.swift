import Foundation
import Observation
#if os(iOS)
import AVFoundation
import Speech
#endif

@MainActor @Observable
final class VoiceCapture {
    var transcript = ""
    var error: String?
    var spectrum = [Float](repeating: 0, count: VoiceFrequencyAnalyzer.bandCount)
    private var lifecycle = VoiceCaptureLifecycle()
    var isRecording: Bool { lifecycle.phase == .recording }
    var isStarting: Bool { lifecycle.phase == .starting }
    var isFinishing: Bool { lifecycle.phase == .finishing }
    var isBusy: Bool { lifecycle.phase != .idle }
    private var deadline: Task<Void, Never>?
    #if os(iOS)
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var tapInstalled = false
    #endif

    func start(locale: String) async {
        guard !Task.isCancelled else { return }
        guard let generation = lifecycle.begin() else { return }
        error = nil
        defer {
            if lifecycle.id == generation, isStarting { complete(generation) }
        }
        #if os(iOS)
        let speechPermission = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard lifecycle.id == generation, !Task.isCancelled else { return }
        guard speechPermission == .authorized else {
            error = "Speech access is off. Enable it in iPhone Settings, or type your message."
            return
        }
        let microphonePermission = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard lifecycle.id == generation, !Task.isCancelled else { return }
        guard microphonePermission else {
            error = "Microphone access is off. You can still type your message."
            return
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
              recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            error = "On-device speech is unavailable for this language. You can still type your message."
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true)
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.requiresOnDeviceRecognition = true
            request.shouldReportPartialResults = true
            self.request = request
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                error = "The microphone is unavailable. Try again or type your message."
                return
            }
            transcript = ""
            let analyzer = VoiceFrequencyAnalyzer()
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                request.append(buffer)
                guard let channel = buffer.floatChannelData?[0],
                      let levels = analyzer.levels(Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength))), sampleRate: buffer.format.sampleRate, time: ProcessInfo.processInfo.systemUptime) else { return }
                Task { @MainActor in
                    guard let self, self.lifecycle.id == generation, self.isRecording || self.isStarting else { return }
                    self.spectrum = levels
                }
            }
            tapInstalled = true
            recognition = recognizer.recognitionTask(with: request) { [weak self] result, failure in
                Task { @MainActor in
                    guard let self, self.lifecycle.id == generation else { return }
                    if let text = result?.bestTranscription.formattedString, !text.isEmpty { self.transcript = text }
                    if result?.isFinal == true { self.complete(generation) }
                    else if failure != nil {
                        self.complete(generation)
                        self.error = self.transcript.isEmpty
                            ? "Speech recognition stopped. Try again or type your message."
                            : "Speech recognition stopped. Your transcript is ready to edit."
                    }
                }
            }
            engine.prepare()
            try engine.start()
            _ = lifecycle.didStart(generation)
            deadline = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
                guard let self, self.lifecycle.id == generation else { return }
                self.stop()
            }
        } catch {
            complete(generation)
            self.error = "The microphone could not start. Try again or type your message."
        }
        #else
        error = "Microphone capture is available in the iPhone app. You can still type your message."
        #endif
    }

    /// Release stops audio immediately but lets Apple deliver the final words.
    func stop(finalizationSeconds: Double = 3) {
        if isStarting { cancel(); return }
        guard isRecording, let generation = lifecycle.id else { return }
        lifecycle.finish()
        deadline?.cancel()
        #if os(iOS)
        stopMicrophone()
        request?.endAudio()
        #endif
        deadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0.1, min(3, finalizationSeconds)))) } catch { return }
            guard let self, self.lifecycle.id == generation else { return }
            // Keep the last partial if the recognizer never supplies a final result.
            self.complete(generation)
        }
    }

    /// Navigation/backgrounding invalidates callbacks and never restarts capture.
    func cancel() {
        lifecycle.cancel()
        cleanup()
    }

    private func complete(_ generation: UUID) {
        guard lifecycle.complete(generation) else { return }
        cleanup()
    }

    private func cleanup() {
        spectrum = Array(repeating: 0, count: VoiceFrequencyAnalyzer.bandCount)
        deadline?.cancel(); deadline = nil
        #if os(iOS)
        stopMicrophone()
        request?.endAudio()
        recognition?.cancel()
        recognition = nil; request = nil
        #endif
    }

    #if os(iOS)
    private func stopMicrophone() {
        engine.stop()
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    #endif
}
