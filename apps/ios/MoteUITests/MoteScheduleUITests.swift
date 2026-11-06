import XCTest

@MainActor
final class MoteScheduleUITests: XCTestCase {
    func testScheduleScreensLight() { captureScreens("light") }
    func testScheduleScreensDark() { captureScreens("dark") }

    func testHomeOpensScheduleAndTaskAndPermissionFailurePaths() {
        let app = launch("home", "light")
        let first = app.buttons["和陈老师讨论方案、时间待补充"]
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["复查租房合同、时间待补充"].exists)
        XCTAssertFalse(app.buttons["团队周会、时间待补充"].exists)
        first.tap()
        XCTAssertTrue(app.staticTexts["日程与待办"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["此功能将在后续版本提供"].exists)
        let action = app.buttons["schedule-action-00000000-0000-4000-8000-000000000001"]
        XCTAssertTrue(action.waitForExistence(timeout: 10))
        action.tap()
        XCTAssertTrue(app.buttons["schedule-save-time"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["查看原文依据"].exists)
        app.buttons["schedule-save-time"].tap()
        XCTAssertTrue(action.waitForExistence(timeout: 5))
        action.tap()
        XCTAssertTrue(app.buttons["核对并添加到日历"].waitForExistence(timeout: 5))
        app.buttons["忽略这条建议"].tap()
        app.buttons["schedule-confirm-dismiss"].firstMatch.tap()
        XCTAssertTrue(action.waitForExistence(timeout: 5))
        XCTAssertTrue(action.label.contains("已忽略"))
        app.buttons["待办"].tap()
        XCTAssertTrue(app.staticTexts["整理会议记录"].waitForExistence(timeout: 5))
        app.buttons["标记完成"].tap()
        XCTAssertTrue(app.staticTexts["已完成"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["整理会议记录"].exists)
        app.buttons["日程"].tap()
        app.buttons["更多"].tap()
        app.buttons["schedule-permission"].tap()
        XCTAssertTrue(app.staticTexts["未授权，不读取或写入日历。可随时重新连接。"].waitForExistence(timeout: 5))
        app.terminate()
    }

    func testProfileMenuOpensScheduleWithoutPlaceholder() {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteProfilePreview", "-MoteProfileState", "menu-normal"]
        app.launch()
        let row = app.buttons["menu-schedule"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(app.staticTexts["日程与待办"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["此功能将在后续版本提供"].exists)
        app.terminate()
    }

    private func captureScreens(_ appearance: String) {
        for state in ["home", "list", "empty"] {
            let app = launch(state, appearance)
            let ready = state == "home" ? app.buttons["和陈老师讨论方案、时间待补充"] : app.staticTexts["日程与待办"]
            XCTAssertTrue(ready.waitForExistence(timeout: 15), state)
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "schedule-\(state)-\(appearance)"
            attachment.lifetime = .keepAlways
            add(attachment)
            app.terminate()
        }
    }
    private func launch(_ state: String, _ appearance: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteSchedulePreview", "-MoteScheduleState", state, "-MoteAppearance", appearance]
        app.launch()
        return app
    }
}
