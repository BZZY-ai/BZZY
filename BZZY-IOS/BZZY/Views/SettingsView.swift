import SwiftUI
import RelayKit

struct SettingsView: View {
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showConnection = false
    @State private var showNotifications = false
    @State private var confirmUpdate = false
    @State private var updateTarget: String?
    @AppStorage(SpeechLanguage.recognitionKey, store: SpeechLanguage.preferences) private var recognitionLanguage = SpeechLanguage.preferred.rawValue
    @AppStorage(SpeechLanguage.synthesisKey, store: SpeechLanguage.preferences) private var synthesisLanguage = SpeechLanguage.preferred.rawValue
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
                                Text(relay.hosts.first(where: { $0.id == relay.activeHostID })?.name ?? "Computer").bzzyFont(14, weight: .medium)
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
                    Eyebrow(text: "Voice")
                    VStack(alignment: .leading, spacing: 20) {
                        languagePicker("Listening language · STT", selection: $recognitionLanguage, identifier: "speech-recognition-language")
                        languagePicker("Speaking voice · TTS", selection: $synthesisLanguage, identifier: "speech-synthesis-language")
                    }.panel()
                    Eyebrow(text: "BZZY Updates")
                    VStack(alignment: .leading, spacing: 16) {
                        Text(relay.coreUpdateStatus).bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                        if let snapshot = relay.coreUpdateSnapshot {
                            if let target = snapshot["target"].string, snapshot["available"].bool == true {
                                Text("Version " + String(target.prefix(8))).bzzyFont(11, design: .monospaced).foregroundStyle(BZZYTheme.accent)
                            }
                            Toggle("Monitor updates", isOn: updatePreference("monitoringEnabled")).bzzyFont(12)
                            Toggle("Notify this iPhone", isOn: updatePreference("notificationsEnabled")).bzzyFont(12)
                            Toggle("Allow updates from this iPhone", isOn: updatePreference("remoteUpdatesEnabled")).bzzyFont(12)
                            if let blocked = snapshot["blocked"].string { Text(blocked).bzzyFont(11).foregroundStyle(BZZYTheme.secondary) }
                        }
                        Button("Check for updates") { relay.performHostAction { await relay.refreshCoreUpdates(checkNow: true) } }
                            .bzzyFont(13).accessibilityIdentifier("check-bzzy-updates")
                        Button(relay.coreUpdatePending ? "Retry accepted update request" : "Update CLI and Core") { updateTarget = relay.coreUpdatePendingTarget ?? relay.coreUpdateSnapshot?["target"].string; confirmUpdate = true }
                            .bzzyFont(13, weight: .medium).foregroundStyle(BZZYTheme.accent)
                            .disabled(!relay.coreUpdatePending && relay.coreUpdateSnapshot?["canInstall"].bool != true)
                            .accessibilityIdentifier("install-bzzy-update")
                        Text("Updating pauses running work. Core reconnects when installation finishes.").bzzyFont(10).foregroundStyle(BZZYTheme.muted)
                    }.panel().disabled(!relay.coreActionsAvailable || relay.coreUpdateBusy)
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
                .task {
                    let origin = HostActionContext(hostID: relay.activeHostID)
                    while !Task.isCancelled && origin.permits(relay.activeHostID) {
                        await relay.refreshCoreUpdates()
                        do { try await Task.sleep(for: .seconds(5)) } catch { return }
                    }
                }
                .confirmationDialog("Update CLI and Core to " + String((updateTarget ?? "checked version").prefix(16)) + "? Running work will be paused.", isPresented: $confirmUpdate, titleVisibility: .visible) {
                    Button("Update CLI and Core") {
                        let target = updateTarget
                        relay.performHostAction { await relay.installCoreUpdate(expectedTarget: target) }
                    }
                    Button("Cancel", role: .cancel) {}
                }
                .sheet(isPresented: $showConnection) {
                    if relay.hosts.isEmpty { ConnectView() }
                    else { HostPickerView() }
                }
                .sheet(isPresented: $showNotifications) { NotificationsView() }
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
    }
    private func languagePicker(_ label: String, selection: Binding<String>, identifier: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(label).bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
            Picker(label, selection: selection) {
                ForEach(SpeechLanguage.allCases) { Text($0.name).tag($0.rawValue) }
            }.pickerStyle(.segmented).accessibilityIdentifier(identifier)
        }
    }
    private func updatePreference(_ key: String) -> Binding<Bool> {
        Binding(get: { relay.coreUpdateSnapshot?[key].bool ?? false }, set: { value in
            relay.performHostAction { await relay.configureCoreUpdates([key: .bool(value)]) }
        })
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
