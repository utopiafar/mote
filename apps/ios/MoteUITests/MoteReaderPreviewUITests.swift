import XCTest

@MainActor
final class MoteReaderPreviewUITests: XCTestCase {
    private let originalID = "00000000-0000-4000-8000-000000000001"
    private let body = "周四和房东确认：暖气费按实际用量分摊，月底前把账单照片发给他。押金下个月退，记得要收据。"

    func testReaderLightAndDark() throws {
        for appearance in ["light", "dark"] {
            let app = launch(state: "reader", appearance: appearance)
            XCTAssertTrue(app.staticTexts[body].waitForExistence(timeout: 15))
            for label in ["返回", "分享", "更多", "围绕这份资料提问"] {
                let button = app.buttons[label].firstMatch
                XCTAssertTrue(button.exists, "\(label) is missing")
                XCTAssertGreaterThanOrEqual(button.frame.width, 44)
                XCTAssertGreaterThanOrEqual(button.frame.height, 44)
            }
            try capture("reader-\(appearance)")
        }
    }

    func testReaderPanelsLightAndDark() throws {
        for appearance in ["light", "dark"] {
            let more = launch(appearance: appearance)
            more.buttons["更多"].tap()
            XCTAssertTrue(more.buttons["详情"].waitForExistence(timeout: 15))
            XCTAssertTrue(more.buttons["资料说明"].exists)
            XCTAssertTrue(more.buttons["复制"].exists)
            XCTAssertTrue(more.buttons["删除"].exists)
            waitForTarget(more.buttons["删除"])
            try capture("panel-more-\(appearance)")

            let detail = launch(appearance: appearance)
            detail.buttons["更多"].tap()
            detail.buttons["详情"].tap()
            for text in ["详情", "本机已保存", "中央已接收", "已整理，可搜索", "14:20", "14:22", "14:25", "来源", "记录 · 我的 iPhone", "引用它的对话", "2"] {
                XCTAssertTrue(detail.staticTexts[text].firstMatch.waitForExistence(timeout: 3), "\(text) is missing")
            }
            waitForTarget(detail.buttons["关闭"])
            try capture("panel-detail-\(appearance)")
        }
    }

    func testScopeHandoffAndUnconfirmedDeletionKeepOriginal() {
        var app = launch(state: "reader")
        app.buttons["围绕这份资料提问"].tap()
        XCTAssertTrue(app.staticTexts["ask.\(originalID)"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["暖气费按实际用量分摊，月底前给账单照片"].exists)
        app.buttons["清除范围"].tap()
        XCTAssertFalse(app.staticTexts["暖气费按实际用量分摊，月底前给账单照片"].exists)

        app = launch(state: "deleteError")
        app.buttons["更多"].tap()
        app.buttons["删除"].tap()
        app.buttons["确认"].tap()
        try? capture("deletion-error-light")
        XCTAssertTrue(app.staticTexts["未能确认删除完成。原文仍保留，刷新后可核对当前状态。"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts[body].exists)
        XCTAssertTrue(app.staticTexts["delete-attempts.1"].exists)
        XCTAssertFalse(app.staticTexts["delete-attempts.2"].exists)
        XCTAssertFalse(app.staticTexts["deleted"].exists)
    }

    private func waitForTarget(_ button: XCUIElement) {
        let settled = expectation(description: "panel animation settled")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { settled.fulfill() }
        wait(for: [settled], timeout: 3)
        XCTAssertTrue(button.exists)
        XCTAssertGreaterThanOrEqual(button.frame.height, 44)
    }

    private func launch(state: String = "reader", appearance: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteReaderPreview", "-MoteReaderState", state, "-MoteAppearance", appearance]
        app.launch()
        return app
    }

    private func capture(_ name: String) throws {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        let iosDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let directory = ProcessInfo.processInfo.environment["MOTE_IOS_SCREENSHOT_DIR"]
            ?? iosDirectory.appendingPathComponent(".artifacts/ios-screens").path
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        try screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("impl-\(name).png"))
    }
}
