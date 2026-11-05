import XCTest

@MainActor
final class MoteEditorUITests: XCTestCase {
    func testClearUndoRestoresAllContentAndBackKeepsDraft() {
        let app = launch(fixture: "typed")
        let originalText = "周四和房东确认：暖气费按实际用量分摊，月底前把账单照片发给他。\n押金下个月退，记得要收据。"
        XCTAssertTrue(editorText(in: app).waitForExistence(timeout: 10))
        app.buttons["资料说明"].tap()
        let description = app.textFields["mote-source-description"]
        XCTAssertTrue(description.waitForExistence(timeout: 5))
        description.tap()
        description.typeText("生成的资料说明")

        app.buttons["清空"].tap()
        XCTAssertTrue(app.staticTexts["已清空"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["撤销"].exists)
        XCTAssertFalse(app.buttons["移除照片"].exists)
        XCTAssertFalse(app.buttons["移除录音"].exists)

        app.buttons["撤销"].tap()
        XCTAssertEqual(editorText(in: app).value as? String, originalText)
        XCTAssertEqual(description.value as? String, "生成的资料说明")
        XCTAssertTrue(app.buttons["移除照片"].exists)
        XCTAssertTrue(app.buttons["播放录音"].exists)
        XCTAssertFalse(app.staticTexts["已清空"].exists)

        app.buttons["返回"].tap()
        XCTAssertTrue(app.buttons["继续草稿"].waitForExistence(timeout: 5))
        app.buttons["继续草稿"].tap()
        XCTAssertEqual(editorText(in: app).value as? String, originalText)
        XCTAssertEqual(description.value as? String, "生成的资料说明")
    }

    func testEditSaveAndProcessRestartKeepOneDraft() throws {
        let app = launch(fixture: "typed")
        let text = editorText(in: app)
        XCTAssertTrue(text.waitForExistence(timeout: 10))
        text.tap()
        text.typeText("追加")
        let expected = try XCTUnwrap(text.value as? String)
        app.buttons["保存"].tap()
        XCTAssertEqual(text.value as? String, expected)
        XCTAssertTrue(app.buttons["移除照片"].exists)
        XCTAssertTrue(app.buttons["播放录音"].exists)

        app.terminate()
        app.launchArguments = ["-MoteAppearance", "light"]
        app.launch()
        XCTAssertEqual(editorText(in: app).value as? String, expected)
        XCTAssertTrue(app.buttons["移除照片"].exists)
        XCTAssertTrue(app.buttons["播放录音"].exists)
    }

    func testSourceDescriptionStartsCollapsedAndExpandsWithoutExampleText() {
        let app = launch(fixture: "typed")
        let description = app.textFields["mote-source-description"]
        XCTAssertTrue(app.buttons["资料说明"].waitForExistence(timeout: 10))
        XCTAssertFalse(description.exists)

        app.buttons["资料说明"].tap()
        XCTAssertTrue(description.waitForExistence(timeout: 5))
        let value = description.value as? String ?? ""
        XCTAssertTrue(value.isEmpty || value == "资料说明")
    }

    func testRecordingAttachmentPlaysPausesAndRemainsRemovedAfterRestart() {
        let app = launch(fixture: "typed")
        let play = app.buttons["播放录音"]
        XCTAssertTrue(play.waitForExistence(timeout: 10))
        assertTouchTarget(play)
        assertTouchTarget(app.buttons["移除录音"])

        play.tap()
        XCTAssertTrue(app.buttons["暂停录音"].waitForExistence(timeout: 5))
        app.buttons["暂停录音"].tap()
        XCTAssertTrue(play.waitForExistence(timeout: 5))
        app.buttons["移除录音"].tap()
        XCTAssertFalse(play.exists)
        XCTAssertFalse(app.descendants(matching: .any)["mote-audio-attachment"].exists)

        app.terminate()
        app.launchArguments = ["-MoteAppearance", "light"]
        app.launch()
        XCTAssertTrue(app.buttons["移除照片"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["播放录音"].exists)
    }

    func testEditorReferencesLight() {
        captureEditorReferences(appearance: "light")
    }

    func testEditorReferencesDark() {
        captureEditorReferences(appearance: "dark")
    }

    private func captureEditorReferences(appearance: String) {
        for state in ["typed", "empty", "cleared", "describe-true", "audio-false"] {
            let app = launch(
                fixture: state == "describe-true" ? "typed" : state,
                appearance: appearance,
                descriptionExpanded: state == "describe-true"
            )
            XCTAssertTrue(app.buttons["保存"].waitForExistence(timeout: 10))
            if state == "typed" || state == "describe-true" || state == "audio-false" {
                XCTAssertTrue(app.buttons["移除照片"].waitForExistence(timeout: 5))
            }
            if state == "cleared" {
                XCTAssertTrue(app.buttons["撤销"].waitForExistence(timeout: 5))
            }
            if state == "describe-true" {
                XCTAssertTrue(app.textFields["mote-source-description"].waitForExistence(timeout: 5))
            }
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "editor-\(state)-\(appearance)"
            attachment.lifetime = .keepAlways
            add(attachment)
            app.terminate()
        }
    }

    private func launch(
        fixture: String,
        appearance: String = "light",
        descriptionExpanded: Bool = false
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-MoteEditorFixture", fixture,
            "-MoteAppearance", appearance,
            "-MoteEditorDescribe", descriptionExpanded ? "true" : "false",
        ]
        app.launch()
        return app
    }

    private func editorText(in app: XCUIApplication) -> XCUIElement {
        app.textFields["mote-editor-text"]
    }

    private func assertTouchTarget(_ element: XCUIElement) {
        XCTAssertGreaterThanOrEqual(element.frame.width, 44)
        XCTAssertGreaterThanOrEqual(element.frame.height, 44)
        XCTAssertFalse(element.label.isEmpty)
    }
}
