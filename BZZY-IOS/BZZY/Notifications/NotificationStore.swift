import Foundation
import Observation
import UserNotifications
#if os(iOS)
import UIKit
#endif

// A notification is only a navigation hint. It never authorizes or executes work.
enum NotificationDestination: String { case agents, terminal, connection, updates }

/// Registration/configuration is not a delivery receipt, and an on-device
/// preview cannot establish the remote Core -> Relay -> Apple route.
enum NotificationDeliveryReadiness: Equatable {
    case relaySetupRequired, coreSetupRequired, relayConfigured, coreConfigured, waiting, disabled, permissionRequired, deviceRegistrationPending, authorizationRemoved

    init(status: String) {
        switch status {
        case "Device registered · Configure Apple push on Relay", "Relay APNs not configured · Remote alerts cannot be delivered": self = .relaySetupRequired
        case "Device registered · Configure APNs on the source Core": self = .coreSetupRequired
        case "Relay push configured · Background alerts enabled", "Relay APNs configured · Delivery requires Apple connectivity", "Relay push configured · Apple delivery not yet confirmed": self = .relayConfigured
        case "Host push configured · Delivery requires Apple connectivity": self = .coreConfigured
        case "Host activity alerts disabled": self = .disabled
        case "Notification permission unavailable": self = .permissionRequired
        case "Waiting for device registration", "Waiting for Apple push registration", "Push registration unavailable": self = .deviceRegistrationPending
        case "Host authorization removed": self = .authorizationRemoved
        default: self = .waiting
        }
    }

    var title: String {
        switch self {
        case .relaySetupRequired: return "Relay APNs not configured for this build"
        case .coreSetupRequired: return "Core APNs not configured for this build"
        case .relayConfigured: return "Relay APNs configuration confirmed"
        case .coreConfigured: return "Core APNs configuration confirmed"
        case .disabled: return "Remote activity alerts disabled"
        case .permissionRequired: return "iPhone notification permission required"
        case .deviceRegistrationPending: return "iPhone Apple push registration pending"
        case .authorizationRemoved: return "Computer authorization removed"
        case .waiting: return "Remote delivery not confirmed"
        }
    }

    var explanation: String {
        switch self {
        case .relaySetupRequired:
            return "The Relay administrator must configure its Apple push key, app topic and matching sandbox or production environment. Pairing and iPhone permission alone do not enable background delivery. See Core docs/PUSH.md."
        case .coreSetupRequired:
            return "This connection uses direct Core delivery. The Core owner must configure Apple push for this app’s topic and environment. See Core docs/PUSH.md."
        case .relayConfigured, .coreConfigured:
            return "The service reported matching Apple push configuration. This is not confirmation that Apple accepted an alert or that the iPhone displayed it."
        case .disabled: return "Enable Activity alerts and allow notifications in iOS Settings to register this iPhone."
        case .permissionRequired: return "Allow BZZY notifications in iOS Settings, then reopen the app to register for remote activity alerts."
        case .deviceRegistrationPending: return "Apple has not supplied a current push registration. Keep notifications enabled and reopen the app with internet access."
        case .authorizationRemoved: return "Pair this iPhone with the computer again before enabling its remote alerts."
        case .waiting: return "Keep this iPhone paired and reconnect to Core to confirm registration and remote push setup. Saved goals alone are not a delivered alert."
        }
    }
}

struct NotificationHint {
    let eventID: String
    let hostID: String?
    let destination: NotificationDestination
    let resource: String?
    let sessionID: String?
    let agentID: String?
    init?(_ userInfo: [AnyHashable: Any]) {
        guard let value = userInfo["bzzy"] as? [String: Any], Set(value.keys).isSubset(of: ["v", "eventId", "hostId", "destination", "resource", "sessionId", "agentId"]),
              Set(["v", "eventId", "destination"]).isSubset(of: Set(value.keys)),
              let version = value["v"] as? Int, version == 1,
              let id = value["eventId"] as? String, id.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil,
              let raw = value["destination"] as? String, let route = NotificationDestination(rawValue: raw) else { return nil }
        let suppliedHost = value["hostId"] as? String
        if value["hostId"] != nil {
            // Relay certificate IDs are SHA256 public-key fingerprints encoded
            // as unpadded base64url. A valid hint is not proof of a known host.
            guard let suppliedHost, suppliedHost.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { return nil }
        }
        let suppliedResource = value["resource"] as? String
        if value["resource"] != nil {
            guard [.terminal, .agents].contains(route), let suppliedResource,
                  suppliedResource.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil else { return nil }
        }
        let suppliedSession = value["sessionId"] as? String
        if value["sessionId"] != nil {
            guard [.terminal, .agents].contains(route), let suppliedSession, UUID(uuidString: suppliedSession) != nil, suppliedResource != nil else { return nil }
        }
        let suppliedAgent = value["agentId"] as? String
        if value["agentId"] != nil {
            guard route == .agents, let suppliedAgent, UUID(uuidString: suppliedAgent) != nil,
                  suppliedResource != nil, suppliedSession != nil else { return nil }
        }
        eventID = id; hostID = suppliedHost; destination = route; resource = suppliedResource; sessionID = suppliedSession; agentID = suppliedAgent
    }
}

@MainActor @Observable
final class NotificationStore {
    static let shared = NotificationStore(enabled: true)
    private(set) var permission = "Not enabled"
    private(set) var authorized = false
    private(set) var permissionChecked = false
    private(set) var pushStatus = "Host delivery not registered"
    private(set) var pushToken: String?
    private(set) var registrationRevision = 0
    var destinationHostID: String?
    var destinationResource: String?
    var destinationSessionID: String?
    var destinationAgentID: String?
    private(set) var errorMessage: String?
    var destination: NotificationDestination?
    var alertsEnabled: Bool {
        didSet {
            if enabled { UserDefaults.standard.set(alertsEnabled, forKey: "bzzy-notification-alerts") }
            if !alertsEnabled {
                // This preference applies to the phone, including computers
                // currently offline and unable to receive a Core RPC.
                stopRemoteRegistration(status: "Host activity alerts disabled")
            } else if !oldValue {
                pushToken = nil
                pushStatus = "Waiting for device registration"
                if enabled { Task { await refresh() } }
            }
            registrationRevision += 1
        }
    }
    let enabled: Bool
    @ObservationIgnored private var handled: [String] = []

    init(enabled: Bool = false) {
        self.enabled = enabled
        alertsEnabled = enabled ? (UserDefaults.standard.object(forKey: "bzzy-notification-alerts") as? Bool ?? true) : true
    }

    func refresh() async {
        guard enabled else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        permissionChecked = true
        authorized = [.authorized, .provisional].contains(settings.authorizationStatus)
        #if os(iOS)
        if settings.authorizationStatus == .ephemeral { authorized = true }
        #endif
        switch settings.authorizationStatus {
        case .authorized: permission = "Enabled"
        case .provisional: permission = "Quiet delivery"
        #if os(iOS)
        case .ephemeral: permission = "Quiet delivery"
        #endif
        case .denied: permission = "Disabled in iOS Settings"
        default: permission = "Not enabled"
        }
        if !authorized || !alertsEnabled {
            stopRemoteRegistration(status: alertsEnabled ? "Notification permission unavailable" : "Host activity alerts disabled")
        }
        registrationRevision += 1
        #if os(iOS)
        if authorized && alertsEnabled { UIApplication.shared.registerForRemoteNotifications() }
        #endif
    }

    func requestPermission() async {
        guard enabled else { return }
        errorMessage = nil
        do { _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) }
        catch { errorMessage = "Notification permission unavailable." }
        await refresh()
    }

    func receiveTap(_ info: [AnyHashable: Any]) {
        guard let hint = NotificationHint(info) else { return }
        let receipt = "\(hint.hostID ?? "legacy"):\(hint.eventID)"
        guard !handled.contains(receipt) else { return }
        handled.append(receipt)
        if handled.count > 256 { handled.removeFirst(handled.count - 256) }
        destinationHostID = hint.hostID
        destinationResource = hint.resource
        destinationSessionID = hint.sessionID
        destinationAgentID = hint.agentID
        destination = hint.destination
    }

    func hostNotice(_ kind: String) async {
        guard ["paired", "revoked"].contains(kind) else { return }
        await deliver(kind == "paired" ? "Host pairing approved." : "Host access revoked.")
    }

    func sendTest() async { await deliver("This on-device preview works. Remote Core and Relay delivery is checked separately.") }

    private func deliver(_ body: String) async {
        guard enabled, alertsEnabled, authorized else { return }
        let id = UUID().uuidString
        let content = UNMutableNotificationContent()
        content.title = "BZZY"
        content.body = body
        content.sound = .default
        content.categoryIdentifier = "BZZY_UPDATE"
        content.threadIdentifier = "bzzy-connection"
        content.userInfo = ["bzzy": ["v": 1, "eventId": id, "destination": "connection"]]
        do { try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) }
        catch { errorMessage = "Notification could not be delivered." }
    }

    var pushEnvironment: String? {
        switch Bundle.main.object(forInfoDictionaryKey: "BZZYAPNSEnvironment") as? String {
        case "development": return "sandbox"
        case "production": return "production"
        default: return nil
        }
    }
    func registeredForPush(_ token: Data) {
        guard alertsEnabled else {
            // A callback from an earlier register request cannot undo a newer
            // app-wide disable while host preference updates are in flight.
            stopRemoteRegistration(status: "Host activity alerts disabled")
            registrationRevision += 1
            return
        }
        let encoded = token.map { String(format: "%02x", $0) }.joined()
        guard encoded.count >= 64, encoded.count <= 512 else { registrationFailed(); return }
        pushToken = encoded
        pushStatus = "Device registered · Waiting for Core"
        registrationRevision += 1
    }
    func hostRegistrationStatus(_ status: String) { pushStatus = status }
    func hostAuthorizationRemoved() {
        stopRemoteRegistration(status: "Host authorization removed")
        registrationRevision += 1
    }
    private func stopRemoteRegistration(status: String) {
        pushToken = nil; pushStatus = status
        #if os(iOS)
        if enabled { UIApplication.shared.unregisterForRemoteNotifications() }
        #endif
    }
    func registrationFailed() { pushToken = nil; pushStatus = "Push registration unavailable"; registrationRevision += 1 }
}

#if os(iOS)
final class NotificationAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        let category = UNNotificationCategory(identifier: "BZZY_UPDATE", actions: [], intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([category])
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        // The token stays in memory and is sent only through the authorized,
        // encrypted Core application contract. Never print it or put it in events.
        Task { @MainActor in NotificationStore.shared.registeredForPush(deviceToken) }
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in NotificationStore.shared.registrationFailed() }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in
            let store = NotificationStore.shared
            completionHandler(store.alertsEnabled && NotificationHint(notification.request.content.userInfo) != nil ? [.banner, .sound] : [])
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
                NotificationStore.shared.receiveTap(response.notification.request.content.userInfo)
            }
            completionHandler()
        }
    }
}
#endif
