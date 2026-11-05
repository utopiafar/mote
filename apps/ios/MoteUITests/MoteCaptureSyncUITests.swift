import XCTest

@MainActor
final class MoteCaptureSyncUITests: XCTestCase {
    func testCaptureSyncPermissionLight() {
        assertPermissionState(appearance: "light")
    }

    func testCaptureSyncPermissionDark() {
        assertPermissionState(appearance: "dark")
    }

    func testAddSourceSheetShowsOnlyNamesAndCloudOpensCentral() {
        let app = launch(state: "permission")
        app.buttons["添加来源"].tap()

        XCTAssertTrue(app.staticTexts["添加来源"].firstMatch.waitForExistence(timeout: 5))
        for label in ["文件", "文件夹", "日历", "设备事件", "云端来源"] {
            let row = app.buttons[label]
            XCTAssertTrue(row.waitForExistence(timeout: 5), "\(label) row is missing")
            XCTAssertGreaterThanOrEqual(row.frame.height, 44, "\(label) target is too short")
        }
        XCTAssertFalse(app.staticTexts["照片"].exists)
        XCTAssertFalse(app.staticTexts["屏幕与应用活动"].exists)

        app.buttons["云端来源"].tap()
        XCTAssertTrue(app.staticTexts["openCentralSources"].waitForExistence(timeout: 3))

        app.buttons["添加来源"].tap()
        XCTAssertTrue(app.buttons["关闭"].waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(app.buttons["关闭"].frame.width, 44)
        XCTAssertGreaterThanOrEqual(app.buttons["关闭"].frame.height, 44)
        app.buttons["关闭"].tap()
        XCTAssertFalse(app.buttons["文件"].waitForExistence(timeout: 2))
    }

    func testShortcutMissingKeepsFixedSourcesAndOffersSetup() {
        let app = launch(state: "shortcutsOff")

        XCTAssertTrue(app.staticTexts["通知"].exists)
        XCTAssertTrue(app.staticTexts["截图"].exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "快捷指令未启用")).count, 2)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@", "设置")).count, 2)

        let setup = app.buttons.matching(NSPredicate(format: "label == %@", "设置")).firstMatch
        XCTAssertGreaterThanOrEqual(setup.frame.height, 44)
        setup.tap()
        XCTAssertTrue(app.staticTexts["openShortcutSetup.notification"].waitForExistence(timeout: 3))

        attachScreenshot(named: "capture-sync-shortcuts-off-light")
    }

    func testSendGroupStatesAndOperations() {
        let pending = launch(state: "pending")
        XCTAssertTrue(pending.staticTexts["待同步 3 条"].exists)
        let sendNow = pending.buttons["立即发送"]
        XCTAssertTrue(sendNow.exists)
        XCTAssertGreaterThanOrEqual(sendNow.frame.height, 44)
        sendNow.tap()
        XCTAssertTrue(pending.staticTexts["sendNow"].waitForExistence(timeout: 3))
        attachScreenshot(named: "capture-sync-pending-light")
        pending.terminate()

        let paused = launch(state: "sendPaused")
        XCTAssertTrue(paused.staticTexts["发送已暂停"].exists)
        XCTAssertEqual(paused.switches["暂停发送"].value as? String, "1")
        attachScreenshot(named: "capture-sync-send-paused-light")
        paused.switches["暂停发送"].tap()
        XCTAssertTrue(paused.staticTexts["已同步"].waitForExistence(timeout: 3))
        paused.terminate()

        let reconnect = launch(state: "reconnect")
        XCTAssertTrue(reconnect.staticTexts["需要重新连接"].exists)
        let connect = reconnect.buttons["连接"]
        XCTAssertTrue(connect.exists)
        XCTAssertGreaterThanOrEqual(connect.frame.height, 44)
        connect.tap()
        XCTAssertTrue(reconnect.staticTexts["reconnect"].waitForExistence(timeout: 3))
        attachScreenshot(named: "capture-sync-reconnect-light")
    }

    func testPauseToggleSendMethodAndStorage() {
        let app = launch(state: "synced")
        XCTAssertTrue(app.staticTexts["已同步 · 21:42"].exists)

        let pause = app.switches["暂停发送"]
        XCTAssertTrue(pause.exists)
        XCTAssertGreaterThanOrEqual(pause.frame.height, 44)
        pause.tap()
        XCTAssertTrue(app.staticTexts["发送已暂停"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.switches["暂停发送"].value as? String, "1")
        XCTAssertTrue(app.staticTexts["setSendPaused.true"].exists)

        app.switches["暂停发送"].tap()
        XCTAssertTrue(app.staticTexts["已同步 · 21:42"].waitForExistence(timeout: 3))

        app.staticTexts["发送方式"].tap()
        XCTAssertTrue(app.staticTexts["openSendMethod"].waitForExistence(timeout: 3))

        app.staticTexts["本机存储"].tap()
        XCTAssertTrue(app.staticTexts["openStorage"].waitForExistence(timeout: 3))
    }

    func testRowsOnlyListAddedSources() {
        let app = launch(state: "minimal")
        XCTAssertTrue(app.staticTexts["通知"].exists)
        XCTAssertTrue(app.staticTexts["截图"].exists)
        XCTAssertTrue(app.staticTexts["添加来源"].firstMatch.exists)
        XCTAssertFalse(app.staticTexts["媒体"].exists)
        XCTAssertFalse(app.staticTexts["文件夹"].exists)

        app.staticTexts["通知"].tap()
        XCTAssertTrue(app.staticTexts["openSource.notification"].waitForExistence(timeout: 3))
    }

    func testMediaPermissionOperationDispatchesDirectly() {
        let app = launch(state: "permission")
        XCTAssertTrue(app.staticTexts["等待采集权限"].exists)
        let fix = app.buttons["处理"]
        XCTAssertTrue(fix.exists)
        XCTAssertGreaterThanOrEqual(fix.frame.height, 44)
        fix.tap()
        XCTAssertTrue(app.staticTexts["handleMediaPermission"].waitForExistence(timeout: 3))
    }

    private func assertPermissionState(appearance: String) {
        let app = launch(state: "permission", appearance: appearance)
        XCTAssertTrue(app.staticTexts["通知"].exists)
        XCTAssertTrue(app.staticTexts["截图"].exists)
        XCTAssertTrue(app.staticTexts["媒体"].exists)
        XCTAssertTrue(app.staticTexts["文件夹"].exists)
        XCTAssertTrue(app.staticTexts["等待采集权限"].exists)
        XCTAssertTrue(app.staticTexts["mote.example.net"].exists)
        XCTAssertTrue(app.staticTexts["已同步 · 21:42"].exists)
        XCTAssertTrue(app.staticTexts["发送方式"].exists)
        XCTAssertTrue(app.staticTexts["暂停发送"].exists)
        XCTAssertTrue(app.staticTexts["本机存储"].exists)
        XCTAssertFalse(app.staticTexts["采集中"].exists)

        for label in ["返回", "添加来源", "处理"] {
            let button = app.buttons[label].firstMatch
            XCTAssertTrue(button.exists, "\(label) button is missing")
            XCTAssertGreaterThanOrEqual(button.frame.width, 44, "\(label) target is too narrow")
            XCTAssertGreaterThanOrEqual(button.frame.height, 44, "\(label) target is too short")
        }
        let pause = app.switches["暂停发送"]
        XCTAssertTrue(pause.exists)
        XCTAssertGreaterThanOrEqual(pause.frame.height, 44)

        attachScreenshot(named: "capture-sync-permission-\(appearance)")
    }

    private func launch(state: String, appearance: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-MoteCaptureSyncPreview",
            "-MoteCaptureSyncState", state,
            "-MoteAppearance", appearance,
        ]
        app.launch()
        XCTAssertTrue(app.staticTexts["采集与同步"].waitForExistence(timeout: 15))
        return app
    }

    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
