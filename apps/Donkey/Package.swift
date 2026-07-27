// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Donkey",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "Donkey",
            targets: ["Donkey"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.0")
    ],
    targets: [
        .target(
            name: "DonkeyRuntime",
            resources: [
                .process("Resources/bundled-tools.json")
            ]
        ),
        .target(
            name: "DonkeyUI"
        ),
        .executableTarget(
            name: "Donkey",
            dependencies: [
                "DonkeyRuntime",
                "DonkeyUI",
                .product(name: "Sparkle", package: "Sparkle")
            ],
            exclude: [
                "Resources/Donkey.icns",
                "Resources/Donkey-dev.icns",
                "Resources/Donkey.iconset"
            ],
            resources: [
                .copy("Resources/menu-bar-icon.png"),
                .copy("Resources/menu-bar-icon@2x.png")
            ]
        ),
        .testTarget(
            name: "DonkeyRuntimeTests",
            dependencies: [
                "Donkey",
                "DonkeyRuntime",
                "DonkeyUI"
            ]
        )
    ]
)
