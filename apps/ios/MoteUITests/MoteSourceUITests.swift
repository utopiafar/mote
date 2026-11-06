import XCTest

@MainActor
final class MoteSourceUITests: XCTestCase {
    func testCaptureNavigationPersistsSourceTextRules() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["我的 Mote"].waitForExistence(timeout: 15))
        app.buttons["我的 Mote"].tap()
        app.buttons["采集与同步"].tap()
        let setup = app.buttons.matching(NSPredicate(format: "label == %@", "设置")).firstMatch
        XCTAssertTrue(setup.waitForExistence(timeout: 5))
        setup.tap()
        XCTAssertTrue(app.staticTexts["收到通知时"].waitForExistence(timeout: 5))
        app.buttons["返回"].tap()

        app.buttons["文字规则，未设置"].tap()
        let editor = app.textViews["文字规则"]
        editor.tap()
        editor.typeText("密码")
        app.buttons["保存"].tap()
        XCTAssertTrue(app.buttons["文字规则，1 条"].waitForExistence(timeout: 3))
        app.buttons["返回"].tap()

        XCTAssertTrue(setup.waitForExistence(timeout: 5))
        setup.tap()
        XCTAssertTrue(app.staticTexts["收到通知时"].waitForExistence(timeout: 5))
        app.buttons["返回"].tap()
        app.buttons["文字规则，1 条"].tap()
        XCTAssertEqual(app.textViews["文字规则"].value as? String, "密码")
        app.buttons["取消"].tap()
    }

    func testNotificationSourceLight() {
        assertSource(appearance: "light")
    }

    func testNotificationSourceDark() {
        assertSource(appearance: "dark")
    }

    func testSourcePauseResumeAndSettingsControls() {
        let app = launchSource(state: "receiving")
        for label in ["快捷指令，已启用", "允许的应用，4 个", "通知内容，标题和正文", "文字规则，2 条", "资料说明"] {
            let row = app.buttons[label]
            XCTAssertTrue(row.exists, "\(label) is missing")
            XCTAssertGreaterThanOrEqual(row.frame.height, 44)
        }
        app.buttons["暂停"].tap()
        XCTAssertTrue(app.staticTexts["已暂停"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["暂停"].exists)
        app.buttons["恢复"].tap()
        XCTAssertTrue(app.buttons["暂停"].waitForExistence(timeout: 3))
    }

    func testSettingsEditorsUpdateRulesContentAndDescription() {
        let app = launchSource(state: "receiving")

        app.buttons["文字规则，2 条"].tap()
        let rules = app.textViews["文字规则"]
        XCTAssertTrue(rules.waitForExistence(timeout: 3))
        rules.tap()
        rules.typeText("密码")
        XCTAssertEqual(rules.value as? String, "密码验证码\n内部")
        app.buttons["保存"].tap()
        app.buttons["文字规则，2 条"].tap()
        XCTAssertEqual(app.textViews["文字规则"].value as? String, "密码验证码\n内部")
        app.buttons["取消"].tap()

        app.buttons["通知内容，标题和正文"].tap()
        app.buttons["仅标题"].tap()
        app.buttons["保存"].tap()
        XCTAssertTrue(app.buttons["通知内容，仅标题"].waitForExistence(timeout: 3))

        app.buttons["资料说明"].tap()
        let description = app.textViews["资料说明"]
        description.tap()
        description.typeText("个人通知")
        app.buttons["保存"].tap()
        app.buttons["资料说明"].tap()
        XCTAssertEqual(app.textViews["资料说明"].value as? String, "个人通知")
        app.buttons["取消"].tap()
    }

    func testRemoveSourceClearsReceivedItemsAndReturnsToDisabledState() {
        let app = launchSource(state: "receiving")
        app.buttons["移除来源"].tap()
        XCTAssertTrue(app.staticTexts["快捷指令未启用"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["收到"].exists)
        XCTAssertTrue(app.buttons["快捷指令，未启用"].exists)
    }

    func testEmptySourceOpensNumberedShortcutSetup() {
        let app = launchSource(state: "empty")
        XCTAssertTrue(app.staticTexts["快捷指令未启用"].exists)
        XCTAssertFalse(app.staticTexts["收到"].exists)
        app.buttons["设置"].tap()
        for step in ["收到通知时", "选择 App", "立即运行", "保存通知"] {
            XCTAssertTrue(app.staticTexts[step].waitForExistence(timeout: 3))
        }
        XCTAssertTrue(app.buttons["打开快捷指令"].exists)
    }

    func testScreenshotSourceUsesScreenshotRows() {
        let app = launchSource(kind: "screenshot", state: "receiving")
        XCTAssertTrue(app.staticTexts["截图"].exists)
        XCTAssertTrue(app.staticTexts["白板：第三季度路线图"].exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "允许的应用")).firstMatch.exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "通知内容")).firstMatch.exists)
        attachScreenshot(named: "source-screenshot-light")
    }

    func testShortcutSetupLightAndDark() {
        assertSetup(appearance: "light")
        assertSetup(appearance: "dark")
    }

    func testShortcutSetupWaitingThenReceived() {
        let app = launchSetup(state: "start")
        let open = app.buttons["打开快捷指令"]
        XCTAssertGreaterThanOrEqual(open.frame.height, 44)
        open.tap()
        XCTAssertTrue(app.staticTexts["等待第一条通知"].waitForExistence(timeout: 3))
        attachScreenshot(named: "shortcut-waiting-light")
        app.terminate()

        let received = launchSetup(state: "received")
        XCTAssertTrue(received.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "已收到 · 顺丰速运 21:38")
        ).firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(received.buttons["完成"].exists)
        XCTAssertFalse(received.buttons["打开快捷指令"].exists)
        attachScreenshot(named: "shortcut-received-light")
    }

    func testScreenshotShortcutSteps() {
        let app = launchSetup(kind: "screenshot", state: "start")
        for step in ["截屏时", "立即运行", "保存截图"] {
            XCTAssertTrue(app.staticTexts[step].exists)
        }
        XCTAssertFalse(app.staticTexts["选择 App"].exists)
        attachScreenshot(named: "shortcut-screenshot-light")
    }

    private func assertSource(appearance: String) {
        let app = launchSource(state: "receiving", appearance: appearance)
        for text in ["通知", "收到", "包裹已放入驿站", "顺丰速运 · 21:38", "设置"] {
            XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 5), "\(text) is missing")
        }
        for label in ["暂停", "移除来源"] {
            XCTAssertTrue(app.buttons[label].waitForExistence(timeout: 5), "\(label) is missing")
        }
        XCTAssertGreaterThanOrEqual(app.buttons["返回"].frame.height, 44)
        attachScreenshot(named: "source-notify-\(appearance)")
    }

    private func assertSetup(appearance: String) {
        let app = launchSetup(state: "start", appearance: appearance)
        for text in ["通知", "收到通知时", "选择 App", "立即运行", "保存通知"] {
            XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 5))
        }
        XCTAssertTrue(app.buttons["打开快捷指令"].exists)
        attachScreenshot(named: "shortcut-start-\(appearance)")
        app.terminate()
    }

    private func launchSource(
        kind: String = "notify",
        state: String,
        appearance: String = "light"
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-MoteSourcePreview",
            "-MoteSourceKind", kind,
            "-MoteSourceState", state,
            "-MoteAppearance", appearance,
        ]
        app.launch()
        XCTAssertTrue(app.buttons["返回"].waitForExistence(timeout: 15))
        return app
    }

    private func launchSetup(
        kind: String = "notify",
        state: String,
        appearance: String = "light"
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-MoteShortcutSetupPreview",
            "-MoteSourceKind", kind,
            "-MoteShortcutState", state,
            "-MoteAppearance", appearance,
        ]
        app.launch()
        XCTAssertTrue(app.buttons["返回"].waitForExistence(timeout: 15))
        return app
    }

    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
