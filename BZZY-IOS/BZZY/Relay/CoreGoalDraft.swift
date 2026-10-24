import Foundation

/// Pure composer projection: the full slash command stays in the saved draft.
public enum CoreGoalDraft {
    public static func isGoal(_ text: String) -> Bool {
        text == "/goal" || text.hasPrefix("/goal ") || text.hasPrefix("/goal\n") || text.hasPrefix("/goal\t")
    }
    public static func body(_ text: String) -> String {
        guard isGoal(text) else { return text }
        return String(text.dropFirst(5).drop(while: { $0.isWhitespace }))
    }
    public static func replacingBody(_ body: String) -> String {
        "/goal " + String(body.drop(while: { $0.isWhitespace }))
    }
    public static func needsReplacement(status: String?) -> Bool {
        ["active", "verifying", "paused"].contains(status ?? "")
    }
    public static func isNewGoal(_ text: String) -> Bool {
        guard isGoal(text) else { return false }
        return !["", "status", "resume", "pause", "cancel", "clear"].contains(body(text).trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
