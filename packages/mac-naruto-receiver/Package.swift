// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MacNarutoReceiver",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "NarutoReceiver", targets: ["NarutoReceiver"])],
    targets: [
        .target(name: "NarutoTransfer"),
        .executableTarget(name: "NarutoReceiver", dependencies: ["NarutoTransfer"]),
        .testTarget(name: "NarutoTransferTests", dependencies: ["NarutoTransfer"], resources: [.copy("Fixtures")])
    ]
)
