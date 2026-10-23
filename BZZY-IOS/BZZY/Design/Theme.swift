import SwiftUI
#if os(iOS)
import UIKit
#endif

enum BZZYTheme {
    static let background = Color(hex: 0x030908)
    static let surface = Color(hex: 0x0B1413)
    static let elevated = Color(hex: 0x101D1B)
    static let accent = Color(hex: 0x00E5CB)
    static let text = Color(hex: 0xEDF5F2)
    static let secondary = Color(hex: 0x91A6A1)
    static let muted = Color(hex: 0x728D85)
    static let line = Color(hex: 0x18332D)
    static let amber = Color(hex: 0xE4BD7C)

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
                .foregroundStyle(BZZYTheme.secondary)
                .frame(width: 44, height: 44)
                .background(BZZYTheme.surface, in: Circle())
                .overlay(Circle().stroke(BZZYTheme.line, lineWidth: 0.5))
        }.buttonStyle(.plain).accessibilityLabel(label)
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
        }.buttonStyle(.plain)
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
