import XCTest
@testable import RelayKit

final class CoreHostMetricsTests: XCTestCase {
    private var sample: CoreJSONValue {
        .object(["version": .number(1), "sampledAt": .string("2026-10-23T02:00:00.000Z"), "intervalMs": .number(1000),
            "host": .object(["cpuPercent": .number(24.5), "memory": .object(["totalBytes": .number(8192), "usedBytes": .number(3072), "freeBytes": .number(5120), "usedPercent": .number(37.5)])]),
            "core": .object(["cpuPercent": .number(3.2), "rssBytes": .number(1024)])])
    }
    func testMetricsAreReadOnlyAndRejectClientScopeOrProcessSelection() throws {
        XCTAssertFalse(CoreApplicationProtocol.commands.contains("host.metrics"))
        _ = try CoreApplicationProtocol.request(op: "host.metrics", params: [:], id: "metrics", resource: "approved_resource")
        for key in ["pid", "hostname", "sessionId", "resource", "path"] {
            XCTAssertThrowsError(try CoreApplicationProtocol.request(op: "host.metrics", params: [key: .string("other")], id: "metrics", resource: "approved_resource"))
        }
    }
    func testActualHostAndCoreMetricsRemainDistinctAndWarmupIsUnknown() throws {
        let metrics = try CoreHostMetrics(sample)
        XCTAssertEqual(metrics.hostCPUPercent, 24.5)
        XCTAssertEqual(metrics.coreCPUPercent, 3.2)
        XCTAssertEqual(metrics.memoryUsedBytes, 3072)
        XCTAssertEqual(metrics.memoryTotalBytes, 8192)
        XCTAssertEqual(metrics.coreRSSBytes, 1024)
        var value = sample.object!, host = value["host"]!.object!, core = value["core"]!.object!
        host["cpuPercent"] = .null; core["cpuPercent"] = .null
        value["host"] = .object(host); value["core"] = .object(core); value["intervalMs"] = .null
        let warming = try CoreHostMetrics(.object(value))
        XCTAssertNil(warming.hostCPUPercent); XCTAssertNil(warming.coreCPUPercent)
    }
    func testMalformedOrPrivateHostTelemetryIsRejected() throws {
        for invalid in [CoreJSONValue.number(-1), .number(101), .string("20%"), .bool(true)] {
            var value = sample.object!, host = value["host"]!.object!
            host["cpuPercent"] = invalid; value["host"] = .object(host)
            XCTAssertThrowsError(try CoreHostMetrics(.object(value)))
        }
        var value = sample.object!, host = value["host"]!.object!, memory = host["memory"]!.object!
        memory["usedBytes"] = .number(9000); host["memory"] = .object(memory); value["host"] = .object(host)
        XCTAssertThrowsError(try CoreHostMetrics(.object(value)))
        value = sample.object!; host = value["host"]!.object!; host["hostname"] = .string("private-host"); value["host"] = .object(host)
        XCTAssertThrowsError(try CoreHostMetrics(.object(value)))
        value = sample.object!; value["sampledAt"] = .string("invalid")
        XCTAssertThrowsError(try CoreHostMetrics(.object(value)))
    }
}
