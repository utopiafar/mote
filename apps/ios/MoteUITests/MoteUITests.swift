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
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.buttons["连接"].waitForExistence(timeout: 10))
        app.buttons["连接"].tap()
        XCTAssertTrue(app.staticTexts["连接你的 Mote"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["扫描二维码"].exists)
        app.buttons["返回"].tap()
        XCTAssertTrue(app.buttons["连接"].waitForExistence(timeout: 2), "连接 did not return to home")
        for label in ["问一问", "记录", "拍照", "录音", "搜索"] {
            app.buttons[label].tap()
            XCTAssertTrue(app.buttons["关闭"].waitForExistence(timeout: 2), "\(label) has no destination")
            app.buttons["关闭"].tap()
            XCTAssertTrue(app.buttons[label].waitForExistence(timeout: 2), "\(label) did not return to home")
        }
    }

    func testFirstUseHomeOpensConnection() {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteAppearance", "light"]
        app.launch()

        XCTAssertTrue(app.buttons["连接"].waitForExistence(timeout: 10))
        app.buttons["连接"].tap()
        XCTAssertTrue(app.staticTexts["连接你的 Mote"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["扫描二维码"].exists)
        XCTAssertTrue(app.buttons["粘贴邀请"].exists)
        XCTAssertTrue(app.buttons["选择邀请文件"].exists)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "home-to-connect-light"
        attachment.lifetime = .keepAlways
        add(attachment)
        app.buttons["返回"].tap()
        XCTAssertTrue(app.buttons["连接"].waitForExistence(timeout: 5), "Returning from connection should show home")
    }

    func testEntryDeepLinksOpenAskAndRecordDestinations() {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.buttons["问一问"].waitForExistence(timeout: 10))

        app.open(URL(string: "mote://entry/ask")!)
        XCTAssertTrue(app.navigationBars["问一问"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["关闭"].exists)
        app.buttons["关闭"].tap()

        XCTAssertTrue(app.buttons["记录"].waitForExistence(timeout: 5))
        app.open(URL(string: "mote://entry/record")!)
        XCTAssertTrue(app.navigationBars["记录"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["关闭"].exists)
    }
}
