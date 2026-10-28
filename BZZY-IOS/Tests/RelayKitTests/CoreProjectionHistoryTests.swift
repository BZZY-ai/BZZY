import Foundation
import XCTest
@testable import RelayKit

private struct ProjectionHistoryFixture {
    let session = UUID().uuidString.lowercased()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)

    func store() throws -> CoreEventProjectionStore {
        try CoreEventProjectionStore(directory: directory, hostID: "host", resource: "resource", sessionID: session)
    }

    func envelopes(_ sequences: [Int64]) -> [CoreJSONValue] {
        sequences.map { seq in
            .object(["version": .number(1), "id": .string("\(session):\(seq)"), "seq": .number(Double(seq)),
                "sessionId": .string(session), "type": .string("text"), "createdAt": .string("2026-10-27T00:00:00Z"),
                "data": .object(["text": .string("Reply \(seq)")])])
        }
    }

    func page(_ sequences: [Int64], hasOlder: Bool, token: String? = nil) throws -> CoreEventHistoryPage {
        var value: [String: CoreJSONValue] = ["events": .array(envelopes(sequences)),
            "nextCursor": .number(Double(sequences.last ?? 0)), "oldestCursor": .number(Double(sequences.first ?? 0)),
            "hasMore": .bool(false), "hasOlder": .bool(hasOlder)]
        if let token { value["bootstrapToken"] = .string(token) }
        return try CoreEventHistoryPage(.object(value), sessionID: session)
    }

    func batch(_ sequences: [Int64], after cursor: Int64) throws -> CoreEventBatch {
        try CoreEventBatch(.object(["v": .number(1), "protocol": .string("bzzy-core"), "type": .string("events"),
            "subscriptionId": .string("subscription"), "resource": .string("resource"), "sessionId": .string(session),
            "events": .array(envelopes(sequences)), "nextCursor": .number(Double(sequences.last ?? 0)),
            "hasMore": .bool(false)]), resource: "resource", sessionID: session, cursor: cursor)
    }

    func remove() { try? FileManager.default.removeItem(at: directory) }
}

final class CoreProjectionHistoryTests: XCTestCase {
    func testAutomaticOlderFillKeepsFollowingLiveTailAndRestoresDurably() throws {
        let fixture = ProjectionHistoryFixture(); defer { fixture.remove() }
        let store = try fixture.store()
        try store.bootstrap(fixture.page(Array(51...100), hasOlder: true, token: "tail-proof"))
        try store.markSubscribed()
        let consumer = store.consumerID
        try store.prepend(fixture.page(Array(1...50), hasOlder: false), preservingHistoryPosition: false)
        XCTAssertEqual(store.cursor, 100, "Backward reads cannot advance the processed live cursor")
        XCTAssertFalse(store.hasOlderHistory)
        XCTAssertFalse(store.hasNewerHistory)

        try store.apply(fixture.batch([101], after: 100))
        XCTAssertEqual(store.events.last?.seq, 101, "Automatic fill must not require Latest to reveal live replies")
        XCTAssertFalse(store.hasNewerHistory)
        let restored = try fixture.store()
        XCTAssertEqual(restored.events.map(\.seq), Array(1...101))
        XCTAssertEqual(restored.cursor, 101)
        XCTAssertEqual(restored.consumerID, consumer)
        XCTAssertTrue(restored.historyInitialized)
        XCTAssertNil(restored.bootstrapToken)
    }

    func testAutomaticFillDoesNotReleaseAnIntentionalHistoryHold() throws {
        let fixture = ProjectionHistoryFixture(); defer { fixture.remove() }
        let store = try fixture.store()
        try store.bootstrap(fixture.page(Array(51...100), hasOlder: true, token: "tail-proof"))
        store.holdHistoryWindow()
        try store.apply(fixture.batch([101], after: 100))
        try store.prepend(fixture.page(Array(1...50), hasOlder: false), preservingHistoryPosition: false)
        XCTAssertEqual(store.events.first?.seq, 1)
        XCTAssertEqual(store.events.last?.seq, 100)
        XCTAssertEqual(store.cursor, 101)
        XCTAssertTrue(store.hasNewerHistory)
        try store.apply(fixture.batch([102], after: 101))
        XCTAssertEqual(store.events.last?.seq, 100)

        store.showLatestHistory()
        XCTAssertEqual(store.events.last?.seq, 102)
        XCTAssertFalse(store.hasNewerHistory)
    }

    func testExplicitBackwardNavigationKeepsItsReadingWindow() throws {
        let fixture = ProjectionHistoryFixture(); defer { fixture.remove() }
        let store = try fixture.store()
        try store.bootstrap(fixture.page(Array(51...100), hasOlder: true, token: "tail-proof"))
        try store.prepend(fixture.page(Array(1...50), hasOlder: false))
        try store.apply(fixture.batch([101], after: 100))
        XCTAssertEqual(store.events.last?.seq, 100)
        XCTAssertTrue(store.hasNewerHistory)
        XCTAssertEqual(try fixture.store().events.last?.seq, 101, "Held display cannot prevent durable live receipt")
    }

    func testEmptyLoadingViewCannotHoldTheFirstReply() throws {
        let fixture = ProjectionHistoryFixture(); defer { fixture.remove() }
        let store = try fixture.store()
        store.holdHistoryWindow()
        try store.apply(fixture.batch([1], after: 0))
        XCTAssertEqual(store.events.last?.seq, 1)
        XCTAssertFalse(store.hasNewerHistory)
    }

    func testAlreadyDurableReplayDoesNotRewriteTheLargeCache() throws {
        let fixture = ProjectionHistoryFixture(); defer { fixture.remove() }
        let store = try fixture.store()
        let batch = try fixture.batch([1, 2], after: 0)
        try store.apply(batch)
        let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: fixture.directory,
            includingPropertiesForKeys: nil).first { $0.pathExtension == "json" })
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1_700_000_000)], ofItemAtPath: file.path)
        let previous = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date
        try store.apply(batch)
        let current = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date
        XCTAssertEqual(current, previous)
        XCTAssertEqual(store.events.map(\.seq), [1, 2])
        XCTAssertEqual(try fixture.store().cursor, 2)
    }
}
