import XCTest
@testable import MoteCore

final class ConnectionDevicePresentationTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-11-06T04:00:00Z")!
    private var calendar: Calendar = {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(secondsFromGMT: 8 * 60 * 60)!
        return value
    }()

    func testConnectedDeviceShowsCentralScopeNameAndDate() {
        let presentation = ConnectionDevicePresentation(
            serverUrl: "https://mote.example.net",
            scope: "owner",
            deviceName: "我的 iPhone",
            connectedAt: ISO8601DateFormatter().date(from: "2026-10-03T04:00:00Z")!,
            now: now,
            calendar: calendar,
            locale: Locale(identifier: "zh_CN")
        )
        XCTAssertTrue(presentation.connected)
        XCTAssertEqual(presentation.central, "mote.example.net")
        XCTAssertEqual(presentation.permission, "本人设备")
        XCTAssertEqual(presentation.connectionTime, "10月3日")
        XCTAssertEqual(presentation.deviceName, "我的 iPhone")
    }

    func testCentralKeepsNonDefaultPortAndHidesDefaultPorts() {
        let custom = presentation(server: "https://mote.example.net:8443")
        XCTAssertEqual(custom.central, "mote.example.net:8443")
        XCTAssertEqual(presentation(server: "https://mote.example.net:443").central, "mote.example.net")
        XCTAssertEqual(presentation(server: "http://mote.example.net:80").central, "mote.example.net")
    }

    func testNonOwnerScopeShowsCapturePermission() {
        XCTAssertEqual(presentation(scope: "capture").permission, "采集权限")
    }

    func testEarlierYearsUseTheFullDate() {
        let presentation = ConnectionDevicePresentation(
            serverUrl: "https://mote.example.net",
            scope: "owner",
            deviceName: "我的 iPhone",
            connectedAt: ISO8601DateFormatter().date(from: "2025-10-03T04:00:00Z")!,
            now: now,
            calendar: calendar,
            locale: Locale(identifier: "zh_CN")
        )
        XCTAssertEqual(presentation.connectionTime, "2025年10月3日")
    }

    func testMissingConnectionShowsDisconnectedValuesAndFallbackName() {
        let presentation = ConnectionDevicePresentation(
            serverUrl: nil,
            scope: nil,
            deviceName: nil,
            connectedAt: nil,
            now: now,
            calendar: calendar
        )
        XCTAssertFalse(presentation.connected)
        XCTAssertEqual(presentation.central, "尚未连接")
        XCTAssertEqual(presentation.permission, "尚未连接")
        XCTAssertEqual(presentation.connectionTime, "尚未连接")
        XCTAssertEqual(presentation.deviceName, "我的 iPhone")
    }

    func testOldConnectionWithoutTimestampReadsAsUnavailable() {
        XCTAssertEqual(presentation(connectedAt: nil).connectionTime, "暂不可读取")
    }

    private func presentation(
        server: String = "https://mote.example.net",
        scope: String = "owner",
        connectedAt: Date? = ISO8601DateFormatter().date(from: "2026-10-03T04:00:00Z")
    ) -> ConnectionDevicePresentation {
        ConnectionDevicePresentation(
            serverUrl: server,
            scope: scope,
            deviceName: "我的 iPhone",
            connectedAt: connectedAt,
            now: now,
            calendar: calendar,
            locale: Locale(identifier: "zh_CN")
        )
    }
}
