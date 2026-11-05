import XCTest
@testable import MoteCore

final class CaptureSyncPresentationTests: XCTestCase {
    func testSendGroupStatesExposeStatusAndOperation() {
        let synced = SendGroupPresentation(host: "mote.example.net", status: .synced(at: "21:42"))
        XCTAssertEqual(synced.statusText, "已同步 · 21:42")
        XCTAssertEqual(synced.tone, .normal)
        XCTAssertNil(synced.actionTitle)
        XCTAssertNil(synced.action)

        let syncedWithoutTime = SendGroupPresentation(host: "mote.example.net", status: .synced(at: nil))
        XCTAssertEqual(syncedWithoutTime.statusText, "已同步")
        XCTAssertNil(syncedWithoutTime.actionTitle)

        let pending = SendGroupPresentation(host: "mote.example.net", status: .pending(count: 3))
        XCTAssertEqual(pending.statusText, "待同步 3 条")
        XCTAssertEqual(pending.tone, .normal)
        XCTAssertEqual(pending.actionTitle, "立即发送")
        XCTAssertEqual(pending.action, .sendNow)

        let paused = SendGroupPresentation(host: "mote.example.net", status: .paused)
        XCTAssertEqual(paused.statusText, "发送已暂停")
        XCTAssertEqual(paused.tone, .normal)
        XCTAssertNil(paused.actionTitle)
        XCTAssertNil(paused.action)

        let reconnect = SendGroupPresentation(host: "mote.example.net", status: .reconnect)
        XCTAssertEqual(reconnect.statusText, "需要重新连接")
        XCTAssertEqual(reconnect.tone, .warning)
        XCTAssertEqual(reconnect.actionTitle, "连接")
        XCTAssertEqual(reconnect.action, .reconnect)
    }

    func testPauseOverrideUsesPausedStatus() {
        let presentation = CaptureSyncPresentation(facts: facts(sendState: .pending(count: 4)))
        XCTAssertEqual(presentation.send(paused: true).statusText, "发送已暂停")
        XCTAssertEqual(presentation.send(paused: false).statusText, "待同步 4 条")
    }

    func testPausedStateStartsPausedAndResumesAsSynced() {
        let presentation = CaptureSyncPresentation(facts: facts(sendState: .paused))
        XCTAssertTrue(presentation.sendPaused)
        XCTAssertEqual(presentation.send(paused: true).statusText, "发送已暂停")
        XCTAssertEqual(presentation.send(paused: false).statusText, "已同步")
    }

    func testFixedSourcesStayInTheListWhenShortcutsAreMissing() {
        let presentation = CaptureSyncPresentation(facts: facts(shortcutEnabled: false))
        XCTAssertEqual(presentation.sources.map(\.id), [.notification, .screenshot, .media, .folder])

        let fixed = presentation.sources.prefix(2)
        for source in fixed {
            XCTAssertEqual(source.detail, "快捷指令未启用")
            XCTAssertEqual(source.tone, .warning)
            XCTAssertEqual(source.actionTitle, "设置")
            XCTAssertEqual(source.action, .openShortcutSetup)
        }
    }

    func testEnabledShortcutsShowLastReceivedTimes() {
        let presentation = CaptureSyncPresentation(facts: facts(shortcutEnabled: true))
        XCTAssertEqual(presentation.sources[0].detail, "21:38")
        XCTAssertEqual(presentation.sources[0].tone, .normal)
        XCTAssertEqual(presentation.sources[0].action, .openSource)
        XCTAssertEqual(presentation.sources[1].detail, "18:02")
    }

    func testMediaAndFoldersOnlyAppearWhenAdded() {
        let minimal = CaptureSyncPresentation(facts: facts(
            mediaAdded: false,
            folderCount: 0
        ))
        XCTAssertEqual(minimal.sources.map(\.id), [.notification, .screenshot])

        let added = CaptureSyncPresentation(facts: facts(
            mediaAdded: true,
            mediaPermissionMissing: false,
            mediaLastReceived: "昨天",
            folderCount: 2
        ))
        XCTAssertEqual(added.sources.map(\.id), [.notification, .screenshot, .media, .folder])
        XCTAssertEqual(added.sources[2].detail, "昨天")
        XCTAssertEqual(added.sources[3].detail, "2 个")
    }

    func testMediaPermissionShowsWarningAndFixOperation() {
        let presentation = CaptureSyncPresentation(facts: facts(
            mediaAdded: true,
            mediaPermissionMissing: true
        ))
        let media = presentation.sources.first { $0.id == .media }
        XCTAssertEqual(media?.detail, "等待采集权限")
        XCTAssertEqual(media?.tone, .warning)
        XCTAssertEqual(media?.actionTitle, "处理")
        XCTAssertEqual(media?.action, .handleMediaPermission)
    }

    func testAddSourceKindsKeepCanvasOrderAndOnlyCloudIsExternal() {
        let presentation = CaptureSyncPresentation(facts: facts())
        XCTAssertEqual(presentation.addSourceKinds, [.file, .folder, .calendar, .deviceEvents, .cloud])
        XCTAssertEqual(presentation.addSourceKinds.map(\.title), ["文件", "文件夹", "日历", "设备事件", "云端来源"])
        XCTAssertEqual(presentation.addSourceKinds.filter(\.opensExternal), [.cloud])
    }

    func testStorageTextUsesGigabytes() {
        let presentation = CaptureSyncPresentation(facts: facts(storageBytes: 1_200_000_000))
        XCTAssertEqual(presentation.storageText, "1.2 GB")
    }

    private func facts(
        shortcutEnabled: Bool = true,
        mediaAdded: Bool = true,
        mediaPermissionMissing: Bool = false,
        mediaLastReceived: String? = nil,
        folderCount: Int = 2,
        sendState: SendSyncState = .synced(at: "21:42"),
        storageBytes: Int64? = 1_200_000_000
    ) -> CaptureSyncFacts {
        CaptureSyncFacts(
            shortcutEnabled: shortcutEnabled,
            notificationLastReceived: "21:38",
            screenshotLastReceived: "18:02",
            mediaAdded: mediaAdded,
            mediaPermissionMissing: mediaPermissionMissing,
            mediaLastReceived: mediaLastReceived,
            folderCount: folderCount,
            centralHost: "mote.example.net",
            sendState: sendState,
            sendMethod: "立即发送",
            sendPaused: sendState == .paused,
            storageBytes: storageBytes
        )
    }
}
