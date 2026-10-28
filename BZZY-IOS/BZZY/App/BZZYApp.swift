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
    @State private var importKind: SharedResourceKind?
    @State private var showConnection = false
    @State private var showHosts = false
    @State private var notificationRoutingNotice: String?
    @State private var hostProfilesReady = false
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
        return AppLaunchMode.allowsPreviewNavigation
        #else
        return false
        #endif
    }

    var body: some View {
        VStack(spacing: 0) {
            if !allowsDemoNavigation && !relay.corePairAuthorized {
                VStack(spacing: 0) {
                    if !relay.hosts.isEmpty { workspaceHeader }
                    ConnectView(required: true)
                    if !relay.hosts.isEmpty { CoreConnectionFooter() }
                }
            } else {
                NavigationStack {
                    VStack(spacing: 0) {
                        workspaceHeader
                        if store.selectedTab == .chat {
                            CoreChatView(store: store)
                        } else if store.selectedTab == .agents {
                            AgentsView(store: store, showCreate: $showCreate)
                        } else {
                            TerminalView(store: store)
                        }
                    }
                    .safeAreaInset(edge: .bottom, spacing: 0) {
                        VStack(spacing: 0) { bottomBar; CoreConnectionFooter() }
                    }
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
            .sheet(item: $importKind) { kind in
                if kind == .agent && !store.showsDemoContent { LiveAgentImportView(store: store).coreAvailabilityGate() }
                else { ImportResourceView(store: store, kind: kind).coreAvailabilityGate() }
            }
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

    private var workspaceHeader: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Text(">_").bzzyFont(15, weight: .semibold).foregroundStyle(BZZYTheme.accent).accessibilityHidden(true)
                Text("BZZY").bzzyFont(18, weight: .bold).foregroundStyle(BZZYTheme.accent)
                if !dynamicTypeSize.isAccessibilitySize {
                    Text("/ " + store.selectedTab.rawValue.lowercased()).bzzyFont(10).foregroundStyle(BZZYTheme.secondary)
                        .accessibilityHidden(true)
                }
                Spacer()
                if store.selectedTab != .chat {
                RoundButton(symbol: "square.and.arrow.down", label: "Import \(store.selectedTab == .agents ? "agent" : "terminal")") {
                    importKind = store.selectedTab == .agents ? .agent : .terminal
                }.accessibilityIdentifier("import-resource").disabled(!allowsDemoNavigation && !relay.coreActionsAvailable)
                }
                if store.selectedTab == .agents {
                    RoundButton(symbol: "plus", label: "Create an agent") { showCreate = true }
                        .accessibilityIdentifier("create-agent").disabled(!allowsDemoNavigation && !relay.coreActionsAvailable)
                }
                RoundButton(symbol: "slider.horizontal.3", label: "Settings") { showSettings = true }
            }
            if !relay.hosts.isEmpty {
                Button { showHosts = true } label: {
                    HStack(spacing: 9) {
                        Image(systemName: "desktopcomputer").bzzyFont(13)
                        Text(relay.hosts.first(where: { $0.id == relay.activeHostID })?.name ?? "Choose computer")
                            .bzzyFont(13, weight: .medium).lineLimit(1)
                        if relay.activeHostID == relay.defaultHostID { Image(systemName: "star.fill").bzzyFont(9) }
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.up.chevron.down").bzzyFont(10, weight: .semibold)
                    }.foregroundStyle(BZZYTheme.accent).padding(.horizontal, 12).frame(minHeight: 44)
                        .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius))
                        .overlay(RoundedRectangle(cornerRadius: BZZYTheme.controlRadius).stroke(BZZYTheme.line, lineWidth: 0.7))
                }.buttonStyle(BZZYPressStyle()).accessibilityIdentifier("host-selector")
                    .accessibilityLabel("Computer")
                    .accessibilityValue(relay.hosts.first(where: { $0.id == relay.activeHostID })?.name ?? "Choose computer")
                    .accessibilityHint("Switch computers, choose a default, or add a computer")
            }
        }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 10)
            .background(BZZYTheme.surface)
            .overlay(alignment: .bottom) { Rectangle().fill(BZZYTheme.line).frame(height: 0.5) }
    }

    private func resetHostNavigation() {
        showCreate = false; showSettings = false; showConnection = false; importKind = nil
        pendingConnectionFromNotification = false
        store.notificationAgentID = nil; store.notificationTerminalID = nil
        navigationID = UUID()
    }

    private func applyMultiHostFixture() {
        #if DEBUG
        guard AppLaunchMode.contains("--ui-testing"), AppLaunchMode.contains("--multi-host-testing") else { return }
        store.selectedTab = .terminal
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
            showSettings = false
            showConnection = false
            store.selectedTab = route == .agents ? .agents : .terminal
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
            if let resource {
                await relay.reconcileNotificationResource(resource, sessionID: sessionID, agentID: agentID)
                guard relay.activeHostID == routingHostID else { return }
                if let agentID, store.hostAgents.contains(where: { $0.id == agentID && $0.sessionID == relay.coreSessionID }) { store.notificationAgentID = agentID }
                else if let sessionID, store.liveTerminals.contains(where: { $0.id == sessionID && $0.id == relay.coreSessionID }) { store.notificationTerminalID = sessionID }
            }
        }
    }

    private var bottomBar: some View {
        HStack(spacing: 4) {
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
                        .background(store.selectedTab == tab ? BZZYTheme.selection : .clear,
                                    in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius))
                }.buttonStyle(.plain)
                    .accessibilityIdentifier("tab-\(tab.rawValue.lowercased())")
                    .disabled(!allowsDemoNavigation && !relay.coreActionsAvailable && tab == .agents)
                    .accessibilityAddTraits(store.selectedTab == tab ? .isSelected : [])
            }
        }.padding(.horizontal, 8).padding(.vertical, 4)
            .background(BZZYTheme.surface)
            .overlay(alignment: .top) { Rectangle().fill(BZZYTheme.line).frame(height: 0.5) }
            .padding(.top, 4)
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
    func body(content: Content) -> some View {
        content.disabled(enabled && !AppLaunchMode.allowsPreviewNavigation && !relay.coreActionsAvailable)
    }
}

private struct CoreConnectionFooter: View {
    @Environment(RelayConnection.self) private var relay
    @State private var checking = false
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            HStack(spacing: 7) {
                Circle().fill(relay.connectionOnline ? BZZYTheme.success : BZZYTheme.danger).frame(width: 6, height: 6)
                Text("CORE").bzzyFont(10, weight: .semibold).foregroundStyle(BZZYTheme.secondary)
                Text(relay.connectionOnline ? "Online" : "Offline").bzzyFont(11, weight: .medium)
                    .accessibilityIdentifier("connection-status-label")
                HostMetricsBar(metrics: relay.connectionOnline ? relay.hostMetrics : nil, status: relay.hostMetricsStatus)
                    .frame(maxWidth: .infinity)
                Button {
                    checking = true
                    Task { await relay.checkConnection(); checking = false }
                } label: {
                    if checking { ProgressView().controlSize(.mini) }
                    else { Image(systemName: "arrow.clockwise").bzzyFont(13) }
                }.frame(minWidth: 44, minHeight: 44).disabled(checking).buttonStyle(.plain).foregroundStyle(BZZYTheme.secondary)
                    .accessibilityIdentifier("refresh-connection")
                    .accessibilityLabel(checking ? "Checking connection" : "Refresh connection")
            }.padding(.horizontal, 16).frame(minHeight: 44).background(BZZYTheme.background)
                .accessibilityElement(children: .contain).accessibilityIdentifier("connection-status")
        }
    }
}

private struct HostMetricsBar: View {
    let metrics: CoreHostMetrics?
    let status: String
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { Text(cpu); Text(memory) }.fixedSize()
            VStack(spacing: 1) { Text(cpu); Text(memory) }
        }.bzzyFont(10, design: .monospaced).foregroundStyle(BZZYTheme.secondary)
            .accessibilityElement(children: .combine).accessibilityIdentifier("host-metrics")
            .accessibilityLabel("Host usage").accessibilityValue(metrics == nil ? status : "\(cpu), \(memory)")
    }
    private var cpu: String { "CPU \(metrics?.hostCPUPercent.map { String(format: "%.0f%%", $0) } ?? "—")" }
    private var memory: String {
        guard let metrics else { return "RAM —" }
        let gib = 1024.0 * 1024 * 1024, total = Double(metrics.memoryTotalBytes) / gib
        return "RAM " + String(format: total >= 10 ? "%.1f/%.0fG" : "%.1f/%.1fG", Double(metrics.memoryUsedBytes) / gib, total)
    }
}
