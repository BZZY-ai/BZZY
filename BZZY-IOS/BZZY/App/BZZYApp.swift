import SwiftUI
import RelayKit

private enum AppLaunchMode {
    static var allowsPreviewNavigation: Bool {
        #if BZZY_PREVIEW
        return true
        #elseif DEBUG
        return contains("--ui-testing") && !contains("--pairing-gate-testing") && !contains("--core-offline-testing")
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
    @MainActor private static func makeRelay() -> RelayConnection {
        #if DEBUG
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
    @State private var importKind: SharedResourceKind?
    @State private var showConnection = false
    @State private var pendingConnectionFromNotification = false
    @State private var navigationID = UUID()
    @Environment(\.scenePhase) private var scenePhase

    init(store: WorkspaceStore, relay: RelayConnection? = nil, notifications: NotificationStore? = nil) {
        self.store = store
        self._relay = State(initialValue: relay ?? RelayConnection())
        self._notifications = State(initialValue: notifications ?? NotificationStore())
    }
    @State private var showSettings = false
    @State private var showCreate = false
    @State private var storageNoticeDismissed = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var allowsDemoNavigation: Bool {
        #if BZZY_PREVIEW
        return true
        #elseif DEBUG
        return CommandLine.arguments.contains("--ui-testing") && !CommandLine.arguments.contains("--pairing-gate-testing") && !CommandLine.arguments.contains("--core-offline-testing")
        #else
        return false
        #endif
    }

    var body: some View {
        Group {
            if !allowsDemoNavigation && !relay.corePairAuthorized {
                ConnectView(required: true)
            } else {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Text(store.selectedTab.rawValue).bzzyFont(22, weight: .medium)
                    Spacer()
                    RoundButton(symbol: "square.and.arrow.down", label: "Import \(store.selectedTab == .agents ? "agent" : "terminal")") {
                        importKind = store.selectedTab == .agents ? .agent : .terminal
                    }.accessibilityIdentifier("import-resource")
                    if store.selectedTab == .agents {
                        RoundButton(symbol: "plus", label: "Create an agent") { showCreate = true }
                            .accessibilityIdentifier("create-agent")
                    }
                    RoundButton(symbol: "slider.horizontal.3", label: "Settings") { showSettings = true }
                }.padding(.horizontal, 25).padding(.top, 10).padding(.bottom, 8)

                if relay.coreActionsAvailable {
                    HostMetricsBar(metrics: relay.hostMetrics, status: relay.hostMetricsStatus)
                        .padding(.horizontal, 25).padding(.bottom, 8)
                }

                if store.selectedTab == .agents {
                    AgentsView(store: store, showCreate: $showCreate)
                } else {
                    TerminalView(store: store)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
            .bzzyScreen()
            .toolbar(.hidden)
            .sheet(isPresented: $showSettings, onDismiss: {
                if pendingConnectionFromNotification {
                    pendingConnectionFromNotification = false
                    showConnection = true
                }
            }) { SettingsView() }
            .sheet(isPresented: $showConnection) { ConnectView() }
            .sheet(item: $importKind) { kind in
                if kind == .agent && !store.showsDemoContent { LiveAgentImportView(store: store).coreAvailabilityGate() }
                else { ImportResourceView(store: store, kind: kind).coreAvailabilityGate() }
            }
            .alert("Local storage", isPresented: Binding(get: { store.storageError != nil && !storageNoticeDismissed }, set: { if !$0 { storageNoticeDismissed = true } })) {
                Button("OK") { storageNoticeDismissed = true }
            } message: { Text(store.storageError ?? "") }
        }
        .coreAvailabilityGate(enabled: !allowsDemoNavigation)
            }
        }.id(navigationID).environment(relay).environment(notifications).environment(transfers)
            .tint(BZZYTheme.accent).preferredColorScheme(.dark)
            .task {
                relay.onNotice = { kind in Task { await notifications.hostNotice(kind) } }
                relay.onCoreSnapshot = { store.applyLiveSnapshot($0) }
                relay.onCoreEvents = { store.applyLiveEvents($0) }
                relay.onCoreAvailability = { store.setLiveAvailability($0, status: $1) }
                relay.onCoreCleared = { store.clearLiveSession() }
                relay.onCoreConversationCleared = { store.clearLiveConversation() }
                relay.onCoreSessions = { store.applyLiveTerminalCatalog($0) }
                relay.onCoreAgents = { store.applyHostAgents($0) }
                relay.onCoreAgentStatus = { store.applyHostAgentStatus($0) }
                navigateFromNotification()
                await notifications.refresh()
                await relay.resume()
                await synchronizePushRegistration()
            }
            .onChange(of: notifications.registrationRevision) { _, _ in Task { await synchronizePushRegistration() } }
            .onChange(of: relay.corePairAuthorized) { _, authorized in
                if authorized { Task { await notifications.refresh(); await synchronizePushRegistration() } }
                else { notifications.hostAuthorizationRemoved() }
            }
            .onChange(of: relay.coreCatalogReady) { _, ready in if ready { Task { await synchronizePushRegistration() } } }
            .onChange(of: notifications.destination) { _, _ in navigateFromNotification() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await notifications.refresh(); await relay.resume(); await synchronizePushRegistration() } }
                else if phase == .background { relay.pause() }
            }
    }

    private func synchronizePushRegistration() async {
        guard notifications.enabled else { return }
        let revision = notifications.registrationRevision
        let connection = "\(relay.hostFingerprint):\(relay.corePairAuthorized):\(relay.coreCatalogReady)"
        let status = await relay.synchronizeCoreNotifications(token: notifications.pushToken,
            environment: notifications.pushEnvironment, enabled: notifications.authorized && notifications.alertsEnabled)
        notifications.hostRegistrationStatus(status)
        let current = "\(relay.hostFingerprint):\(relay.corePairAuthorized):\(relay.coreCatalogReady)"
        if revision != notifications.registrationRevision || connection != current { await synchronizePushRegistration() }
    }

    private func navigateFromNotification() {
        guard let route = notifications.destination else { return }
        let resource = notifications.destinationResource
        let sessionID = notifications.destinationSessionID
        let agentID = notifications.destinationAgentID
        notifications.destination = nil; notifications.destinationResource = nil; notifications.destinationSessionID = nil; notifications.destinationAgentID = nil
        switch route {
        case .agents, .terminal:
            showSettings = false
            showConnection = false
            store.selectedTab = route == .agents ? .agents : .terminal
            navigationID = UUID()
        case .connection:
            if showSettings {
                pendingConnectionFromNotification = true
                showSettings = false
            } else {
                showConnection = true
            }
        }
        Task {
            await relay.refresh()
            if let resource {
                await relay.reconcileNotificationResource(resource, sessionID: sessionID, agentID: agentID)
                if let agentID, store.hostAgents.contains(where: { $0.id == agentID && $0.sessionID == relay.coreSessionID }) { store.notificationAgentID = agentID }
                else if let sessionID, store.liveTerminals.contains(where: { $0.id == sessionID && $0.id == relay.coreSessionID }) { store.notificationTerminalID = sessionID }
            }
        }
    }

    private var bottomBar: some View {
        HStack(spacing: 8) {
            ForEach(WorkspaceTab.allCases, id: \.self) { tab in
                Button {
                    BZZYTheme.haptic()
                    store.selectedTab = tab
                } label: {
                    let layout = dynamicTypeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(spacing: 5))
                        : AnyLayout(HStackLayout(spacing: 10))
                    layout {
                        Image(systemName: tab.symbol).bzzyFont(18, weight: .medium)
                        Text(tab.rawValue).bzzyFont(13, weight: .medium).lineLimit(1)
                    }.frame(maxWidth: .infinity).frame(minHeight: 52)
                        .padding(.vertical, dynamicTypeSize.isAccessibilitySize ? 8 : 0)
                        .foregroundStyle(store.selectedTab == tab ? BZZYTheme.accent : BZZYTheme.secondary)
                        .background(store.selectedTab == tab ? BZZYTheme.accent.opacity(0.09) : .clear,
                                    in: RoundedRectangle(cornerRadius: 19))
                }.buttonStyle(.plain)
                    .accessibilityIdentifier("tab-\(tab.rawValue.lowercased())")
                    .accessibilityAddTraits(store.selectedTab == tab ? .isSelected : [])
            }
        }.padding(6)
            .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: 25))
            .overlay(RoundedRectangle(cornerRadius: 25).stroke(BZZYTheme.line, lineWidth: 0.7))
            .padding(.horizontal, 25).padding(.top, 10).padding(.bottom, 9)
            .background(BZZYTheme.background)
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
    @State private var showConnection = false
    @State private var showSettings = false
    private var locked: Bool { enabled && !AppLaunchMode.allowsPreviewNavigation && !relay.coreActionsAvailable }

    func body(content: Content) -> some View {
        ZStack {
            content.opacity(locked ? 0 : 1).disabled(locked)
                .allowsHitTesting(!locked).accessibilityHidden(locked)
            if locked {
                VStack(spacing: 22) {
                    Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                        .font(.system(size: 38, weight: .light)).foregroundStyle(BZZYTheme.accent)
                    Text(relay.coreConnectionLabel).bzzyFont(28, weight: .medium)
                        .accessibilityIdentifier("core-offline-status")
                    Text("Start BZZY Core on your computer to continue.")
                        .bzzyFont(14).foregroundStyle(BZZYTheme.secondary).multilineTextAlignment(.center)
                    Text(relay.status == .connected ? "Relay connected · Core connection required" : "Relay disconnected · Core connection required")
                        .bzzyFont(11).foregroundStyle(BZZYTheme.muted).multilineTextAlignment(.center)
                    HStack(spacing: 24) {
                        Label("Agents locked", systemImage: "lock").accessibilityIdentifier("offline-agents")
                        Label("Terminal locked", systemImage: "lock").accessibilityIdentifier("offline-terminal")
                    }.bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                    Text("Your pairing and saved history are kept.").bzzyFont(11).foregroundStyle(BZZYTheme.muted)
                    Button("Reconnect") { Task { await relay.resume(); await relay.refresh() } }
                        .bzzyFont(15).disabled(!relay.networkingEnabled || relay.status == .connecting)
                        .accessibilityIdentifier("core-reconnect")
                    HStack(spacing: 28) {
                        Button("Connection") { showConnection = true }
                        Button("Settings") { showSettings = true }
                    }.bzzyFont(13)
                }.padding(30).frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(BZZYTheme.background).accessibilityIdentifier("core-offline-lock")
            }
        }
        .sheet(isPresented: $showConnection) { ConnectView().disabled(false) }
        .sheet(isPresented: $showSettings) { SettingsView().disabled(false) }
    }
}

private struct HostMetricsBar: View {
    let metrics: CoreHostMetrics?
    let status: String
    var body: some View {
        HStack(spacing: 12) {
            if let metrics {
                Text("Host CPU \(metrics.hostCPUPercent.map { String(format: "%.0f%%", $0) } ?? "Warming up")")
                Text("RAM \(ByteCountFormatter.string(fromByteCount: metrics.memoryUsedBytes, countStyle: .memory))/\(ByteCountFormatter.string(fromByteCount: metrics.memoryTotalBytes, countStyle: .memory))")
                Spacer(minLength: 0)
                Text(metrics.sampledAt, style: .relative).foregroundStyle(BZZYTheme.muted)
            } else {
                Text(status)
                Spacer(minLength: 0)
            }
        }.bzzyFont(10, design: .monospaced).foregroundStyle(BZZYTheme.secondary)
            .accessibilityElement(children: .combine).accessibilityIdentifier("host-metrics")
    }
}
