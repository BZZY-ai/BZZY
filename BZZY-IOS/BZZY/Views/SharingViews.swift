import SwiftUI
import CoreImage.CIFilterBuiltins
import RelayKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

struct ShareResourceView: View {
    let target: ShareTarget
    @Environment(DemoTransferStore.self) private var transfers
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    @State private var mode = ResourceShareMode.portable
    @State private var ticket: DemoShareTicket?
    @State private var error: String?
    @State private var copied = false
    @State private var showConnection = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    Text("Share").bzzyFont(32, weight: .medium).tracking(-1)
                    SharedResourceLabel(kind: target.kind, name: target.name)
                    Picker("Share mode", selection: $mode) {
                        ForEach(ResourceShareMode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.segmented).accessibilityIdentifier("share-mode")

                    if let ticket {
                        demoCode(ticket)
                    } else {
                        VStack(spacing: 0) {
                            SharingDetail(symbol: mode == .portable ? "square.on.square" : "eye",
                                          title: mode == .portable ? "Independent copy" : "View only",
                                          value: mode == .portable ? "Instructions & workflow" : "This workspace only")
                            Divider().overlay(BZZYTheme.line).padding(.vertical, 17)
                            SharingDetail(symbol: mode == .portable ? "person.crop.circle" : "clock",
                                          title: mode == .portable ? "Their own accounts" : "10 minutes",
                                          value: mode == .portable ? "Chats stay private" : "Host approval required")
                        }.panel()

                        VStack(alignment: .leading, spacing: 14) {
                            Text("Sharing requires host support.").bzzyFont(13).foregroundStyle(BZZYTheme.secondary)
                                .accessibilityIdentifier("share-host-required")
                            Button { showConnection = true } label: {
                                Label(relay.hasHost ? "Host connection" : "Connect host", systemImage: "desktopcomputer")
                                    .bzzyFont(13).foregroundStyle(BZZYTheme.accent).frame(minHeight: 44)
                            }.buttonStyle(.plain)
                        }
                        if target.isDemo && mode == .portable {
                            AccentButton(title: "Try demo", symbol: "qrcode") { issueDemo() }
                                .accessibilityIdentifier("share-try-demo")
                            Text("Sample only · Works on this iPhone").bzzyFont(11).foregroundStyle(BZZYTheme.muted)
                        }
                    }
                    if let error { Text(error).bzzyFont(12).foregroundStyle(BZZYTheme.amber).accessibilityIdentifier("sharing-error") }
                }.padding(25)
            }.scrollIndicators(.hidden).bzzyScreen().toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
            .sheet(isPresented: $showConnection) { ConnectView() }
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
            .onChange(of: mode) { _, _ in
                if let ticket { transfers.revoke(ticket) }
                ticket = nil; error = nil; copied = false
            }
    }

    private func demoCode(_ ticket: DemoShareTicket) -> some View {
        VStack(spacing: 22) {
            Eyebrow(text: "Demo · This iPhone only", color: BZZYTheme.accent)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let active = ticket.expiresAt > context.date
                VStack(spacing: 18) {
                    if active {
                        NativeQRCodeView(text: ticket.qrText).frame(maxWidth: 220)
                        Label("Expires " + ticket.expiresAt.formatted(date: .omitted, time: .shortened), systemImage: "clock")
                            .bzzyFont(11).foregroundStyle(BZZYTheme.secondary)
                    } else {
                        Image(systemName: "clock.badge.xmark").font(.system(size: 56, weight: .ultraLight))
                            .foregroundStyle(BZZYTheme.muted).frame(height: 180)
                        Text("Code expired").bzzyFont(14)
                    }
                    if active {
                        Text(ticket.code).bzzyFont(11, design: .monospaced).multilineTextAlignment(.center)
                            .foregroundStyle(BZZYTheme.secondary).fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("share-code")
                        AccentButton(title: copied ? "Copied" : "Copy code", symbol: copied ? "checkmark" : "doc.on.doc") {
                            copyCode(ticket); copied = true
                        }.accessibilityIdentifier("share-copy-code")
                    }
                }
            }
            Text("Paste in Import to add an inactive sample.").bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                .multilineTextAlignment(.center)
            Button("Revoke code") {
                transfers.revoke(ticket); self.ticket = nil; copied = false
            }.bzzyFont(13).foregroundStyle(BZZYTheme.secondary).frame(minHeight: 44)
                .accessibilityIdentifier("share-revoke")
        }.frame(maxWidth: .infinity)
    }

    private func issueDemo() {
        do { ticket = try transfers.issue(target); error = nil; copied = false }
        catch { self.error = error.localizedDescription }
    }
    private func copyCode(_ ticket: DemoShareTicket) {
        #if os(iOS)
        UIPasteboard.general.setItems([["public.utf8-plain-text": ticket.code]], options: [.localOnly: true, .expirationDate: ticket.expiresAt])
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(ticket.code, forType: .string)
        #endif
    }
}

struct ImportResourceView: View {
    @Bindable var store: WorkspaceStore
    let kind: SharedResourceKind
    @Environment(DemoTransferStore.self) private var transfers
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var demo: DemoShareTicket?
    @State private var invitation: RelayShareInvitation?
    @State private var importedName: String?
    @State private var error: String?
    @State private var showScanner = false
    @State private var showConnection = false
    @FocusState private var codeFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 27) {
                    Text(importedName == nil ? "Import \(kind.title.lowercased())" : "Imported")
                        .bzzyFont(32, weight: .medium).tracking(-1)
                    if let importedName {
                        completion(importedName)
                    } else if let demo {
                        demoPreview(demo)
                    } else if let invitation {
                        relayPreview(invitation)
                    } else {
                        entry
                    }
                    if let error {
                        Text(error).bzzyFont(13).foregroundStyle(BZZYTheme.amber).fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("import-error")
                    }
                }.padding(25)
            }.scrollIndicators(.hidden).bzzyScreen().toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
            .sheet(isPresented: $showConnection) { ConnectView() }
            #if os(iOS)
            .sheet(isPresented: $showScanner) {
                ZStack(alignment: .topTrailing) {
                    InvitationScannerView(prefixes: ["BZZY:INVITE:1:", "BZZY:DEMO:1:"], onCode: { raw in
                        showScanner = false; review(raw)
                    }, onError: { error = $0; showScanner = false })
                    Button("Close") { showScanner = false }.padding(20).background(.black.opacity(0.7), in: Capsule()).padding()
                }.ignoresSafeArea(edges: .bottom)
            }
            #endif
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
            .onDisappear { code = "" }
    }

    private var entry: some View {
        VStack(alignment: .leading, spacing: 23) {
            #if os(iOS)
            Button { codeFocused = false; showScanner = true } label: {
                VStack(spacing: 18) {
                    Image(systemName: "qrcode.viewfinder").font(.system(size: 48, weight: .ultraLight))
                    Text("Scan QR").bzzyFont(14, weight: .medium)
                }.foregroundStyle(BZZYTheme.accent).frame(maxWidth: .infinity).padding(.vertical, 34)
                    .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: 24))
                    .overlay(RoundedRectangle(cornerRadius: 24).stroke(BZZYTheme.line, lineWidth: 0.6))
            }.buttonStyle(.plain).accessibilityIdentifier("import-scan")
            #endif
            VStack(alignment: .leading, spacing: 13) {
                Eyebrow(text: "Or paste a code")
                SecureField("BZZY-\(kind.rawValue)-…", text: $code)
                    .textContentType(.oneTimeCode).autocorrectionDisabled().focused($codeFocused)
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .bzzyFont(13, design: .monospaced).padding(18).textFieldStyle(.plain)
                    .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: 17))
                    .overlay(RoundedRectangle(cornerRadius: 17).stroke(BZZYTheme.line, lineWidth: 0.6))
                    .accessibilityIdentifier("import-code")
                    .onChange(of: code) { _, value in
                        if value.utf8.count > 4096 { code = ""; error = SharingFailure.invalid.localizedDescription }
                    }
                AccentButton(title: "Review", symbol: "arrow.right") { review(code) }
                    .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .opacity(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.35 : 1)
                    .accessibilityIdentifier("import-review")
            }
        }
    }

    private func demoPreview(_ ticket: DemoShareTicket) -> some View {
        VStack(alignment: .leading, spacing: 26) {
            Eyebrow(text: "Demo · Local sample", color: BZZYTheme.accent)
            SharedResourceLabel(kind: kind, name: ticket.definition.name)
            Text(ticket.definition.instructions).bzzyFont(14).lineSpacing(5).foregroundStyle(BZZYTheme.secondary)
            VStack(alignment: .leading, spacing: 18) {
                Eyebrow(text: "Needs your approval")
                ForEach(ticket.definition.access, id: \.self) { access in
                    Label(access, systemImage: "hand.raised").bzzyFont(14)
                }
                Text("Connect your own accounts after import.").bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading).panel()
            SharingDetail(symbol: "pause.circle", title: "Inactive draft", value: "No permissions granted")
            AccentButton(title: "Import draft", symbol: "square.and.arrow.down") {
                do {
                    importedName = try transfers.importCopy(ticket, into: store)
                    demo = nil; error = nil
                } catch { self.error = error.localizedDescription }
            }.accessibilityIdentifier("import-confirm")
            Button("Use another code") { reset() }.bzzyFont(13).frame(minHeight: 44)
        }
    }

    private func relayPreview(_ invitation: RelayShareInvitation) -> some View {
        VStack(alignment: .leading, spacing: 25) {
            SharedResourceLabel(kind: kind, name: "Invitation")
            if let fingerprint = invitation.senderFingerprint {
                VStack(alignment: .leading, spacing: 12) {
                    Eyebrow(text: "Sender fingerprint")
                    Text(fingerprint).bzzyFont(11, design: .monospaced).textSelection(.enabled)
                    Text("Compare with the sender before trusting.").bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading).panel()
            }
            if let expiry = invitation.expiresAt {
                Label("Expires " + expiry.formatted(date: .abbreviated, time: .shortened), systemImage: "clock")
                    .bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
            }
            Text("Transfer requires host sharing support. This code has not been redeemed.")
                .bzzyFont(13).foregroundStyle(BZZYTheme.secondary).accessibilityIdentifier("import-host-required")
            Button { showConnection = true } label: {
                Label("Host connection", systemImage: "desktopcomputer").bzzyFont(14).frame(minHeight: 44)
            }.buttonStyle(.plain)
            Button("Use another code") { reset() }.bzzyFont(13).frame(minHeight: 44)
        }
    }

    private func completion(_ name: String) -> some View {
        VStack(alignment: .leading, spacing: 27) {
            Image(systemName: "checkmark.circle").font(.system(size: 50, weight: .ultraLight)).foregroundStyle(BZZYTheme.accent)
            SharedResourceLabel(kind: kind, name: name)
            Text("Added as an inactive draft.").bzzyFont(14).foregroundStyle(BZZYTheme.secondary)
                .accessibilityIdentifier("import-complete")
            AccentButton(title: "Done", symbol: "checkmark") {
                store.selectedTab = kind == .agent ? .agents : .terminal
                dismiss()
            }.accessibilityIdentifier("import-done")
        }.padding(.top, 16)
    }

    private func review(_ raw: String) {
        codeFocused = false; error = nil; demo = nil; invitation = nil
        defer { code = "" }
        guard raw.utf8.count <= 4096 else { error = SharingFailure.invalid.localizedDescription; return }
        do {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("BZZY-DEMO-") || trimmed.hasPrefix("BZZY:DEMO:1:") {
                guard store.showsDemoContent else { throw SharingFailure.invalid }
                demo = try transfers.preview(trimmed, kind: kind)
            } else {
                invitation = try RelayShareInvitation.parse(trimmed, expectedKind: kind == .agent ? .agent : .terminal)
            }
        } catch { self.error = error.localizedDescription }
    }
    private func reset() { code = ""; demo = nil; invitation = nil; error = nil }
}

private struct SharedResourceLabel: View {
    let kind: SharedResourceKind
    let name: String
    var body: some View {
        HStack(spacing: 15) {
            Image(systemName: kind.symbol).font(.system(size: 21, weight: .light)).foregroundStyle(BZZYTheme.accent)
                .frame(width: 48, height: 48).background(BZZYTheme.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
            VStack(alignment: .leading, spacing: 6) {
                Text(name).bzzyFont(18, weight: .medium)
                Text(kind.title).bzzyFont(11).foregroundStyle(BZZYTheme.secondary)
            }
        }
    }
}

private struct SharingDetail: View {
    let symbol: String
    let title: String
    let value: String
    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: symbol).bzzyFont(17).foregroundStyle(BZZYTheme.accent).frame(width: 23)
            VStack(alignment: .leading, spacing: 7) {
                Text(title).bzzyFont(14, weight: .medium)
                Text(value).bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct NativeQRCodeView: View {
    let text: String
    private var qr: CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        return CIContext().createCGImage(output, from: output.extent)
    }
    var body: some View {
        VStack(spacing: 0) {
            if let qr {
                Image(decorative: qr, scale: 1).resizable().interpolation(.none).scaledToFit()
                    .padding(18).background(.white, in: RoundedRectangle(cornerRadius: 20))
            } else {
                Image(systemName: "qrcode").resizable().scaledToFit().padding(25).foregroundStyle(BZZYTheme.secondary)
            }
        }.aspectRatio(1, contentMode: .fit).accessibilityElement(children: .ignore)
            .accessibilityLabel("BZZY QR code")
            .accessibilityIdentifier("share-qr")
    }
}

/// Live source sharing is a separate flow from the isolated local examples.
/// Invitation material stays in this sheet's memory and never enters chat/history.
struct LiveTerminalShareView: View {
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    let sessionID: String
    let title: String
    let directory: String?
    var kind: RelayShareKind = .terminal
    @State private var invitation: LiveTerminalInvitation?
    @State private var shareID: String?
    @State private var createRequestID: String?
    @State private var shareState = ""
    @State private var claims: [LiveRecipientClaim] = []
    @State private var expiresAt: Date?
    @State private var archiveBytes: Int64?
    @State private var isBusy = false
    @State private var uncertain = false
    @State private var copied = false
    @State private var error: String?
    @State private var selectedClaim: LiveRecipientClaim?
    @State private var visible = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text(kind == .agent ? "Share agent" : "Share terminal").bzzyFont(30, weight: .medium)
                    Text(title).bzzyFont(17, weight: .medium)
                    if let directory { Text(directory).bzzyFont(12, design: .monospaced).textSelection(.enabled) }
                    Text("Project files and full saved context, including chats, notes, memory, goals, nested agents and evidence. Private credentials stay on your host; the recipient connects their own accounts.")
                        .bzzyFont(13).foregroundStyle(BZZYTheme.secondary)
                    VStack(alignment: .leading, spacing: 10) {
                        Eyebrow(text: "Source fingerprint")
                        Text(relay.hostFingerprint).bzzyFont(11, design: .monospaced).textSelection(.enabled)
                        Text("Your recipient compares this complete fingerprint before importing.").bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                    }.panel()
                    if let invitation {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            if invitation.expiresAt > context.date {
                                VStack(spacing: 18) {
                                    NativeQRCodeView(text: invitation.qr).frame(maxWidth: 220)
                                    Text(invitation.code).bzzyFont(11, design: .monospaced)
                                        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                                        .accessibilityIdentifier("live-share-code")
                                    AccentButton(title: copied ? "Copied" : "Copy code", symbol: "doc.on.doc") { copy(invitation); copied = true }
                                }.frame(maxWidth: .infinity)
                            } else { Text("Code expired").bzzyFont(14).foregroundStyle(BZZYTheme.amber) }
                        }
                    }
                    if let expiresAt { Text("Expires " + expiresAt.formatted(date: .omitted, time: .shortened)).bzzyFont(12).foregroundStyle(BZZYTheme.secondary) }
                    if let archiveBytes { Text(ByteCountFormatter.string(fromByteCount: archiveBytes, countStyle: .file)).bzzyFont(12).foregroundStyle(BZZYTheme.secondary) }
                    if !shareState.isEmpty { Text(shareState.capitalized).bzzyFont(14) }
                    if shareID == nil && !uncertain {
                        AccentButton(title: "Generate temporary code", symbol: "qrcode") { Task { await create() } }
                            .disabled(isBusy || !relay.coreConnected || !relay.coreSharingAllowed)
                    } else if let shareID {
                        if invitation == nil && ["open", "pending", "approved"].contains(shareState) {
                            Text("The code is hidden. You can still approve a recipient or revoke this transfer.")
                                .bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                        }
                        ForEach(claims) { claim in
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Recipient fingerprint").bzzyFont(14, weight: .medium)
                                Text(claim.fingerprint).bzzyFont(11, design: .monospaced).textSelection(.enabled)
                                Text(kind == .agent ? "Compare the complete fingerprint with the one shown in your recipient’s iPhone import screen." : "Compare the complete fingerprint with the one shown in your recipient’s BZZY CLI.")
                                    .bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                                Button("I verified this fingerprint") { selectedClaim = claim }
                                    .disabled(isBusy || !relay.coreConnected)
                            }.panel()
                        }
                        Button("Refresh transfer status") { Task { await refreshStatus(shareID) } }.disabled(isBusy)
                        if !["complete", "revoked", "expired"].contains(shareState) {
                            Button("Revoke code", role: .destructive) { Task { await revoke(shareID) } }.disabled(isBusy)
                        } else {
                            Button("New share") { self.shareID = nil; invitation = nil; shareState = ""; createRequestID = nil; uncertain = false; error = nil }
                        }
                    }
                    if uncertain {
                        Text("Share preparation is not confirmed. No automatic retry.").bzzyFont(12).foregroundStyle(BZZYTheme.amber)
                        Button("Check request status") { Task { await reconcile() } }.disabled(isBusy || !relay.coreConnected)
                    }
                    if let error { Text(error).bzzyFont(12).foregroundStyle(BZZYTheme.amber) }
                    Text(kind == .agent ? "Both Cores must stay online. Your recipient imports on iPhone; Core restores a fresh paused agent beneath their own Agents workspace. Their accounts and permissions stay separate." : "The source Core must stay online. Your recipient imports the code in their BZZY CLI, restores it into their current directory, and authorizes their own accounts.")
                        .bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                }.padding(25)
            }.bzzyScreen().toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
                .confirmationDialog("Approve this recipient to receive the project and saved context?", isPresented: Binding(get: { selectedClaim != nil }, set: { if !$0 { selectedClaim = nil } }), titleVisibility: .visible) {
                    if let claim = selectedClaim {
                        Button("Approve verified recipient") { Task { await approve(claim) } }
                    }
                }
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
            .onAppear {
                visible = true
                if let reference = relay.recentCoreShare(sessionID: sessionID) {
                    shareID = reference.shareID; expiresAt = reference.expiresAt
                } else if let request = relay.pendingCoreShareRequest(sessionID: sessionID) {
                    createRequestID = request; uncertain = true
                }
            }
            .task(id: shareID) {
                guard let shareID else { return }
                while !Task.isCancelled {
                    if let expiresAt, expiresAt <= Date() { invitation = nil; claims = []; shareState = "expired"; return }
                    if scenePhase == .active && !isBusy { await refreshStatus(shareID) }
                    if ["complete", "revoked", "expired"].contains(shareState) { return }
                    do { try await Task.sleep(for: .seconds(4)) } catch { return }
                }
            }
            .onChange(of: scenePhase) { _, phase in if phase != .active { invitation = nil; copied = false } }
            .onChange(of: relay.coreActionsAvailable) { _, ready in if !ready { invitation = nil; copied = false; claims = [] } }
            .coreAvailabilityGate()
            .task(id: invitation?.id) {
                guard let invitation else { return }
                do { try await Task.sleep(for: .seconds(max(0, invitation.expiresAt.timeIntervalSinceNow))) } catch { return }
                if self.invitation?.id == invitation.id { self.invitation = nil; copied = false }
            }
            .onDisappear { visible = false; invitation = nil; copied = false; createRequestID = nil; claims = []; selectedClaim = nil }
    }

    private func create() async {
        guard !isBusy, shareID == nil, !uncertain else { return }
        isBusy = true; error = nil
        defer { isBusy = false }
        let request = createRequestID ?? CoreRelayClient.commandID(); createRequestID = request
        do {
            let result = try await relay.requestCoreShare("share.create", sessionID: sessionID, requestID: request)
            guard visible, scenePhase == .active, !Task.isCancelled else { return }
            invitation = try LiveTerminalInvitation(result)
            shareID = invitation?.id; expiresAt = invitation?.expiresAt; archiveBytes = result["bytes"].integer
            shareState = "open"; uncertain = false
        } catch { uncertain = true; self.error = "Share preparation was not confirmed. Check its saved request status." }
    }

    private func refreshStatus(_ id: String) async {
        guard !isBusy else { return }
        do {
            let result = try await relay.requestCoreShare("share.status", fields: ["shareId": id], sessionID: sessionID, requestID: CoreRelayClient.commandID())
            guard visible, shareID == id, !Task.isCancelled else { return }
            shareState = result["state"].string ?? "unknown"
            if let expiry = result["expiresAt"].integer { expiresAt = Date(timeIntervalSince1970: Double(expiry) / 1000) }
            archiveBytes = result["bytes"].integer
            claims = (result["pending"].array ?? []).compactMap { item in
                guard let claimID = item["claimId"].string, let fingerprint = item["fingerprint"].string else { return nil }
                return LiveRecipientClaim(id: claimID, fingerprint: fingerprint)
            }
            if shareState != "open" { invitation = nil; copied = false }
            if ["complete", "revoked", "expired"].contains(shareState) { claims = [] }
            error = nil
        } catch { if !Task.isCancelled { self.error = "Transfer status unavailable. Reconnect to your source host." } }
    }

    private func approve(_ claim: LiveRecipientClaim) async {
        guard !isBusy, let shareID else { return }
        isBusy = true; defer { isBusy = false; selectedClaim = nil }
        do {
            _ = try await relay.requestCoreShare("share.approve", fields: ["shareId": shareID, "claimId": claim.id, "confirmedFingerprint": claim.fingerprint], sessionID: sessionID, requestID: CoreRelayClient.commandID())
            shareState = "approved"; claims = []; invitation = nil; error = nil
        } catch { self.error = "Approval was not confirmed. Refresh status before trying again." }
    }

    private func revoke(_ id: String) async {
        guard !isBusy else { return }
        isBusy = true; defer { isBusy = false }
        do {
            _ = try await relay.requestCoreShare("share.revoke", fields: ["shareId": id], sessionID: sessionID, requestID: CoreRelayClient.commandID())
            invitation = nil; claims = []; shareState = "revoked"; error = nil
        } catch { self.error = "Revocation was not confirmed. Check your source host." }
    }

    private func reconcile() async {
        guard !isBusy, let request = createRequestID else { return }
        isBusy = true; defer { isBusy = false }
        do {
            let result = try await relay.checkCoreShareRequest(request, sessionID: sessionID)
            if result["state"].string == "accepted", let id = result["acceptance"]["shareId"].string {
                shareID = id; shareState = "open"; uncertain = false; error = nil
            } else if result["state"].string == "rejected" {
                uncertain = false; createRequestID = nil; error = "The host rejected share preparation."
            } else { error = "Share request \(result["state"].string ?? "uncertain"). No automatic retry." }
        } catch { self.error = "Request status unavailable. Check your source host." }
    }

    private func copy(_ invitation: LiveTerminalInvitation) {
        guard invitation.expiresAt > Date() else { return }
        #if os(iOS)
        UIPasteboard.general.setItems([["public.utf8-plain-text": invitation.code]], options: [.localOnly: true, .expirationDate: invitation.expiresAt])
        #else
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(invitation.code, forType: .string)
        #endif
    }
}

private struct LiveTerminalInvitation: CustomStringConvertible, CustomDebugStringConvertible {
    let id: String
    let code: String
    let qr: String
    let expiresAt: Date
    var description: String { "Temporary terminal invitation (redacted)" }
    var debugDescription: String { description }
    init(_ result: CoreJSONValue) throws {
        guard let id = result["shareId"].string, let code = result["code"].string, let qr = result["qr"].string,
              let expiry = result["expiresAt"].integer else { throw CoreApplicationError("INVALID_RESPONSE") }
        self.id = id; self.code = code; self.qr = qr; expiresAt = Date(timeIntervalSince1970: Double(expiry) / 1000)
    }
}
private struct LiveRecipientClaim: Identifiable {
    let id: String
    let fingerprint: String
}

/// The phone controls a Core import job. Bundle bytes and private account
/// bindings never pass through this view or the phone filesystem.
struct LiveAgentImportView: View {
    @Bindable var store: WorkspaceStore
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var code = ""
    @State private var invitation: RelayShareInvitation?
    @State private var fingerprint = ""
    @State private var verified = false
    @State private var name = ""
    @State private var provider = ""
    @State private var model = ""
    @State private var effort = "default"
    @State private var providers: [CoreJSONValue] = []
    @State private var models: [CoreJSONValue] = []
    @State private var modelCursor: String?
    @State private var modelHasMore = false
    @State private var modelSource = ""
    @State private var loading = false
    @State private var busy = false
    @State private var showScanner = false
    @State private var error: String?
    @State private var visible = false
    private var progress: CoreJSONValue? { relay.coreAgentImportSnapshot }
    private var finished: Bool { relay.coreAgentImportRecoveredAgent != nil || ["complete", "cancelled", "failed"].contains(progress?["state"].string ?? "") }
    private var efforts: [String] {
        models.first(where: { $0["id"].string == model })?["capabilities"]["supportedEfforts"].array?.compactMap(\.string)
            ?? providers.first(where: { $0["id"].string == provider })?["supportedEfforts"].array?.compactMap(\.string) ?? []
    }
    private var validFingerprint: Bool {
        fingerprint.count == 43 && fingerprint.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    }
    private var resolvedModel: String? {
        let explicit = model.trimmingCharacters(in: .whitespacesAndNewlines)
        if !explicit.isEmpty { return explicit }
        guard let configured = providers.first(where: { $0["id"].string == provider })?["model"].string, !configured.isEmpty else { return nil }
        return configured
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text("Import agent").bzzyFont(30, weight: .medium)
                    if !relay.coreAgentsAvailable {
                        Text("Agent management must be explicitly enabled for this iPhone when pairing.").bzzyFont(14)
                    } else if relay.coreAgentImportPending {
                        job
                    } else if let invitation {
                        review(invitation)
                    } else {
                        entry
                    }
                    if let error { Text(error).bzzyFont(12).foregroundStyle(BZZYTheme.amber).accessibilityIdentifier("agent-import-error") }
                }.padding(25)
            }.bzzyScreen().textFieldStyle(.plain)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
                #if os(iOS)
                .sheet(isPresented: $showScanner) {
                    ZStack(alignment: .topTrailing) {
                        InvitationScannerView(prefixes: ["BZZY:INVITE:1:"], onCode: { raw in showScanner = false; parse(raw) }, onError: { error = $0; showScanner = false })
                        Button("Close") { showScanner = false }.padding(20).background(.black.opacity(0.7), in: Capsule()).padding()
                    }.ignoresSafeArea(edges: .bottom)
                }
                #endif
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
            .onAppear { visible = true }
            .onDisappear { visible = false; clearInvitation() }
            .task {
                await loadProviders()
                while !Task.isCancelled {
                    if scenePhase == .active && relay.coreActionsAvailable && relay.coreAgentImportPending && !busy && !finished { await refresh() }
                    do { try await Task.sleep(for: .seconds(3)) } catch { return }
                }
            }
            .task(id: invitation?.expiresAt) {
                guard let expiry = invitation?.expiresAt else { return }
                do { try await Task.sleep(for: .seconds(max(0, expiry.timeIntervalSinceNow))) } catch { return }
                if self.invitation?.expiresAt == expiry { clearInvitation(); error = "Invitation expired. Ask the sender for a new code." }
            }
            .onChange(of: relay.coreActionsAvailable) { _, ready in if !ready { clearInvitation() } }
            .onChange(of: scenePhase) { _, phase in if phase != .active { clearInvitation() } }
            .onChange(of: fingerprint) { _, _ in verified = false }
            .onChange(of: provider) { _, value in if !loading { model = ""; effort = "default"; Task { await loadModels(value) } } }
    }

    private var entry: some View {
        VStack(alignment: .leading, spacing: 22) {
            Text("Receive a complete agent workspace on your Core, including its project files and saved conversations/context.").bzzyFont(14).foregroundStyle(BZZYTheme.secondary)
            #if os(iOS)
            Button { showScanner = true } label: { Label("Scan QR", systemImage: "qrcode.viewfinder").bzzyFont(18).frame(maxWidth: .infinity).padding(30).panel() }
                .accessibilityIdentifier("agent-import-scan")
            #endif
            SecureField("BZZY-AGENT-…", text: $code).bzzyFont(13, design: .monospaced).panel()
                .textContentType(.oneTimeCode).autocorrectionDisabled().accessibilityIdentifier("agent-import-code")
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .onChange(of: code) { _, value in if value.utf8.count > 4096 { clearInvitation(); error = "Invalid invitation." } }
            AccentButton(title: "Review", symbol: "arrow.right") { parse(code) }.disabled(code.isEmpty).accessibilityIdentifier("agent-import-review")
        }
    }

    private func review(_ invitation: RelayShareInvitation) -> some View {
        VStack(alignment: .leading, spacing: 22) {
            Text("Full workspace copy").bzzyFont(18, weight: .medium)
            Text("Includes project files, full chats, notes, memory, goals, evidence and nested relationships. Core validates the bundle and restores fresh local identities beneath your Agents root. Imported work stays paused. No sender accounts, credentials, permissions or schedules are activated.")
                .bzzyFont(13).foregroundStyle(BZZYTheme.secondary)
            if let source = invitation.senderFingerprint {
                Eyebrow(text: "Source fingerprint")
                Text(source).bzzyFont(11, design: .monospaced).textSelection(.enabled)
            } else {
                TextField("Complete sender fingerprint", text: $fingerprint).bzzyFont(12, design: .monospaced).panel().autocorrectionDisabled()
                    .accessibilityIdentifier("agent-import-fingerprint")
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
            }
            Toggle("I compared the complete fingerprint with the sender", isOn: $verified).bzzyFont(13).accessibilityIdentifier("agent-import-verified")
            if let expiry = invitation.expiresAt { Text("Expires " + expiry.formatted(date: .omitted, time: .shortened)).bzzyFont(12) }
            Text("Use your Core’s own provider and accounts").bzzyFont(14, weight: .medium)
            if !relay.coreAgentsConfigured { Text("Configure your Core Agents workspace first.").bzzyFont(12).foregroundStyle(BZZYTheme.amber) }
            if loading { ProgressView() }
            TextField("Agent name (optional)", text: $name).bzzyFont(14).panel()
            Picker("Provider", selection: $provider) {
                if providers.isEmpty { Text("No providers available").tag("") }
                ForEach(providers.compactMap { $0["id"].string }, id: \.self) { id in Text(providers.first(where: { $0["id"].string == id })?["name"].string ?? id).tag(id) }
            }.pickerStyle(.menu)
            Picker("Model", selection: $model) {
                Text(providers.first(where: { $0["id"].string == provider })?["model"].string == nil ? "Choose model" : "Provider default").tag("")
                ForEach(models.compactMap { $0["id"].string }, id: \.self) { id in Text(models.first(where: { $0["id"].string == id })?["name"].string ?? id).tag(id) }
            }.pickerStyle(.menu)
            if modelSource == "manual" || models.isEmpty { TextField("Model ID (optional)", text: $model).bzzyFont(13, design: .monospaced).panel() }
            if modelHasMore { Button("Load more models") { Task { await loadModels(provider, more: true) } } }
            Picker("Effort", selection: $effort) {
                Text("Provider default").tag("default")
                ForEach(efforts.filter { $0 != "default" }, id: \.self) { Text($0).tag($0) }
            }.pickerStyle(.menu)
            AccentButton(title: "Receive on Core", symbol: "square.and.arrow.down") { Task { await receive(invitation) } }
                .disabled(busy || loading || !verified || !validFingerprint || provider.isEmpty || resolvedModel == nil || !relay.coreActionsAvailable || !relay.coreAgentsConfigured || name.utf8.count > 120)
                .accessibilityIdentifier("agent-import-receive")
            Button("Use another code") { clearInvitation(); error = nil }
        }
    }

    private var job: some View {
        VStack(alignment: .leading, spacing: 22) {
            Text(relay.coreAgentImportRecoveredAgent != nil ? "Imported agent found on Core" : progress?["state"].string == "complete" ? "Imported · Paused" : progress?["state"].string == "awaitingApproval" ? "Awaiting sender approval" : (progress?["state"].string ?? "Checking saved request").capitalized)
                .bzzyFont(21, weight: .medium).accessibilityIdentifier("agent-import-state")
            if let recipient = progress?["recipientFingerprint"].string {
                Eyebrow(text: "Recipient fingerprint")
                Text(recipient).bzzyFont(11, design: .monospaced).textSelection(.enabled).accessibilityIdentifier("agent-import-recipient")
                Text("Ask the sender to compare this full fingerprint and approve it in their Share screen.").bzzyFont(13).foregroundStyle(BZZYTheme.secondary)
            }
            if let received = progress?["received"].integer, let total = progress?["total"].integer, total > 0 {
                ProgressView(value: Double(received), total: Double(total))
                Text("\(ByteCountFormatter.string(fromByteCount: received, countStyle: .file)) / \(ByteCountFormatter.string(fromByteCount: total, countStyle: .file))").bzzyFont(12)
            }
            if let expiry = progress?["expiresAt"].integer { Text("Expires " + Date(timeIntervalSince1970: Double(expiry) / 1000).formatted(date: .omitted, time: .shortened)).bzzyFont(12) }
            if let code = progress?["errorCode"].string { Text("Transfer stopped (\(code)). No work was started.").bzzyFont(12).foregroundStyle(BZZYTheme.amber) }
            if progress?["state"].string == "complete" || relay.coreAgentImportRecoveredAgent != nil {
                Text(relay.coreAgentImportRecoveredAgent?["name"].string ?? progress?["agent"]["name"].string ?? "Agent").bzzyFont(18, weight: .medium)
                Text("Saved on your Core with new identities. Review the imported context and authorize your own accounts before asking it to work.").bzzyFont(13).foregroundStyle(BZZYTheme.secondary)
            }
            Button("Refresh transfer") { Task { await refresh() } }.disabled(busy || !relay.coreActionsAvailable)
            if finished {
                AccentButton(title: progress?["state"].string == "complete" || relay.coreAgentImportRecoveredAgent != nil ? "Done" : "Use another code", symbol: "checkmark") {
                    let complete = progress?["state"].string == "complete" || relay.coreAgentImportRecoveredAgent != nil
                    relay.finishCoreAgentImport()
                    if complete { store.selectedTab = .agents; dismiss() }
                }
            } else {
                Button("Cancel transfer", role: .destructive) { Task { await cancel() } }.disabled(busy || progress == nil || !relay.coreActionsAvailable)
            }
            Text("Both Cores must stay online during transfer. Closing this sheet does not execute or resume imported work.").bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
        }
    }

    private func parse(_ raw: String) {
        clearInvitation(); error = nil
        do {
            let value = try RelayShareInvitation.parse(raw, expectedKind: .agent)
            invitation = value; fingerprint = value.senderFingerprint ?? ""; verified = false
        } catch { self.error = error.localizedDescription }
    }
    private func clearInvitation() { code = ""; invitation = nil; fingerprint = ""; verified = false }
    private func receive(_ invitation: RelayShareInvitation) async {
        guard !busy, verified, validFingerprint, let selectedModel = resolvedModel, invitation.expiresAt == nil || invitation.expiresAt! > Date() else { return }
        let code = invitation.code, source = fingerprint
        clearInvitation(); busy = true; error = nil
        defer { busy = false }
        do {
            try await relay.beginCoreAgentImport(code: code, sourceFingerprint: source, provider: provider,
                model: selectedModel,
                effort: effort, name: name.trimmingCharacters(in: .whitespacesAndNewlines))
            if visible { _ = try await relay.refreshCoreAgentImport() }
        } catch { if visible { self.error = "Import was not confirmed (\((error as? CoreApplicationError)?.code ?? "UNAVAILABLE")). Check the saved request; no automatic retry." } }
    }
    private func refresh() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do { _ = try await relay.refreshCoreAgentImport(); if visible { error = nil } }
        catch { if visible { self.error = "Transfer status unavailable (\((error as? CoreApplicationError)?.code ?? "UNAVAILABLE")). Refresh to reconcile; do not submit the code again." } }
    }
    private func cancel() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do { try await relay.cancelCoreAgentImport(); if visible { error = nil } }
        catch { if visible { self.error = "Cancellation was not confirmed. Refresh transfer status before trying again." } }
    }
    private func loadProviders() async {
        loading = true; defer { loading = false }
        do {
            let result = try await relay.readCoreAgent("agents.providers")
            guard visible else { return }
            providers = result["providers"].array ?? []; provider = providers.first?["id"].string ?? ""
            await loadModels(provider)
        } catch { if visible { self.error = "Core provider settings are unavailable." } }
    }
    private func loadModels(_ requested: String, more: Bool = false) async {
        guard !requested.isEmpty else { return }
        let cursor = more ? modelCursor : nil
        do {
            let page = try await relay.readCoreAgentModels(requested, after: cursor)
            guard visible, provider == requested, !more || modelCursor == cursor else { return }
            if more { models += page["models"].array ?? [] } else { models = page["models"].array ?? [] }
            modelCursor = page["nextCursor"].string; modelHasMore = page["hasMore"].bool == true; modelSource = page["source"].string ?? "manual"
        } catch { if visible, provider == requested { self.error = "Core model catalog is unavailable." } }
    }
}
