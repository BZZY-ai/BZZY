import SwiftUI
#if os(iOS)
import UIKit
#endif

enum BZZYTheme {
    static let background = Color(hex: 0x03090F)
    static let surface = Color(hex: 0x0A151F)
    static let elevated = Color(hex: 0x102331)
    static let accent = Color(hex: 0x24DFFF)
    static let text = Color(hex: 0xEDF5F2)
    static let secondary = Color(hex: 0x94ADB8)
    static let muted = Color(hex: 0x718F9E)
    static let line = Color(hex: 0x1A4354)
    static let amber = Color(hex: 0xE4BD7C)
    static let success = Color(hex: 0x16E09A)
    static let danger = Color(hex: 0xFF526C)
    static let yolo = Color(hex: 0xFF5BBF)

    static func haptic() {
        #if os(iOS)
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        #endif
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 255) / 255,
                  green: Double((hex >> 8) & 255) / 255,
                  blue: Double(hex & 255) / 255, opacity: 1)
    }
}

struct Eyebrow: View {
    let text: String
    var color: Color = BZZYTheme.secondary
    var body: some View {
        Text(text.uppercased())
            .bzzyFont(10, weight: .medium, design: .monospaced)
            .tracking(2.2).foregroundStyle(color)
    }
}

struct RoundButton: View {
    let symbol: String
    let label: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 17, weight: .regular))
                .foregroundStyle(BZZYTheme.accent)
                .frame(width: 44, height: 44)
                .background(BZZYTheme.surface, in: Circle())
                .overlay(Circle().stroke(BZZYTheme.line, lineWidth: 0.5))
        }.buttonStyle(BZZYPressStyle()).accessibilityLabel(label)
    }
}

struct AccentButton: View {
    let title: String
    var symbol: String = "arrow.up.right"
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Text(title).bzzyFont(15, weight: .semibold)
                Spacer()
                Image(systemName: symbol).bzzyFont(14, weight: .semibold)
            }.padding(.horizontal, 20).frame(minHeight: 54)
                .foregroundStyle(BZZYTheme.background)
                .background(BZZYTheme.accent, in: RoundedRectangle(cornerRadius: 18))
        }.buttonStyle(BZZYPressStyle())
    }
}

struct BZZYPressStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(enabled ? configuration.isPressed ? 0.76 : 1 : 0.35)
            .scaleEffect(configuration.isPressed && enabled && !reduceMotion ? 0.98 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct BZZYActionStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        let tone = configuration.role == .destructive ? Color(hex: 0xF28B82) : BZZYTheme.accent
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .multilineTextAlignment(.center)
            .padding(.horizontal, 15).padding(.vertical, 10)
            .frame(minWidth: 44, minHeight: 44)
            .foregroundStyle(tone)
            .background(tone.opacity(configuration.isPressed ? 0.22 : 0.08), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(tone.opacity(configuration.isPressed ? 0.65 : 0.25), lineWidth: 0.8))
            .opacity(enabled ? 1 : 0.35)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

extension View {
    func bzzyFont(_ size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) -> some View {
        modifier(ScaledBZZYFont(size: size, weight: weight, design: design))
    }

    func panel() -> some View {
        self.padding(18).background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(BZZYTheme.line, lineWidth: 0.6))
    }

    func bzzyScreen() -> some View {
        self.background(BZZYTheme.background.ignoresSafeArea())
            .foregroundStyle(BZZYTheme.text).preferredColorScheme(.dark)
            .buttonStyle(BZZYActionStyle())
    }
}

private struct ScaledBZZYFont: ViewModifier {
    @ScaledMetric private var size: CGFloat
    let weight: Font.Weight
    let design: Font.Design

    init(size: CGFloat, weight: Font.Weight, design: Font.Design) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: .body)
        self.weight = weight
        self.design = design
    }

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight, design: design))
    }
}
