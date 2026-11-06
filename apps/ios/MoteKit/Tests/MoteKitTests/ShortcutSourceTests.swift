import XCTest
import MoteCentral
import MoteCore
import MoteStorage

final class ShortcutSourceTests: XCTestCase {
    private var directoryURL: URL!

    override func setUpWithError() throws {
        directoryURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directoryURL)
    }

    func testDisabledAndPausedNotificationsNeverReachCaptureEncoding() {
        let content = notification()
        XCTAssertNil(ShortcutSourceFilter.notification(content, settings: ShortcutSourceSettings()))

        var paused = ShortcutSourceSettings(setupPhase: .enabled)
        paused.isPaused = true
        XCTAssertNil(ShortcutSourceFilter.notification(content, settings: paused))
    }

    func testAllowedAppsMatchEitherIdentifierOrNameWithoutCase() {
        var settings = ShortcutSourceSettings(setupPhase: .waiting)
        settings.allowedApps = ["com.generated.parcel", "微信"]
        XCTAssertNotNil(ShortcutSourceFilter.notification(notification(), settings: settings))
        XCTAssertNotNil(ShortcutSourceFilter.notification(
            notification(appId: "com.generated.chat", appName: "微信"),
            settings: settings
        ))
        XCTAssertNil(ShortcutSourceFilter.notification(
            notification(appId: "com.generated.other", appName: "其他"),
            settings: settings
        ))
    }

    func testTitleOnlyAndExcludedTextAreAppliedBeforeCaptureMetadataIsBuilt() throws {
        var settings = ShortcutSourceSettings(setupPhase: .enabled, notificationContent: .titleOnly)
        let filtered = try XCTUnwrap(ShortcutSourceFilter.notification(notification(), settings: settings))
        XCTAssertEqual(filtered.title, "Generated parcel")
        XCTAssertNil(filtered.text)

        let capture = try IOSNotificationCapture.make(
            content: filtered,
            deviceId: "generated-device",
            deviceName: "Generated iPhone",
            postedAt: "2026-11-06T00:00:00Z"
        )
        XCTAssertEqual(capture.metadata?.notification?.title, "Generated parcel")
        XCTAssertNil(capture.metadata?.notification?.text)

        settings.notificationContent = .titleAndBody
        settings.excludedText = ["secret code"]
        XCTAssertNil(ShortcutSourceFilter.notification(notification(), settings: settings))
        settings.excludedText = ["GENERATED PARCEL"]
        XCTAssertNil(ShortcutSourceFilter.notification(notification(), settings: settings))
    }

    func testScreenshotTextRulesRespectSetupAndPauseState() {
        var settings = ShortcutSourceSettings(setupPhase: .waiting, excludedText: ["内部"])
        XCTAssertTrue(ShortcutSourceFilter.acceptsScreenshot(recognizedText: "Generated roadmap", settings: settings))
        XCTAssertFalse(ShortcutSourceFilter.acceptsScreenshot(recognizedText: "内部 roadmap", settings: settings))
        settings.isPaused = true
        XCTAssertFalse(ShortcutSourceFilter.acceptsScreenshot(recognizedText: "Generated roadmap", settings: settings))
    }

    func testFirstAcceptedReceiptMovesWaitingSetupToEnabledAndRemovalClearsLocalSource() throws {
        let store = ShortcutSourceStore(directoryURL: directoryURL)
        try store.beginWaiting(for: .notification)
        XCTAssertEqual(try store.snapshot(for: .notification).settings.setupPhase, .waiting)
        XCTAssertTrue(try store.snapshot(for: .notification).settings.acceptsCaptures)

        let receipt = ShortcutSourceReceipt(
            id: "generated-receipt",
            title: "Generated parcel",
            appName: "Parcel",
            capturedAt: "2026-11-06T00:00:00Z"
        )
        try store.record(receipt, for: .notification)
        try store.record(receipt, for: .notification)
        let received = try store.snapshot(for: .notification)
        XCTAssertEqual(received.settings.setupPhase, .enabled)
        XCTAssertEqual(received.received, [receipt])

        try store.remove(.notification)
        try store.record(receipt, for: .notification)
        XCTAssertEqual(try store.snapshot(for: .notification), ShortcutSourceSnapshot())
        XCTAssertEqual(try store.snapshot(for: .screenshot), ShortcutSourceSnapshot())
    }

    func testSourceAndSetupPresentationsMatchCanvasStates() {
        let item = SourceReceivedItem(id: "generated", title: "包裹已放入驿站", meta: "顺丰速运 · 21:38")
        let settings = ShortcutSourceSettings(
            setupPhase: .enabled,
            allowedApps: ["一", "二", "三", "四"],
            excludedText: ["验证码", "内部"]
        )
        let source = ShortcutSourcePresentation(kind: .notification, settings: settings, items: [item])
        XCTAssertNil(source.notice)
        XCTAssertTrue(source.canPause)
        XCTAssertEqual(source.settingRows.map(\.title), ["允许的应用", "通知内容", "文字规则", "资料说明"])
        XCTAssertEqual(source.settingRows.map(\.value), ["4 个", "标题和正文", "2 条", ""])

        let paused = ShortcutSourcePresentation(
            kind: .notification,
            settings: ShortcutSourceSettings(setupPhase: .enabled, isPaused: true),
            items: [item]
        )
        XCTAssertEqual(paused.notice?.title, "已暂停")
        XCTAssertEqual(paused.notice?.actionTitle, "恢复")
        XCTAssertFalse(paused.canPause)

        let waiting = ShortcutSetupPresentation(kind: .notification, phase: .waiting)
        XCTAssertEqual(waiting.steps.map(\.title), ["收到通知时", "选择 App", "立即运行", "保存通知"])
        XCTAssertEqual(waiting.waitingText, "等待第一条通知")
        XCTAssertTrue(waiting.showsOpenButton)
        XCTAssertFalse(waiting.showsDoneButton)

        let received = ShortcutSetupPresentation(kind: .notification, phase: .enabled, latestItem: item)
        XCTAssertFalse(received.showsOpenButton)
        XCTAssertTrue(received.showsDoneButton)
        let screenshot = ShortcutSetupPresentation(kind: .screenshot, phase: .notEnabled)
        XCTAssertEqual(screenshot.steps.map(\.title), ["截屏时", "立即运行", "保存截图"])
    }

    func testCaptureListTracksShortcutSetupIndependentlyPerSource() {
        let presentation = CaptureSyncPresentation(facts: CaptureSyncFacts(
            notificationShortcutEnabled: true,
            screenshotShortcutEnabled: false,
            notificationLastReceived: "21:38",
            centralHost: "generated.example",
            sendState: .synced(at: nil)
        ))
        XCTAssertEqual(presentation.sources[0].detail, "21:38")
        XCTAssertEqual(presentation.sources[0].action, .openSource)
        XCTAssertEqual(presentation.sources[1].detail, "快捷指令未启用")
        XCTAssertEqual(presentation.sources[1].action, .openShortcutSetup)
    }

    private func notification(
        appId: String = "COM.GENERATED.PARCEL",
        appName: String = "Parcel"
    ) -> IOSNotificationContent {
        IOSNotificationContent(
            appId: appId,
            appName: appName,
            title: "Generated parcel",
            text: "Secret code inside"
        )
    }
}
