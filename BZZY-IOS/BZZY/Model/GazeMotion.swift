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
    init(time: Double, mood: FlyMood, touchAge: Double, touch: CGPoint, still: Bool) {
        guard !still else { target = .zero; energy = 0; return }
        let time = time.isFinite ? max(0, time) : 0
        func smooth(_ a: Double, _ b: Double) -> Double {
            let x = min(1, max(0, (time.truncatingRemainder(dividingBy: 13) - a) / (b - a)))
            return x * x * (3 - 2 * x)
        }
        let delight = max(0, 1 - max(0, touchAge) / 2.2)
        energy = mood == .resting ? 0.35 : mood == .listening || delight > 0 ? 1.2 : 1
        if delight > 0 {
            target = CGPoint(x: min(1, max(-1, touch.x)) * delight, y: min(1, max(-1, touch.y)) * delight)
        } else if mood == .thinking {
            target = CGPoint(x: -0.45 + sin(time * 0.7) * 0.12, y: -0.35)
        } else if mood == .listening {
            target = CGPoint(x: sin(time * 0.8) * 0.12, y: -0.12)
        } else {
            let right = smooth(1.4, 2.3) - smooth(4.6, 5.4), left = smooth(7.4, 8.2) - smooth(10.4, 11.2)
            target = CGPoint(x: right * 0.62 - left * 0.45, y: sin(time * 0.55) * 0.09)
        }
    }
}

/// Frame-rate-independent easing with a speed limit: new touch targets never snap the pupils.
struct GazeMotion {
    private(set) var position = CGPoint.zero
    private var previousTime: TimeInterval?
    mutating func advance(toward target: CGPoint, time: TimeInterval) {
        guard time.isFinite, target.x.isFinite, target.y.isFinite else { return }
        let elapsed = previousTime.map { time - $0 } ?? (1.0 / 30)
        previousTime = time
        guard elapsed > 0 else { return }
        // A paused/delayed frame must not fast-forward the eyes across the screen.
        let dt = elapsed > 0.1 ? 1.0 / 30 : elapsed
        let desired = CGPoint(x: min(1, max(-1, target.x)), y: min(1, max(-1, target.y)))
        let alpha = 1 - exp(-dt / 0.36)
        var dx = (desired.x - position.x) * alpha
        var dy = (desired.y - position.y) * alpha
        let distance = hypot(dx, dy), maximum = 1.65 * dt
        if distance > maximum { dx *= maximum / distance; dy *= maximum / distance }
        position.x += dx; position.y += dy
    }
    mutating func pause() { previousTime = nil }
}
