// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "MoteKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v14),
    ],
    products: [
        .library(name: "MoteDesign", targets: ["MoteDesign"]),
        .library(name: "MoteCore", targets: ["MoteCore"]),
        .library(name: "MoteCentral", targets: ["MoteCentral"]),
        .library(name: "MoteStorage", targets: ["MoteStorage"]),
    ],
    targets: [
        .target(name: "MoteDesign"),
        .target(name: "MoteCore"),
        .target(name: "MoteCentral", dependencies: ["MoteStorage"]),
        .target(name: "MoteStorage", dependencies: ["MoteCore"]),
        .testTarget(
            name: "MoteKitTests",
            dependencies: ["MoteDesign", "MoteCore", "MoteCentral", "MoteStorage"]
        ),
    ],
    swiftLanguageModes: [.v6]
)
