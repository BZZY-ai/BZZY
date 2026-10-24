import Foundation
import CoreGraphics

enum FlyMood: String, CaseIterable {
    case idle, curious, thinking, listening, happy, resting
    var label: String {
        switch self {
        case .idle: "Ready"
        case .curious: "Curious"
        case .thinking: "Thinking"
        case .listening: "Listening"
        case .happy: "Happy"
        case .resting: "Resting"
        }
    }
}

struct FlyAnimationClock {
    private(set) var elapsed: Double = 0
    private var previous: Double?
    mutating func advance(_ now: Double) {
        guard now.isFinite else { return }
        let delta = previous.map { now - $0 } ?? 1 / 30
        previous = now
        guard delta > 0 else { return }
        elapsed += delta > 0.1 ? 1 / 30 : delta
    }
    mutating func pause() { previous = nil }
}

struct FlyAnimationPose {
    let target: CGPoint
    let energy: Double
    let scanning: Bool
    private static let scanPath: [(CGPoint, Double)] = [
        (CGPoint(x: -0.70, y: -0.16), 0.74), (CGPoint(x: 0.52, y: 0.14), 0.95),
        (CGPoint(x: 0.02, y: -0.48), 0.68), (CGPoint(x: 0.78, y: -0.10), 0.88),
        (CGPoint(x: -0.28, y: 0.26), 0.62), (CGPoint(x: -0.62, y: -0.38), 1.05),
        (CGPoint(x: 0.44, y: -0.32), 0.76), (CGPoint(x: 0.12, y: 0.02), 0.90),
    ]
    private static func scan(at time: Double) -> CGPoint {
        var phase = time.truncatingRemainder(dividingBy: scanPath.reduce(0) { $0 + $1.1 })
        for (point, hold) in scanPath {
            if phase < hold { return point }
            phase -= hold
        }
        return scanPath[0].0
    }
    init(time: Double, mood: FlyMood, touchAge: Double, touch: CGPoint, still: Bool) {
        guard !still else { target = .zero; energy = 0; scanning = false; return }
        let time = time.isFinite ? max(0, time) : 0
        let delight = max(0, 1 - max(0, touchAge) / 2.2)
        scanning = delight == 0 && ![.thinking, .listening, .resting].contains(mood)
        energy = mood == .resting ? 0.35 : mood == .listening || delight > 0 ? 1.2 : 1
        if delight > 0 {
            target = CGPoint(x: min(1, max(-1, touch.x)) * delight, y: min(1, max(-1, touch.y)) * delight)
        } else if mood == .thinking {
            target = CGPoint(x: -0.45 + sin(time * 0.7) * 0.12, y: -0.35)
        } else if mood == .listening {
            target = CGPoint(x: sin(time * 0.8) * 0.12, y: -0.12)
        } else {
            target = Self.scan(at: mood == .resting ? time * 0.45 : time)
        }
    }
}

/// Frame-rate-independent easing with a speed limit: new touch targets never snap the pupils.
struct GazeMotion {
    private(set) var position = CGPoint.zero
    private var previousTime: TimeInterval?
    mutating func advance(toward target: CGPoint, time: TimeInterval, rapid: Bool = false) {
        guard time.isFinite, target.x.isFinite, target.y.isFinite else { return }
        let elapsed = previousTime.map { time - $0 } ?? (1.0 / 30)
        previousTime = time
        guard elapsed > 0 else { return }
        // A paused/delayed frame must not fast-forward the eyes across the screen.
        let dt = elapsed > 0.1 ? 1.0 / 30 : elapsed
        let desired = CGPoint(x: min(1, max(-1, target.x)), y: min(1, max(-1, target.y)))
        if rapid && hypot(desired.x - position.x, desired.y - position.y) < 0.002 { position = desired; return }
        let alpha = 1 - exp(-dt / (rapid ? 0.035 : 0.36))
        var dx = (desired.x - position.x) * alpha
        var dy = (desired.y - position.y) * alpha
        let distance = hypot(dx, dy), maximum = (rapid ? 12 : 1.65) * dt
        if distance > maximum { dx *= maximum / distance; dy *= maximum / distance }
        position.x += dx; position.y += dy
    }
    mutating func pause() { previousTime = nil }
}
