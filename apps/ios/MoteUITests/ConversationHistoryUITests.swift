import XCTest

@MainActor
final class ConversationHistoryUITests: XCTestCase {
    func testListLight() { assertList(appearance: "light") }
    func testListDark() { assertList(appearance: "dark") }

    func testEmptyHasOnlyComposerAndBack() {
        let app = launch(state: "empty")
        XCTAssertTrue(app.textFields["问一问"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["本周"].exists)
        XCTAssertFalse(app.staticTexts["更早"].exists)
        XCTAssertFalse(app.staticTexts["还没有对话。"].exists)
        XCTAssertFalse(app.buttons["发送"].exists)
        screenshot("history-empty-light")
    }

    func testComposerAndRowDispatch() {
        let app = launch()
        let field = app.textFields["问一问"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["发送"].exists)
        app.buttons["添加图片"].tap()
        XCTAssertTrue(app.staticTexts["image"].waitForExistence(timeout: 2))
        app.buttons["conversation-one"].tap()
        XCTAssertTrue(app.staticTexts["open.one"].waitForExistence(timeout: 2))
        field.tap()
        field.typeText("hello")
        XCTAssertTrue(app.buttons["history-send"].waitForExistence(timeout: 2))
        app.buttons["history-send"].tap()
        XCTAssertTrue(app.staticTexts["send.hello"].waitForExistence(timeout: 2))
    }

    func testLongPressDeletionKeepsRowWhenCancelledAndRemovesItAfterConfirmation() {
        let app = launch()
        let row = app.buttons["conversation-one"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.press(forDuration: 1)
        app.buttons["删除这段对话"].tap()
        XCTAssertTrue(app.staticTexts["会删除这段对话的所有问答。已单独保存的记录保留。"].exists)
        app.buttons["取消"].tap()
        XCTAssertTrue(row.exists)
        row.press(forDuration: 1)
        app.buttons["删除这段对话"].tap()
        app.buttons["删除对话"].tap()
        XCTAssertFalse(row.waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["conversation-two"].exists)
    }

    func testSwipeDeletionAndFailureDetails() {
        let app = launch(state: "deleteFailure")
        let row = app.buttons["conversation-one"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.swipeLeft()
        app.buttons["删除这段对话"].tap()
        app.buttons["删除对话"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 2))
        row.press(forDuration: 1)
        XCTAssertTrue(app.buttons["查看详情"].waitForExistence(timeout: 2))
        app.buttons["查看详情"].tap()
        XCTAssertTrue(app.staticTexts["删除未完成，连接或中央暂不可用。"].waitForExistence(timeout: 2))
    }

    func testTypingAppearance() {
        let app = launch(state: "typing")
        XCTAssertTrue(app.buttons["发送"].waitForExistence(timeout: 10))
        screenshot("history-typing-light")
    }

    private func assertList(appearance: String) {
        let app = launch(appearance: appearance)
        XCTAssertTrue(app.staticTexts["本周"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["更早"].exists)
        XCTAssertEqual(app.buttons.matching(identifier: "conversation-one").count, 1)
        XCTAssertTrue(app.staticTexts["今天"].exists)
        XCTAssertTrue(app.staticTexts["10月21日"].exists)
        for label in ["返回", "添加图片"] {
            XCTAssertGreaterThanOrEqual(app.buttons[label].frame.width, 44)
            XCTAssertGreaterThanOrEqual(app.buttons[label].frame.height, 44)
        }
        screenshot("history-list-\(appearance)")
    }

    private func launch(state: String = "list", appearance: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteHistoryPreview", "-MoteHistoryState", state, "-MoteAppearance", appearance]
        app.launch()
        return app
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
