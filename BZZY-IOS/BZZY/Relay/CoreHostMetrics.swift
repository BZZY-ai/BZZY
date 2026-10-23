import Foundation

/// Coarse telemetry from the authorized execution host, never the phone.
public struct CoreHostMetrics: Sendable {
    public let sampledAt: Date
    public let hostCPUPercent: Double?
    public let memoryUsedBytes: Int64
    public let memoryTotalBytes: Int64
    public let coreCPUPercent: Double?
    public let coreRSSBytes: Int64

    init(_ value: CoreJSONValue) throws {
        try value.record(["version", "sampledAt", "intervalMs", "host", "core"])
        try value["host"].record(["cpuPercent", "memory"])
        try value["host"]["memory"].record(["totalBytes", "usedBytes", "freeBytes", "usedPercent"])
        try value["core"].record(["cpuPercent", "rssBytes"])
        let memory = value["host"]["memory"]
        let validInterval: Bool
        switch value["intervalMs"] {
        case .null: validInterval = true
        case .number(let interval): validInterval = interval.isFinite && interval > 0
        default: validInterval = false
        }
        guard value["version"].integer == 1,
              let text = value["sampledAt"].string,
              let sampledAt = Self.date(text),
              validInterval,
              let total = memory["totalBytes"].integer, total > 0,
              let used = memory["usedBytes"].integer, used >= 0, used <= total,
              let free = memory["freeBytes"].integer, free >= 0, free == total - used,
              let rss = value["core"]["rssBytes"].integer, rss >= 0 else { throw CoreApplicationError("INVALID_RESPONSE") }
        let usedPercent = try Self.percent(memory["usedPercent"], nullable: false)!
        guard abs(usedPercent - Double(used) / Double(total) * 100) <= 1 else { throw CoreApplicationError("INVALID_RESPONSE") }
        self.sampledAt = sampledAt
        hostCPUPercent = try Self.percent(value["host"]["cpuPercent"])
        coreCPUPercent = try Self.percent(value["core"]["cpuPercent"])
        memoryUsedBytes = used; memoryTotalBytes = total; coreRSSBytes = rss
    }
    private static func percent(_ value: CoreJSONValue, nullable: Bool = true) throws -> Double? {
        if nullable && value == .null { return nil }
        guard case .number(let number) = value, number.isFinite, (0...100).contains(number) else { throw CoreApplicationError("INVALID_RESPONSE") }
        return number
    }
    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
