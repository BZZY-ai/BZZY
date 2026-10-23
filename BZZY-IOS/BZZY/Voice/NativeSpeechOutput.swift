import Foundation
import Observation
#if os(iOS)
import AVFoundation
#endif

@MainActor @Observable
final class NativeSpeechOutput: NSObject {
    private(set) var isSpeaking = false
    private(set) var lastText = ""
    #if os(iOS)
    private let synthesizer = AVSpeechSynthesizer()
    private var utterances = Set<ObjectIdentifier>()
    #endif
    func speak(_ text: String, language: SpeechLanguage = .preferred) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        stop(); lastText = text
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        do { try session.setCategory(.playback, mode: .spokenAudio, options: .duckOthers); try session.setActive(true) }
        catch { return }
        synthesizer.delegate = self
        var index = text.startIndex
        while index < text.endIndex {
            let end = text.index(index, offsetBy: 1800, limitedBy: text.endIndex) ?? text.endIndex
            let utterance = AVSpeechUtterance(string: String(text[index..<end]))
            utterance.voice = AVSpeechSynthesisVoice(language: language.rawValue)
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
    static func explanation(_ code: String, language: SpeechLanguage = .english) -> String {
        if language == .spanish {
            switch code {
            case "ASSISTANT_SETUP_REQUIRED": return "Primero elige el modelo predeterminado de BZZY Core en tu computador."
            case "WORKSPACE_SETUP_REQUIRED": return "En los ajustes de BZZY CLI de tu computador, elige la carpeta BZZY predeterminada."
            case "WORKSPACE_CHANGED": return "Vuelve a seleccionar la carpeta BZZY predeterminada en los ajustes de BZZY CLI de tu computador."
            case "WORKSPACE_UNAVAILABLE": return "La carpeta BZZY de tu computador no está disponible. Comprueba que su disco esté conectado."
            case "PROVIDER_UNAVAILABLE": return "El proveedor no está disponible. Comprueba su inicio de sesión en tu computador."
            case "VOICE_STOPPED": return "La respuesta se detuvo antes de terminar."
            case "OPERATION_DENIED", "PROTOCOL_UNSUPPORTED": return "Actualiza BZZY Core desde la CLI para usar el chat de voz."
            case "FORBIDDEN", "GRANT_UNAVAILABLE": return "El chat de voz necesita el emparejamiento completo de tu iPhone."
            case "UNCERTAIN": return "No se ha confirmado el mensaje. Comprueba su estado antes de enviarlo otra vez."
            case "VOICE_NOT_SENT": return "El mensaje no se envió. Puedes intentarlo otra vez."
            case "VOICE_EMPTY_REPLY": return "El asistente terminó sin una respuesta de voz."
            case "INVALID_REQUEST": return "Prueba con un mensaje más corto."
            default: return "BZZY Core no está disponible. Comprueba la conexión con tu computador."
            }
        }
        return switch code {
        case "ASSISTANT_SETUP_REQUIRED": "Choose BZZY Core’s default assistant on your host first."
        case "WORKSPACE_SETUP_REQUIRED": "In BZZY CLI Settings on your computer, choose Default BZZY folder."
        case "WORKSPACE_CHANGED": "In BZZY CLI Settings on your computer, select Default BZZY folder again."
        case "WORKSPACE_UNAVAILABLE": "The BZZY folder on your computer is unavailable. Check that its disk is connected."
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
    static func captureExplanation(_ error: String, language: SpeechLanguage) -> String {
        if language == .spanish {
            if error.contains("access is off") { return "Permite el acceso al micrófono y al reconocimiento de voz en los ajustes de tu iPhone." }
            if error.contains("On-device speech") { return "El reconocimiento de voz en el dispositivo no está disponible para este idioma." }
            return "No se pudo completar el reconocimiento. Puedes enviar lo capturado con la flecha, o descartarlo y volver a hablar."
        }
        return error.replacingOccurrences(of: "You can still type your message.", with: "Please check speech permissions and try again.")
            .replacingOccurrences(of: "Your transcript is ready to edit.", with: "You can send what was captured with the arrow, or discard it and try again.")
            .replacingOccurrences(of: "or type your message", with: "and try again")
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
