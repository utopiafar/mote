import XCTest

@MainActor
final class MoteComponentPreviewUITests: XCTestCase {
    func testComponentPreviewLight() {
        capture(appearance: "light")
    }

    func testComponentPreviewDark() {
        capture(appearance: "dark")
    }

    private func capture(appearance: String) {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteComponentPreview", "-MoteAppearance", appearance]
        app.launch()

        XCTAssertTrue(app.staticTexts["组件预览"].waitForExistence(timeout: 15))
        for label in ["拍照", "录音", "发送"] {
            assertTouchTarget(app, label: label, iconOnly: true)
        }
        for label in ["保存", "取消", "资料", "记忆", "恢复", "处理", "撤销"] {
            assertTouchTarget(app, label: label)
        }

        attachScreenshot(named: "components-\(appearance)")
        let scrollView = app.scrollViews.firstMatch
        scrollView.swipeUp()
        scrollView.swipeUp()
        attachScreenshot(named: "catalog-\(appearance)")
    }

    private func assertTouchTarget(_ app: XCUIApplication, label: String, iconOnly: Bool = false) {
        let button = app.buttons[label].firstMatch
        XCTAssertTrue(button.exists, "\(label) button is missing")
        XCTAssertGreaterThanOrEqual(button.frame.width, 44, "\(label) target is narrower than 44pt")
        XCTAssertGreaterThanOrEqual(button.frame.height, 44, "\(label) target is shorter than 44pt")
        if iconOnly {
            XCTAssertFalse(button.label.isEmpty, "\(label) icon-only button has no accessibility name")
        }
    }

    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
