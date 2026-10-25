import SwiftUI
#if os(iOS)
import UIKit
#endif

struct NotificationsView: View {
    @Environment(NotificationStore.self) private var notifications
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        @Bindable var settings = notifications
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 8) {
                        Text("›").foregroundStyle(BZZYTheme.accent).accessibilityHidden(true)
                        Text("Notifications")
                    }.bzzyFont(20, weight: .semibold)
                    Text(notifications.permission).bzzyFont(14).foregroundStyle(BZZYTheme.secondary)
                    if notifications.authorized {
                        Toggle("Activity alerts", isOn: $settings.alertsEnabled).tint(BZZYTheme.accent).bzzyFont(15)
                    } else if notifications.permission == "Not enabled" {
                        AccentButton(title: "Enable notifications", symbol: "bell") { Task { await notifications.requestPermission() } }
                            .disabled(!notifications.enabled).accessibilityIdentifier("enable-notifications")
                    }
                    #if os(iOS)
                    Button("Open iOS Settings") {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                    }.bzzyFont(13)
                    #endif
                    if notifications.authorized && notifications.alertsEnabled {
                        Button("Test notification") { Task { await notifications.sendTest() } }
                            .bzzyFont(13).accessibilityIdentifier("test-notification")
                    }
                    Text("Private details stay in the app.").bzzyFont(12).foregroundStyle(BZZYTheme.muted)
                    Text(notifications.pushStatus).bzzyFont(11).foregroundStyle(BZZYTheme.muted)
                    if let error = notifications.errorMessage { Text(error).bzzyFont(12).foregroundStyle(BZZYTheme.secondary) }
                }.padding(16)
            }.bzzyScreen().toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark).task { await notifications.refresh() }
    }
}
