import SwiftUI
import RelayKit

extension RelayConnection {
    /// Capture before scheduling. A task queued by an old sheet cannot write to
    /// a newly selected computer, even if both computers share session UUIDs.
    @MainActor @discardableResult
    func performHostAction(_ action: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        let origin = HostActionContext(hostID: activeHostID)
        return Task { @MainActor in
            guard !Task.isCancelled, origin.permits(activeHostID) else { return }
            await action()
        }
    }
}

struct ConnectView: View {
    var required = false
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var fingerprint = ""
    @State private var compared = false
    @State private var showScanner = false
    @State private var scannerError: String?
    @State private var hostToRemove: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("›").foregroundStyle(BZZYTheme.accent).accessibilityHidden(true)
                        Text(relay.isAddingHost ? "Add computer" : required ? "Pair BZZY Core" : "Connect")
                    }.bzzyFont(20, weight: .semibold)
                    HStack {
                        Label(relay.status.rawValue, systemImage: relay.status == .connected ? "checkmark.circle" : "network")
                            .bzzyFont(13).foregroundStyle(relay.status == .connected ? BZZYTheme.accent : BZZYTheme.secondary)
                        Spacer()
                        if relay.status != .connected {
                            Button("Connect") { Task { await relay.connect() } }
                                .bzzyFont(13).disabled(relay.status == .connecting || !relay.networkingEnabled)
                        }
                    }
                    if relay.hasHost && !relay.isAddingHost {
                        if let name = relay.hosts.first(where: { $0.id == relay.activeHostID })?.name {
                            Text(name).bzzyFont(16, weight: .medium).foregroundStyle(BZZYTheme.accent)
                        }
                        Label(relay.hostStatus, systemImage: "desktopcomputer").bzzyFont(17)
                        fingerprintBlock("Host", relay.hostFingerprint)
                        Text(relay.coreConnectionLabel).bzzyFont(14, weight: .medium)
                            .foregroundStyle(relay.coreActionsAvailable ? BZZYTheme.accent : BZZYTheme.secondary)
                        if let error = relay.coreError { Text(error).bzzyFont(12).foregroundStyle(BZZYTheme.secondary) }
                        Button("Refresh Core connection") { Task { await relay.refresh() } }.bzzyFont(13)
                        Button("Remove computer", role: .destructive) { hostToRemove = relay.activeHostID }.bzzyFont(13)
                    } else if relay.hasPairingPreview {
                        fingerprintBlock("Host fingerprint", relay.hostFingerprint)
                        Text("Compare the full fingerprint with the one shown on your host.")
                            .bzzyFont(13).foregroundStyle(BZZYTheme.secondary)
                        Toggle("Compared with my host", isOn: $compared).bzzyFont(13).tint(BZZYTheme.accent)
                            .accessibilityIdentifier("host-fingerprint-compared")
                        AccentButton(title: "Confirm host", symbol: "checkmark") {
                            let originHostID = relay.activeHostID
                            let fingerprint = relay.hostFingerprint
                            Task {
                                guard relay.activeHostID == originHostID, relay.hostFingerprint == fingerprint, !Task.isCancelled else { return }
                                await relay.claimConfirmedHost()
                            }
                        }.disabled(!compared || relay.isBusy || relay.status == .connecting || !relay.networkingEnabled).opacity(compared ? 1 : 0.4)
                        Button("Cancel") { relay.cancelPairingPreview(); compared = false }.bzzyFont(13)
                    } else if relay.pairingStatus == "Pending approval" {
                        Label("Approve on your host", systemImage: "desktopcomputer").bzzyFont(17)
                        fingerprintBlock("This iPhone", relay.deviceFingerprint)
                        Text("Compare this fingerprint before approving the device.").bzzyFont(12).foregroundStyle(BZZYTheme.secondary)
                        Button("Refresh") { Task { await relay.refresh() } }.bzzyFont(13)
                    } else {
                        VStack(alignment: .leading, spacing: 15) {
                            #if os(iOS)
                            Button { showScanner = true } label: {
                                Label("Scan host QR", systemImage: "qrcode.viewfinder").bzzyFont(15)
                                    .frame(maxWidth: .infinity, minHeight: 52)
                                    .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius))
                                    .overlay(RoundedRectangle(cornerRadius: BZZYTheme.controlRadius).stroke(BZZYTheme.line, lineWidth: 0.7))
                            }.buttonStyle(.plain).foregroundStyle(BZZYTheme.accent)
                            #endif
                            SecureField("Pairing code or QR text", text: $code)
                                .textContentType(.oneTimeCode).autocorrectionDisabled()
                                .bzzyFont(13, design: .monospaced).padding(14)
                                .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius))
                                .overlay(RoundedRectangle(cornerRadius: BZZYTheme.controlRadius).stroke(BZZYTheme.line, lineWidth: 0.7))
                                .accessibilityIdentifier("pairing-code")
                            if !code.hasPrefix("BZZY:INVITE:1:") && !code.hasPrefix("BZZY:P:") {
                                TextField("Host fingerprint", text: $fingerprint).autocorrectionDisabled()
                                    .bzzyFont(13, design: .monospaced).padding(14)
                                    .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: BZZYTheme.controlRadius))
                                    .overlay(RoundedRectangle(cornerRadius: BZZYTheme.controlRadius).stroke(BZZYTheme.line, lineWidth: 0.7))
                                    .accessibilityIdentifier("pairing-fingerprint")
                            }
                            Button("Review host") { review(code) }.bzzyFont(14).foregroundStyle(BZZYTheme.accent)
                                .disabled(code.isEmpty).accessibilityIdentifier("review-host")
                        }.textFieldStyle(.plain)
                        Text("Use a PAIR invitation from your host.").bzzyFont(11).foregroundStyle(BZZYTheme.muted)
                    }
                    if let error = relay.errorMessage ?? scannerError {
                        Text(error).bzzyFont(12).foregroundStyle(BZZYTheme.secondary).accessibilityIdentifier("connection-error")
                    }
                    if !relay.deviceFingerprint.isEmpty && relay.pairingStatus != "Pending approval" {
                        fingerprintBlock("This iPhone", relay.deviceFingerprint)
                    }
                }.padding(16)
            }.bzzyScreen().toolbar {
                if !required { ToolbarItem(placement: .cancellationAction) { Button("Close") { if relay.isAddingHost { relay.cancelAddingHost() }; dismiss() }.accessibilityIdentifier("close-connection") } }
            }
            #if os(iOS)
            .sheet(isPresented: $showScanner) {
                InvitationScannerView(onCode: { raw in showScanner = false; review(raw) }, onError: {
                    scannerError = $0; showScanner = false
                })
            }
            #endif
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
            .interactiveDismissDisabled(required)
            .accessibilityIdentifier(required ? "required-core-pairing" : "core-connection")
            .confirmationDialog("Remove this computer from this iPhone?", isPresented: Binding(get: { hostToRemove != nil }, set: { if !$0 { hostToRemove = nil } }), titleVisibility: .visible) {
                Button("Remove computer", role: .destructive) {
                    if let id = hostToRemove { Task { await relay.forgetHost(id) } }
                    hostToRemove = nil
                }
                Button("Cancel", role: .cancel) { hostToRemove = nil }
            } message: { Text("Its saved connection and cached conversations will be removed. Pair again to reconnect.") }
            .onDisappear { code = ""; fingerprint = ""; relay.cancelPairingPreview(); if relay.isAddingHost { relay.cancelAddingHost() } }
    }

    private func review(_ raw: String) {
        compared = false
        scannerError = nil
        relay.previewPairing(raw, expectedFingerprint: fingerprint)
        code = ""; fingerprint = ""
    }
    private func fingerprintBlock(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(text: title)
            Text(value).bzzyFont(12, design: .monospaced).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading).panel()
    }
}

struct HostPickerView: View {
    var onSelect: () -> Void = {}
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    @State private var showConnection = false
    @State private var renamingID: String?
    @State private var friendlyName = ""
    @State private var removingID: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 13) {
                        Image(systemName: "desktopcomputer").bzzyFont(20, weight: .regular).foregroundStyle(BZZYTheme.accent)
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Computers").bzzyFont(20, weight: .semibold)
                            Text("Your default opens on a fresh app launch.").bzzyFont(11).foregroundStyle(BZZYTheme.secondary)
                        }
                    }.padding(.top, 6)
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        VStack(spacing: 12) {
                            ForEach(relay.hosts) { host in hostRow(host) }
                        }
                    }
                    Button {
                        relay.beginAddingHost(); showConnection = true
                    } label: {
                        Label("Add computer", systemImage: "plus").bzzyFont(14, weight: .medium)
                            .frame(maxWidth: .infinity, minHeight: 48)
                    }.buttonStyle(BZZYActionStyle()).accessibilityIdentifier("add-computer")
                    Text("Pair with the new computer’s QR or expiring code, then compare its full fingerprint.")
                        .bzzyFont(11).foregroundStyle(BZZYTheme.muted).lineSpacing(4)
                }.padding(16)
            }.bzzyScreen()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.accessibilityIdentifier("close-host-picker") } }
                .sheet(isPresented: $showConnection) { ConnectView() }
                .alert("Rename computer", isPresented: Binding(get: { renamingID != nil }, set: { if !$0 { renamingID = nil } })) {
                    TextField("Computer name", text: $friendlyName).accessibilityIdentifier("computer-name")
                    Button("Save") { if let id = renamingID { relay.renameHost(id, name: friendlyName) }; renamingID = nil }
                        .disabled(friendlyName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Cancel", role: .cancel) { renamingID = nil }
                } message: { Text("Choose a name you will recognize before sending work.") }
                .confirmationDialog("Remove \(relay.hosts.first(where: { $0.id == removingID })?.name ?? "computer") from this iPhone?", isPresented: Binding(get: { removingID != nil }, set: { if !$0 { removingID = nil } }), titleVisibility: .visible) {
                    Button("Remove computer", role: .destructive) {
                        if let id = removingID { if id == relay.activeHostID { onSelect() }; Task { await relay.forgetHost(id) } }
                        removingID = nil
                    }
                    Button("Cancel", role: .cancel) { removingID = nil }
                } message: { Text("Its saved connection and cached conversations will be removed. Pair again to reconnect.") }
        }.tint(BZZYTheme.accent).preferredColorScheme(.dark)
    }

    private func hostRow(_ host: CoreHostSummary) -> some View {
        let selected = host.id == relay.activeHostID
        let online = selected && relay.connectionOnline
        return HStack(spacing: 12) {
            Button {
                if !selected { onSelect(); Task { await relay.activateHost(host.id) } }
                dismiss()
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle").bzzyFont(20)
                        .foregroundStyle(selected ? BZZYTheme.accent : BZZYTheme.muted)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(host.name).bzzyFont(15, weight: .medium).foregroundStyle(BZZYTheme.text)
                        HStack(spacing: 7) {
                            Circle().fill(selected ? (online ? BZZYTheme.success : BZZYTheme.danger) : BZZYTheme.muted).frame(width: 5, height: 5)
                            Text(!host.isPaired ? "Pairing required" : selected ? (online ? "Online · Selected" : "Offline · Selected") : "Not selected · Status unknown")
                                .bzzyFont(10).foregroundStyle(BZZYTheme.secondary)
                        }
                        if host.isDefault {
                            Label("Default on launch", systemImage: "star.fill").bzzyFont(10).foregroundStyle(BZZYTheme.accent)
                        }
                    }
                    Spacer(minLength: 0)
                }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Select \(host.name)")
                .accessibilityValue((selected ? "Selected" : "Not selected") + (host.isDefault ? ", Default on launch" : ""))
                .accessibilityIdentifier("select-host-\(host.id)")
            Menu {
                Button { relay.setDefaultHost(host.id) } label: { Label(host.isDefault ? "Default on launch" : "Set as default", systemImage: host.isDefault ? "star.fill" : "star") }
                    .disabled(host.isDefault)
                Button("Rename", systemImage: "pencil") { friendlyName = host.name; renamingID = host.id }
                if selected { Button("Connection details", systemImage: "network") { showConnection = true } }
                Button("Remove computer", systemImage: "trash", role: .destructive) { removingID = host.id }
            } label: {
                Image(systemName: "ellipsis").bzzyFont(17, weight: .semibold).foregroundStyle(BZZYTheme.accent).frame(width: 44, height: 44)
            }.accessibilityLabel("Options for \(host.name)").accessibilityIdentifier("host-options-\(host.id)")
        }.padding(12).background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: BZZYTheme.panelRadius))
            .overlay(RoundedRectangle(cornerRadius: BZZYTheme.panelRadius).stroke(selected ? BZZYTheme.accent.opacity(0.6) : BZZYTheme.line, lineWidth: 0.8))
    }
}

#if os(iOS)
import AVFoundation
import UIKit

struct InvitationScannerView: UIViewControllerRepresentable {
    var prefixes = ["BZZY:INVITE:1:", "BZZY:P:"]
    let onCode: (String) -> Void
    let onError: (String) -> Void
    func makeUIViewController(context: Context) -> InvitationScannerController {
        let controller = InvitationScannerController()
        controller.prefixes = prefixes
        controller.onCode = onCode; controller.onError = onError
        return controller
    }
    func updateUIViewController(_ uiViewController: InvitationScannerController, context: Context) {}
    static func dismantleUIViewController(_ controller: InvitationScannerController, coordinator: ()) { controller.stop() }
}

final class InvitationScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var prefixes = ["BZZY:INVITE:1:", "BZZY:P:"]
    var onCode: ((String) -> Void)?
    var onError: ((String) -> Void)?
    private let capture = AVCaptureSession()
    private let queue = DispatchQueue(label: "app.bzzy.qr-camera")
    private var preview: AVCaptureVideoPreviewLayer?
    private var finished = false
    private var visible = false
    override func viewDidLoad() { super.viewDidLoad(); view.backgroundColor = .black }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        visible = true
        Task { @MainActor [weak self] in
            let allowed = await AVCaptureDevice.requestAccess(for: .video)
            guard let self, self.visible else { return }
            guard allowed else { self.onError?("Camera access is off. Paste the code instead."); return }
            self.start()
        }
    }
    override func viewDidDisappear(_ animated: Bool) { super.viewDidDisappear(animated); stop() }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    func stop() { visible = false; queue.async { [capture] in if capture.isRunning { capture.stopRunning() } } }
    private func start() {
        guard capture.inputs.isEmpty else { return }
        guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), capture.canAddInput(input) else {
            onError?("Camera unavailable. Paste the code instead."); return
        }
        capture.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard capture.canAddOutput(output) else { onError?("QR scanning unavailable."); return }
        capture.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: capture)
        layer.videoGravity = .resizeAspectFill; layer.frame = view.bounds
        view.layer.addSublayer(layer); preview = layer
        queue.async { [capture] in capture.startRunning() }
    }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard visible, !finished,
              let code = metadataObjects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first,
              code.count <= 4096, prefixes.contains(where: { code.hasPrefix($0) }) else { return }
        finished = true; stop(); onCode?(code)
    }
}
#endif
