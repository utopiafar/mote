import XCTest
@testable import MoteCore

final class MoteMenuPresentationTests: XCTestCase {
    func testNormalCaptureStatesStaySilent() {
        XCTAssertNil(status(connection: .connected, captureEnabled: true, captureLive: true, syncState: .idle))
        XCTAssertNil(status(
            connection: .connected, captureEnabled: true, captureLive: true,
            syncState: .waiting, pending: 12
        ))
        XCTAssertNil(status(
            connection: .unconfigured, captureEnabled: true, captureLive: true,
            syncState: .unconfigured
        ))
        XCTAssertNil(status(
            connection: .connected, captureEnabled: true, captureLive: true,
            syncState: .idle, disconnected: true
        ))
    }

    func testPermissionNeedsActionUsesWarningTone() {
        XCTAssertEqual(
            status(connection: .connected, captureEnabled: true, captureLive: false, permission: .missing),
            MoteMenuStatus(title: "等待采集权限", tone: .warning)
        )
        XCTAssertEqual(
            status(connection: .connected, captureEnabled: true, captureLive: true, permission: .partial),
            MoteMenuStatus(title: "等待采集权限", tone: .warning)
        )
    }

    func testPausedSendingUsesNeutralTone() {
        XCTAssertEqual(
            status(connection: .connected, captureEnabled: true, captureLive: true, syncState: .paused, pending: 3),
            MoteMenuStatus(title: "发送已暂停", tone: .neutral)
        )
    }

    func testReconnectAndStorageUseWarningTone() {
        XCTAssertEqual(
            status(connection: .reconnect, captureEnabled: true, captureLive: true, syncState: .idle),
            MoteMenuStatus(title: "需要重新连接", tone: .warning)
        )
        XCTAssertEqual(
            status(connection: .connected, captureEnabled: true, captureLive: true, syncState: .idle, storageFull: true),
            MoteMenuStatus(title: "本机空间已满", tone: .warning)
        )
        XCTAssertEqual(
            status(connection: .connected, captureEnabled: true, captureLive: true, syncState: .error),
            MoteMenuStatus(title: "发送需要处理", tone: .warning)
        )
    }

    private func status(
        connection: CaptureConnection,
        captureEnabled: Bool,
        captureLive: Bool,
        syncState: CaptureSyncState = .idle,
        permission: CapturePermission? = nil,
        storageFull: Bool? = nil,
        pending: Int = 0,
        disconnected: Bool? = nil
    ) -> MoteMenuStatus? {
        MoteMenuPresentation(facts: CaptureStatusFacts(
            connection: connection,
            captureEnabled: captureEnabled,
            captureLive: captureLive,
            permission: permission,
            storageFull: storageFull,
            syncState: syncState,
            pending: pending,
            disconnected: disconnected
        )).captureStatus
    }
}
