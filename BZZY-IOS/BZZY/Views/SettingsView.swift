import SwiftUI
import RelayKit

struct SettingsView: View {
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showConnection = false
    @State private var showNotifications = false
    @State private var showDefaults = false
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
                    Button { showDefaults = true } label: {
                        HStack {
                            Label("Models and defaults", systemImage: "slider.horizontal.3").bzzyFont(14)
                            Spacer(); Image(systemName: "chevron.right").bzzyFont(11)
                        }.panel()
                    }.buttonStyle(.plain).disabled(!relay.coreActionsAvailable)
                        .accessibilityIdentifier("model-defaults-settings")
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
                .sheet(isPresented: $showDefaults) { CoreDefaultsEditor() }
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
                    Text(sessionID == nil ? "Models and defaults" : "Conversation model").bzzyFont(27, weight: .medium)
                    Text(sessionID == nil ? "Saved on this computer. Defaults apply to new chats and mode launches." : "Pause, choose a model, then resume your saved goal in this conversation.")
                        .bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                    if sessionID == nil {
                        Picker("Default for", selection: $target) {
                            ForEach(targets, id: \.self) { Text($0 == "cli" ? "CLI chat" : $0 == "core" ? "Core assistant" : $0.capitalized).tag($0) }
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
            } }.padding(25).bzzyScreen()
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
            TextField("Model ID", text: $choice.model).autocorrectionDisabled().bzzyFont(12, design: .monospaced)
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
