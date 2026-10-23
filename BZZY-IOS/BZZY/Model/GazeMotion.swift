import Foundation
import CoreGraphics

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
