import SwiftUI
import RelayKit

enum AppLaunchMode {
    static var allowsPreviewNavigation: Bool {
        #if BZZY_PREVIEW
        return true
        #elseif DEBUG
        return contains("--ui-testing") && !contains("--pairing-gate-testing") && !contains("--core-offline-testing") && !contains("--multi-host-testing")
        #else
        return false
        #endif
    }
    static func contains(_ argument: String) -> Bool {
        #if DEBUG
        return CommandLine.arguments.contains(argument)
        #else
        return false
        #endif
    }
}

#if !BZZY_PREVIEW
@main
struct BZZYApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var appDelegate
    #endif
    @State private var notifications = AppLaunchMode.contains("--ui-testing") && !AppLaunchMode.contains("--ui-notification-testing") ? NotificationStore() : NotificationStore.shared
    @State private var smokeResult = "Checking"
    @State private var store = WorkspaceStore.deviceStore()
    @State private var relay = Self.makeRelay()
    init() {
        #if DEBUG
        if AppLaunchMode.contains("--ui-testing") && AppLaunchMode.contains("--reset-ui-testing") {
            UserDefaults(suiteName: "app.bzzy.ios.voice-tests")?.removePersistentDomain(forName: "app.bzzy.ios.voice-tests")
        }
        #endif
    }
    @MainActor private static func makeRelay() -> RelayConnection {
        #if DEBUG
        if AppLaunchMode.contains("--ui-testing") && AppLaunchMode.contains("--multi-host-testing") {
            let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("BZZY", isDirectory: true)
            let url = folder.appendingPathComponent("multi-host-ui-profiles.json")
            if AppLaunchMode.contains("--reset-ui-testing") { try? FileManager.default.removeItem(at: url) }
            if let preview = try? RelayConnection.multipleHostsOfflinePreview(storageURL: url) { return preview }
        }
        if AppLaunchMode.contains("--ui-testing") && AppLaunchMode.contains("--core-offline-testing"),
           let preview = try? RelayConnection.pairedOfflinePreview() { return preview }
        #endif
        return RelayConnection(networkingEnabled: !AppLaunchMode.contains("--ui-testing") && !AppLaunchMode.contains("--pairing-gate-testing"))
    }
    var body: some Scene {
        WindowGroup {
            WorkspaceView(store: store, relay: relay, notifications: notifications)
                #if DEBUG
                .overlay {
                    if CommandLine.arguments.contains("--relay-smoke-test") {
                        Text(smokeResult).accessibilityIdentifier("relay-smoke-result")
                            .padding().background(.black)
                    }
                }
                .task {
                    guard CommandLine.arguments.contains("--relay-smoke-test") else { return }
                    do {
                        try RelayDiagnostics.checkDeviceStorage()
                        smokeResult = "Keychain verified; checking Relay"
                        _ = try await RelayDiagnostics.checkPublicEndpoint()
                        smokeResult = "Relay and Keychain verified"
                    } catch { smokeResult += ": " + RelayDiagnostics.failureCode(error) }
                }
                #endif
        }
    }
}
#endif

struct WorkspaceView: View {
    @Bindable var store: WorkspaceStore
    @State private var relay: RelayConnection
    @State private var notifications: NotificationStore
    @State private var transfers = DemoTransferStore()
    @State private var showImport = false
    @State private var showConnection = false
    @State private var showHosts = false
    @State private var showSettings = false
    @State private var notificationRoutingNotice: String?
    @State private var hostProfilesReady = false
    @State private var pendingConnectionFromNotification = false
    @State private var navigationID = UUID()
    @State private var storageNoticeDismissed = false
    @Environment(\.scenePhase) private var scenePhase

    init(store: WorkspaceStore, relay: RelayConnection? = nil, notifications: NotificationStore? = nil) {
        self.store = store
        self._relay = State(initialValue: relay ?? RelayConnection())
        self._notifications = State(initialValue: notifications ?? NotificationStore())
    }

    private var allowsDemoNavigation: Bool {
        #if BZZY_PREVIEW
        return true
        #elseif DEBUG
        return AppLaunchMode.allowsPreviewNavigation
        #else
        return false
        #endif
    }

    var body: some View {
        VStack(spacing: 0) {
            if !allowsDemoNavigation && !relay.corePairAuthorized {
                VStack(spacing: 0) {
                    if !relay.hosts.isEmpty { homeHeader(navigable: false) }
                    ConnectView(required: true)
                    if !relay.hosts.isEmpty { CoreConnectionFooter() }
                }
            } else {
                NavigationStack {
                    TerminalView(store: store)
                        .safeAreaInset(edge: .top, spacing: 0) { homeHeader(navigable: true) }
                        .safeAreaInset(edge: .bottom, spacing: 0) { CoreConnectionFooter() }
                        .bzzyScreen()
                        .toolbar(.hidden)
                }
                .id(navigationID)
            }
        }
            .bzzyScreen()
            .sheet(isPresented: $showSettings, onDismiss: {
                if pendingConnectionFromNotification {
                    pendingConnectionFromNotification = false
                    showConnection = true
                }
            }) { SettingsView() }
            .sheet(isPresented: $showConnection) { ConnectView() }
            .sheet(isPresented: $showHosts) { HostPickerView(onSelect: { resetHostNavigation() }) }
            .sheet(isPresented: $showImport) { ImportResourceView(store: store, kind: .terminal).coreAvailabilityGate() }
            .alert("Local storage", isPresented: Binding(get: { store.storageError != nil && !storageNoticeDismissed }, set: { if !$0 { storageNoticeDismissed = true } })) {
                Button("OK") { storageNoticeDismissed = true }
            } message: { Text(store.storageError ?? "") }
            .alert("Choose a computer", isPresented: Binding(get: { notificationRoutingNotice != nil }, set: { if !$0 { notificationRoutingNotice = nil } })) {
                Button("Computers") { notificationRoutingNotice = nil; showHosts = true }
                Button("Cancel", role: .cancel) { notificationRoutingNotice = nil }
            } message: { Text(notificationRoutingNotice ?? "") }
            .environment(relay).environment(notifications).environment(transfers)
            .tint(BZZYTheme.accent).preferredColorScheme(.dark)
            .task {
                relay.onNotice = { kind in Task { await notifications.hostNotice(kind) } }
                relay.onCoreSnapshot = { store.applyLiveSnapshot($0) }
                relay.onCoreEvents = { store.applyLiveEvents($0) }
                relay.onCoreAvailability = { store.setLiveAvailability($0, status: $1) }
                relay.onCoreCleared = { store.clearLiveSession(); resetHostNavigation() }
                relay.onCoreConversationCleared = { store.clearLiveConversation() }
                relay.onCoreSessions = { store.applyLiveTerminalCatalog($0) }
                relay.onCoreAgents = { store.applyHostAgents($0) }
                relay.onCoreAgentStatus = { store.applyHostAgentStatus($0) }
                relay.onCorePresentationRestore = { host, resource, session, grant in
                    store.restoreCachedPresentation(scope: .init(hostID: host, resource: resource, sessionID: session, authorizationID: grant))
                }
                relay.onCorePresentationSave = { host, resource, session, grant in
                    store.cacheLivePresentation(scope: .init(hostID: host, resource: resource, sessionID: session, authorizationID: grant))
                }
                relay.onCorePresentationPurge = { host, grant, session in
                    store.removeCachedPresentation(hostID: host, authorizationID: grant, sessionID: session)
                }
                do {
                    try relay.restoreSavedHosts()
                    hostProfilesReady = true
                    store.retainHostDrafts(Set(relay.hosts.filter(\.isPaired).map(\.id)))
                    store.retainCachedPresentationHosts(Set(relay.hosts.filter(\.isPaired).map(\.id)))
                    applyMultiHostFixture()
                    navigateFromNotification()
                } catch { /* Relay surfaces private-storage failures during resume. */ }
                await notifications.refresh()
                await relay.resume()
                await synchronizePushRegistration()
            }
            .onChange(of: notifications.registrationRevision) { _, _ in Task { await synchronizePushRegistration() } }
            .onChange(of: relay.corePairAuthorized) { _, authorized in
                if authorized { Task { await notifications.refresh(); await synchronizePushRegistration() } }
                else if relay.hosts.isEmpty { notifications.hostAuthorizationRemoved() }
            }
            .onChange(of: relay.activeHostID) { _, _ in applyMultiHostFixture() }
            .onChange(of: relay.hosts.filter(\.isPaired).map(\.id)) { _, ids in
                if hostProfilesReady { store.retainHostDrafts(Set(ids)); store.retainCachedPresentationHosts(Set(ids)) }
            }
            .onChange(of: relay.coreCatalogReady) { _, ready in if ready { Task { await synchronizePushRegistration() } } }
            .onChange(of: notifications.destination) { _, _ in navigateFromNotification() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await notifications.refresh(); await relay.resume(); await synchronizePushRegistration() } }
                else if phase == .background { relay.pause() }
            }
    }

    private var activeHostName: String {
        relay.hosts.first(where: { $0.id == relay.activeHostID })?.name ?? "Choose computer"
    }

    private func homeHeader(navigable: Bool) -> some View {
        VStack(spacing: 12) {
            HStack(spacing: 4) {
                BrandMark()
                Spacer(minLength: 8)
                if navigable {
                    NavigationLink { CoreChatView(store: store) } label: { askCoreLabel }
                        .buttonStyle(BZZYPressStyle())
                        .accessibilityLabel("Ask Core")
                        .accessibilityHint("Read-only questions about your sessions")
                        .accessibilityIdentifier("open-core-chat")
                }
                RoundButton(symbol: "square.and.arrow.down", label: "Import terminal") { showImport = true }
                    .accessibilityIdentifier("import-resource").disabled(!allowsDemoNavigation && !relay.coreActionsAvailable)
                RoundButton(symbol: "gearshape", label: "Settings") { showSettings = true }
            }
            if !relay.hosts.isEmpty { hostSelector }
        }.padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 10)
            .background(BZZYTheme.background)
    }

    private var askCoreLabel: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 7) {
                Image(systemName: "sparkles").font(.system(size: 14, weight: .semibold))
                Text("Ask Core").bzzyFont(14, weight: .semibold).lineLimit(1)
            }.foregroundStyle(BZZYTheme.accent)
                .padding(.horizontal, 14).frame(height: 40)
                .background(BZZYTheme.accent.opacity(0.12), in: Capsule())
                .overlay(Capsule().stroke(BZZYTheme.accent.opacity(0.32), lineWidth: 0.7))
                .frame(minHeight: 44).contentShape(Rectangle()).fixedSize()
            RoundIcon(symbol: "sparkles", tint: BZZYTheme.accent)
        }
    }

    private var hostSelector: some View {
        Button { showHosts = true } label: {
            HStack(spacing: 10) {
                Image(systemName: "desktopcomputer").font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(BZZYTheme.accent)
                Text(activeHostName).bzzyFont(15, weight: .semibold).foregroundStyle(BZZYTheme.text).lineLimit(1)
                if relay.activeHostID == relay.defaultHostID {
                    Image(systemName: "star.fill").font(.system(size: 9, weight: .bold)).foregroundStyle(BZZYTheme.accent)
                        .accessibilityHidden(true)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(BZZYTheme.muted)
            }.padding(.horizontal, 14).frame(minHeight: 46)
                .hiveCard(radius: BZZYTheme.controlRadius + 2)
                .contentShape(Rectangle())
        }.buttonStyle(BZZYPressStyle()).accessibilityIdentifier("host-selector")
            .accessibilityLabel("Computer")
            .accessibilityValue(activeHostName)
            .accessibilityHint("Switch computers, choose a default, or add a computer")
    }

    private func resetHostNavigation() {
        showSettings = false; showConnection = false; showImport = false
        pendingConnectionFromNotification = false
        store.notificationTerminalID = nil
        navigationID = UUID()
    }

    private func applyMultiHostFixture() {
        #if DEBUG
        guard AppLaunchMode.contains("--ui-testing"), AppLaunchMode.contains("--multi-host-testing") else { return }
        guard relay.hosts.first(where: { $0.id == relay.activeHostID })?.name == "Test Mac" else { return }
        let sessionID = "44444444-4444-4444-8444-444444444444"
        let snapshot: [String: Any] = ["session": ["id": sessionID, "alias": "Test only dummy chat", "cwd": "/isolated-ui-fixture", "model": "Fixture"]]
        if let data = try? JSONSerialization.data(withJSONObject: snapshot) { store.applyLiveSnapshot(data) }
        #endif
    }

    private func synchronizePushRegistration() async {
        guard notifications.enabled, notifications.permissionChecked else { return }
        let revision = notifications.registrationRevision
        let token = notifications.pushToken
        let environment = notifications.pushEnvironment
        let registrationEnabled = notifications.authorized && notifications.alertsEnabled
        let connection = "\(relay.activeHostID ?? ""): \(relay.hostFingerprint):\(relay.corePairAuthorized):\(relay.coreCatalogReady)"
        let status = await relay.synchronizeAllCoreNotifications(token: token,
            environment: environment, enabled: registrationEnabled)
        let current = "\(relay.activeHostID ?? ""): \(relay.hostFingerprint):\(relay.corePairAuthorized):\(relay.coreCatalogReady)"
        let currentPlan = revision == notifications.registrationRevision && token == notifications.pushToken
            && environment == notifications.pushEnvironment
            && registrationEnabled == (notifications.authorized && notifications.alertsEnabled)
        if currentPlan && connection == current { notifications.hostRegistrationStatus(status) }
        else { await synchronizePushRegistration() }
    }

    private func navigateFromNotification() {
        guard hostProfilesReady, let route = notifications.destination else { return }
        let resource = notifications.destinationResource
        let sessionID = notifications.destinationSessionID
        let agentID = notifications.destinationAgentID
        let hostID = notifications.destinationHostID
        notifications.destination = nil; notifications.destinationResource = nil; notifications.destinationSessionID = nil; notifications.destinationAgentID = nil
        notifications.destinationHostID = nil
        let matchingHosts = resource.map { relay.notificationHostHintIDs(resource: $0, sessionID: sessionID, agentID: agentID) } ?? []
        let targetHostID = hostID.flatMap { relay.hostProfileID(forNotificationHostID: $0) }
            ?? (hostID == nil ? (matchingHosts.count == 1 ? matchingHosts[0] : relay.hosts.count == 1 ? relay.hosts[0].id : nil) : nil)
        // Legacy hints are ambiguous after a second computer is paired. Never
        // reconcile their resource against whichever computer happens to be open.
        if (hostID != nil || !relay.hosts.isEmpty) && targetHostID == nil {
            notificationRoutingNotice = hostID == nil ? "This alert does not identify one saved computer. Choose its computer to inspect the current state." : "This alert belongs to a computer that is not saved on this iPhone."
            return
        }
        Task {
        showHosts = false
        if let targetHostID, targetHostID != relay.activeHostID {
            resetHostNavigation()
            await relay.activateHost(targetHostID)
        }
        let routingHostID = relay.activeHostID
        guard targetHostID == nil || routingHostID == targetHostID else { return }
        switch route {
        case .agents, .terminal:
            // iPhone lists terminals only; an Agent alert opens the home list.
            showSettings = false
            showConnection = false
            showImport = false
            navigationID = UUID()
        case .updates:
            showConnection = false
            showSettings = true
        case .connection:
            if showSettings {
                pendingConnectionFromNotification = true
                showSettings = false
            } else {
                showConnection = true
            }
        }
            await relay.refresh()
            guard relay.activeHostID == routingHostID else { return }
            if let resource, route == .terminal, agentID == nil {
                await relay.reconcileNotificationResource(resource, sessionID: sessionID)
                guard relay.activeHostID == routingHostID else { return }
                if let sessionID, store.liveTerminals.contains(where: { $0.id == sessionID && $0.id == relay.coreSessionID }) { store.notificationTerminalID = sessionID }
            }
        }
    }
}

extension View {
    func coreAvailabilityGate(enabled: Bool = true) -> some View {
        modifier(CoreAvailabilityGate(enabled: enabled))
    }
}

private struct CoreAvailabilityGate: ViewModifier {
    let enabled: Bool
    @Environment(RelayConnection.self) private var relay
    func body(content: Content) -> some View {
        content.disabled(enabled && !AppLaunchMode.allowsPreviewNavigation && !relay.coreActionsAvailable)
    }
}

private struct CoreConnectionFooter: View {
    @Environment(RelayConnection.self) private var relay
    @State private var checking = false
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let online = relay.connectionOnline
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Circle().fill(online ? BZZYTheme.success : BZZYTheme.danger).frame(width: 7, height: 7)
                        .shadow(color: (online ? BZZYTheme.success : BZZYTheme.danger).opacity(0.6), radius: 3)
                    Text("CORE").bzzyFont(10, weight: .bold).tracking(0.8).foregroundStyle(BZZYTheme.muted)
                    Text(online ? "Online" : "Offline").bzzyFont(12, weight: .semibold)
                        .foregroundStyle(online ? BZZYTheme.text : BZZYTheme.danger)
                        .accessibilityIdentifier("connection-status-label")
                }.fixedSize()
                HostMetricsBar(metrics: online ? relay.hostMetrics : nil, status: relay.hostMetricsStatus)
                    .frame(maxWidth: .infinity)
                Button {
                    checking = true
                    Task { await relay.checkConnection(); checking = false }
                } label: {
                    Group {
                        if checking { ProgressView().controlSize(.mini).tint(BZZYTheme.secondary) }
                        else { Image(systemName: "arrow.clockwise").font(.system(size: 13, weight: .semibold)) }
                    }.frame(width: 44, height: 44).contentShape(Rectangle())
                }.disabled(checking).buttonStyle(BZZYPressStyle()).foregroundStyle(BZZYTheme.secondary)
                    .accessibilityIdentifier("refresh-connection")
                    .accessibilityLabel(checking ? "Checking connection" : "Refresh connection")
            }.padding(.leading, 16).padding(.trailing, 6).frame(minHeight: 46)
                .background(BZZYTheme.surface.ignoresSafeArea(edges: .bottom))
                .overlay(alignment: .top) { Rectangle().fill(BZZYTheme.line).frame(height: 0.5) }
                .accessibilityElement(children: .contain).accessibilityIdentifier("connection-status")
        }
    }
}

private struct HostMetricsBar: View {
    let metrics: CoreHostMetrics?
    let status: String
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) { cpuChip; memoryChip }.fixedSize()
            VStack(alignment: .leading, spacing: 2) { cpuChip; memoryChip }
        }.bzzyFont(10, weight: .medium, design: .monospaced)
            .accessibilityElement(children: .combine).accessibilityIdentifier("host-metrics")
            .accessibilityLabel("Host usage").accessibilityValue(metrics == nil ? status : "\(cpu), \(memory)")
    }
    private var cpuChip: some View { MetricChip(label: "CPU", value: cpuValue, fraction: metrics?.hostCPUPercent.map { $0 / 100 }) }
    private var memoryChip: some View {
        MetricChip(label: "RAM", value: memoryValue,
                   fraction: metrics.flatMap { $0.memoryTotalBytes > 0 ? Double($0.memoryUsedBytes) / Double($0.memoryTotalBytes) : nil })
    }
    private var cpuValue: String { metrics?.hostCPUPercent.map { String(format: "%.0f%%", $0) } ?? "—" }
    private var memoryValue: String {
        guard let metrics else { return "—" }
        let gib = 1024.0 * 1024 * 1024, total = Double(metrics.memoryTotalBytes) / gib
        return String(format: total >= 10 ? "%.1f/%.0fG" : "%.1f/%.1fG", Double(metrics.memoryUsedBytes) / gib, total)
    }
    private var cpu: String { "CPU \(cpuValue)" }
    private var memory: String { "RAM \(memoryValue)" }
}

private struct MetricChip: View {
    let label: String
    let value: String
    let fraction: Double?
    var body: some View {
        HStack(spacing: 5) {
            Text(label).foregroundStyle(BZZYTheme.muted)
            if let fraction {
                let clamped = min(max(fraction, 0), 1)
                Capsule().fill(BZZYTheme.line).frame(width: 24, height: 4)
                    .overlay(alignment: .leading) { Capsule().fill(tone(clamped)).frame(width: max(2, 24 * clamped), height: 4) }
            }
            Text(value).foregroundStyle(BZZYTheme.secondary)
        }
    }
    private func tone(_ value: Double) -> Color {
        value < 0.7 ? BZZYTheme.success : value < 0.9 ? BZZYTheme.amber : BZZYTheme.danger
    }
}
