import SwiftUI
import RelayKit

struct SettingsView: View {
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showConnection = false
    @State private var showNotifications = false
    @State private var showDefaults = false
    @State private var showVoice = false
    @State private var confirmUpdate = false
    @State private var updateTarget: String?
    @AppStorage(SpeechLanguage.recognitionKey, store: SpeechLanguage.preferences) private var recognitionLanguage = SpeechLanguage.preferred.rawValue
    @AppStorage(SpeechLanguage.synthesisKey, store: SpeechLanguage.preferences) private var synthesisLanguage = SpeechLanguage.preferred.rawValue
    @Environment(NotificationStore.self) private var notifications

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if BZZYTheme.showsMascot {
                        FlyEyes(interactive: false).frame(width: 100).frame(maxWidth: .infinity).padding(.top, 10)
                    }
                    SheetTitle(title: "Settings")
                    Button { showConnection = true } label: {
                        HStack(spacing: 14) {
                            IconTile(symbol: "desktopcomputer", tint: relay.coreActionsAvailable ? BZZYTheme.success : BZZYTheme.accent, size: 44)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(relay.hosts.first(where: { $0.id == relay.activeHostID })?.name ?? "Computer").bzzyFont(16, weight: .semibold)
                                Text(relay.corePairAuthorized ? relay.coreConnectionLabel : relay.hostStatus).bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(BZZYTheme.muted)
                        }.padding(14).hiveCard().contentShape(Rectangle())
                    }.buttonStyle(BZZYCardStyle()).accessibilityIdentifier("connection-settings")
                    section("General")
                    VStack(spacing: 0) {
                        Button { showNotifications = true } label: {
                            settingsRow("bell.fill", "Notifications", value: notifications.permission, tint: BZZYTheme.danger)
                        }.buttonStyle(BZZYCardStyle()).accessibilityIdentifier("notification-settings")
                        rowDivider
                        Button { showDefaults = true } label: {
                            settingsRow("cpu", "Models and defaults", tint: BZZYTheme.agent)
                        }.buttonStyle(BZZYCardStyle()).disabled(!relay.coreActionsAvailable)
                            .accessibilityIdentifier("model-defaults-settings")
                    }.hiveCard()
                    section("Voice")
                    VStack(alignment: .leading, spacing: 0) {
                        Button { showVoice = true } label: {
                            settingsRow("waveform", "Open voice chat", tint: BZZYTheme.user)
                        }.buttonStyle(BZZYCardStyle()).disabled(!AppLaunchMode.allowsPreviewNavigation && !relay.coreActionsAvailable)
                            .accessibilityIdentifier("open-voice-chat")
                        rowDivider
                        VStack(alignment: .leading, spacing: 16) {
                            languagePicker("Listening language · STT", selection: $recognitionLanguage, identifier: "speech-recognition-language")
                            languagePicker("Speaking voice · TTS", selection: $synthesisLanguage, identifier: "speech-synthesis-language")
                        }.padding(14)
                    }.hiveCard()
                    section("BZZY Updates")
                    VStack(alignment: .leading, spacing: 14) {
                        HStack(alignment: .top, spacing: 12) {
                            IconTile(symbol: "arrow.down.circle.fill", tint: BZZYTheme.success, size: 34)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(relay.coreUpdateStatus).bzzyFont(13).foregroundStyle(BZZYTheme.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                                if let target = relay.coreUpdateSnapshot?["target"].string, relay.coreUpdateSnapshot?["available"].bool == true {
                                    Text("Version " + String(target.prefix(8))).bzzyFont(12, weight: .semibold, design: .monospaced).foregroundStyle(BZZYTheme.accent)
                                }
                            }
                        }
                        if let snapshot = relay.coreUpdateSnapshot {
                            Toggle("Monitor updates", isOn: updatePreference("monitoringEnabled")).bzzyFont(14)
                            Toggle("Notify this iPhone", isOn: updatePreference("notificationsEnabled")).bzzyFont(14)
                            Toggle("Allow updates from this iPhone", isOn: updatePreference("remoteUpdatesEnabled")).bzzyFont(14)
                            if let blocked = snapshot["blocked"].string { Text(blocked).bzzyFont(12).foregroundStyle(BZZYTheme.secondary) }
                        }
                        HStack(spacing: 10) {
                            Button("Check now") { relay.performHostAction { await relay.refreshCoreUpdates(checkNow: true) } }
                                .accessibilityIdentifier("check-bzzy-updates")
                            Button(relay.coreUpdatePending ? "Retry accepted update" : "Update CLI and Core") { updateTarget = relay.coreUpdatePendingTarget ?? relay.coreUpdateSnapshot?["target"].string; confirmUpdate = true }
                                .disabled(!relay.coreUpdatePending && relay.coreUpdateSnapshot?["canInstall"].bool != true)
                                .accessibilityIdentifier("install-bzzy-update")
                        }
                        Text("Updating pauses running work. Core reconnects when installation finishes.").bzzyFont(11).foregroundStyle(BZZYTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }.tint(BZZYTheme.accent).frame(maxWidth: .infinity, alignment: .leading).panel().disabled(!relay.coreActionsAvailable || relay.coreUpdateBusy)
                    section("Privacy")
                    VStack(alignment: .leading, spacing: 0) {
                        setting("lock.shield.fill", "Credentials", "Credentials stay on your host.")
                        rowDivider
                        setting("hand.raised.fill", "Permissions", "No permissions granted.")
                        rowDivider
                        setting("figure.walk.motion", "Motion", reduceMotion ? "Reduce Motion enabled." : "Follows system settings.")
                        rowDivider
                        setting("qrcode", "Sharing", "QR or expiring code. Relay required.")
                    }.hiveCard()
                    Text("BZZY · Native iOS")
                        .bzzyFont(10, design: .monospaced).foregroundStyle(BZZYTheme.muted)
                        .frame(maxWidth: .infinity).padding(.top, 14)
                }.padding(16)
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
                .sheet(isPresented: $showDefaults) { CoreDefaultsEditor() }
                .sheet(isPresented: $showNotifications) { NotificationsView() }
                .voiceChatScreen(isPresented: $showVoice)
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
    }
    private var rowDivider: some View {
        Rectangle().fill(BZZYTheme.line).frame(height: 0.5).padding(.leading, 60)
    }
    private func section(_ title: String) -> some View {
        Eyebrow(text: title).padding(.top, 14).padding(.leading, 4)
    }
    private func settingsRow(_ icon: String, _ title: String, value: String? = nil, tint: Color) -> some View {
        HStack(spacing: 12) {
            IconTile(symbol: icon, tint: tint, size: 34)
            Text(title).bzzyFont(15, weight: .medium).foregroundStyle(BZZYTheme.text)
            Spacer(minLength: 8)
            if let value { Text(value).bzzyFont(13).foregroundStyle(BZZYTheme.secondary).lineLimit(1) }
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(BZZYTheme.muted)
        }.padding(.horizontal, 14).frame(minHeight: 54).contentShape(Rectangle())
    }
    private func languagePicker(_ label: String, selection: Binding<String>, identifier: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(label).bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
            Picker(label, selection: selection) {
                ForEach(SpeechLanguage.allCases) { Text($0.name).tag($0.rawValue) }
            }.pickerStyle(.segmented).labelsHidden().accessibilityIdentifier(identifier)
        }
    }
    private func updatePreference(_ key: String) -> Binding<Bool> {
        Binding(get: { relay.coreUpdateSnapshot?[key].bool ?? false }, set: { value in
            relay.performHostAction { await relay.configureCoreUpdates([key: .bool(value)]) }
        })
    }
    private func setting(_ icon: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            IconTile(symbol: icon, tint: BZZYTheme.accent, size: 34)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).bzzyFont(14, weight: .semibold)
                Text(text).bzzyFont(12).foregroundStyle(BZZYTheme.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }.padding(14)
    }
}

private struct DefaultModelChoice: Equatable {
    var provider = ""
    var model = ""
    var effort = "default"
    init(_ value: CoreJSONValue = .null) {
        provider = value["provider"].string ?? ""
        model = value["model"].string ?? ""
        effort = value["effort"].string ?? "default"
    }
    var json: CoreJSONValue { .object(["provider": .string(provider), "model": model.isEmpty ? .null : .string(model), "effort": .string(effort)]) }
}

struct CoreDefaultsEditor: View {
    var sessionID: String? = nil
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    @State private var target = "cli"
    @State private var snapshot: CoreJSONValue = .null
    @State private var providers: [CoreJSONValue] = []
    @State private var choices = [DefaultModelChoice()]
    @State private var revision = ""
    @State private var origin: String?
    @State private var busy = false
    @State private var message = ""
    @State private var pendingID: String?
    private let targets = ["cli", "core", "besties", "parallel", "debate", "delegate"]
    private var available: Bool { relay.coreActionsAvailable && origin == relay.activeHostID }
    var body: some View {
        NavigationStack {
            ScrollView { VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 22) {
                    SheetTitle(title: sessionID == nil ? "Models and defaults" : "Conversation model",
                               subtitle: sessionID == nil ? "Saved on this computer. Defaults apply to new chats and mode launches." : "Pause, choose a model, then resume your saved goal in this conversation.")
                    if sessionID == nil {
                        Picker("Default for", selection: $target) {
                            ForEach(targets, id: \.self) { Text($0 == "cli" ? "CLI chat" : $0 == "core" ? "Core assistant" : $0 == "debate" ? "Validate" : $0.capitalized).tag($0) }
                        }.pickerStyle(.menu).accessibilityIdentifier("defaults-target")
                        if !["cli", "core", "delegate"].contains(target) {
                            Stepper("Agents: \(choices.count)", value: Binding(get: { choices.count }, set: { count in
                                if count > choices.count { choices.append(DefaultModelChoice()) }
                                else { choices = Array(choices.prefix(count)) }
                            }), in: 2...3).bzzyFont(14)
                        }
                    }
                    ForEach(choices.indices, id: \.self) { index in
                        VStack(alignment: .leading, spacing: 12) {
                            Text(target == "delegate" && sessionID == nil ? (index == 0 ? "Supervisor" : "Executor") : choices.count == 1 ? "Model selection" : "Agent \(index + 1)").bzzyFont(14, weight: .medium)
                            DefaultModelFields(choice: $choices[index], providers: providers)
                        }.panel()
                    }
                    if !message.isEmpty { Text(message).bzzyFont(12).foregroundStyle(BZZYTheme.secondary).accessibilityIdentifier("defaults-status") }
                }.disabled(busy || pendingID != nil || !available)
                VStack(spacing: 16) {
                    AccentButton(title: pendingID == nil ? "Save on Core" : "Retry same save", symbol: "checkmark") {
                        relay.performHostAction { await save() }
                    }.disabled(busy || !available || revision.isEmpty || choices.contains(where: { $0.provider.isEmpty }))
                        .accessibilityIdentifier("save-model-defaults")
                    Button("Reload saved settings") { relay.performHostAction { await load() } }.disabled(busy || !available)
                }.padding(.top, 20)
            } }.padding(16).bzzyScreen()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
            .task { origin = relay.activeHostID; await load() }
            .onChange(of: target) { _, _ in selectTarget() }
            .coreAvailabilityGate()
    }
    private func selectTarget() {
        let value = snapshot["defaults"][target]
        let saved = ["cli", "core"].contains(target) ? (value == .null ? [] : [value]) : value.array ?? []
        choices = saved.isEmpty ? Array(repeating: DefaultModelChoice(), count: ["cli", "core"].contains(target) ? 1 : 2) : saved.map(DefaultModelChoice.init)
        pendingID = nil; message = ""
    }
    private func load() async {
        guard available else { return }
        busy = true; defer { busy = false }
        do {
            let catalog = try await relay.readCoreSettings("settings.providers")
            guard available else { return }
            providers = catalog["providers"].array ?? []
            if let sessionID {
                let session = try await relay.readCoreSessionSelection(sessionID: sessionID)
                guard available else { return }
                choices = [DefaultModelChoice(.object(["provider": session["provider"], "model": session["model"], "effort": session["selectedEffort"]]))]
                revision = session["updatedAt"].string ?? ""
            } else {
                let result = try await relay.readCoreSettings()
                guard available else { return }
                snapshot = result; revision = result["revision"].string ?? ""; selectTarget()
            }
            pendingID = nil; message = ""
        } catch { if available { message = error.localizedDescription } }
    }
    private func save() async {
        guard available else { return }
        busy = true; defer { busy = false }
        if let sessionID {
            if await relay.changeCoreSessionSelection(choices[0].json, revision: revision, sessionID: sessionID) { dismiss() }
            else { message = "Save was not confirmed. Check conversation activity and reload before editing again." }
        } else {
            let id = pendingID ?? CoreRelayClient.commandID(); pendingID = id
            do {
                let result = try await relay.saveCoreDefaults(target: target, revision: revision, agents: choices.map(\.json), requestID: id)
                guard available else { return }
                snapshot = result; revision = result["revision"].string ?? ""; pendingID = nil
                message = "Default saved on Core."
            } catch {
                guard available else { return }
                if let code = (error as? CoreApplicationError)?.code, ["CONFLICT", "INVALID_REQUEST", "FORBIDDEN", "OPERATION_DENIED"].contains(code) {
                    pendingID = nil; revision = ""; message = "Settings changed or were rejected. Reload before saving."
                } else { message = "Save not confirmed. Retry the same save or reload Core’s saved settings." }
            }
        }
    }
}

private struct DefaultModelFields: View {
    @Binding var choice: DefaultModelChoice
    let providers: [CoreJSONValue]
    @Environment(RelayConnection.self) private var relay
    @State private var models: [CoreJSONValue] = []
    @State private var next: String?
    @State private var loading = false
    @State private var catalogMessage = ""
    private var efforts: [String] {
        models.first(where: { $0["id"].string == choice.model })?["capabilities"]["supportedEfforts"].array?.compactMap(\.string)
        ?? providers.first(where: { $0["id"].string == choice.provider })?["supportedEfforts"].array?.compactMap(\.string) ?? []
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Provider", selection: Binding(get: { choice.provider }, set: { choice.provider = $0; choice.model = ""; choice.effort = "default" })) {
                Text("Choose provider").tag("")
                ForEach(providers.compactMap { $0["id"].string }, id: \.self) { id in
                    Text(providers.first(where: { $0["id"].string == id })?["name"].string ?? id).tag(id)
                }
            }.pickerStyle(.menu)
            Picker("Model", selection: $choice.model) {
                Text("Provider default").tag("")
                ForEach(models.compactMap { $0["id"].string }, id: \.self) { Text($0).tag($0) }
                if !choice.model.isEmpty && !models.contains(where: { $0["id"].string == choice.model }) { Text(choice.model).tag(choice.model) }
            }.pickerStyle(.menu)
            TextField("Model ID", text: $choice.model).autocorrectionDisabled().bzzyFont(13, design: .monospaced).textFieldStyle(.plain).hiveField()
            Picker("Effort", selection: $choice.effort) {
                Text("Provider default").tag("default")
                ForEach(Array(Set(efforts + (choice.effort == "default" ? [] : [choice.effort]))).sorted(), id: \.self) { Text($0).tag($0) }
            }.pickerStyle(.menu)
            if loading { ProgressView() }
            if next != nil { Button("Load more models") { relay.performHostAction { await load(more: true) } }.disabled(loading) }
            if !catalogMessage.isEmpty { Text(catalogMessage).bzzyFont(11).foregroundStyle(BZZYTheme.secondary) }
        }.task(id: choice.provider) { await load() }
    }
    private func load(more: Bool = false) async {
        let provider = choice.provider, origin = relay.activeHostID
        guard !provider.isEmpty else { models = []; next = nil; return }
        loading = true; defer { if choice.provider == provider { loading = false } }
        if !more { models = []; next = nil }
        var params: [String: CoreJSONValue] = ["provider": .string(provider), "limit": .number(25)]
        if more, let next { params["after"] = .string(next) }
        do {
            let result = try await relay.readCoreSettings("settings.models", params: params)
            guard origin == relay.activeHostID, provider == choice.provider, !Task.isCancelled else { return }
            let page = result["models"].array ?? []
            models = more ? models + page : page
            next = result["hasMore"].bool == true ? result["nextCursor"].string : nil
            catalogMessage = result["source"].string == "manual" ? "Catalog unavailable. You can enter a model ID." : ""
        } catch { if origin == relay.activeHostID && provider == choice.provider { catalogMessage = "Catalog unavailable. You can enter a model ID." } }
    }
}
