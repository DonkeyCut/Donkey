// swift-tools-version: 6.2
import PackageDescription

// DonkeyKitModels holds observable product state, repositories, and pure
// capture math; it imports Foundation and SwiftData only. DonkeyKitUI renders
// that state and emits typed intents; it never reaches into the app target's
// controllers. Both default to main-actor isolation per docs/guides/swift.md.
let package = Package(
    name: "DonkeyKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "DonkeyKitModels", targets: ["DonkeyKitModels"]),
        .library(name: "DonkeyKitUI", targets: ["DonkeyKitUI"]),
    ],
    targets: [
        .target(
            name: "DonkeyKitModels",
            swiftSettings: [.defaultIsolation(MainActor.self)]
        ),
        .target(
            name: "DonkeyKitUI",
            dependencies: ["DonkeyKitModels"],
            swiftSettings: [.defaultIsolation(MainActor.self)]
        ),
        .testTarget(
            name: "DonkeyKitModelsTests",
            dependencies: ["DonkeyKitModels"],
            // Fixtures/analytics-rollup.json is written by the site's
            // analytics pipeline (npm run analytics:rollup-fixture).
            resources: [.copy("Fixtures")],
            swiftSettings: [.defaultIsolation(MainActor.self)]
        ),
    ]
)
