import XCTest

/// Discovery screens use generated in-memory fixtures only.
@MainActor
final class MoteDiscoveryUITests: XCTestCase {
    func testHomeDiscoveryRow() throws {
        for appearance in ["light", "dark"] {
            let app = launch(["-MoteHomePreview", "-MoteHomeState", "discovery"], appearance: appearance)
            XCTAssertTrue(app.staticTexts["这个月的暖气费约定"].waitForExistence(timeout: 15),
                          "home discovery title is missing")
            XCTAssertTrue(app.staticTexts["发现 · 2026年11月5日"].exists, "home discovery detail is missing")
            let row = app.descendants(matching: .button).containing(.staticText, identifier: "这个月的暖气费约定").firstMatch
            XCTAssertTrue(row.exists, "home discovery row is missing")
            XCTAssertGreaterThanOrEqual(row.frame.height, 44)
            capture("home-discovery", appearance, app)
        }
    }

    func testHistoryEmptyAndDeniedStates() throws {
        for appearance in ["light", "dark"] {
            let history = launch(["-MoteDiscoveryPreview", "-MoteDiscoveryState", "history"],
                                 appearance: appearance)
            XCTAssertTrue(history.staticTexts["发现历史"].waitForExistence(timeout: 15))
            let row = history.buttons["discovery-row-generated-insight-heating"]
            XCTAssertTrue(row.waitForExistence(timeout: 5))
            capture("discovery-history", appearance, history)

            let empty = launch(["-MoteDiscoveryPreview", "-MoteDiscoveryState", "empty"],
                               appearance: appearance)
            XCTAssertTrue(empty.staticTexts["第一份洞察会保存在这里，之后可以随时回看。"].waitForExistence(timeout: 15))
            capture("discovery-empty", appearance, empty)

            let denied = launch(["-MoteDiscoveryPreview", "-MoteDiscoveryState", "denied"],
                                appearance: appearance)
            XCTAssertTrue(denied.staticTexts["暂不可读取"].waitForExistence(timeout: 15))
            XCTAssertTrue(denied.buttons["重试"].exists)
            capture("discovery-denied", appearance, denied)
        }
    }

    func testHistoryRowOpensTheSavedReport() throws {
        let app = launch(["-MoteDiscoveryPreview", "-MoteDiscoveryState", "history"])
        let row = app.buttons["discovery-row-generated-insight-heating"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()

        XCTAssertTrue(app.staticTexts["这个月的暖气费约定"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["原文依据"].exists)
        XCTAssertTrue(app.staticTexts["发现 · 2026年11月5日 · 1 份依据"].exists)
        XCTAssertTrue(app.staticTexts["和室友的约定"].exists)

        app.buttons["返回"].tap()
        XCTAssertTrue(app.staticTexts["发现历史"].waitForExistence(timeout: 5))
    }

    private func launch(_ arguments: [String], appearance: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = arguments + ["-MoteAppearance", appearance]
        app.launch()
        return app
    }

    private func capture(_ name: String, _ appearance: String, _ app: XCUIApplication) {
        usleep(300_000)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "\(name)-\(appearance)"
        attachment.lifetime = .keepAlways
        add(attachment)
        app.terminate()
    }
}
