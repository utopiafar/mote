import XCTest

/// G08 iOS walkthrough: every destination that the current iOS client owns is
/// reachable from the real root (not a preview fixture) and returns home.
@MainActor
final class MoteDestinationUITests: XCTestCase {
    func testHomeAndMenuDestinationsOpenTheirScreens() {
        resetDraft()
        defer { resetDraft() }

        let app = XCUIApplication()
        app.launchArguments = ["-MoteAppearance", "light"]
        app.launch()
        XCTAssertTrue(app.buttons["我的 Mote"].waitForExistence(timeout: 20))

        open(app, "搜索")
        XCTAssertTrue(app.staticTexts["搜索"].waitForExistence(timeout: 10))
        app.buttons["关闭"].tap()
        XCTAssertTrue(app.buttons["我的 Mote"].waitForExistence(timeout: 10))

        open(app, "问一问")
        XCTAssertTrue(app.textFields["问一问"].waitForExistence(timeout: 10), "问一问 did not open the conversation list")
        app.buttons["返回"].tap()
        XCTAssertTrue(app.buttons["我的 Mote"].waitForExistence(timeout: 10))

        let record = app.buttons["继续草稿"].exists ? app.buttons["继续草稿"] : app.buttons["记录"]
        XCTAssertTrue(record.exists)
        record.tap()
        XCTAssertTrue(app.textFields["mote-editor-text"].waitForExistence(timeout: 10), "记录 did not open the editor")
        app.buttons["返回"].tap()
        XCTAssertTrue(app.buttons["我的 Mote"].waitForExistence(timeout: 10))

        app.buttons["我的 Mote"].tap()
        XCTAssertTrue(app.buttons["menu-library"].waitForExistence(timeout: 10))
        app.buttons["menu-library"].tap()
        XCTAssertTrue(app.textFields["library-search"].waitForExistence(timeout: 10), "资料与记忆 did not open")
        app.buttons["返回"].tap()
        XCTAssertTrue(app.buttons["menu-library"].waitForExistence(timeout: 10))

        app.buttons["采集与同步"].tap()
        XCTAssertTrue(app.staticTexts["采集与同步"].waitForExistence(timeout: 10), "采集与同步 did not open")
        app.buttons["返回"].firstMatch.tap()
        XCTAssertTrue(app.buttons["我的 Mote"].waitForExistence(timeout: 10))

        app.buttons["我的 Mote"].tap()
        XCTAssertTrue(app.buttons["menu-library"].waitForExistence(timeout: 10))
        app.buttons["设置"].tap()
        XCTAssertTrue(app.staticTexts["设置"].waitForExistence(timeout: 10), "设置 did not open")
        app.buttons["返回"].tap()
        XCTAssertTrue(app.buttons["menu-library"].waitForExistence(timeout: 10))

        app.buttons["返回"].firstMatch.tap()
        XCTAssertTrue(app.buttons["我的 Mote"].waitForExistence(timeout: 10), "我的 Mote did not return home")
    }

    private func open(_ app: XCUIApplication, _ label: String) {
        let button = app.buttons[label]
        XCTAssertTrue(button.waitForExistence(timeout: 10), "\(label) is missing from home")
        button.tap()
    }

    private func resetDraft() {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteEditorPreview", "-MoteEditorFixture", "empty"]
        app.launch()
        XCTAssertTrue(app.textFields["mote-editor-text"].waitForExistence(timeout: 15))
        app.terminate()
    }
}
