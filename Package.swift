// swift-tools-version: 5.9
// The Swift client of exchange-rates-uy (clients/swift): add this repository in Xcode or as
// .package(url: "https://github.com/guillecura/exchange-rates-uy", from: "1.6.0").
import PackageDescription

let package = Package(
    name: "ExchangeRatesUY",
    platforms: [.iOS(.v15), .macOS(.v12), .tvOS(.v15), .watchOS(.v8)],
    products: [
        .library(name: "ExchangeRatesUY", targets: ["ExchangeRatesUY"]),
    ],
    targets: [
        .target(name: "ExchangeRatesUY", path: "clients/swift/Sources/ExchangeRatesUY"),
        .testTarget(name: "ExchangeRatesUYTests", dependencies: ["ExchangeRatesUY"], path: "clients/swift/Tests/ExchangeRatesUYTests"),
    ]
)
