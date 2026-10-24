// swift-tools-version: 5.9
import PackageDescription
import Foundation

let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()

let package = Package(
    name: "BZZYIOS",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "RelayKit", targets: ["RelayKit"]),
               .executable(name: "RelayProbe", targets: ["RelayProbe"]),
               .executable(name: "BZZYPreview", targets: ["BZZYPreview"])],
    dependencies: [.package(url: "https://github.com/jedisct1/swift-sodium.git",
                            revision: "cfd195c76882aa9b997560ca7cb95d72fbf5db00")],
    targets: [
        .target(name: "RelayKit", dependencies: [.product(name: "Sodium", package: "swift-sodium")], path: "BZZY/Relay"),
        .testTarget(name: "RelayKitTests", dependencies: ["RelayKit"], path: "Tests/RelayKitTests"),
        .executableTarget(name: "RelayProbe", dependencies: ["RelayKit"], path: "tools/RelayProbe"),
        .executableTarget(name: "BZZYPreview", dependencies: ["RelayKit"], path: ".",
            exclude: ["BZZY/Relay", "BZZY/Resources", "BZZY.xcodeproj", "Tests", "docs", "previews",
                      "message_format.txt", "bzzy-eyes.jpeg", "README.md", "tools/RelayProbe", "tools/check.sh", "tools/relay-interop.mjs",
                      "tools/multi-host-fixture.mjs", "tools/core-line-fixture.mjs", "tools/core-line-model.mjs", "tools/pairing-connection-fixture.mjs", "tools/relay-transport-fixture.mjs", "tools/check-app-artifact.py"].filter { FileManager.default.fileExists(atPath: packageRoot.appendingPathComponent($0).path) },
            sources: ["BZZY/App", "BZZY/Design", "BZZY/Mascot/FlyEyes.swift", "BZZY/Model", "BZZY/Notifications", "BZZY/Views", "BZZY/Voice", "tools/RenderPreview.swift"],
            resources: [.copy("BZZY/Assets.xcassets"), .copy("BZZY/Mascot/FlyMotion.metal")],
            swiftSettings: [.define("BZZY_PREVIEW")])
    ]
)
