import SwiftUI
import RelayKit

struct SettingsView: View {
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showConnection = false
    @State private var showNotifications = false
    @Environment(NotificationStore.self) private var notifications

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    FlyEyes(interactive: false).frame(width: 100).frame(maxWidth: .infinity).padding(.top, 10)
                    Text("Settings").bzzyFont(32, weight: .medium).tracking(-1)
                    Eyebrow(text: "Connection")
                    Button { showConnection = true } label: {
                        HStack(spacing: 14) {
                            Image(systemName: "desktopcomputer").bzzyFont(22, weight: .light).foregroundStyle(BZZYTheme.accent)
                            VStack(alignment: .leading, spacing: 7) {
                                Text("Home host").bzzyFont(14, weight: .medium)
                                Text(relay.corePairAuthorized ? relay.coreConnectionLabel : relay.hostStatus).bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").bzzyFont(12).foregroundStyle(BZZYTheme.muted)
                        }.panel()
                    }.buttonStyle(.plain)
                    Button { showNotifications = true } label: {
                        HStack {
                            Label("Notifications", systemImage: "bell").bzzyFont(14)
                            Spacer()
                            Text(notifications.permission).bzzyFont(11).foregroundStyle(BZZYTheme.secondary)
                            Image(systemName: "chevron.right").bzzyFont(11)
                        }.panel()
                    }.buttonStyle(.plain).accessibilityIdentifier("notification-settings")
                    Eyebrow(text: "Privacy")
                    VStack(alignment: .leading, spacing: 22) {
                        setting("lock.shield", "Credentials", "Credentials stay on your host.")
                        setting("hand.raised", "Permissions", "No permissions granted.")
                        setting("figure.walk.motion", "Motion", reduceMotion ? "Reduce Motion enabled." : "Follows system settings.")
                        setting("qrcode", "Sharing", "QR or expiring code. Relay required.")
                    }
                    Text("BZZY · Native iOS")
                        .bzzyFont(9, design: .monospaced).foregroundStyle(BZZYTheme.muted).lineSpacing(5).padding(.top, 12)
                }.padding(25)
            }.bzzyScreen().toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
                .sheet(isPresented: $showConnection) { ConnectView() }
                .sheet(isPresented: $showNotifications) { NotificationsView() }
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
    }
    private func setting(_ icon: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon).bzzyFont(18, weight: .light).foregroundStyle(BZZYTheme.accent).frame(width: 23)
            VStack(alignment: .leading, spacing: 7) {
                Text(title).bzzyFont(14, weight: .medium)
                Text(text).bzzyFont(12).foregroundStyle(BZZYTheme.secondary).lineSpacing(5)
            }
        }
    }
}
