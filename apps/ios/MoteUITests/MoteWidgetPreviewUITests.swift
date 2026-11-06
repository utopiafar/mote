import XCTest

@MainActor
final class MoteWidgetPreviewUITests: XCTestCase {
    func testWidgetPreviewLight() {
        capture(appearance: "light")
    }

    func testWidgetPreviewDark() {
        capture(appearance: "dark")
    }

    private func capture(appearance: String) {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteWidgetPreview", "-MoteAppearance", appearance]
        app.launch()

        XCTAssertTrue(app.staticTexts["小组件"].waitForExistence(timeout: 15))
        for entry in ["record", "photo", "recording", "ask"] {
            assertTarget(app, identifier: "mote-widget-small-\(entry)")
            assertTarget(app, identifier: "mote-widget-medium-\(entry)")
        }

        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "widgets-\(appearance)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func assertTarget(_ app: XCUIApplication, identifier: String) {
        let target = app.descendants(matching: .any)[identifier].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 5), "\(identifier) is missing")
        XCTAssertGreaterThanOrEqual(target.frame.width, 44, "\(identifier) is narrower than 44pt")
        XCTAssertGreaterThanOrEqual(target.frame.height, 44, "\(identifier) is shorter than 44pt")
        XCTAssertFalse(target.label.isEmpty, "\(identifier) has no accessibility name")
    }
}
