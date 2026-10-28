import Foundation

@main
struct NotificationReadinessChecks {
    static func main() {
        let relayMissing = NotificationDeliveryReadiness(status: "Device registered · Configure Apple push on Relay")
        require(relayMissing == .relaySetupRequired && relayMissing.title.contains("Relay APNs not configured"),
            "A registered phone with missing Relay APNs must show the missing remote prerequisite")
        require(relayMissing.explanation.contains("Pairing and iPhone permission alone do not enable background delivery"),
            "Device permission must stay separate from remote Apple setup")
        require(NotificationDeliveryReadiness(status: "Relay APNs not configured · Remote alerts cannot be delivered") == .relaySetupRequired,
            "The current Relay readiness response must expose its missing Apple setup")
        let directMissing = NotificationDeliveryReadiness(status: "Device registered · Configure APNs on the source Core")
        require(directMissing == .coreSetupRequired && directMissing.explanation.contains("direct Core delivery"),
            "Legacy direct delivery must identify the correct machine for setup")
        for status in ["Relay push configured · Background alerts enabled", "Relay APNs configured · Delivery requires Apple connectivity", "Relay push configured · Apple delivery not yet confirmed"] {
            let ready = NotificationDeliveryReadiness(status: status)
            require(ready == .relayConfigured && ready.explanation.contains("not confirmation that Apple accepted an alert"),
                "Matching configuration must never claim an Apple or phone display receipt")
        }
        require(NotificationDeliveryReadiness(status: "Host push configured · Delivery requires Apple connectivity") == .coreConfigured,
            "Direct Core configuration must remain distinct from Relay configuration")
        for status in ["Device registered · Waiting for Core", "An unknown future status"] {
            require(NotificationDeliveryReadiness(status: status) == .waiting,
                "Missing, removed or unknown registration state cannot imply remote readiness")
        }
        require(NotificationDeliveryReadiness(status: "Host activity alerts disabled") == .disabled,
            "A disabled phone preference must remain explicit")
        require(NotificationDeliveryReadiness(status: "Notification permission unavailable") == .permissionRequired,
            "iPhone permission must identify local settings rather than server configuration")
        require(NotificationDeliveryReadiness(status: "Waiting for Apple push registration") == .deviceRegistrationPending,
            "Missing device registration must identify Apple registration rather than model or Relay setup")
        require(NotificationDeliveryReadiness(status: "Host authorization removed") == .authorizationRemoved,
            "Lost host authorization must direct the user to pairing")
        print("Notification readiness checks passed")
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) {
        if !condition() { fatalError(message) }
    }
}
