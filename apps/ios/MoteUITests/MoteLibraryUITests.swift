import XCTest

@MainActor
final class MoteLibraryUITests: XCTestCase {
    func testLibraryAndMemoryScreens() {
        for appearance in ["light", "dark"] {
            let library = launch(state: "library", appearance: appearance)
            XCTAssertTrue(library.staticTexts["资料与记忆"].waitForExistence(timeout: 10))
            XCTAssertTrue(library.staticTexts["今天"].exists)
            XCTAssertTrue(library.staticTexts["昨天"].exists)
            XCTAssertTrue(library.textFields["library-search"].exists)
            for id in ["capture.generated-board", "capture.generated-call", "capture.generated-heating",
                       "capture.generated-recipe", "capture.generated-parcel", "material.generated-lease"] {
                XCTAssertTrue(library.buttons["library-row-\(id)"].exists, "\(id) is missing")
            }
            attach("library-\(appearance)", library)
            library.terminate()

            let memories = launch(state: "memories", appearance: appearance)
            XCTAssertTrue(memories.staticTexts["资料与记忆"].waitForExistence(timeout: 10))
            XCTAssertTrue(memories.textFields["memory-search"].exists)
            for id in ["memory.generated-deposit", "memory.generated-heating", "memory.generated-ribs",
                       "memory.generated-weekly", "memory.generated-teacher", "memory.generated-bookstore",
                       "memory.generated-checkup", "memory.generated-parking"] {
                XCTAssertTrue(memories.buttons["memory-row-\(id)"].exists, "\(id) is missing")
            }
            attach("memories-\(appearance)", memories)
            memories.terminate()
        }
    }

    func testLibraryFilterAndTimeReview() {
        let app = launch(state: "library")

        app.buttons["library-filter"].tap()
        XCTAssertTrue(app.staticTexts["筛选"].waitForExistence(timeout: 5))
        attach("library-filter-light", app)

        app.buttons["library-filter-notifications"].tap()
        XCTAssertTrue(app.buttons["library-row-capture.generated-parcel"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["library-row-capture.generated-heating"].waitForNonExistence(timeout: 5))

        app.buttons["library-filter"].tap()
        app.buttons["library-filter-all"].tap()
        XCTAssertTrue(app.buttons["library-row-capture.generated-heating"].waitForExistence(timeout: 5))

        app.buttons["library-filter"].tap()
        app.buttons["library-filter-date"].tap()
        XCTAssertTrue(app.staticTexts["按时间回看"].waitForExistence(timeout: 5))
        app.buttons["完成"].tap()
        XCTAssertTrue(app.buttons["library-row-capture.generated-board"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["library-row-capture.generated-parcel"].waitForNonExistence(timeout: 5))

        app.buttons["library-filter"].tap()
        app.buttons["library-filter-date"].tap()
        app.buttons["全部日期"].tap()
        XCTAssertTrue(app.buttons["library-row-capture.generated-parcel"].waitForExistence(timeout: 5))
    }

    func testMemorySearchHighlightsAndFilterSheet() {
        let search = launch(state: "memories-search")
        XCTAssertTrue(search.buttons["memory-row-memory.generated-deposit"].waitForExistence(timeout: 10))
        XCTAssertTrue(search.buttons["memory-row-memory.generated-parking"].exists)
        XCTAssertEqual(rowCount(search, prefix: "memory-row-"), 2)
        XCTAssertEqual(search.textFields["memory-search"].value as? String, "押金")
        attach("memories-search-light", search)
        search.terminate()

        let app = launch(state: "memories")
        app.buttons["library-filter"].tap()
        XCTAssertTrue(app.staticTexts["筛选"].waitForExistence(timeout: 5))
        attach("memories-filter-light", app)

        app.buttons["memory-filter-events"].tap()
        XCTAssertTrue(app.buttons["memory-row-memory.generated-heating"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["memory-row-memory.generated-deposit"].waitForNonExistence(timeout: 5))
        XCTAssertEqual(rowCount(app, prefix: "memory-row-"), 3)

        app.buttons["library-filter"].tap()
        app.buttons["memory-filter-personal"].tap()
        XCTAssertTrue(app.buttons["memory-row-memory.generated-deposit"].waitForExistence(timeout: 5))
        XCTAssertEqual(rowCount(app, prefix: "memory-row-"), 8)

        app.buttons["library-filter"].tap()
        let history = app.buttons["memory-filter-history"]
        XCTAssertTrue(history.waitForExistence(timeout: 5))
        history.tap()
        XCTAssertEqual(history.value as? String, "开")
        app.buttons["关闭"].tap()
        XCTAssertTrue(app.buttons["memory-row-memory.generated-old-parking"].waitForExistence(timeout: 5))
        XCTAssertEqual(rowCount(app, prefix: "memory-row-"), 9)
    }

    func testProfileEntryOpensLibrary() {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteProfilePreview", "-MoteProfileState", "menu-normal", "-MoteAppearance", "light"]
        app.launch()
        XCTAssertTrue(app.buttons["menu-library"].waitForExistence(timeout: 10))
        app.buttons["menu-library"].tap()
        XCTAssertTrue(app.textFields["library-search"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["资料与记忆"].exists)
    }

    private func rowCount(_ app: XCUIApplication, prefix: String) -> Int {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).count
    }

    private func launch(state: String, appearance: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteLibraryPreview", "-MoteLibraryState", state, "-MoteAppearance", appearance]
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
