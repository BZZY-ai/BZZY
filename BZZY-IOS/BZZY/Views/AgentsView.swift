import SwiftUI
import RelayKit

struct AgentsView: View {
    @Environment(RelayConnection.self) private var relay
    @Bindable var store: WorkspaceStore
    @Binding var showCreate: Bool
    @State private var showVoice = false
    @State private var createdAgent: AgentProfile?
    @State private var openedAgent: AgentProfile?
    @State private var editingHostAgent: HostAgentRecord?
    @State private var archivingHostAgent: HostAgentRecord?
    @State private var notificationAgent: HostAgentRecord?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(spacing: 24) {
                    FlyEyes().frame(maxWidth: .infinity).padding(.horizontal, -14)
                    Button { showVoice = true } label: {
                        Label("Talk to BZZY", systemImage: "waveform").bzzyFont(13, weight: .medium)
                    }.buttonStyle(BZZYActionStyle()).accessibilityLabel("Open voice").accessibilityIdentifier("open-voice-chat")
                        .disabled(!AppLaunchMode.allowsPreviewNavigation && !relay.coreActionsAvailable)
                }.frame(maxWidth: .infinity).padding(.top, 32).padding(.bottom, 30)

                if relay.coreAgentsAvailable || !store.hostAgents.isEmpty {
                    VStack(alignment: .leading, spacing: 15) {
                        HStack {
                            Text(relay.coreAgentsAvailable ? "On demand" : "Saved agents · Offline").bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                            Spacer()
                            Button { relay.performHostAction { await relay.refreshCoreAgents() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                                .bzzyFont(12).disabled(!relay.coreActionsAvailable)
                        }
                        if relay.coreAgentsAvailable && !store.hostAgentsConfigured {
                            Text("Configure the default Agents workspace on your host to create agents.").bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                        }
                        ForEach(store.hostAgents) { agent in
                            NavigationLink {
                                HostAgentConversationView(store: store, agent: agent)
                            } label: {
                                HStack(spacing: 15) {
                                    Image(systemName: "square.stack.3d.up").bzzyFont(20).frame(width: 46)
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(agent.name).bzzyFont(15, weight: .medium)
                                        Text("\(agent.provider) · \(agent.model) · \(agent.state)").bzzyFont(11).foregroundStyle(BZZYTheme.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "arrow.up.right").bzzyFont(12)
                                }.padding(.vertical, 15).contentShape(Rectangle())
                            }.buttonStyle(.plain).disabled(!relay.coreActionsAvailable || !relay.coreCatalogReady || relay.coreBusy)
                                .accessibilityIdentifier("host-agent-\(agent.id)")
                                .contextMenu {
                                    Button("Edit") { editingHostAgent = agent }.disabled(!relay.coreActionsAvailable)
                                    Button("Archive", role: .destructive) { archivingHostAgent = agent }.disabled(!relay.coreActionsAvailable)
                                }
                        }
                        if !relay.coreAgentStatus.isEmpty { Text(relay.coreAgentStatus).bzzyFont(12).foregroundStyle(BZZYTheme.amber) }
                        if relay.coreAgentMutationPending {
                            Button("Check saved agent request") { relay.performHostAction { await relay.reconcileCoreAgentCommand() } }.bzzyFont(12)
                            Button("Retry exact saved agent request") { relay.performHostAction { await relay.retryCoreAgentCommand() } }.bzzyFont(12)
                        }
                        if relay.coreSessionAttachmentPending { Button("Cancel pending attachment") { relay.cancelCoreSessionAttachment() }.bzzyFont(12) }
                    }.padding(.bottom, 24)
                } else if !store.showsDemoContent {
                    Text("Agent management is not enabled for this iPhone. Enable it when approving the pairing on your host.")
                        .bzzyFont(12).foregroundStyle(BZZYTheme.secondary).padding(.bottom, 24)
                }
                if !store.agents.isEmpty && !store.showsDemoContent { Text("On-device drafts · Inactive").bzzyFont(11).foregroundStyle(BZZYTheme.muted) }
                VStack(spacing: 0) {
                    ForEach(store.agents) { agent in
                        NavigationLink {
                            ConversationView(store: store, agent: agent)
                        } label: { AgentRow(agent: agent) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("agent-\(agent.name)")
                        if agent.id != store.agents.last?.id {
                            Rectangle().fill(BZZYTheme.line.opacity(0.7)).frame(height: 0.5).padding(.leading, 65)
                        }
                    }
                    if store.agents.isEmpty {
                        VStack(spacing: 8) {
                            AccentButton(title: "New agent", symbol: "plus") { showCreate = true }
                        }.frame(maxWidth: .infinity).padding(.vertical, 30)
                    }
                }
            }.padding(.horizontal, 25).padding(.bottom, 20)
        }.scrollIndicators(.hidden)
            .sheet(isPresented: $showCreate, onDismiss: {
                if let createdAgent { openedAgent = createdAgent; self.createdAgent = nil }
            }) {
                if relay.coreAgentsAvailable { HostAgentEditorView() }
                else if store.showsDemoContent { CreateAgentView(store: store, onCreated: { createdAgent = $0 }) }
                else { AgentAccessRequiredView() }
            }
            .sheet(item: $editingHostAgent) { HostAgentEditorView(agent: $0) }
            .confirmationDialog("Archive this agent? It will stop appearing in the active agent list.", isPresented: Binding(get: { archivingHostAgent != nil }, set: { if !$0 { archivingHostAgent = nil } }), titleVisibility: .visible) {
                if let agent = archivingHostAgent {
                    Button("Archive", role: .destructive) { relay.performHostAction {
                        _ = await relay.mutateCoreAgent("agents.archive", params: ["agentId": .string(agent.id), "expectedRevision": .number(Double(agent.revision))])
                        archivingHostAgent = nil
                    } }
                }
            }
            .voiceChatScreen(isPresented: $showVoice)
            .navigationDestination(item: $openedAgent) { agent in ConversationView(store: store, agent: agent) }
            .navigationDestination(item: $notificationAgent) { agent in HostAgentConversationView(store: store, agent: agent) }
            .onChange(of: store.notificationAgentID) { _, id in
                if let id, let agent = store.hostAgents.first(where: { $0.id == id }) { notificationAgent = agent; store.notificationAgentID = nil }
            }
    }
}

struct AgentRow: View {
    let agent: AgentProfile
    var body: some View {
        HStack(spacing: 15) {
            Image(systemName: agent.symbol).bzzyFont(20, weight: .light)
                .foregroundStyle(BZZYTheme.secondary)
                .frame(width: 46, height: 40)
            Text(agent.name).bzzyFont(15, weight: .medium).foregroundStyle(BZZYTheme.secondary)
            Spacer(minLength: 5)
            Image(systemName: "arrow.up.right").bzzyFont(12, weight: .regular).foregroundStyle(BZZYTheme.muted)
        }.padding(.vertical, 13).contentShape(Rectangle())
    }
}

struct CreateAgentView: View {
    @Bindable var store: WorkspaceStore
    var onCreated: (AgentProfile) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @State private var mode: AgentMode?
    @State private var name = ""
    @State private var purpose = ""
    @State private var symbol = "sparkle"
    @State private var interval = 1
    @State private var unit: AgentSchedule.Unit = .hours
    private let symbols = ["sparkle", "square.stack.3d.up", "waveform.path", "leaf", "book.closed", "terminal"]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    Text("New agent").bzzyFont(26, weight: .medium)
                    if let mode {
                        Button { self.mode = nil } label: {
                            Label(mode.rawValue, systemImage: mode == .scheduled ? "clock.arrow.circlepath" : "bubble.left")
                                .bzzyFont(13).foregroundStyle(BZZYTheme.accent)
                        }.buttonStyle(.plain).accessibilityLabel("Change agent type")
                        configuration(mode)
                    } else {
                        typeChoice(.scheduled, icon: "clock.arrow.circlepath", explanation: "Runs at an interval.")
                        typeChoice(.onDemand, icon: "bubble.left", explanation: "Acts when you ask.")
                    }
                }.padding(25)
            }.bzzyScreen().textFieldStyle(.plain)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                }
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
    }

    private func typeChoice(_ type: AgentMode, icon: String, explanation: String) -> some View {
        Button { mode = type } label: {
            HStack(spacing: 18) {
                Image(systemName: icon).bzzyFont(23, weight: .light).foregroundStyle(BZZYTheme.accent).frame(width: 30)
                VStack(alignment: .leading, spacing: 8) {
                    Text(type.rawValue).bzzyFont(18, weight: .medium).foregroundStyle(BZZYTheme.text)
                    Text(explanation).bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                }
                Spacer()
                Image(systemName: "arrow.right").bzzyFont(13).foregroundStyle(BZZYTheme.muted)
            }.padding(.vertical, 17).panel()
        }.buttonStyle(.plain)
            .accessibilityIdentifier(type == .scheduled ? "agent-type-scheduled" : "agent-type-on-demand")
    }

    @ViewBuilder private func configuration(_ mode: AgentMode) -> some View {
        HStack {
            ForEach(symbols, id: \.self) { item in
                Button { symbol = item } label: {
                    Image(systemName: item).bzzyFont(20)
                        .frame(maxWidth: .infinity).frame(minHeight: 48)
                        .foregroundStyle(symbol == item ? BZZYTheme.accent : BZZYTheme.secondary)
                        .background(symbol == item ? BZZYTheme.accent.opacity(0.1) : BZZYTheme.surface, in: RoundedRectangle(cornerRadius: 14))
                }.buttonStyle(.plain).accessibilityLabel(item.replacingOccurrences(of: ".", with: " "))
                    .accessibilityAddTraits(symbol == item ? .isSelected : [])
            }
        }
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(text: "Name")
            TextField("Name", text: $name).accessibilityIdentifier("agent-name")
                .bzzyFont(16).padding(18).background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: 17))
        }
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(text: mode == .scheduled ? "Task" : "Instructions")
            TextField(mode == .scheduled ? "What should it do each time?" : "What should it help with?", text: $purpose, axis: .vertical)
                .accessibilityIdentifier("agent-purpose").lineLimit(3...6).bzzyFont(15).padding(18)
                .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: 17))
        }
        if mode == .scheduled {
            VStack(alignment: .leading, spacing: 14) {
                Eyebrow(text: "Repeat")
                Stepper("Every \(interval)", value: $interval, in: 1...365)
                    .bzzyFont(15).accessibilityIdentifier("agent-interval")
                Picker("Interval unit", selection: $unit) {
                    ForEach(AgentSchedule.Unit.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented).accessibilityIdentifier("agent-interval-unit")
            }.panel()
        }
        Text(mode == .scheduled ? "Inactive until authorized on your host." : "Starts when you ask. Host authorization required.")
            .bzzyFont(11).foregroundStyle(BZZYTheme.muted)
        AccentButton(title: "Create draft", symbol: "plus") {
            let schedule = mode == .scheduled ? AgentSchedule(interval: interval, unit: unit) : nil
            if let agent = store.createAgent(name: name, purpose: purpose, symbol: symbol, mode: mode, schedule: schedule) {
                onCreated(agent); dismiss()
            }
        }.accessibilityIdentifier("save-agent").disabled(!valid).opacity(valid ? 1 : 0.4)
    }

    private var valid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

private struct AgentAccessRequiredView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Text("Enable Agent management when approving this iPhone on your Core host.")
                .bzzyFont(15).padding(25).frame(maxWidth: .infinity, maxHeight: .infinity).bzzyScreen()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
    }
}

private struct HostAgentConversationView: View {
    @Environment(RelayConnection.self) private var relay
    @Bindable var store: WorkspaceStore
    let agent: HostAgentRecord
    var body: some View {
        ConversationCanvas(store: store, conversationID: agent.sessionID, title: agent.name,
            subtitle: "\(agent.provider) · \(agent.model)", assistantName: agent.name, remoteSession: true)
            .id(agent.sessionID)
            .task(id: agent.id) { await relay.observeCoreAgent(agent.id, sessionID: agent.sessionID) }
    }
}

private struct HostAgentEditorView: View {
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    var agent: HostAgentRecord? = nil
    @State private var name = ""
    @State private var instructions = ""
    @State private var provider = ""
    @State private var model = ""
    @State private var effort = "default"
    @State private var providers: [HostProviderChoice] = []
    @State private var models: [CoreJSONValue] = []
    @State private var catalogSource = ""
    @State private var modelCursor: String?
    @State private var modelHasMore = false
    @State private var revision: Int64 = 0
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    private var efforts: [String] {
        let selected = models.first(where: { $0["id"].string == model })
        return selected?["capabilities"]["supportedEfforts"].array?.compactMap(\.string)
            ?? providers.first(where: { $0.id == provider })?.efforts ?? []
    }
    private var valid: Bool {
        !loading && !saving && relay.coreActionsAvailable && relay.coreAgentsAvailable && relay.coreCatalogReady &&
        (agent != nil || relay.coreAgentsConfigured) && !relay.coreAgentMutationPending &&
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.utf8.count <= 120 &&
        !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && instructions.utf8.count <= 16000 && !provider.isEmpty
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text(agent == nil ? "New agent" : "Edit agent").bzzyFont(28, weight: .medium)
                    Label("On demand", systemImage: "bubble.left").bzzyFont(13).foregroundStyle(BZZYTheme.accent)
                    Text("Scheduling is not available on this host.").bzzyFont(11).foregroundStyle(BZZYTheme.secondary)
                    if loading { ProgressView().tint(BZZYTheme.accent) }
                    TextField("Name", text: $name).bzzyFont(16).panel().accessibilityIdentifier("host-agent-name")
                    TextField("Instructions", text: $instructions, axis: .vertical).lineLimit(5...12).bzzyFont(14).panel()
                        .accessibilityIdentifier("host-agent-instructions")
                    Text("Keep credentials out of instructions. Private account access is authorized on your host.")
                        .bzzyFont(11).foregroundStyle(BZZYTheme.secondary)
                    Picker("Provider", selection: $provider) {
                        if providers.isEmpty { Text("No providers available").tag("") }
                        ForEach(providers) { item in Text(item.name).tag(item.id) }
                    }.pickerStyle(.menu).accessibilityIdentifier("host-agent-provider")
                    Picker("Model", selection: $model) {
                        Text("Provider default").tag("")
                        ForEach(models.compactMap { $0["id"].string }, id: \.self) { id in
                            Text(models.first(where: { $0["id"].string == id })?["name"].string ?? id).tag(id)
                        }
                        if !model.isEmpty && !models.contains(where: { $0["id"].string == model }) { Text(model).tag(model) }
                    }.pickerStyle(.menu).accessibilityIdentifier("host-agent-model")
                    if modelHasMore { Button("Load more models") { relay.performHostAction { await loadMoreModels() } }.bzzyFont(12) }
                    if catalogSource == "manual" || models.isEmpty {
                        TextField("Model ID (optional)", text: $model).bzzyFont(13, design: .monospaced).panel()
                    }
                    Picker("Effort", selection: $effort) {
                        Text("Provider default").tag("default")
                        ForEach(efforts.filter { $0 != "default" }, id: \.self) { Text($0).tag($0) }
                    }.pickerStyle(.menu)
                    if let error { Text(error).bzzyFont(12).foregroundStyle(BZZYTheme.amber) }
                    if !relay.coreAgentStatus.isEmpty { Text(relay.coreAgentStatus).bzzyFont(12).foregroundStyle(BZZYTheme.secondary) }
                    if relay.coreAgentMutationPending {
                        Button("Check saved agent request") { relay.performHostAction { if await relay.reconcileCoreAgentCommand() { dismiss() } } }
                        Button("Retry exact saved agent request") { relay.performHostAction { await relay.retryCoreAgentCommand() } }
                    }
                    AccentButton(title: saving ? "Saving" : agent == nil ? "Create on Core" : "Save on Core", symbol: "checkmark") { relay.performHostAction { await save() } }
                        .disabled(!valid).opacity(valid ? 1 : 0.4).accessibilityIdentifier("host-agent-save")
                }.padding(25)
            }.textFieldStyle(.plain).bzzyScreen()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
            .task { await load() }
            .coreAvailabilityGate()
            .onChange(of: provider) { _, value in
                guard !loading else { return }
                model = ""; effort = "default"
                relay.performHostAction { await loadModels(value) }
            }
    }

    private func load() async {
        loading = true; defer { loading = false }
        let origin = HostActionContext(hostID: relay.activeHostID)
        do {
            let catalog = try await relay.readCoreAgent("agents.providers")
            guard origin.permits(relay.activeHostID), !Task.isCancelled else { return }
            providers = (catalog["providers"].array ?? []).compactMap { item in
                guard let id = item["id"].string, let name = item["name"].string else { return nil }
                return HostProviderChoice(id: id, name: name, efforts: item["supportedEfforts"].array?.compactMap(\.string) ?? [])
            }
            if let agent {
                let detail = try await relay.readCoreAgent("agents.get", fields: ["agentId": agent.id])["agent"]
                guard origin.permits(relay.activeHostID), !Task.isCancelled else { return }
                name = detail["name"].string ?? agent.name; instructions = detail["instructions"].string ?? ""
                provider = detail["provider"].string ?? agent.provider; model = detail["model"].string ?? ""
                effort = detail["effort"].string ?? "default"; revision = detail["revision"].integer ?? Int64(agent.revision)
            } else { provider = providers.first?.id ?? "" }
            if origin.permits(relay.activeHostID), !Task.isCancelled { await loadModels(provider) }
        } catch { self.error = "Agent settings unavailable. Check host access and refresh." }
    }

    private func loadModels(_ id: String) async {
        guard !id.isEmpty else { models = []; return }
        do {
            let catalog = try await relay.readCoreAgentModels(id)
            guard provider == id else { return }
            models = catalog["models"].array ?? []; catalogSource = catalog["source"].string ?? "manual"
            modelHasMore = catalog["hasMore"].bool == true; modelCursor = catalog["nextCursor"].string
        } catch { if provider == id { models = []; catalogSource = "manual" } }
    }

    private func loadMoreModels() async {
        guard modelHasMore, let cursor = modelCursor else { return }
        let requested = provider
        do {
            let page = try await relay.readCoreAgentModels(requested, after: cursor)
            guard provider == requested, modelCursor == cursor else { return }
            models += page["models"].array ?? []
            modelHasMore = page["hasMore"].bool == true; modelCursor = page["nextCursor"].string
        } catch { self.error = "Additional models unavailable. You can keep the current selection." }
    }

    private func save() async {
        guard valid else { return }
        saving = true; defer { saving = false }
        var params: [String: CoreJSONValue] = ["name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
            "instructions": .string(instructions.trimmingCharacters(in: .whitespacesAndNewlines)), "provider": .string(provider),
            "effort": .string(effort)]
        let selectedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        if !selectedModel.isEmpty { params["model"] = .string(selectedModel) }
        if let agent { params["agentId"] = .string(agent.id); params["expectedRevision"] = .number(Double(revision)) }
        if await relay.mutateCoreAgent(agent == nil ? "agents.create" : "agents.update", params: params) { dismiss() }
        else { error = relay.coreAgentStatus.isEmpty ? "Agent changes were not accepted. Refresh before retrying." : relay.coreAgentStatus }
    }
}
private struct HostProviderChoice: Identifiable {
    let id: String
    let name: String
    let efforts: [String]
}
