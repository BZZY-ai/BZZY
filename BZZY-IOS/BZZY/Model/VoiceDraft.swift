import Foundation

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
