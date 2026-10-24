import SwiftUI
import RelayKit

struct ActivityView: View {
    var store: WorkspaceStore? = nil
    var sessionID: String? = nil
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    private var session: LiveSessionState? {
        guard let session = store?.liveSession, session.id == sessionID else { return nil }
        return session
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    HStack {
                        Text("Activity").bzzyFont(26, weight: .medium)
                        Spacer()
                        if session != nil { Button("Refresh") { relay.performHostAction { await relay.refreshCore() } }.bzzyFont(12) }
                    }
                    if let session {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(session.title).bzzyFont(16, weight: .medium)
                            Text("Execution: \(session.execution)").bzzyFont(13)
                            if let goal = session.goalStatus { Text("Goal: \(goal)").bzzyFont(13) }
                            if let objective = session.goalObjective { Text(objective).bzzyFont(13).textSelection(.enabled) }
                            if let turns = session.goalTurns { Text("Turns: \(turns)").bzzyFont(12) }
                            if let tokens = session.goalTokensUsed {
                                Text(session.goalTokenBudget.map { "Goal tokens: \(tokens) / \($0)" } ?? "Goal tokens: \(tokens)").bzzyFont(12)
                            }
                            if let basis = session.acceptanceLevel { Text("Acceptance basis: \(basis)").bzzyFont(12) }
                            Text(store?.liveStatus ?? "Unknown connection").bzzyFont(11).foregroundStyle(BZZYTheme.secondary)
                        }.panel()
                        ForEach(session.questions) { question in LiveQuestionView(question: question, sessionID: session.id) }
                        if let store, !store.liveActivity.isEmpty {
                            ForEach(store.liveActivity.reversed()) { item in
                                DisclosureGroup {
                                    Text(verbatim: item.details).font(.system(.caption, design: .monospaced))
                                        .textSelection(.enabled).padding(.top, 8)
                                } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(item.type).bzzyFont(13)
                                        Text(item.date.formatted(date: .omitted, time: .standard)).bzzyFont(10).foregroundStyle(BZZYTheme.secondary)
                                    }
                                }.panel()
                            }
                        } else { Text("No recorded activity").bzzyFont(13).foregroundStyle(BZZYTheme.muted) }
                    } else { Text("No activity").bzzyFont(13).foregroundStyle(BZZYTheme.muted) }
                }.padding(25).frame(maxWidth: .infinity, alignment: .leading)
            }.bzzyScreen().toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
            .coreAvailabilityGate()
    }
}
