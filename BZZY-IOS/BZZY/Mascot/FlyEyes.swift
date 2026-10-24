import SwiftUI
#if BZZY_PREVIEW
import AppKit
#endif

struct FlyEyes: View {
    var mood: FlyMood = .idle
    var interactive = true
    var frozenTime: Double? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var clock = FlyAnimationClock()
    @State private var touchedAt: Date?
    @State private var touchPoint = CGPoint.zero
    @State private var isTouching = false
    @State private var gazeMotion = GazeMotion()
    @State private var isVisible = false

    #if BZZY_PREVIEW
    static var previewShaderURL: URL?
    #endif
    private var shaderLibrary: ShaderLibrary {
        #if BZZY_PREVIEW
        if let url = Self.previewShaderURL { ShaderLibrary(url: url) } else { .default }
        #else
        .default
        #endif
    }
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
        TimelineView(.animation(minimumInterval: 1 / 30,
                                paused: reduceMotion || scenePhase != .active || !isVisible || frozenTime != nil)) { timeline in
            let time = frozenTime ?? clock.elapsed
            let age = isTouching ? 0 : touchedAt.map { timeline.date.timeIntervalSince($0) } ?? 100
            let pose = FlyAnimationPose(time: time, mood: mood, touchAge: age, touch: touchPoint, still: reduceMotion)
            let gaze = frozenTime == nil ? gazeMotion.position : pose.target
            GeometryReader { geometry in
                let imageSize = CGSize(width: geometry.size.width * 1.25, height: geometry.size.width * 0.625)
                ZStack {
                    artwork.resizable().frame(width: imageSize.width, height: imageSize.height)
                        .distortionEffect(shaderLibrary.bzzyFlyMotion(.float2(imageSize), .float2(gaze), .float(time), .float(pose.energy)),
                                          maxSampleOffset: CGSize(width: imageSize.width * 0.06, height: imageSize.height * 0.08),
                                          isEnabled: !reduceMotion && time > 0)
                }.frame(width: geometry.size.width, height: geometry.size.height)
                    .clipped().blendMode(.screen).contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            guard interactive else { return }
                            if !isTouching { BZZYTheme.haptic() }
                            isTouching = true
                            touchPoint = CGPoint(x: min(1, max(-1, (value.location.x / max(1, geometry.size.width) - 0.5) * 2)),
                                                 y: min(1, max(-1, (value.location.y / max(1, geometry.size.height) - 0.5) * 2)))
                        }.onEnded { _ in isTouching = false; touchedAt = Date() })
            }
            .onChange(of: timeline.date) { _, date in
                guard frozenTime == nil, !reduceMotion, isVisible, scenePhase == .active else { return }
                clock.advance(date.timeIntervalSinceReferenceDate)
                gazeMotion.advance(toward: pose.target, time: date.timeIntervalSinceReferenceDate, rapid: pose.scanning)
            }
        }
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false; gazeMotion.pause(); clock.pause(); isTouching = false }
        .onChange(of: scenePhase) { _, _ in gazeMotion.pause(); clock.pause(); isTouching = false }
        .onChange(of: reduceMotion) { _, _ in gazeMotion = GazeMotion(); clock.pause() }
        .aspectRatio(1.6, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("BZZY, your fly companion")
        .accessibilityValue(mood.label)
        .accessibilityAddTraits(interactive ? .isButton : .isImage)
        .accessibilityHint(interactive ? "Touch and move to play" : "")
        .accessibilityAction {
            guard interactive else { return }
            BZZYTheme.haptic(); touchPoint = .zero; touchedAt = Date()
        }
    }
}
