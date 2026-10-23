import SwiftUI
#if BZZY_PREVIEW
import AppKit
#endif

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

/// The supplied BZZY artwork stays intact; only the complete mark moves.
/// Its shape, facet texture, pupils and antennae are never approximated.
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

    private var artwork: Image {
        #if BZZY_PREVIEW
        if let url = Bundle.module.url(forResource: "eyes", withExtension: "png", subdirectory: "Assets.xcassets/BZZYEyes.imageset"),
           let image = NSImage(contentsOf: url) { Image(nsImage: image) }
        else { Image(systemName: "eye") }
        #else
        Image("BZZYEyes")
        #endif
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30,
                                paused: reduceMotion || scenePhase != .active || !isVisible || frozenTime != nil)) { timeline in
            let time = frozenTime ?? (reduceMotion ? 0 : timeline.date.timeIntervalSince(appearedAt))
            let age = isTouching ? 0 : touchedAt.map { timeline.date.timeIntervalSince($0) } ?? 100
            GeometryReader { geometry in
                artwork
                    .resizable()
                    .aspectRatio(2, contentMode: .fit)
                    .offset(x: reduceMotion ? 0 : gazeMotion.position.x * geometry.size.width * 0.008,
                            y: reduceMotion ? 0 : gazeMotion.position.y * geometry.size.height * 0.008)
                    .blendMode(.screen)
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
