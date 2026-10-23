import Foundation
import Observation
#if os(iOS)
import AVFoundation
import NaturalLanguage
#endif

@MainActor @Observable
final class NativeSpeechOutput: NSObject {
    private(set) var isSpeaking = false
    private(set) var lastText = ""
    #if os(iOS)
    private let synthesizer = AVSpeechSynthesizer()
    private var utterances = Set<ObjectIdentifier>()
    #endif
    func speak(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        stop(); lastText = text
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        do { try session.setCategory(.playback, mode: .spokenAudio, options: .duckOthers); try session.setActive(true) }
        catch { return }
        let detector = NLLanguageRecognizer(); detector.processString(text)
        let language = detector.dominantLanguage?.rawValue ?? Locale.preferredLanguages.first ?? "en-US"
        synthesizer.delegate = self
        var index = text.startIndex
        while index < text.endIndex {
            let end = text.index(index, offsetBy: 1800, limitedBy: text.endIndex) ?? text.endIndex
            let utterance = AVSpeechUtterance(string: String(text[index..<end]))
            utterance.voice = AVSpeechSynthesisVoice(language: language)
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate
            utterances.insert(ObjectIdentifier(utterance)); synthesizer.speak(utterance); index = end
        }
        isSpeaking = true
        #endif
    }
    func stop() {
        #if os(iOS)
        utterances.removeAll(); synthesizer.stopSpeaking(at: .immediate)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
        isSpeaking = false
    }
    static func explanation(_ code: String) -> String {
        switch code {
        case "ASSISTANT_SETUP_REQUIRED": "Choose BZZY Core’s default assistant on your host first."
        case "WORKSPACE_SETUP_REQUIRED", "WORKSPACE_CHANGED", "WORKSPACE_UNAVAILABLE": "Check the default BZZY folder on your host."
        case "PROVIDER_UNAVAILABLE": "The assistant provider is unavailable. Check its login or API setup on your host."
        case "VOICE_STOPPED": "The assistant response stopped before it finished."
        case "OPERATION_DENIED", "PROTOCOL_UNSUPPORTED": "Update BZZY Core from the CLI to enable voice chat."
        case "FORBIDDEN", "GRANT_UNAVAILABLE": "Voice chat needs your fully approved phone pairing."
        case "UNCERTAIN": "That message has not been confirmed. Check its status before sending it again."
        case "VOICE_NOT_SENT": "That message was not sent. You can tap send to try again."
        case "VOICE_EMPTY_REPLY": "The assistant finished without a spoken reply."
        case "INVALID_REQUEST": "That recording could not be sent. Please try a shorter message."
        default: "BZZY Core is unavailable. Check your host connection and try again."
        }
    }
}

#if os(iOS)
extension NativeSpeechOutput: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { ended(utterance) }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { ended(utterance) }
    nonisolated private func ended(_ utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in
            guard let self, self.utterances.remove(id) != nil else { return }
            if self.utterances.isEmpty {
                self.isSpeaking = false
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            }
        }
    }
}
#endif
