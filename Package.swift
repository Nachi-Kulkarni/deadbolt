// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "deadbolt",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "deadbolt",
            path: "Sources/deadbolt",
            swiftSettings: [.unsafeFlags(["-swift-version", "5"])],
            linkerSettings: [.linkedLibrary("sqlite3")]
        )
    ]
)
