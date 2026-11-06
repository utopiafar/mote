import XCTest

@MainActor
final class MoteMemoryDetailUITests: XCTestCase {
    func testMemoryDetailStates() {
        for appearance in ["light", "dark"] {
            for state in ["base", "more", "correct", "history", "info", "delete"] {
                let app = launch(state: state, appearance: appearance)
                XCTAssertTrue(app.staticTexts["租房押金"].waitForExistence(timeout: 10), state)
                XCTAssertTrue(app.staticTexts["押金为两个月租金，下个月退，需要收据。"].exists, state)
                XCTAssertTrue(app.staticTexts["今天起"].exists, state)
                XCTAssertTrue(app.buttons["memory-evidence-capture.generated-lease"].exists, state)
                XCTAssertTrue(app.buttons["memory-evidence-capture.generated-heating"].exists, state)
                attach("memory-detail-\(state)-\(appearance)", app)
                app.terminate()
            }
        }
    }

    func testEvidenceOpensTheOriginal() {
        let app = launch(state: "base")
        XCTAssertTrue(app.buttons["memory-evidence-capture.generated-lease"].waitForExistence(timeout: 10))
        app.buttons["memory-evidence-capture.generated-lease"].tap()
        XCTAssertTrue(app.buttons["围绕这份资料提问"].waitForExistence(timeout: 5))
        attach("memory-detail-evidence", app)
        app.buttons["返回"].tap()
        XCTAssertTrue(app.staticTexts["证据"].waitForExistence(timeout: 5))
    }

    func testMoreCorrectionHistoryInfoAndDelete() {
        let app = launch(state: "base")
        app.buttons["memory-detail-more"].tap()
        XCTAssertTrue(app.buttons["memory-more-correct"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["memory-more-history"].exists)
        XCTAssertTrue(app.buttons["memory-more-info"].exists)
        XCTAssertTrue(app.buttons["memory-more-delete"].exists)
        attach("memory-detail-more-interaction", app)

        app.buttons["memory-more-correct"].tap()
        XCTAssertTrue(app.textFields["memory-correction-title"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["memory-correction-title"].value as? String, "租房押金")
        XCTAssertTrue(app.textViews["memory-correction-statement"].exists)
        XCTAssertTruthy(app.textViews["memory-correction-statement"].value, contains: "押金为两个月租金")
        XCTAssertTrue(app.textViews["memory-correction-uncertainty"].exists)
        XCTAssertTrue(app.buttons["memory-correction-valid-from"].exists)
        XCTAssertTrue(app.buttons["memory-correction-valid-until"].exists)
        XCTAssertTrue(app.buttons["memory-correction-save"].exists)
        XCTAssertTrue(app.buttons["memory-correction-cancel"].exists)
        app.buttons["memory-correction-cancel"].tap()

        app.buttons["memory-detail-more"].tap()
        app.buttons["memory-more-history"].tap()
        XCTAssertTrue(app.staticTexts["当前版本 · 今天起"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["历史版本 · 10月1日 – 今天"].exists)
        app.buttons["关闭"].tap()

        app.buttons["memory-detail-more"].tap()
        app.buttons["memory-more-info"].tap()
        XCTAssertTrue(app.staticTexts["精选记忆"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["模型生成"].exists)
        XCTAssertTrue(app.staticTexts["今天 14:31"].exists)
        app.buttons["关闭"].tap()

        app.buttons["memory-detail-more"].tap()
        app.buttons["memory-more-delete"].tap()
        XCTAssertTrue(app.staticTexts["删除这条记忆？"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["原始资料保留。同一批旧证据不会重新生成这个结论；有新证据时可以重新判断。"].exists)
        XCTAssertTrue(app.buttons["memory-delete-confirm"].exists)
        XCTAssertTrue(app.buttons["memory-delete-cancel"].exists)
        attach("memory-detail-delete-interaction", app)
        app.buttons["memory-delete-cancel"].tap()
        XCTAssertTrue(app.staticTexts["证据"].waitForExistence(timeout: 5))
    }

    func testMemoryListOpensTheDetail() {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteLibraryPreview", "-MoteLibraryState", "memories", "-MoteAppearance", "light"]
        app.launch()
        XCTAssertTrue(app.buttons["memory-row-memory.generated-deposit"].waitForExistence(timeout: 10))
        app.buttons["memory-row-memory.generated-deposit"].tap()
        XCTAssertTrue(app.staticTexts["证据"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["memory-evidence-capture.generated-lease"].exists)
    }

    private func launch(state: String, appearance: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteMemoryDetailPreview", "-MoteMemoryDetailState", state,
                               "-MoteAppearance", appearance]
        app.launch()
        return app
    }

    private func attach(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func XCTAssertTruthy(_ value: Any?, contains text: String,
                                 file: StaticString = #filePath, line: UInt = #line) {
        guard let value = value as? String else {
            XCTFail("Value is not text", file: file, line: line)
            return
        }
        XCTAssertTrue(value.contains(text), "\(value) does not contain \(text)", file: file, line: line)
    }
}
