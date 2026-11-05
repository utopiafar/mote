import XCTest

@MainActor
final class MoteSharePreviewUITests: XCTestCase {
    func testShareLinkLight() {
        capture(state: "link", appearance: "light")
    }

    func testShareLinkDark() {
        capture(state: "link", appearance: "dark")
    }

    func testShareImagesFileAndDescriptionStates() {
        for state in ["images", "file", "describe"] {
            let app = launch(state: state, appearance: "light")
            XCTAssertTrue(app.staticTexts["保存到 Mote"].waitForExistence(timeout: 10))
            XCTAssertTrue(app.buttons["保存"].exists)
            switch state {
            case "images":
                XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "mote-share-images").count, 3)
            case "file":
                XCTAssertTrue(app.staticTexts["季度计划.pdf"].exists)
                XCTAssertTrue(app.staticTexts["2.4 MB"].exists)
            default:
                XCTAssertTrue(app.textFields["mote-share-description"].exists)
            }
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "share-\(state)-light"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    func testSaveShowsSavedThenClosesWithoutEditor() {
        let app = launch(state: "link", appearance: "light")
        XCTAssertTrue(app.staticTexts["保存到 Mote"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["取消"].exists)
        XCTAssertTrue(app.buttons["保存"].exists)
        XCTAssertFalse(app.textFields["mote-editor-text"].exists)
        XCTAssertTrue(app.staticTexts["低温慢烤牛肋排的时间表"].exists)
        XCTAssertTrue(app.staticTexts["seriouseats.com"].exists)
        XCTAssertTrue(app.buttons["资料说明"].exists)
        XCTAssertFalse(app.textFields["mote-share-description"].exists)

        app.buttons["保存"].tap()
        XCTAssertTrue(app.staticTexts["已保存"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["已关闭"].waitForExistence(timeout: 5))
    }

    private func capture(state: String, appearance: String) {
        let app = launch(state: state, appearance: appearance)
        XCTAssertTrue(app.staticTexts["保存到 Mote"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["低温慢烤牛肋排的时间表"].exists)
        XCTAssertTrue(app.staticTexts["seriouseats.com"].exists)
        for label in ["取消", "保存", "资料说明"] {
            let button = app.buttons[label].firstMatch
            XCTAssertTrue(button.exists, "\(label) is missing")
            XCTAssertGreaterThanOrEqual(button.frame.width, 44, "\(label) target is too narrow")
            XCTAssertGreaterThanOrEqual(button.frame.height, 44, "\(label) target is too short")
        }
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "share-link-\(appearance)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func launch(state: String, appearance: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteSharePreview", "-MoteShareState", state, "-MoteAppearance", appearance]
        app.launch()
        return app
    }
}
