import Foundation
import Observation
import Security

enum SharedResourceKind: String, CaseIterable, Codable, Identifiable {
    case agent = "AGENT", terminal = "TERMINAL"
    var id: String { rawValue }
    var title: String { self == .agent ? "Agent" : "Terminal" }
    var symbol: String { self == .agent ? "square.grid.2x2" : "terminal" }
}
enum ResourceShareMode: String, CaseIterable {
    case portable = "Copy", live = "Live access"
}
struct ShareTarget {
    let id: String
    let kind: SharedResourceKind
    let name: String
    let isDemo: Bool
    static func agent(_ agent: AgentProfile) -> ShareTarget {
        .init(id: agent.id.uuidString, kind: .agent, name: agent.name, isDemo: agent.isSample)
    }
    static func terminal(_ session: TerminalPreview) -> ShareTarget {
        .init(id: session.id, kind: .terminal, name: session.name, isDemo: true)
    }
}

/// Internal demo data only. This is NOT a proposed portable package or Relay payload schema.
struct DemoSharedDefinition: Equatable {
    let kind: SharedResourceKind
    let name: String
    let instructions: String
    let symbol: String
    let access: [String]
    static func example(for target: ShareTarget) -> DemoSharedDefinition? {
        guard target.isDemo else { return nil }
        if target.kind == .agent, let sample = AgentProfile.samples.first(where: { $0.id.uuidString == target.id }) {
            // Always use immutable examples, never an edited draft, account binding or chat history.
            let access = sample.name == "Subscriptions" ? ["Read email"] : sample.name == "Signal" ? ["Web research"] : ["Read project"]
            return .init(kind: .agent, name: sample.name, instructions: sample.purpose, symbol: sample.symbol, access: access)
        }
        if target.kind == .terminal, let sample = TerminalPreview.samples.first(where: { $0.id == target.id }) {
            return .init(kind: .terminal, name: sample.name,
                         instructions: "Help with \(sample.name.lowercased()) using the recipient's own authorized workspace.",
                         symbol: sample.symbol, access: ["Choose workspace"])
        }
        return nil
    }
}
struct DemoShareTicket: Identifiable {
    var id: String { code }
    let code: String
    let expiresAt: Date
    let definition: DemoSharedDefinition
    var qrText: String { "BZZY:DEMO:1:" + code }
}
enum SharingFailure: Error, LocalizedError {
    case wrongType, unavailable, expired, capacity, invalid, saveFailed
    var errorDescription: String? {
        switch self {
        case .wrongType: "This code belongs in the other tab."
        case .unavailable: "Demo code unavailable. Create a new one in Share."
        case .expired: "Code expired. Create a new one."
        case .capacity: "Too many demo codes. Revoke one or wait for expiry."
        case .invalid: "Use a BZZY QR or import code."
        case .saveFailed: "Import could not be saved."
        }
    }
}

@MainActor @Observable
final class DemoTransferStore {
    // Codes are ephemeral capabilities for immutable examples on this app instance only.
    @ObservationIgnored private var tickets: [String: DemoShareTicket] = [:]
    @ObservationIgnored private let now: () -> Date
    init(now: @escaping () -> Date = Date.init) { self.now = now }
    func issue(_ target: ShareTarget) throws -> DemoShareTicket {
        tickets = tickets.filter { $0.value.expiresAt > now() }
        guard let definition = DemoSharedDefinition.example(for: target) else { throw SharingFailure.unavailable }
        guard tickets.count < 32 else { throw SharingFailure.capacity }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw SharingFailure.unavailable }
        let random = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let ticket = DemoShareTicket(code: "BZZY-DEMO-\(target.kind.rawValue)-\(random)", expiresAt: now().addingTimeInterval(600), definition: definition)
        tickets[ticket.code] = ticket
        return ticket
    }
    func preview(_ raw: String, kind: SharedResourceKind) throws -> DemoShareTicket {
        var code = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if code.hasPrefix("BZZY:DEMO:1:") { code = String(code.dropFirst("BZZY:DEMO:1:".count)) }
        let prefix = "BZZY-DEMO-\(kind.rawValue)-"
        guard code.hasPrefix(prefix) else { throw SharingFailure.wrongType }
        guard code.range(of: "^BZZY-DEMO-(AGENT|TERMINAL)-[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw SharingFailure.invalid }
        guard let ticket = tickets[code] else { throw SharingFailure.unavailable }
        guard ticket.expiresAt > now() else { tickets.removeValue(forKey: code); throw SharingFailure.expired }
        return ticket
    }
    func revoke(_ ticket: DemoShareTicket) { tickets.removeValue(forKey: ticket.code) }
    func importCopy(_ ticket: DemoShareTicket, into store: WorkspaceStore) throws -> String {
        let valid = try preview(ticket.code, kind: ticket.definition.kind)
        guard let name = store.importDemoDefinition(valid.definition) else { throw SharingFailure.saveFailed }
        tickets.removeValue(forKey: ticket.code)
        return name
    }
}

struct TerminalDraft: Identifiable, Codable, Equatable {
    let id: UUID
    let name: String
    let instructions: String
    let symbol: String
    var conversationID: String { "terminal-draft-" + id.uuidString }
}
