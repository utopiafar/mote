import XCTest

@MainActor
final class MoteUITests: XCTestCase {
    func testAppLaunches() {
        let app = XCUIApplication()
        app.launch()

        XCTAssertEqual(app.state, .runningForeground)
        XCTAssertTrue(app.windows.firstMatch.exists)
    }

    func testDefaultLaunchShowsFirstUseHome() {
        resetDraft()
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.buttons["我的 Mote"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["连接你的 Mote"].exists)
        XCTAssertTrue(app.buttons["连接"].exists)
        XCTAssertTrue(app.buttons["搜索"].exists)
        XCTAssertTrue(app.buttons["问一问"].exists)
        XCTAssertTrue(app.buttons["记录"].exists)
        XCTAssertTrue(app.buttons["拍照"].exists)
        XCTAssertTrue(app.buttons["录音"].exists)
        XCTAssertFalse(app.staticTexts["今天"].exists)
    }

    func testDefaultHomeActionsOpenADestination() {
        resetDraft()
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.buttons["连接"].waitForExistence(timeout: 10))
        for label in ["连接", "问一问", "记录", "拍照", "录音", "搜索"] {
            app.buttons[label].tap()
            let control = app.buttons.matching(
                NSPredicate(format: "label == %@ OR label == %@", "关闭", "返回")
            ).firstMatch
            XCTAssertTrue(control.waitForExistence(timeout: 5), "\(label) has no destination")
            if ["记录", "拍照", "录音"].contains(label) {
                XCTAssertTrue(app.textFields["mote-editor-text"].waitForExistence(timeout: 5), "\(label) did not open the editor")
            }
            control.tap()
            XCTAssertTrue(app.buttons[label].waitForExistence(timeout: 2), "\(label) did not return to home")
        }
    }

    private func resetDraft() {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteEditorPreview", "-MoteEditorFixture", "empty"]
        app.launch()
        XCTAssertTrue(app.textFields["mote-editor-text"].waitForExistence(timeout: 10))
        app.terminate()
    }
}
