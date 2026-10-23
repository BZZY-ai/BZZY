import XCTest
@testable import RelayKit

final class CoreUpdateTests: XCTestCase {
    func testVoiceProtocolAcceptsOnlyTextAndBoundedOutputCursors() throws {
        XCTAssertNoThrow(try CoreApplicationProtocol.request(op: "voice.send", params: ["text": .string("Hello")], id: "request", resource: "resource"))
        XCTAssertNoThrow(try CoreApplicationProtocol.request(op: "voice.poll", params: ["requestId": .string("request"), "cursor": .number(0)], id: "poll", resource: "resource"))
        let invalid: [[String: CoreJSONValue]] = [["text": .string("")], ["text": .string("Hello"), "model": .string("override")], ["audio": .string("bytes")]]
        for params in invalid {
            XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "voice.send", params: params, id: "request", resource: "resource"))
        }
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "voice.poll", params: ["requestId": .string("request"), "cursor": .number(-1)], id: "poll", resource: "resource"))
    }
    func testUpdateProtocolPinsRevisionAndAcceptsOnlyBooleanPreferences() throws {
        let target = String(repeating: "a", count: 40)
        XCTAssertNoThrow(try CoreApplicationProtocol.request(op: "updates.install", params: ["target": .string(target)], id: "request", resource: "resource"))
        XCTAssertNoThrow(try CoreApplicationProtocol.request(op: "updates.configure", params: ["remoteUpdatesEnabled": .bool(true)], id: "request", resource: "resource"))
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "updates.install", params: ["target": .string("main")], id: "request", resource: "resource"))
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "updates.install", params: ["target": .string(target), "url": .string("https://other.invalid")], id: "request", resource: "resource"))
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "updates.configure", params: ["remoteUpdatesEnabled": .string("yes")], id: "request", resource: "resource"))
        XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "updates.configure", params: [:], id: "request", resource: "resource"))
    }
}
