import Foundation
import Observation

enum WorkspaceTab: String, CaseIterable {
    case agents = "Agents"
    case terminal = "Terminal"
    var symbol: String { self == .agents ? "square.grid.2x2" : "terminal" }
}

enum AgentMode: String, Codable, CaseIterable {
    case scheduled = "Scheduled"
    case onDemand = "On demand"
}

struct AgentSchedule: Codable, Hashable {
    enum Unit: String, Codable, CaseIterable { case minutes = "Minutes", hours = "Hours", days = "Days" }
    var interval: Int
    var unit: Unit
    var isValid: Bool { (1...365).contains(interval) }
    var label: String { "Every \(interval) \(unit.rawValue.lowercased().dropLast(interval == 1 ? 1 : 0))" }
}

struct AgentProfile: Identifiable, Codable, Hashable {
    let id: UUID
    var name: String
    var subtitle: String
    var purpose: String
    var symbol: String
    var isSample: Bool
    var mode: AgentMode
    var schedule: AgentSchedule?

    init(id: UUID, name: String, subtitle: String, purpose: String, symbol: String, isSample: Bool,
         mode: AgentMode = .onDemand, schedule: AgentSchedule? = nil) {
        self.id = id; self.name = name; self.subtitle = subtitle; self.purpose = purpose
        self.symbol = symbol; self.isSample = isSample; self.mode = mode; self.schedule = schedule
    }

    private enum CodingKeys: String, CodingKey { case id, name, subtitle, purpose, symbol, isSample, mode, schedule }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        subtitle = try values.decode(String.self, forKey: .subtitle)
        purpose = try values.decode(String.self, forKey: .purpose)
        symbol = try values.decode(String.self, forKey: .symbol)
        isSample = try values.decode(Bool.self, forKey: .isSample)
        // Existing local drafts predate the type selection.
        mode = try values.decodeIfPresent(AgentMode.self, forKey: .mode) ?? .onDemand
        schedule = try values.decodeIfPresent(AgentSchedule.self, forKey: .schedule)
        guard (mode == .scheduled && schedule?.isValid == true) || (mode == .onDemand && schedule == nil) else {
            throw DecodingError.dataCorruptedError(forKey: .schedule, in: values, debugDescription: "Invalid draft schedule")
        }
    }

    static let samples: [AgentProfile] = [
        .init(id: UUID(uuidString: "00000000-0000-4000-8000-000000000001")!, name: "COOL", subtitle: "Your project, in focus", purpose: "Help me understand my project using inspected files and evidence.", symbol: "square.stack.3d.up", isSample: true),
        .init(id: UUID(uuidString: "00000000-0000-4000-8000-000000000002")!, name: "Signal", subtitle: "Less noise. Better research.", purpose: "Research relevant developments and preserve source references.", symbol: "waveform.path", isSample: true),
        .init(id: UUID(uuidString: "00000000-0000-4000-8000-000000000003")!, name: "Subscriptions", subtitle: "A little clarity on recurring costs", purpose: "Review authorized subscription information with read-only account access.", symbol: "creditcard", isSample: true)
    ]
}

struct LocalMessage: Identifiable, Codable, Equatable {
    enum Kind: String, Codable { case user, assistant, sample }
    let id: UUID
    let text: String
    let kind: Kind
    let createdAt: Date
    var speaker: String? = nil
    var isUser: Bool { kind == .user }
}

private struct LiveReplyIdentity: Hashable {
    let speaker: String
    let peer: String?
    let item: String?
    let turn: String?
}

struct TerminalPreview: Identifiable {
    let id: String
    let name: String
    let summary: String
    let model: String
    let time: String
    let symbol: String

    static let samples = [
        TerminalPreview(id: "session-design", name: "Design review", summary: "Design review · 12 messages", model: "Codex", time: "12m", symbol: "command"),
        TerminalPreview(id: "session-research", name: "Research", summary: "Research · 8 messages", model: "Claude", time: "1h", symbol: "text.magnifyingglass")
    ]
}

@MainActor @Observable
final class WorkspaceStore {
    var selectedTab: WorkspaceTab = .agents
    var notificationAgentID: String?
    var notificationTerminalID: String?
    private(set) var agents: [AgentProfile]
    private(set) var messages: [String: [LocalMessage]]
    private(set) var terminalDrafts: [TerminalDraft] = []
    var storageError: String?
    // Host projections are kept separate from local demo and draft conversations.
    private(set) var liveSession: LiveSessionState?
    private(set) var liveMessages: [LocalMessage] = []
    private(set) var liveActivity: [LiveActivity] = []
    private(set) var liveTerminals: [LiveTerminalRecord] = []
    private(set) var hostAgents: [HostAgentRecord] = []
    private(set) var hostAgentWorkspace: String?
    private(set) var hostAgentsConfigured = false
    private(set) var liveAvailable = false
    private(set) var liveStatus = "Not connected"
    private let persistenceURL: URL?
    let showsDemoContent: Bool

    private struct SavedWorkspace: Codable {
        var version: Int
        var terminalDrafts: [TerminalDraft]?
        var agents: [AgentProfile]
        var messages: [String: [LocalMessage]]
    }

    init(persistenceURL: URL? = nil, includeSamples: Bool = true) {
        self.persistenceURL = persistenceURL
        self.showsDemoContent = includeSamples
        self.agents = includeSamples ? AgentProfile.samples : []
        self.messages = [:]
        guard let persistenceURL, FileManager.default.fileExists(atPath: persistenceURL.path) else { return }
        do {
            let saved = try JSONDecoder().decode(SavedWorkspace.self, from: Data(contentsOf: persistenceURL))
            guard saved.version == 1 else { throw CocoaError(.coderReadCorrupt) }
            terminalDrafts = saved.terminalDrafts ?? []
            agents = includeSamples ? saved.agents : saved.agents.filter { !$0.isSample }
            messages = saved.messages
        } catch {
            storageError = "Your saved preview could not be opened. It has been kept on this device."
        }
    }

    static func deviceStore() -> WorkspaceStore {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BZZY", isDirectory: true)
        #if DEBUG
        if CommandLine.arguments.contains("--ui-testing") {
            let testFile = folder.appendingPathComponent("ui-test-workspace.json")
            if CommandLine.arguments.contains("--reset-ui-testing") { try? FileManager.default.removeItem(at: testFile) }
            return WorkspaceStore(persistenceURL: testFile)
        }
        #endif
        return WorkspaceStore(persistenceURL: folder.appendingPathComponent("preview-workspace.json"), includeSamples: false)
    }

    @discardableResult
    func createAgent(name: String, purpose: String, symbol: String, mode: AgentMode = .onDemand, schedule: AgentSchedule? = nil) -> AgentProfile? {
        let cleanedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanedPurpose = purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedName.isEmpty, !cleanedPurpose.isEmpty else { return nil }
        guard (mode == .scheduled && schedule?.isValid == true) || (mode == .onDemand && schedule == nil) else { return nil }
        let agent = AgentProfile(id: UUID(), name: String(cleanedName.prefix(60)), subtitle: "Draft", purpose: String(cleanedPurpose.prefix(4000)), symbol: symbol, isSample: false, mode: mode, schedule: schedule)
        agents.append(agent)
        save()
        return agent
    }

    func deleteAgent(_ id: UUID) {
        agents.removeAll { $0.id == id }
        messages.removeValue(forKey: id.uuidString)
        save()
    }

    func saveDraft(_ text: String, conversationID: String) {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        messages[conversationID, default: []].append(.init(id: UUID(), text: cleaned, kind: .user, createdAt: Date()))
        save()
    }

    func demoConversation(_ id: String) -> DemoConversation? {
        guard showsDemoContent else { return nil }
        let known = TerminalPreview.samples.contains { $0.id == id } || agents.contains { $0.id.uuidString == id && $0.isSample }
        return known ? DemoConversation.samples[id] : nil
    }

    func conversationMessages(_ id: String) -> [LocalMessage] {
        if liveSession?.id == id { return liveMessages }
        return (demoConversation(id)?.messages ?? []) + (messages[id] ?? [])
    }

    @discardableResult
    func sendDemoMessage(_ text: String, conversationID: String) -> Bool {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, let demo = demoConversation(conversationID) else { return false }
        let count = messages[conversationID, default: []].filter { !$0.isUser }.count
        let now = Date()
        messages[conversationID, default: []].append(contentsOf: [
            .init(id: UUID(), text: cleaned, kind: .user, createdAt: now),
            .init(id: UUID(), text: demo.replies[count % demo.replies.count], kind: .assistant, createdAt: now)
        ])
        save()
        return true
    }

    func importDemoDefinition(_ definition: DemoSharedDefinition) -> String? {
        guard storageError == nil else { return nil }
        let previousAgents = agents, previousTerminals = terminalDrafts
        let existingNames = definition.kind == .agent ? agents.map(\.name) : terminalDrafts.map(\.name)
        var name = definition.name
        var suffix = 2
        while existingNames.contains(name) { name = "\(definition.name) \(suffix)"; suffix += 1 }
        if definition.kind == .agent {
            agents.append(AgentProfile(id: UUID(), name: name, subtitle: "Draft", purpose: definition.instructions,
                                       symbol: definition.symbol, isSample: false))
        } else {
            terminalDrafts.append(TerminalDraft(id: UUID(), name: name, instructions: definition.instructions, symbol: definition.symbol))
        }
        save()
        guard storageError == nil else { agents = previousAgents; terminalDrafts = previousTerminals; return nil }
        return name
    }

    func applyLiveSnapshot(_ data: Data) {
        guard let snapshot = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let session = snapshot["session"] as? [String: Any],
              let id = session["id"] as? String, UUID(uuidString: id) != nil else { return }
        if liveSession?.id != id { liveMessages = []; liveActivity = [] }
        let capabilities = snapshot["capabilities"] as? [String: Any] ?? [:]
        let execution = snapshot["execution"] as? [String: Any] ?? [:]
        let goal = session["goal"] as? [String: Any] ?? [:]
        let lease = snapshot["inputOwner"] as? [String: Any] ?? [:]
        let alias = (session["alias"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasAlias = alias?.isEmpty == false
        liveSession = LiveSessionState(id: id, title: hasAlias ? alias! : "Shared terminal", hasAlias: hasAlias,
            provider: session["provider"] as? String ?? "Unknown provider", model: session["model"] as? String ?? "Unknown model",
            directory: session["cwd"] as? String,
            execution: execution["state"] as? String ?? session["executionState"] as? String ?? "Unknown",
            goalStatus: goal["status"] as? String,
            goalObjective: goal["objective"] as? String,
            goalTurns: goal["turns"] as? Int,
            goalTokensUsed: goal["tokensUsed"] as? Int,
            goalTokenBudget: goal["tokenBudget"] as? Int,
            acceptanceLevel: (session["acceptance"] as? [String: Any])?["level"] as? String,
            permissions: Set(capabilities["permissions"] as? [String] ?? []),
            activeSteering: capabilities["activeSteering"] as? Bool == true,
            questions: (snapshot["questions"] as? [[String: Any]] ?? []).compactMap { item in
                guard let questionID = item["id"] as? String else { return nil }
                return LiveQuestion(id: questionID, text: item["question"] as? String ?? item["text"] as? String ?? "Input requested",
                    kind: item["kind"] as? String ?? "input", options: item["options"] as? [String] ?? [])
            }, inputOwner: lease["owner"] as? String)
        if let current = liveSession, let index = liveTerminals.firstIndex(where: { $0.id == current.id }) {
            let previous = liveTerminals[index]
            if !current.hasAlias { liveTerminals.remove(at: index) }
            else { liveTerminals[index] = LiveTerminalRecord(id: current.id, title: current.title,
                directory: current.directory ?? previous.directory, provider: current.provider, model: current.model,
                execution: current.execution, updatedAt: session["updatedAt"] as? String ?? previous.updatedAt) }
            sortLiveTerminals()
        }
    }

    func applyLiveEvents(_ data: [Data]) {
        guard let session = liveSession else { return }
        var seen = Set<String>(), approvalIDs = Set<String>(), projected: [LocalMessage] = [], activity: [LiveActivity] = []
        var activeReply: (identity: LiveReplyIdentity, index: Int)?
        var peerReplies: [LiveReplyIdentity: Int] = [:]
        for bytes in data {
            guard let event = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  event["sessionId"] as? String == session.id,
                  let id = event["id"] as? String, seen.insert(id).inserted,
                  let seq = event["seq"] as? Int64, let type = event["type"] as? String,
                  let payload = event["data"] as? [String: Any] else { continue }
            let date = (event["createdAt"] as? String).flatMap(Self.eventDate) ?? Date(timeIntervalSince1970: 0)
            // Sequence is durable and unique within this explicitly scoped conversation.
            let uuid = UUID(uuidString: String(format: "20000000-0000-4000-8000-%012llx", UInt64(seq) & 0xffffffffffff))!
            if type == "question", payload["kind"] as? String == "approval", let questionID = payload["id"] as? String { approvalIDs.insert(questionID) }
            // Match terminal chat entries, including boundaries kept only in
            // Activity on iOS. Telemetry/backend events do not split deltas.
            if ["message.user", "question", "tool", "summary", "error", "control.failed", "debate.message", "debate.result"].contains(type)
                || type == "info" && !(payload["message"] as? String ?? "").isEmpty
                || type == "worker.progress" && payload["type"] as? String == "error" { activeReply = nil }
            if type == "message.user", let text = payload["text"] as? String {
                projected.append(.init(id: uuid, text: text, kind: .user, createdAt: date))
            } else if ["text", "peer.text"].contains(type), let text = payload["text"] as? String {
                let peer = type == "peer.text" ? ["childSessionId", "sessionId", "agent"].compactMap { payload[$0] as? String }.first(where: { !$0.isEmpty }) : nil
                let speaker = type == "peer.text" ? (payload["agent"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? peer ?? "Agent" : "bzzy"
                let identity = LiveReplyIdentity(speaker: speaker, peer: peer, item: payload["itemId"] as? String, turn: payload["turnId"] as? String)
                // Explicit peer identities can interleave without creating
                // duplicate bubbles; ordinary replies merge only adjacently.
                let previous = peer != nil && identity.item?.isEmpty == false ? peerReplies[identity]
                    : activeReply.flatMap { $0.identity == identity && $0.index == projected.count - 1 ? $0.index : nil }
                let index: Int
                if let previous {
                    let message = projected[previous]; index = previous
                    projected[index] = .init(id: message.id, text: message.text + text, kind: .assistant, createdAt: message.createdAt, speaker: message.speaker)
                } else {
                    index = projected.count
                    projected.append(.init(id: uuid, text: text, kind: .assistant, createdAt: date, speaker: type == "peer.text" ? speaker : nil))
                }
                if peer != nil && identity.item?.isEmpty == false { peerReplies[identity] = index }
                // Updating an older peer bubble leaves the latest entry intact.
                if index == projected.count - 1 { activeReply = (identity, index) }
            } else if type == "question", payload["kind"] as? String == "input", let text = payload["question"] as? String {
                projected.append(.init(id: uuid, text: text, kind: .assistant, createdAt: date))
            } else if type == "question.answered", !approvalIDs.contains(payload["id"] as? String ?? ""), let text = payload["answer"] as? String {
                projected.append(.init(id: uuid, text: text, kind: .user, createdAt: date))
            } else if type == "debate.result", let text = payload["message"] as? String {
                projected.append(.init(id: uuid, text: text, kind: .assistant, createdAt: date))
            } else if type == "debate.message", let text = payload["text"] as? String {
                let speaker = [payload["participant"] as? String, payload["role"] as? String].compactMap { $0 }.joined(separator: " · ")
                projected.append(.init(id: uuid, text: text, kind: .assistant, createdAt: date, speaker: speaker.isEmpty ? nil : speaker))
            }
            if !["text", "message.user", "input.accepted"].contains(type) {
                let details = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
                    .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
                activity.append(LiveActivity(id: id, type: type, details: details, date: date))
            }
        }
        liveMessages = projected
        liveActivity = activity
    }

    func applyHostAgents(_ data: Data) {
        guard let items = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
        hostAgents = items.compactMap { item in
            guard let id = item["id"] as? String, UUID(uuidString: id) != nil,
                  let sessionID = item["sessionId"] as? String, UUID(uuidString: sessionID) != nil,
                  let revision = item["revision"] as? Int, let name = item["name"] as? String else { return nil }
            return HostAgentRecord(id: id, name: name, provider: item["provider"] as? String ?? "Unknown provider",
                model: item["model"] as? String ?? "Provider default", effort: item["effort"] as? String ?? "default",
                directory: item["cwd"] as? String ?? "", sessionID: sessionID, revision: revision,
                state: item["state"] as? String ?? "unknown", goalStatus: item["goalStatus"] as? String)
        }
    }

    func applyHostAgentStatus(_ data: Data) {
        guard let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        hostAgentsConfigured = status["configured"] as? Bool == true
        hostAgentWorkspace = (status["workspaceRoot"] as? [String: Any])?["path"] as? String
    }

    func applyLiveTerminalCatalog(_ data: Data) {
        guard let items = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
        liveTerminals = items.compactMap { item in
            guard let id = item["id"] as? String, UUID(uuidString: id) != nil, let directory = item["cwd"] as? String,
                  let alias = (item["alias"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !alias.isEmpty else { return nil }
            return LiveTerminalRecord(id: id, title: alias, directory: directory,
                provider: item["provider"] as? String ?? "Unknown provider", model: item["model"] as? String ?? "Unknown model",
                execution: item["executionState"] as? String ?? "Unknown", updatedAt: item["updatedAt"] as? String ?? item["createdAt"] as? String ?? "")
        }
        sortLiveTerminals()
    }

    private func sortLiveTerminals() {
        liveTerminals.sort {
            let left = Self.eventDate($0.updatedAt) ?? .distantPast
            let right = Self.eventDate($1.updatedAt) ?? .distantPast
            return left == right ? $0.id < $1.id : left > right
        }
    }

    func setLiveAvailability(_ available: Bool, status: String) { liveAvailable = available; liveStatus = status }
    func clearLiveConversation() { liveSession = nil; liveMessages = []; liveActivity = []; liveAvailable = false; liveStatus = "Conversation unavailable" }
    func clearLiveSession() { liveSession = nil; liveMessages = []; liveActivity = []; liveTerminals = []; hostAgents = []; hostAgentWorkspace = nil; hostAgentsConfigured = false; liveAvailable = false; liveStatus = "Not connected" }
    private static func eventDate(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    private func save() {
        guard let persistenceURL else { return }
        // A corrupt or newer file must never be silently overwritten.
        guard storageError == nil else { return }
        do {
            try FileManager.default.createDirectory(at: persistenceURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(SavedWorkspace(version: 1, terminalDrafts: terminalDrafts, agents: agents, messages: messages))
            #if os(iOS)
            try data.write(to: persistenceURL, options: [.atomic, .completeFileProtection])
            #else
            try data.write(to: persistenceURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: persistenceURL.path)
            #endif
        } catch {
            storageError = "Changes are available for this visit, but could not be saved on this device."
        }
    }
}

/// Synthetic, local-only conversations. These never describe inspected host state.
struct DemoConversation {
    let messages: [LocalMessage]
    let replies: [String]
    private static func make(_ seed: Int, _ texts: [String], replies: [String]) -> DemoConversation {
        DemoConversation(messages: texts.enumerated().map { index, text in
            LocalMessage(id: UUID(uuidString: String(format: "10000000-0000-4000-8000-%012d", seed + index))!,
                         text: text, kind: index.isMultiple(of: 2) ? .user : .assistant,
                         createdAt: Date(timeIntervalSince1970: Double(index)))
        }, replies: replies)
    }
    static let samples: [String: DemoConversation] = [
        "00000000-0000-4000-8000-000000000001": make(100, [
            "What should we focus on for COOL?",
            """
            <message version="1"><p>Keep the next step <b>small and clear.</b></p><table><tr><th>Focus</th><th>Status</th></tr><tr><td>Chat flow</td><td><span color="mint">Ready</span></td></tr><tr><td>Voice</td><td><span color="amber">Next</span></td></tr></table></message>
            """,
            "Start with the chat flow.",
            """
            <message version="1"><p><b>One conversation, one place.</b></p><ul><li>Ask a question.</li><li>Review the response.</li><li>Choose the next step.</li></ul><p size="small"><span color="muted">We can keep it focused.</span></p></message>
            """
        ], replies: [
            "<message version=\"1\"><p>Let’s start with <b>one clear task.</b></p><p>What would you like to work through first?</p></message>",
            "<message version=\"1\"><p><span color=\"mint\">Got it.</span> We can break that into a few smaller steps here.</p></message>"
        ]),
        "00000000-0000-4000-8000-000000000002": make(200, [
            "Give me the short version.",
            """
            <message version="1"><h2>Three things to watch</h2><ol><li><b>On-device models</b> for small, fast tasks.</li><li><b>Human approvals</b> before important actions.</li><li><b>Clear evidence</b> behind every result.</li></ol></message>
            """,
            "Which matters most for us?",
            "<message version=\"1\"><p><span color=\"lavender\" size=\"large\"><b>Clear evidence.</b></span></p><p>A useful response should make the next decision easier.</p></message>"
        ], replies: ["<message version=\"1\"><p>Want a <b>quick summary</b> or a deeper comparison?</p></message>"]),
        "00000000-0000-4000-8000-000000000003": make(300, [
            "What’s coming up this month?",
            """
            <message version="1"><p>Your <b>sample renewals</b>, in one place.</p><table><tr><th>Service</th><th>Monthly</th></tr><tr><td>Music</td><td>$10.99</td></tr><tr><td>Cloud</td><td>$2.99</td></tr><tr><td>Design</td><td>$12.00</td></tr></table><p><span color="mint" size="large"><b>$25.98</b></span> <span color="muted">/ month</span></p></message>
            """,
            "Anything worth reviewing?",
            "<message version=\"1\"><p><span color=\"amber\"><b>Design</b></span> is the largest item in this example.</p><p>Want to keep it on the review list?</p></message>"
        ], replies: [
            "<message version=\"1\"><p>We can compare <b>cost</b> and <b>renewal date</b> before deciding.</p><p size=\"small\"><span color=\"muted\">This demo uses fictional subscriptions.</span></p></message>"
        ]),
        "session-design": make(400, [
            "Review this mobile chat layout.",
            """
            <message version="1"><p>The conversation should have <b>more room.</b></p><table><tr><th>Element</th><th>Direction</th></tr><tr><td>Messages</td><td><span color="mint">Clear bubbles</span></td></tr><tr><td>Header</td><td>Keep compact</td></tr><tr><td>Details</td><td>One tap away</td></tr></table></message>
            """,
            "Show me a simple structure.",
            """
            <message version="1"><p><b>Start here.</b></p><pre language="swift">VStack {
                ChatHeader()
                MessageList()
                Composer()
            }</pre></message>
            """
        ], replies: [
            "<message version=\"1\"><p>I’d start with the <b>conversation</b>, then refine spacing and contrast.</p><p><span color=\"mint\">One clear action</span> in the composer.</p></message>"
        ]),
        "session-research": make(500, [
            "Compare two approaches for the prototype.",
            """
            <message version="1"><table><tr><th>Approach</th><th>Trade-off</th></tr><tr><td>Native views</td><td><span color="mint">Consistent feel</span></td></tr><tr><td>Web content</td><td>More flexibility</td></tr></table><p><b>For this prototype:</b> keep the conversation native.</p></message>
            """,
            "What should we validate first?",
            "<message version=\"1\"><blockquote>A response should be <b>easy to read</b> and easy to act on.</blockquote><p>Try a long table, larger text and a short reply.</p><p size=\"small\"><span color=\"blue\">Then refine the details.</span></p></message>"
        ], replies: ["<message version=\"1\"><p>Let’s compare <b>one detail at a time.</b></p><p>Which part would you like to explore?</p></message>"])
    ]
}

/// Authoritative, sanitized snapshots from a currently authorized Core session.
struct LiveSessionState: Identifiable, Equatable {
    let id: String
    let title: String
    let hasAlias: Bool
    let provider: String
    let model: String
    let directory: String?
    let execution: String
    let goalStatus: String?
    let goalObjective: String?
    let goalTurns: Int?
    let goalTokensUsed: Int?
    let goalTokenBudget: Int?
    let acceptanceLevel: String?
    let permissions: Set<String>
    let activeSteering: Bool
    let questions: [LiveQuestion]
    let inputOwner: String?
}
struct LiveQuestion: Identifiable, Equatable {
    let id: String
    let text: String
    let kind: String
    let options: [String]
}
struct LiveActivity: Identifiable, Equatable {
    let id: String
    let type: String
    let details: String
    let date: Date
}

struct LiveTerminalRecord: Identifiable, Hashable {
    let id: String
    let title: String
    let directory: String
    let provider: String
    let model: String
    let execution: String
    let updatedAt: String
}

struct HostAgentRecord: Identifiable, Hashable {
    let id: String
    let name: String
    let provider: String
    let model: String
    let effort: String
    let directory: String
    let sessionID: String
    let revision: Int
    let state: String
    let goalStatus: String?
}
