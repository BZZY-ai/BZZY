import SwiftUI
#if os(iOS)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The "hive" look shared with the CLI: near-black surfaces, amber controls,
/// cyan brand eyes. Token names are stable; views reference them by role.
enum BZZYTheme {
    // Retain the artwork and animation for a future appearance choice without
    // constructing the mascot in the current presentation.
    static let showsMascot = false
    static let controlRadius: CGFloat = 12
    static let panelRadius: CGFloat = 16
    static let bubbleRadius: CGFloat = 18
    static let background = Color(hex: 0x0A0D12)
    static let surface = Color(hex: 0x121821)
    static let elevated = Color(hex: 0x1A222D)
    static let selection = Color(hex: 0x2B210E)
    static let accent = Color(hex: 0xFFB224)
    /// Text drawn on a filled accent control.
    static let accentInk = Color(hex: 0x1C1404)
    static let text = Color(hex: 0xECEFF4)
    static let secondary = Color(hex: 0xA3ADBA)
    static let muted = Color(hex: 0x6F7A89)
    static let line = Color(hex: 0x252E3A)
    /// Notices and recoverable problems (historically named amber).
    static let amber = Color(hex: 0xFF9F43)
    static let success = Color(hex: 0x4ADE80)
    static let danger = Color(hex: 0xFF5470)
    static let yolo = Color(hex: 0xFF4FA3)
    static let user = Color(hex: 0x3CD3F0)
    static let userSurface = Color(hex: 0x1E2733)
    static let userText = Color(hex: 0xF2F5F9)
    static let agent = Color(hex: 0xB07CFF)
    static let agentSurface = Color(hex: 0x16121F)
    static let eyes = Color(hex: 0x5CE6FF)

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
    var color: Color = BZZYTheme.muted
    var body: some View {
        Text(text.uppercased())
            .bzzyFont(12, weight: .semibold)
            .tracking(0.6).foregroundStyle(color)
    }
}

/// The title block at the top of a sheet.
struct SheetTitle: View {
    let title: String
    var subtitle: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).bzzyFont(28, weight: .bold).tracking(-0.3)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let subtitle {
                Text(subtitle).bzzyFont(14).foregroundStyle(BZZYTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 4)
    }
}

/// A circular icon control with a 44 pt touch target.
struct RoundButton: View {
    let symbol: String
    let label: String
    var tint: Color = BZZYTheme.text
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            RoundIcon(symbol: symbol, tint: tint)
        }.buttonStyle(BZZYPressStyle()).accessibilityLabel(label)
    }
}

/// The visual of a round toolbar control; usable inside menus and links.
struct RoundIcon: View {
    let symbol: String
    var tint: Color = BZZYTheme.text
    var body: some View {
        Image(systemName: symbol).font(.system(size: 16, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 40, height: 40)
            .background(BZZYTheme.elevated, in: Circle())
            .overlay(Circle().stroke(BZZYTheme.line, lineWidth: 0.6))
            .frame(width: 44, height: 44).contentShape(Rectangle())
    }
}

/// A rounded square holding a symbol, used to lead list rows.
struct IconTile: View {
    let symbol: String
    var tint: Color = BZZYTheme.accent
    var size: CGFloat = 38
    var body: some View {
        Image(systemName: symbol).font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// The primary filled action of a screen.
struct AccentButton: View {
    let title: String
    var symbol: String = "arrow.up.right"
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Text(title).bzzyFont(16, weight: .semibold)
                Spacer()
                Image(systemName: symbol).bzzyFont(14, weight: .bold)
            }.padding(.horizontal, 18).frame(minHeight: 52)
                .foregroundStyle(BZZYTheme.accentInk)
                .background(BZZYTheme.accent, in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius, style: .continuous))
        }.buttonStyle(BZZYPressStyle())
    }
}

/// Compact status capsule: a dot (or activity indicator) and a short label.
struct StatusPill: View {
    let text: String
    let tone: Color
    var active = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: 6) {
            if active && !reduceMotion { PulseDot(color: tone) }
            else { Circle().fill(tone).frame(width: 7, height: 7) }
            Text(text).bzzyFont(12, weight: .semibold).lineLimit(1)
        }.foregroundStyle(tone)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(tone.opacity(0.13), in: Capsule())
    }
}

/// A softly pulsing dot for live work; static when Reduce Motion is on.
struct PulseDot: View {
    let color: Color
    @State private var expanded = false
    var body: some View {
        ZStack {
            Circle().fill(color.opacity(0.35)).frame(width: 13, height: 13)
                .scaleEffect(expanded ? 1 : 0.45).opacity(expanded ? 0 : 1)
            Circle().fill(color).frame(width: 7, height: 7)
        }.frame(width: 13, height: 13)
            .onAppear { withAnimation(.easeOut(duration: 1.2).repeatForever(autoreverses: false)) { expanded = true } }
            .accessibilityHidden(true)
    }
}

/// The BZZY wordmark beside the brand eyes artwork.
struct BrandMark: View {
    var compact = false
    var body: some View {
        HStack(spacing: 8) {
            // The artwork has an opaque black field; screen blending drops it on dark surfaces.
            BZZYArtwork.eyes.resizable().interpolation(.high).scaledToFill()
                .frame(width: compact ? 34 : 40, height: compact ? 20 : 24)
                .scaleEffect(1.55).clipped().blendMode(.screen)
                .accessibilityHidden(true)
            Text("BZZY").font(.system(size: compact ? 17 : 20, weight: .heavy, design: .rounded)).tracking(1.5)
                .foregroundStyle(BZZYTheme.accent)
                .accessibilityAddTraits(.isHeader)
        }
    }
}

enum BZZYArtwork {
    static var eyes: Image {
        #if BZZY_PREVIEW
        if let url = Bundle.module.url(forResource: "eyes", withExtension: "png", subdirectory: "Assets.xcassets/BZZYEyes.imageset"),
           let image = NSImage(contentsOf: url) { return Image(nsImage: image) }
        return Image(systemName: "eye")
        #else
        return Image("BZZYEyes")
        #endif
    }
}

/// Short, human relative times for list metadata ("now", "5m ago", "Oct 12").
enum RelativeTime {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()

    static func date(_ text: String) -> Date? { fractional.date(from: text) ?? plain.date(from: text) }

    static func short(_ date: Date, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "Just now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h ago" }
        if seconds < 7 * 86_400 { return "\(Int(seconds / 86_400))d ago" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

/// Paths from the computer read better with the home folder abbreviated.
enum DisplayPath {
    static func short(_ path: String) -> String {
        for prefix in ["/Users/", "/home/"] where path.hasPrefix(prefix) {
            let rest = path.dropFirst(prefix.count)
            guard let slash = rest.firstIndex(of: "/") else { return "~" }
            return "~" + rest[slash...]
        }
        return path
    }
}

struct BZZYPressStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(enabled ? configuration.isPressed ? 0.7 : 1 : 0.35)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// A list card that dims while pressed instead of scaling the whole row.
struct BZZYCardStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(enabled ? configuration.isPressed ? 0.75 : 1 : 0.45)
            .brightness(configuration.isPressed ? 0.04 : 0)
    }
}

/// Default button look inside BZZY screens: a tinted rounded control.
struct BZZYActionStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        let tone = configuration.role == .destructive ? BZZYTheme.danger : BZZYTheme.accent
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .multilineTextAlignment(.center)
            .padding(.horizontal, 14).padding(.vertical, 9)
            .frame(minWidth: 44, minHeight: 44)
            .foregroundStyle(tone)
            .background(tone.opacity(configuration.isPressed ? 0.24 : 0.12), in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius, style: .continuous))
            .opacity(enabled ? 1 : 0.35)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

extension View {
    func bzzyFont(_ size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) -> some View {
        modifier(ScaledBZZYFont(size: size, weight: weight, design: design))
    }

    func panel() -> some View {
        self.padding(16).hiveCard()
    }

    /// Card surface with a hairline border; an optional tint highlights live state.
    func hiveCard(highlight: Color? = nil, radius: CGFloat = BZZYTheme.panelRadius) -> some View {
        self.background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous)
                .stroke(highlight?.opacity(0.45) ?? BZZYTheme.line, lineWidth: highlight == nil ? 0.6 : 1))
    }

    /// Text input surface used by sheets.
    func hiveField() -> some View {
        self.padding(14)
            .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: BZZYTheme.controlRadius, style: .continuous).stroke(BZZYTheme.line, lineWidth: 0.7))
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
