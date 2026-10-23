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
        .aspectRatio(2, contentMode: .fit)
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
    private static let cyan = Color(hex: 0x00EEFF)

    static func draw(in context: inout GraphicsContext, size: CGSize, pose: FlyPose) {
        // Geometry follows new-eyes.jpeg: close, inward-facing lenses and long
        // swept antennae. Keep the mascot resolution-independent and interactive.
        let scale = min(size.width / 600, size.height / 300)
        context.translateBy(x: (size.width - 600 * scale) / 2, y: (size.height - 300 * scale) / 2 + pose.hover)
        context.scaleBy(x: scale, y: scale)
        for side in [-1.0, 1.0] {
            antenna(in: &context, side: side, pose: pose)
            var eye = context
            eye.translateBy(x: 300 + side * 94, y: 180)
            eye.rotate(by: .radians(-side * 0.20))
            lens(in: &eye, side: side, pose: pose)
        }
        var bridge = Path()
        bridge.move(to: CGPoint(x: 270, y: 246))
        bridge.addCurve(to: CGPoint(x: 330, y: 246), control1: CGPoint(x: 297, y: 213), control2: CGPoint(x: 303, y: 213))
        context.stroke(bridge, with: .color(cyan.opacity(0.65)), style: StrokeStyle(lineWidth: 1.4, lineCap: .round))
        var crown = Path()
        crown.move(to: CGPoint(x: 275, y: 123))
        crown.addQuadCurve(to: CGPoint(x: 325, y: 123), control: CGPoint(x: 300, y: 103))
        context.stroke(crown, with: .linearGradient(Gradient(colors: [.clear, cyan, .clear]), startPoint: CGPoint(x: 275, y: 118), endPoint: CGPoint(x: 325, y: 118)), lineWidth: 3)
    }

    private static func lens(in context: inout GraphicsContext, side: Double, pose: FlyPose) {
        let rx = 74.0, ry = 75.0, open = pose.openness(side: side)
        let lens = Path(ellipseIn: CGRect(x: -rx, y: -ry, width: rx * 2, height: ry * 2))
        var halo = context
        halo.addFilter(.blur(radius: 11))
        halo.fill(lens, with: .color(cyan.opacity(0.25)))
        var face = context
        face.clip(to: Path(ellipseIn: CGRect(x: -rx - 2, y: 8 - ry * open, width: rx * 2 + 4, height: ry * 2 * open)))
        face.fill(lens, with: .radialGradient(Gradient(colors: [Color(hex: 0x001015), Color(hex: 0x004853), cyan, Color(hex: 0x98FFFF)]), center: CGPoint(x: -side * 35, y: -38), startRadius: 4, endRadius: 133))
        // Recessed upper/inner edge creates the reference's pointed expression.
        var shadow = Path()
        shadow.move(to: CGPoint(x: -side * 72, y: 50))
        shadow.addCurve(to: CGPoint(x: side * 45, y: -69), control1: CGPoint(x: -side * 52, y: -39), control2: CGPoint(x: side * 10, y: -91))
        shadow.addLine(to: CGPoint(x: -side * 80, y: -94))
        shadow.closeSubpath()
        face.fill(shadow, with: .linearGradient(Gradient(colors: [.black, .black.opacity(0.2)]), startPoint: CGPoint(x: 0, y: -52), endPoint: CGPoint(x: side * 45, y: 45)))
        var facets = Path()
        for row in -18...18 {
            for column in -18...18 {
                let x = Double(column) * 4 + (row.isMultiple(of: 2) ? 0 : 2), y = Double(row) * 4
                let distance = x * x / (rx * rx) + y * y / (ry * ry)
                if distance < 0.94 { facets.addEllipse(in: CGRect(x: x, y: y, width: 1.1, height: 1.4)) }
            }
        }
        face.fill(facets, with: .color(Color(hex: 0x002B35).opacity(0.30)))
        face.stroke(lens, with: .linearGradient(Gradient(colors: [cyan.opacity(0.15), Color(hex: 0xB8FFFF), cyan]), startPoint: CGPoint(x: -side * 60, y: -70), endPoint: CGPoint(x: side * 65, y: 65)), lineWidth: 1.5)
        var pupil = face
        pupil.translateBy(x: -side * 16 + pose.gaze.x * 16, y: 24 + pose.gaze.y * 12)
        pupil.rotate(by: .radians(side * 0.22))
        pupil.fill(Path(ellipseIn: CGRect(x: -17, y: -32, width: 34, height: 66)), with: .color(Color(hex: 0x00080C)))
        let glint = Path(ellipseIn: CGRect(x: -side * 9 - 6, y: -36, width: 12, height: 16))
        var glow = pupil
        glow.addFilter(.blur(radius: 4))
        glow.fill(glint, with: .color(cyan))
        pupil.fill(glint, with: .color(Color(hex: 0xD0FFFF)))
        pupil.fill(Path(ellipseIn: CGRect(x: 3, y: -18, width: 3, height: 5)), with: .color(cyan))
    }

    private static func antenna(in context: inout GraphicsContext, side: Double, pose: FlyPose) {
        let flutter = pose.still ? 0 : sin(pose.time * 1.5 + side) * 1.6
        func point(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: 300 + side * x, y: y) }
        var stem = Path()
        stem.move(to: point(19, 158))
        stem.addCurve(to: point(157, 48 + flutter), control1: point(51, 78), control2: point(114, 39 + flutter))
        let shade = GraphicsContext.Shading.linearGradient(Gradient(colors: [cyan.opacity(0.2), cyan, Color(hex: 0xA8FFFF)]), startPoint: point(19, 158), endPoint: point(157, 48))
        var glow = context
        glow.addFilter(.blur(radius: 4))
        glow.stroke(stem, with: shade, style: StrokeStyle(lineWidth: 4, lineCap: .round))
        context.stroke(stem, with: shade, style: StrokeStyle(lineWidth: 2, lineCap: .round))
        var tip = Path()
        tip.move(to: point(128, 48 + flutter))
        tip.addQuadCurve(to: point(157, 48 + flutter), control: point(153, 43 + flutter))
        context.stroke(tip, with: .color(cyan), style: StrokeStyle(lineWidth: 7, lineCap: .round))
    }
}
