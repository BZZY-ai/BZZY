import SwiftUI
import RelayKit

struct ConnectView: View {
    var required = false
    @Environment(RelayConnection.self) private var relay
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var fingerprint = ""
    @State private var compared = false
    @State private var showScanner = false
    @State private var scannerError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    Text(required ? "Pair BZZY Core" : "Connect").bzzyFont(30, weight: .medium)
                    HStack {
                        Label(relay.status.rawValue, systemImage: relay.status == .connected ? "checkmark.circle" : "network")
                            .bzzyFont(13).foregroundStyle(relay.status == .connected ? BZZYTheme.accent : BZZYTheme.secondary)
                        Spacer()
                        if relay.status != .connected {
                            Button("Connect") { Task { await relay.connect() } }
                                .bzzyFont(13).disabled(relay.status == .connecting || !relay.networkingEnabled)
                        }
                    }
                    if relay.hasHost {
                        Label(relay.hostStatus, systemImage: "desktopcomputer").bzzyFont(17)
                        fingerprintBlock("Host", relay.hostFingerprint)
                        Text(relay.coreConnectionLabel).bzzyFont(14, weight: .medium)
                            .foregroundStyle(relay.coreActionsAvailable ? BZZYTheme.accent : BZZYTheme.secondary)
                        if let error = relay.coreError { Text(error).bzzyFont(12).foregroundStyle(BZZYTheme.secondary) }
                        Button("Refresh Core connection") { Task { await relay.refresh() } }.bzzyFont(13)
                        Button("Forget host", role: .destructive) { Task { await relay.forgetHost() } }.bzzyFont(13)
                    } else if relay.hasPairingPreview {
                        fingerprintBlock("Host fingerprint", relay.hostFingerprint)
                        Text("Compare the full fingerprint with the one shown on your host.")
                            .bzzyFont(13).foregroundStyle(BZZYTheme.secondary)
                        Toggle("Compared with my host", isOn: $compared).bzzyFont(13).tint(BZZYTheme.accent)
                            .accessibilityIdentifier("host-fingerprint-compared")
                        AccentButton(title: "Confirm host", symbol: "checkmark") {
                            Task { await relay.claimConfirmedHost() }
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
                                    .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: 17))
                            }.buttonStyle(.plain).foregroundStyle(BZZYTheme.accent)
                            #endif
                            SecureField("Pairing code or QR text", text: $code)
                                .textContentType(.oneTimeCode).autocorrectionDisabled()
                                .bzzyFont(13, design: .monospaced).padding(17)
                                .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: 17))
                                .accessibilityIdentifier("pairing-code")
                            if !code.hasPrefix("BZZY:INVITE:1:") && !code.hasPrefix("BZZY:P:") {
                                TextField("Host fingerprint", text: $fingerprint).autocorrectionDisabled()
                                    .bzzyFont(13, design: .monospaced).padding(17)
                                    .background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: 17))
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
                }.padding(25)
            }.bzzyScreen().toolbar {
                if !required { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
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
            .onDisappear { code = ""; fingerprint = ""; relay.cancelPairingPreview() }
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
