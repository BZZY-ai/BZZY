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
                VStack(alignment: .leading, spacing: 18) {
                    SheetTitle(title: "Share")
                    SharedResourceLabel(kind: target.kind, name: target.name)
                    Picker("Share mode", selection: $mode) {
                        ForEach(ResourceShareMode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.segmented).labelsHidden().accessibilityIdentifier("share-mode")

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
                }.padding(16)
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
                VStack(alignment: .leading, spacing: 18) {
                    SheetTitle(title: importedName == nil ? "Import \(kind.title.lowercased())" : "Imported",
                               subtitle: importedName == nil ? "Scan a BZZY QR or paste an expiring code." : nil)
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
                }.padding(16)
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
                HStack(spacing: 12) {
                    Image(systemName: "qrcode.viewfinder").bzzyFont(20)
                    Text("Scan QR").bzzyFont(14, weight: .medium)
                    Spacer()
                    Image(systemName: "arrow.right").bzzyFont(12)
                }.foregroundStyle(BZZYTheme.accent).padding(.horizontal, 14).frame(maxWidth: .infinity, minHeight: 56)
                    .hiveCard(radius: BZZYTheme.controlRadius)
            }.buttonStyle(BZZYCardStyle()).accessibilityIdentifier("import-scan")
            #endif
            VStack(alignment: .leading, spacing: 13) {
                Eyebrow(text: "Or paste a code")
                SecureField("BZZY-\(kind.rawValue)-…", text: $code)
                    .textContentType(.oneTimeCode).autocorrectionDisabled().focused($codeFocused)
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .bzzyFont(13, design: .monospaced).textFieldStyle(.plain).hiveField()
                    .accessibilityIdentifier("import-code")
                    .onChange(of: code) { _, value in
                        if value.utf8.count > 4096 { code = ""; error = SharingFailure.invalid.localizedDescription }
                    }
                AccentButton(title: "Review", symbol: "arrow.right") { review(code) }
                    .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
            Image(systemName: "checkmark.circle.fill").font(.system(size: 50, weight: .regular)).foregroundStyle(BZZYTheme.success)
            SharedResourceLabel(kind: kind, name: name)
            Text("Added as an inactive draft.").bzzyFont(14).foregroundStyle(BZZYTheme.secondary)
                .accessibilityIdentifier("import-complete")
            AccentButton(title: "Done", symbol: "checkmark") { dismiss() }.accessibilityIdentifier("import-done")
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
            IconTile(symbol: kind.symbol, size: 44)
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
                VStack(alignment: .leading, spacing: 18) {
                    SheetTitle(title: kind == .agent ? "Share agent" : "Share terminal")
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title).bzzyFont(17, weight: .semibold)
                        if let directory { Text(DisplayPath.short(directory)).bzzyFont(12, design: .monospaced).foregroundStyle(BZZYTheme.secondary).textSelection(.enabled) }
                    }
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
                        AccentButton(title: "Generate temporary code", symbol: "qrcode") { relay.performHostAction { await create() } }
                            .disabled(isBusy || !relay.coreActionsAvailable || !relay.coreSharingAllowed)
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
                                    .disabled(isBusy || !relay.coreActionsAvailable)
                            }.panel()
                        }
                        Button("Refresh transfer status") { relay.performHostAction { await refreshStatus(shareID) } }.disabled(isBusy)
                        if !["complete", "revoked", "expired"].contains(shareState) {
                            Button("Revoke code", role: .destructive) { relay.performHostAction { await revoke(shareID) } }.disabled(isBusy)
                        } else {
                            Button("New share") { self.shareID = nil; invitation = nil; shareState = ""; createRequestID = nil; uncertain = false; error = nil }
                        }
                    }
                    if uncertain {
                        Text("Share preparation is not confirmed. No automatic retry.").bzzyFont(12).foregroundStyle(BZZYTheme.amber)
                        Button("Check request status") { relay.performHostAction { await reconcile() } }.disabled(isBusy || !relay.coreActionsAvailable)
                    }
                    if let error { Text(error).bzzyFont(12).foregroundStyle(BZZYTheme.amber) }
                    Text(kind == .agent ? "Both Cores must stay online. Your recipient imports on iPhone; Core restores a fresh paused agent beneath their own Agents workspace. Their accounts and permissions stay separate." : "The source Core must stay online. Your recipient imports the code in their BZZY CLI, restores it into their current directory, and authorizes their own accounts.")
                        .bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                }.padding(16)
            }.bzzyScreen().toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
                .confirmationDialog("Approve this recipient to receive the project and saved context?", isPresented: Binding(get: { selectedClaim != nil }, set: { if !$0 { selectedClaim = nil } }), titleVisibility: .visible) {
                    if let claim = selectedClaim {
                        Button("Approve verified recipient") { relay.performHostAction { await approve(claim) } }
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
                let origin = HostActionContext(hostID: relay.activeHostID)
                while !Task.isCancelled && origin.permits(relay.activeHostID) {
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
