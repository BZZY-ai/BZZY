import SwiftUI

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

/// Native geometry only. No bitmap loading, tracing, or texture sampling.
struct FlyEyes: View {
    var mood: FlyMood = .idle
    var interactive = true
    var frozenTime: Double? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var appearedAt = Date()
    @State private var touchedAt: Date?
    @State private var touchPoint = CGPoint.zero
    @State private var isTouching = false
    @State private var gazeMotion = GazeMotion()
    @State private var isVisible = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30,
                                paused: reduceMotion || scenePhase != .active || !isVisible || frozenTime != nil)) { timeline in
            let time = frozenTime ?? (reduceMotion ? 0 : timeline.date.timeIntervalSince(appearedAt))
            let age = isTouching ? 0 : touchedAt.map { timeline.date.timeIntervalSince($0) } ?? 100
            GeometryReader { geometry in
                Canvas { context, size in
                    let pose = FlyPose(time: time, mood: mood, touchAge: age,
                                       touch: touchPoint, still: reduceMotion, displayedGaze: frozenTime == nil ? gazeMotion.position : nil)
                    FlyDrawing.draw(in: &context, size: size, pose: pose)
                }
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard interactive else { return }
                        if !isTouching { BZZYTheme.haptic() }
                        isTouching = true
                        touchPoint = CGPoint(x: min(1, max(-1, (value.location.x / max(1, geometry.size.width) - 0.5) * 2)),
                                             y: min(1, max(-1, (value.location.y / max(1, geometry.size.height) - 0.5) * 2)))
                    }
                    .onEnded { _ in
                        isTouching = false
                        touchedAt = Date()
                    })
            }
            .onChange(of: timeline.date) { _, date in
                guard frozenTime == nil, !reduceMotion, isVisible, scenePhase == .active else { return }
                let target = FlyPose(time: time, mood: mood, touchAge: age, touch: touchPoint, still: false)
                gazeMotion.advance(toward: target.gaze, time: date.timeIntervalSinceReferenceDate)
            }
        }
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false; gazeMotion.pause() }
        .onChange(of: scenePhase) { _, _ in gazeMotion.pause() }
        .aspectRatio(1.6, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("BZZY, your fly companion")
        .accessibilityValue(mood.label)
        .accessibilityAddTraits(interactive ? .isButton : .isImage)
        .accessibilityHint(interactive ? "Touch and move to play" : "")
        .accessibilityAction {
            guard interactive else { return }
            BZZYTheme.haptic()
            touchPoint = .zero
            touchedAt = Date()
        }
    }
}

private struct FlyPose {
    let time: Double
    let mood: FlyMood
    let gaze: CGPoint
    let delight: Double
    let hover: Double
    let still: Bool

    init(time: Double, mood: FlyMood, touchAge: Double, touch: CGPoint, still: Bool, displayedGaze: CGPoint? = nil) {
        self.time = time
        self.mood = mood
        self.still = still
        delight = still ? 0 : max(0, 1 - touchAge / 1.8)
        hover = still ? 0 : sin(time * 1.3) * 2.2
        let target: CGPoint
        if still {
            target = .zero
        } else if delight > 0 {
            target = CGPoint(x: touch.x * delight, y: touch.y * delight)
        } else if mood == .listening {
            target = CGPoint(x: sin(time * 0.6) * 0.08, y: -0.1)
        } else if mood == .thinking {
            target = CGPoint(x: -0.5 + sin(time * 0.8) * 0.15, y: -0.45)
        } else {
            let beat = time.truncatingRemainder(dividingBy: 12)
            let glance = smooth(beat, 2.2, 2.7) - smooth(beat, 5.0, 5.5)
            let other = smooth(beat, 8.0, 8.5) - smooth(beat, 10.5, 11.0)
            target = CGPoint(x: glance * 0.55 - other * 0.4, y: sin(time * 0.5) * 0.1)
        }
        gaze = still ? .zero : (displayedGaze ?? target)
    }

    func openness(side: Double) -> Double {
        guard !still else { return mood == .resting ? 0.3 : 1 }
        if mood == .resting { return 0.3 }
        let phase = (time + (side > 0 ? 0.025 : 0)).truncatingRemainder(dividingBy: 6.7)
        let blink = smooth(phase, 5.72, 5.84) - smooth(phase, 5.88, 6.06)
        let smile = mood == .happy ? 0.23 : delight * 0.18
        return max(0.035, 1 - blink * 0.98 - smile)
    }
}

private func smooth(_ value: Double, _ start: Double, _ end: Double) -> Double {
    let x = min(1, max(0, (value - start) / (end - start)))
    return x * x * (3 - 2 * x)
}

private enum FlyDrawing {
    private struct Facet {
        let x: Double
        let y: Double
        let z: Double
    }

    // Angular spacing wraps the dotted surface around each spherical lens.
    private static let facets: [Facet] = {
        var result: [Facet] = []
        for row in -18...18 {
            let latitude = Double(row) / 19 * Double.pi / 2
            for column in -20...20 {
                let longitude = (Double(column) + (row.isMultiple(of: 2) ? 0 : 0.5)) / 21 * Double.pi / 2
                result.append(Facet(x: sin(longitude) * cos(latitude), y: sin(latitude),
                                    z: cos(longitude) * cos(latitude)))
            }
        }
        return result
    }()

    private static let palette: [Color] = (0..<12).map { index in
        let light = Double(index) / 11
        return Color(.sRGB, red: 0.02 + pow(light, 4) * 0.47,
                     green: 0.20 + light * 0.80, blue: 0.17 + light * 0.73, opacity: 1)
    }

    static func draw(in context: inout GraphicsContext, size: CGSize, pose: FlyPose) {
        let scale = min(size.width / 480, size.height / 300)
        context.translateBy(x: (size.width - 480 * scale) / 2, y: (size.height - 300 * scale) / 2)
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: 0, y: pose.hover)

        for side in [-1.0, 1.0] {
            var eye = context
            eye.translateBy(x: 240 + side * 99, y: 177)
            eye.rotate(by: .radians(side * 0.13 - side * pose.delight * 0.035))
            drawEye(in: &eye, side: side, pose: pose)
            drawAntenna(in: &context, side: side, pose: pose)
        }

        var bridge = Path()
        bridge.move(to: CGPoint(x: 220, y: 250))
        bridge.addCurve(to: CGPoint(x: 260, y: 250),
                        control1: CGPoint(x: 238, y: 225), control2: CGPoint(x: 242, y: 225))
        context.stroke(bridge, with: .linearGradient(Gradient(colors: [.clear, BZZYTheme.accent.opacity(0.55), .clear]),
                                                     startPoint: CGPoint(x: 217, y: 245), endPoint: CGPoint(x: 263, y: 245)),
                       style: StrokeStyle(lineWidth: 0.9, lineCap: .round))
    }

    private static func drawEye(in context: inout GraphicsContext, side: Double, pose: FlyPose) {
        let rx = 90.0, ry = 101.0
        let open = pose.openness(side: side)
        let lens = Path(ellipseIn: CGRect(x: -rx, y: -ry, width: rx * 2, height: ry * 2))
        var halo = context
        halo.addFilter(.blur(radius: 15))
        halo.fill(lens, with: .color(BZZYTheme.accent.opacity(0.075 + pose.delight * 0.04)))

        var clipped = context
        let opening = Path(ellipseIn: CGRect(x: -rx - 2, y: 10 - ry * open,
                                             width: rx * 2 + 4, height: ry * 2 * open))
        clipped.clip(to: opening)
        clipped.fill(lens, with: .radialGradient(Gradient(colors: [Color(hex: 0x05251F), Color(hex: 0x010C0A), .clear]),
                                                center: CGPoint(x: side * 35, y: -15), startRadius: 0, endRadius: 113))

        let pupilX = -side * 0.13 + pose.gaze.x * 0.28
        let pupilY = 0.25 + pose.gaze.y * 0.21
        let angle = side * 0.34
        let cosine = cos(angle), sine = sin(angle)
        let pupilWidth = pose.mood == .listening ? 0.39 : 0.33
        var buckets = [Path](repeating: Path(), count: palette.count)
        for facet in facets {
            let dx = facet.x - pupilX, dy = facet.y - pupilY
            let px = (dx * cosine + dy * sine) / pupilWidth
            let py = (-dx * sine + dy * cosine) / 0.54
            let pupilDistance = sqrt(px * px + py * py)
            if pupilDistance < 0.94 { continue }
            let pupil = smooth(pupilDistance, 0.88, 1.16)
            let surface = max(0, side * facet.x * 0.72 + facet.z * 0.65)
            let sheen = exp(-pow((facet.x - side * 0.53) / 0.48, 2) - pow((facet.y + 0.18) / 0.7, 2))
            let catchlight = exp(-pow((facet.x - pupilX + 0.1) / 0.13, 2) - pow((facet.y - pupilY + 0.47) / 0.12, 2))
            let pupilRim = exp(-pow((pupilDistance - 1.16) / 0.16, 2)) * smooth(-py, -0.1, 0.7)
            let light = min(1, (0.10 + surface * 0.35 + sheen * 0.48 + catchlight * 0.5 + pupilRim * 0.38) * (0.045 + pupil * 0.955))
            let index = min(palette.count - 1, Int(light * Double(palette.count - 1)))
            let radius = 0.5 + pow(max(0, facet.z), 0.65) * 1.35
            let width = radius * (0.45 + facet.z * 0.55)
            buckets[index].addEllipse(in: CGRect(x: facet.x * rx - width, y: facet.y * ry - radius,
                                                  width: width * 2, height: radius * 2))
        }

        // Batch the facets into twelve paths, rather than thousands of views.
        clipped.drawLayer { layer in
            for index in buckets.indices { layer.fill(buckets[index], with: .color(palette[index])) }
        }
        var glow = clipped
        glow.opacity = 0.25
        glow.addFilter(.blur(radius: 2.6))
        glow.drawLayer { layer in
            for index in 6..<buckets.count { layer.fill(buckets[index], with: .color(palette[index])) }
        }

        var rim = Path()
        rim.addArc(center: .zero, radius: 1, startAngle: .degrees(side < 0 ? 125 : -65),
                   endAngle: .degrees(side < 0 ? 235 : 65), clockwise: false)
        let scaledRim = rim.applying(CGAffineTransform(scaleX: rx, y: ry))
        clipped.stroke(scaledRim, with: .color(BZZYTheme.accent.opacity(0.24)), lineWidth: 0.7)
    }

    private static func drawAntenna(in context: inout GraphicsContext, side: Double, pose: FlyPose) {
        let flutter = pose.still ? 0 : sin(pose.time * 2.1 + side) * 2.2 + sin(pose.time * 7) * pose.delight * 5
        func point(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: 240 + side * x, y: y) }
        var path = Path()
        path.move(to: point(17, 108))
        path.addCurve(to: point(192, 25 + flutter),
                      control1: point(62, 46), control2: point(139, 8 + flutter))
        let gradient = GraphicsContext.Shading.linearGradient(
            Gradient(colors: [BZZYTheme.accent.opacity(0.12), BZZYTheme.accent.opacity(0.8), BZZYTheme.accent.opacity(0.2)]),
            startPoint: point(15, 105), endPoint: point(194, 23))
        var glow = context
        glow.addFilter(.blur(radius: 3))
        glow.opacity = 0.4
        glow.stroke(path, with: gradient, style: StrokeStyle(lineWidth: 3, lineCap: .round))
        context.stroke(path, with: gradient, style: StrokeStyle(lineWidth: 1.15, lineCap: .round))
    }
}
