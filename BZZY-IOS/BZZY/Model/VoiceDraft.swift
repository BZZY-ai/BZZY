import Foundation

enum SpeechLanguage: String, CaseIterable, Identifiable {
    case english = "en-US", spanish = "es-ES"
    var id: String { rawValue }
    var name: String { self == .spanish ? "Español" : "English" }
    static var preferred: Self { Locale.preferredLanguages.first?.hasPrefix("es") == true ? .spanish : .english }
    static let recognitionKey = "bzzy.speech.recognition-language"
    static let synthesisKey = "bzzy.speech.synthesis-language"
    static var preferences: UserDefaults {
        CommandLine.arguments.contains("--ui-testing") ? UserDefaults(suiteName: "app.bzzy.ios.voice-tests")! : .standard
    }
    static func resolve(_ value: String) -> Self { Self(rawValue: value) ?? preferred }
}

/// Only a deliberate release after audio began can submit a voice turn.
/// Permission cancellation, navigation and recognition errors never submit.
struct VoiceReleaseIntent {
    private(set) var held = false
    private(set) var pending = false
    private var recorded = false
    mutating func begin() { held = true; recorded = false; pending = false }
    mutating func audioStarted() { if held { recorded = true } }
    mutating func release() { held = false; pending = recorded; recorded = false }
    mutating func cancel() { held = false; pending = false; recorded = false }
    mutating func consume(_ text: String, busy: Bool, failed: Bool, allowed: Bool) -> String? {
        guard pending, !busy else { return nil }
        pending = false
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return allowed && !failed && !text.isEmpty ? text : nil
    }
}

/// Speech revises earlier words: replace the dictated suffix, preserving typed text.
struct VoiceDraft {
    let original: String

    func text(with transcript: String) -> String {
        let spoken = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return original }
        guard !original.isEmpty else { return spoken }
        return original + (original.last?.isWhitespace == true ? "" : " ") + spoken
    }
}

/// Begin before permission prompts, so release cannot start a late microphone.
struct VoiceCaptureLifecycle {
    enum Phase { case idle, starting, recording, finishing }
    private(set) var phase = Phase.idle
    private(set) var id: UUID?

    mutating func begin() -> UUID? {
        guard phase == .idle else { return nil }
        let next = UUID()
        id = next; phase = .starting
        return next
    }

    mutating func didStart(_ generation: UUID) -> Bool {
        guard id == generation, phase == .starting else { return false }
        phase = .recording
        return true
    }

    mutating func finish() {
        if phase == .recording { phase = .finishing }
        else if phase == .starting { cancel() }
    }

    @discardableResult mutating func complete(_ generation: UUID) -> Bool {
        guard id == generation else { return false }
        cancel()
        return true
    }

    mutating func cancel() { id = nil; phase = .idle }
}
