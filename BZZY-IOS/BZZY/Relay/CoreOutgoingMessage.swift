import Foundation

/// Local delivery state. "Accepted" means Core durably admitted the input,
/// never that an agent finished or a goal was verified.
public struct CoreOutgoingMessage: Codable, Equatable, Identifiable, Sendable {
    public enum Status: String, Codable, Sendable { case sending, accepted, failed, uncertain }
    public let id: String
    public var requestID: String
    public let text: String
    public let createdAt: Date
    public let operation: String
    public var params: [String: CoreJSONValue]
    public var status: Status
    public var executionID: String?
    public var errorCode: String?
    public var actor: String?

    public init(id: String, text: String, operation: String, params: [String: CoreJSONValue]) {
        self.id = id; requestID = id; self.text = text; createdAt = Date()
        self.operation = operation; self.params = params; status = .sending
    }
}
