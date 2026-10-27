// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Donkey",
    defaultLocalization: "en",
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
                .process("Resources/bundled-tools.json"),
                .process("Resources/Localizable.xcstrings")
            ]
        ),
        .target(
            name: "DonkeyUI",
            resources: [
                .process("Resources/Localizable.xcstrings")
            ]
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
                .copy("Resources/menu-bar-icon@2x.png"),
                .process("Resources/Localizable.xcstrings"),
                .process("Resources/InfoPlist.xcstrings")
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
