import XCTest

@MainActor
final class MoteSearchUITests: XCTestCase {
    func testHomeSearchOpensTheCentralSearchScreen() {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteAppearance", "light"]
        app.launch()

        XCTAssertTrue(app.buttons["搜索"].waitForExistence(timeout: 20))
        app.buttons["搜索"].tap()

        let field = app.textFields["搜索资料"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "The home search action did not open 搜索资料")
        XCTAssertTrue(app.staticTexts["搜索资料"].exists)
        XCTAssertFalse(app.staticTexts["此功能将在后续版本提供"].exists)

        field.tap()
        field.typeText("押金")
        XCTAssertEqual(field.value as? String, "押金")

        app.buttons["关闭"].tap()
        XCTAssertTrue(app.buttons["我的 Mote"].waitForExistence(timeout: 10))
    }

    func testSearchPreviewShowsResultsEmptyStateAndOpensAReader() {
        for appearance in ["light", "dark"] {
            let results = launch(state: "results", appearance: appearance)
            XCTAssertTrue(results.buttons["search-row-capture.generated-deposit"].waitForExistence(timeout: 10))
            XCTAssertTrue(results.buttons["search-row-capture.generated-parking"].exists)
            XCTAssertEqual(results.textFields["搜索资料"].value as? String, "押金")
            attach("search-results-\(appearance)", results)

            results.buttons["search-records-clear"].tap()
            let field = results.textFields["搜索资料"]
            field.tap()
            field.typeText("包裹")
            XCTAssertTrue(results.buttons["search-row-capture.generated-parcel"].waitForExistence(timeout: 5))
            XCTAssertFalse(results.buttons["search-row-capture.generated-deposit"].exists)
            results.buttons["search-row-capture.generated-parcel"].tap()
            XCTAssertEqual(results.staticTexts["search-preview-opened"].label, "capture.generated-parcel")
            results.terminate()

            let empty = launch(state: "empty", appearance: appearance)
            XCTAssertTrue(empty.staticTexts["没有找到匹配的原文。"].waitForExistence(timeout: 10))
            XCTAssertEqual(empty.textFields["搜索资料"].value as? String, "会议室")
            attach("search-empty-\(appearance)", empty)
            empty.terminate()
        }
    }

    private func launch(state: String, appearance: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteSearchPreview", "-MoteSearchState", state, "-MoteAppearance", appearance]
        app.launch()
        return app
    }

    private func attach(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
