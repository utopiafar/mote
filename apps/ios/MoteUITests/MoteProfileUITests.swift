import XCTest

@MainActor
final class MoteProfileUITests: XCTestCase {
    func testMenuScreensKeepTheCanvasOrder() {
        for appearance in ["light", "dark"] {
            let app = launch("menu-normal", appearance: appearance)
            assertMenu(app)
            XCTAssertEqual(app.buttons["menu-capture-sync"].label, "采集与同步")
            attach("profile-menu-normal-\(appearance)", app)
            app.terminate()
        }
    }

    func testCaptureStatusOnlyAppearsWhenAbnormal() {
        for state in ["menu-permission", "menu-sendPaused"] {
            for appearance in ["light", "dark"] {
                let app = launch(state, appearance: appearance)
                let title = state == "menu-permission" ? "等待采集权限" : "发送已暂停"
                let row = app.buttons["menu-capture-sync"]
                XCTAssertTrue(row.waitForExistence(timeout: 10), "\(state) has no capture row")
                XCTAssertTrue(row.label.contains(title), "\(state) does not show \(title): \(row.label)")
                attach("profile-\(state)-\(appearance)", app)
                app.terminate()
            }
        }
    }

    func testSettingsOpensConnectionDeviceAndDisconnects() {
        let app = launch("menu-normal")
        app.buttons["设置"].tap()

        XCTAssertTrue(app.staticTexts["设置"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["mote.example.net"].exists)
        XCTAssertTrue(app.staticTexts["我的 iPhone"].exists)
        for label in ["settings-appearance", "settings-backup", "settings-diagnostics", "settings-about"] {
            XCTAssertTrue(app.buttons[label].exists, "\(label) is missing")
        }

        let card = app.buttons["settings-connection-card"]
        XCTAssertTrue(card.exists)
        assertTouchTarget(card, "connection card")
        card.tap()

        XCTAssertTrue(app.staticTexts["连接与设备"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["中央"].exists)
        XCTAssertTrue(app.staticTexts["本人设备"].exists)
        XCTAssertTrue(app.staticTexts["连接时间"].exists)
        XCTAssertTrue(app.staticTexts["10月3日"].exists)
        XCTAssertTrue(app.staticTexts["设备名称"].exists)
        XCTAssertTrue(app.staticTexts["我的 iPhone"].exists)

        let disconnect = app.buttons["settings-disconnect"]
        XCTAssertTrue(disconnect.exists)
        assertTouchTarget(disconnect, "disconnect")
        disconnect.tap()

        let alert = app.alerts["断开连接"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        alert.buttons["断开连接"].tap()

        XCTAssertTrue(app.staticTexts["设置"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["尚未连接"].exists)
        app.buttons["settings-connection-card"].tap()
        XCTAssertTrue(app.staticTexts["连接与设备"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["连接你的 Mote"].exists)
    }

    func testSettingsScreens() {
        for appearance in ["light", "dark"] {
            let app = launch("settings", appearance: appearance)
            XCTAssertTrue(app.staticTexts["设置"].waitForExistence(timeout: 10))
            attach("profile-settings-\(appearance)", app)

            app.buttons["settings-connection-card"].tap()
            XCTAssertTrue(app.staticTexts["连接与设备"].waitForExistence(timeout: 5))
            for label in ["返回", "settings-disconnect"] {
                let button = app.buttons[label]
                XCTAssertTrue(button.exists, "\(label) is missing")
                assertTouchTarget(button, label)
            }
            attach("profile-connection-\(appearance)", app)
            app.terminate()
        }
    }

    private func assertMenu(_ app: XCUIApplication) {
        XCTAssertTrue(app.staticTexts["我的 Mote"].waitForExistence(timeout: 10))
        let order = ["资料与记忆", "发现历史", "日程与待办", "采集与同步", "设置", "中央工作台"]
        var previous: CGFloat = 0
        for label in order {
            let row = app.buttons[label]
            XCTAssertTrue(row.exists, "\(label) is missing")
            assertTouchTarget(row, label)
            XCTAssertGreaterThan(row.frame.minY, previous, "\(label) is out of order")
            previous = row.frame.minY
        }
        XCTAssertTrue(app.buttons["返回"].exists)
    }

    private func assertTouchTarget(_ element: XCUIElement, _ label: String,
                                   file: StaticString = #filePath, line: UInt = #line) {
        // Element frames come back as 43.99999999999997 for a 44pt row; compare
        // with the sub-point tolerance of the coordinate conversion.
        XCTAssertGreaterThanOrEqual(element.frame.height, 44 - 0.01,
                                    "\(label) target is too short", file: file, line: line)
        XCTAssertGreaterThanOrEqual(element.frame.width, 44 - 0.01,
                                    "\(label) target is too narrow", file: file, line: line)
    }

    private func launch(_ state: String, appearance: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-MoteProfilePreview",
            "-MoteProfileState", state,
            "-MoteAppearance", appearance,
        ]
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
