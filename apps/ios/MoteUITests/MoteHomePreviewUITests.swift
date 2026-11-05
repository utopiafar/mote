import XCTest

@MainActor
final class MoteHomePreviewUITests: XCTestCase {
    func testHomeLight() {
        assertHome(appearance: "light")
    }

    func testHomeDark() {
        assertHome(appearance: "dark")
    }

    func testHomeActionsDispatchAndHighlightsOnlyAppearWhenSupplied() {
        let app = launch(state: "highlights")
        XCTAssertTrue(app.buttons["生成的日程、待补充"].exists)
        XCTAssertTrue(app.buttons["生成的发现、查看发现"].exists)
        XCTAssertLessThan(app.buttons["生成的日程、待补充"].frame.minY, app.staticTexts["今天"].frame.minY)

        app.buttons["生成的日程、待补充"].tap()
        XCTAssertTrue(app.staticTexts["highlight.schedule.generated-schedule"].waitForExistence(timeout: 2))
        app.buttons["生成的发现、查看发现"].tap()
        XCTAssertTrue(app.staticTexts["highlight.discovery.generated-discovery"].waitForExistence(timeout: 2))

        app.buttons["白板：第三季度路线图、18:02 · 照片"].tap()
        XCTAssertTrue(app.staticTexts["original.generated-board"].waitForExistence(timeout: 2))

        for (label, action) in [("我的 Mote", "profile"), ("搜索", "search"), ("问一问", "ask"), ("记录", "record"), ("拍照", "camera"), ("录音", "microphone")] {
            app.buttons[label].tap()
            XCTAssertTrue(app.staticTexts[action].waitForExistence(timeout: 2), "\(label) did not dispatch \(action)")
        }
    }

    func testFirstUseAndDraftStates() {
        let app = launch(state: "firstUse")
        XCTAssertTrue(app.staticTexts["连接你的 Mote"].exists)
        XCTAssertTrue(app.buttons["连接"].exists)
        app.buttons["连接"].tap()
        XCTAssertTrue(app.staticTexts["notice.connect"].waitForExistence(timeout: 2))
        app.buttons["记录"].tap()
        XCTAssertTrue(app.staticTexts["record"].waitForExistence(timeout: 2))

        app.terminate()
        app.launchArguments = ["-MoteHomePreview", "-MoteHomeState", "draft", "-MoteAppearance", "light"]
        app.launch()
        XCTAssertTrue(app.buttons["继续草稿"].waitForExistence(timeout: 10))
        app.buttons["继续草稿"].tap()
        XCTAssertTrue(app.staticTexts["record"].waitForExistence(timeout: 2))
    }

    func testStatusActionUsesSharedOperation() {
        let app = launch(state: "permission")
        XCTAssertTrue(app.staticTexts["等待采集权限"].waitForExistence(timeout: 10))
        app.buttons["处理"].tap()
        XCTAssertTrue(app.staticTexts["notice.open_permissions"].waitForExistence(timeout: 2))
    }

    private func assertHome(appearance: String) {
        let app = launch(state: "normal", appearance: appearance)
        XCTAssertTrue(app.staticTexts["今天"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["昨天"].exists)
        XCTAssertFalse(app.staticTexts["采集中"].exists)
        XCTAssertFalse(app.staticTexts["连接你的 Mote"].exists)
        XCTAssertFalse(app.staticTexts["生成的日程"].exists)
        for label in ["我的 Mote", "搜索", "问一问", "记录", "拍照", "录音"] {
            let button = app.buttons[label].firstMatch
            XCTAssertTrue(button.exists, "\(label) is missing")
            XCTAssertGreaterThanOrEqual(button.frame.width, 44, "\(label) target is too narrow")
            XCTAssertGreaterThanOrEqual(button.frame.height, 44, "\(label) target is too short")
        }
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "home-normal-\(appearance)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func launch(state: String, appearance: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteHomePreview", "-MoteHomeState", state, "-MoteAppearance", appearance]
        app.launch()
        return app
    }
}
