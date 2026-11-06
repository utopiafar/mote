import XCTest

@MainActor
final class ConversationUITests: XCTestCase {
    func testAnsweredLight() { assertAnswered(appearance: "light") }
    func testAnsweredDark() { assertAnswered(appearance: "dark") }

    // A05: the page has a back button and neither 对话历史 nor 新对话 chrome.
    func testPageHasBackOnlyChrome() {
        let app = launch(state: "answered")
        XCTAssertTrue(app.buttons["conversation-back"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["对话历史"].exists)
        XCTAssertFalse(app.buttons["新对话"].exists)
        XCTAssertFalse(app.staticTexts["新对话"].exists)
    }

    // A05: back returns to the conversation list.
    func testBackReturnsToConversationList() {
        let app = launch(state: "flow")
        openConversation(in: app)
        app.buttons["conversation-back"].tap()
        XCTAssertTrue(app.staticTexts["对话"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["conversation-\(ConversationId)"].exists)
    }

    // A06: numbered citation chips and cards with source and location.
    func testAnswerShowsNumberedCitationCards() {
        let app = launch(state: "answered")
        XCTAssertTrue(app.buttons["conversation-back"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS '按实际用量分摊'")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts["暖气费按实际用量分摊，月底前给账单照片"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["记录 · 今天 14:20"].exists)
        XCTAssertTrue(app.staticTexts["租房合同 2026.pdf"].exists)
        XCTAssertTrue(app.staticTexts["第 4 页"].exists)
    }

    // A06: tapping a citation card opens the original at the cited position.
    func testCitationCardOpensOriginal() {
        let app = launch(state: "flow")
        openConversation(in: app)
        app.staticTexts["暖气费按实际用量分摊，月底前给账单照片"].tap()
        XCTAssertTrue(app.staticTexts["opened.\(EvidenceA)"].waitForExistence(timeout: 5))
    }

    // A08: while answering, the composer shows only the stop control.
    func testStreamingShowsOnlyStop() {
        let app = launch(state: "streaming")
        XCTAssertTrue(app.buttons["停止"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["发送"].exists)
        XCTAssertFalse(app.buttons["history-send"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS '合同第 4 页写的是两个月'")).firstMatch.exists)
        XCTAssertGreaterThanOrEqual(app.buttons["停止"].frame.width, 44)
        XCTAssertGreaterThanOrEqual(app.buttons["停止"].frame.height, 44)
        screenshot("conversation-streaming-light")
    }

    // A08: stop cancels the run and restores the question for editing.
    func testStopRestoresTheQuestion() {
        let app = launch(state: "streaming")
        XCTAssertTrue(app.buttons["停止"].waitForExistence(timeout: 10))
        app.buttons["停止"].tap()
        let field = app.textFields["你的问题"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "押金是多少？")
        XCTAssertTrue(app.buttons["发送"].waitForExistence(timeout: 5),
                      app.staticTexts["conversation-preview-state"].label)
        XCTAssertGreaterThanOrEqual(app.buttons["发送"].frame.width, 44)
        XCTAssertGreaterThanOrEqual(app.buttons["发送"].frame.height, 44)
    }

    // A08: offline shows the notice and retry action.
    func testOfflineShowsNoticeAndRetry() {
        let app = launch(state: "offline")
        XCTAssertTrue(app.staticTexts["没有连上中央"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["重试"].exists)
        screenshot("conversation-offline-light")
    }

    // Anchored conversations carry the scope chip with a clear control.
    func testAnchoredShowsScopeChipAndClear() {
        let app = launch(state: "anchored")
        XCTAssertTrue(app.buttons["conversation-back"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["租房合同 2026.pdf"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["清除范围"].exists)
        screenshot("conversation-anchored-light")
    }

    // A07: every completed answer offers 保存为记录 next to 复制 and 更多.
    func testAnswerActionsIncludeSaveCopyAndMore() {
        let app = launch(state: "answered")
        XCTAssertTrue(app.buttons["conversation-back"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons.matching(identifier: "保存为记录").count, 2)
        XCTAssertEqual(app.buttons.matching(identifier: "复制").count, 2)
        XCTAssertEqual(app.buttons.matching(identifier: "更多").count, 2)
        let save = app.buttons.matching(identifier: "保存为记录").element(boundBy: 0)
        XCTAssertGreaterThanOrEqual(save.frame.width, 44)
        XCTAssertGreaterThanOrEqual(save.frame.height, 44)
        app.buttons.matching(identifier: "更多").element(boundBy: 0).tap()
        XCTAssertTrue(app.staticTexts["本轮详情"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["使用模型"].exists)
    }

    // S05: the panel quotes the answer, takes a supplement, and saves a record
    // without opening or changing the editor draft.
    func testSaveAsRecordShowsQuoteSupplementAndDescription() {
        let app = launch(state: "answered")
        let save = app.buttons.matching(identifier: "保存为记录").element(boundBy: 0)
        XCTAssertTrue(save.waitForExistence(timeout: 10))
        save.tap()
        XCTAssertTrue(app.staticTexts["保存为记录"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["按实际用量分摊，月底前把账单照片发给房东；押金下个月退，需要收据。"].exists)

        let note = app.textFields["mote-share-note"]
        XCTAssertTrue(note.exists)
        note.tap()
        note.typeText("周一确认")
        XCTAssertTrue(app.buttons["资料说明"].exists)
        XCTAssertFalse(app.textFields["mote-editor-text"].exists)

        app.buttons["保存"].tap()
        XCTAssertTrue(app.staticTexts["已保存"].waitForExistence(timeout: 5))
        let payload = app.staticTexts["conversation-preview-saved"]
        XCTAssertTrue(payload.waitForExistence(timeout: 5))
        XCTAssertTrue(payload.label.hasPrefix("暖气费是怎么约定的？\n\n按实际用量分摊"))
        XCTAssertTrue(payload.label.contains("周一确认"))
        XCTAssertFalse(app.textFields["mote-editor-text"].exists)
    }

    private let ConversationId = "11111111-2222-3333-4444-555555555555"
    private let EvidenceA = "aaaaaaaa-1111-2222-3333-444444444444"

    private func openConversation(in app: XCUIApplication) {
        let row = app.buttons["conversation-\(ConversationId)"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS '按实际用量分摊'")).firstMatch
            .waitForExistence(timeout: 10))
    }

    private func assertAnswered(appearance: String) {
        let app = launch(state: "answered", appearance: appearance)
        XCTAssertTrue(app.buttons["conversation-back"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["暖气费是怎么约定的？"].exists)
        XCTAssertTrue(app.staticTexts["记录 · 今天 14:20"].exists)
        XCTAssertEqual(app.buttons.matching(identifier: "保存为记录").count, 2)
        XCTAssertEqual(app.buttons.matching(identifier: "复制").count, 2)
        XCTAssertEqual(app.buttons.matching(identifier: "更多").count, 2)
        for label in ["返回", "添加图片"] {
            XCTAssertGreaterThanOrEqual(app.buttons[label].frame.width, 44, label)
            XCTAssertGreaterThanOrEqual(app.buttons[label].frame.height, 44, label)
        }
        for label in ["保存为记录", "复制", "更多"] {
            let matches = app.buttons.matching(identifier: label)
            for index in 0..<matches.count {
                let element = matches.element(boundBy: index)
                XCTAssertGreaterThanOrEqual(element.frame.width, 44, label)
                XCTAssertGreaterThanOrEqual(element.frame.height, 44, label)
            }
        }
        screenshot("conversation-answered-\(appearance)")
    }

    private func launch(state: String = "answered", appearance: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteConversationPreview", "-MoteConversationState", state,
                               "-MoteAppearance", appearance]
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
