import XCTest

/// Full simulator screen set for the UI-wave acceptance. Every state uses the
/// generated preview fixtures, so no profile, connection or device data is read.
/// Attachments are named `impl-<state>-<appearance>` and exported by
/// `scripts/test.sh --screens`.
@MainActor
final class MoteScreensUITests: XCTestCase {
    private let homes = [
        ("home-normal", "normal"),
        ("home-firstUse", "firstUse"),
        ("home-permission", "permission"),
        ("home-reconnect", "reconnect"),
        ("home-sendPaused", "sendPaused"),
        ("home-draft", "draft")
    ]

    func testScreensLight() throws { try captureAll(appearance: "light") }
    func testScreensDark() throws { try captureAll(appearance: "dark") }

    private func captureAll(appearance: String) throws {
        dismissCameraAlertIfNeeded()
        try captureHome(appearance)
        try captureEditor(appearance)
        try captureRecording(appearance)
        try captureShare(appearance)
        try captureHistory(appearance)
        try captureAsk(appearance)
        try captureReader(appearance)
        try captureLibrary(appearance)
        try captureMemoryDetail(appearance)
        try captureMenu(appearance)
        try captureCaptureSync(appearance)
        try captureSources(appearance)
        try captureShortcuts(appearance)
        try captureConnection(appearance)
        captureWidgets(appearance)
    }

    private func captureHome(_ appearance: String) throws {
        for (name, state) in homes {
            let app = launch(["-MoteHomePreview", "-MoteHomeState", state], appearance: appearance)
            let ready = switch state {
            case "normal": app.staticTexts["今天"]
            case "firstUse": app.buttons["连接"]
            case "permission": app.staticTexts["等待采集权限"]
            case "reconnect": app.staticTexts["需要重新连接"]
            case "sendPaused": app.staticTexts["发送已暂停"]
            default: app.buttons["继续草稿"]
            }
            XCTAssertTrue(ready.waitForExistence(timeout: 15), "\(name) did not appear")
            capture(name, appearance, app)
        }
    }

    private func captureEditor(_ appearance: String) throws {
        for (name, fixture, describe, clear) in [
            ("editor-normal", "typed", false, false),
            ("editor-empty", "empty", false, false),
            ("editor-cleared", "typed", false, true),
            ("editor-describe", "typed", true, false),
            ("editor-audio-false", "audio-false", false, false)
        ] {
            let app = launch([
                "-MoteEditorPreview",
                "-MoteEditorFixture", fixture,
                "-MoteEditorDescribe", describe ? "true" : "false"
            ], appearance: appearance)
            XCTAssertTrue(app.textFields["mote-editor-text"].waitForExistence(timeout: 15), name)
            if clear {
                app.buttons["清空"].tap()
                XCTAssertTrue(app.buttons["撤销"].waitForExistence(timeout: 5), name)
            }
            if describe {
                XCTAssertTrue(app.textFields["mote-source-description"].waitForExistence(timeout: 5), name)
            }
            if ["editor-normal", "editor-describe", "editor-audio-false"].contains(name) {
                XCTAssertTrue(app.buttons["移除照片"].waitForExistence(timeout: 5), name)
            }
            capture(name, appearance, app)
        }
    }

    private func captureRecording(_ appearance: String) throws {
        for state in ["inApp", "interrupted", "away"] {
            let app = launch([
                "-MoteRecordingPreview", "-MoteRecordingTestInput",
                "-MoteRecordingState", state
            ], appearance: appearance)
            let ready = state == "away" ? app.buttons["mote-recording-bar"] : app.buttons["mote-recording-stop"]
            XCTAssertTrue(ready.waitForExistence(timeout: 15), "recording \(state)")
            capture("recording-\(state)", appearance, app)
        }
    }

    private func captureShare(_ appearance: String) throws {
        for state in ["link", "images", "file", "answer", "describe", "done"] {
            let app = launch(["-MoteSharePreview", "-MoteShareState", state], appearance: appearance)
            let title = state == "answer" ? "保存为记录" : "保存到 Mote"
            XCTAssertTrue(app.staticTexts[title].firstMatch.waitForExistence(timeout: 15), state)
            capture("share-\(state)", appearance, app)
        }
    }

    private func captureHistory(_ appearance: String) throws {
        for state in ["list", "empty", "typing"] {
            let app = launch(["-MoteHistoryPreview", "-MoteHistoryState", state], appearance: appearance)
            let ready = state == "empty" ? app.textFields["问一问"] : app.buttons["conversation-one"]
            XCTAssertTrue(ready.waitForExistence(timeout: 15), "history \(state)")
            capture("history-\(state)", appearance, app)
        }
    }

    private func captureAsk(_ appearance: String) throws {
        for state in ["answered", "streaming", "offline", "anchored"] {
            let app = launch(["-MoteConversationPreview", "-MoteConversationState", state], appearance: appearance)
            let ready = switch state {
            case "streaming": app.buttons["停止"]
            case "offline": app.staticTexts["没有连上中央"]
            default: app.buttons["conversation-back"]
            }
            XCTAssertTrue(ready.waitForExistence(timeout: 15), "ask \(state)")
            capture("ask-\(state)", appearance, app)
        }
    }

    private func captureReader(_ appearance: String) throws {
        for (name, state) in [
            ("reader", "reader"),
            ("reader-screen", "screen"),
            ("reader-panel-more", "panel-more"),
            ("reader-panel-detail", "panel-detail")
        ] {
            let app = launch(["-MoteReaderPreview", "-MoteReaderState", state], appearance: appearance)
            XCTAssertTrue(app.buttons["更多"].waitForExistence(timeout: 15), name)
            if state != "reader" {
                XCTAssertTrue(app.staticTexts["详情"].waitForExistence(timeout: 5), name)
            }
            capture(name, appearance, app)
        }
    }

    private func captureLibrary(_ appearance: String) throws {
        for (name, state) in [
            ("library", "library"),
            ("library-filter", "library-filter"),
            ("memories", "memories"),
            ("memories-search", "memories-search"),
            ("memories-filter", "memories-filter")
        ] {
            let app = launch(["-MoteLibraryPreview", "-MoteLibraryState", state], appearance: appearance)
            XCTAssertTrue(app.staticTexts["资料与记忆"].waitForExistence(timeout: 15), name)
            if state == "memories-search" {
                XCTAssertTrue(app.buttons["memory-row-memory.generated-deposit"].waitForExistence(timeout: 5), name)
            }
            if state.hasSuffix("-filter") {
                XCTAssertTrue(app.staticTexts["筛选"].waitForExistence(timeout: 5), name)
            }
            capture(name, appearance, app)
        }
    }

    private func captureMemoryDetail(_ appearance: String) throws {
        for state in ["base", "more", "correct", "history", "info", "delete"] {
            let name = state == "base" ? "memory-detail" : "memory-detail-\(state)"
            let app = launch(["-MoteMemoryDetailPreview", "-MoteMemoryDetailState", state], appearance: appearance)
            XCTAssertTrue(app.staticTexts["租房押金"].waitForExistence(timeout: 15), state)
            capture(name, appearance, app)
        }
    }

    private func captureMenu(_ appearance: String) throws {
        for (name, state) in [
            ("menu", "menu-normal"),
            ("menu-permission", "menu-permission"),
            ("menu-sendPaused", "menu-sendPaused"),
            ("settings", "settings"),
            ("settings-connection", "connection")
        ] {
            let app = launch(["-MoteProfilePreview", "-MoteProfileState", state], appearance: appearance)
            let ready = state.hasPrefix("menu")
                ? app.buttons["menu-library"]
                : app.staticTexts[state == "settings" ? "设置" : "连接与设备"].firstMatch
            XCTAssertTrue(ready.waitForExistence(timeout: 15), name)
            capture(name, appearance, app)
        }
    }

    private func captureCaptureSync(_ appearance: String) throws {
        for (name, state) in [
            ("capture-sync-permission", "permission"),
            ("capture-sync-synced", "synced"),
            ("capture-sync-pending", "pending"),
            ("capture-sync-sendPaused", "sendPaused"),
            ("capture-sync-reconnect", "reconnect"),
            ("capture-sync-adding", "permission")
        ] {
            let app = launch(["-MoteCaptureSyncPreview", "-MoteCaptureSyncState", state], appearance: appearance)
            XCTAssertTrue(app.staticTexts["采集与同步"].waitForExistence(timeout: 15), name)
            if name == "capture-sync-adding" {
                app.buttons["添加来源"].tap()
                XCTAssertTrue(app.staticTexts["添加来源"].firstMatch.waitForExistence(timeout: 5), name)
            }
            capture(name, appearance, app)
        }
    }

    private func captureSources(_ appearance: String) throws {
        for (name, kind, state) in [
            ("source-notify", "notify", "receiving"),
            ("source-screenshot", "screenshot", "receiving"),
            ("source-empty", "notify", "empty"),
            ("source-paused", "notify", "paused")
        ] {
            let app = launch([
                "-MoteSourcePreview",
                "-MoteSourceKind", kind,
                "-MoteSourceState", state
            ], appearance: appearance)
            XCTAssertTrue(app.buttons["返回"].waitForExistence(timeout: 15), name)
            capture(name, appearance, app)
        }
    }

    private func captureShortcuts(_ appearance: String) throws {
        for (name, kind, state) in [
            ("shortcut-start", "notify", "start"),
            ("shortcut-screenshot", "screenshot", "start"),
            ("shortcut-waiting", "notify", "waiting"),
            ("shortcut-received", "notify", "received")
        ] {
            let app = launch([
                "-MoteShortcutSetupPreview",
                "-MoteSourceKind", kind,
                "-MoteShortcutState", state
            ], appearance: appearance)
            XCTAssertTrue(app.buttons["返回"].waitForExistence(timeout: 15), name)
            capture(name, appearance, app)
        }
    }

    private func captureConnection(_ appearance: String) throws {
        for (name, state, expected) in [
            ("connect", "start", "连接你的 Mote"),
            ("connect-invalid", "invalid", "邀请已失效"),
            ("connect-scan", "scan", "将二维码放入取景框"),
            ("connect-confirm", "confirm", "本人设备"),
            ("connect-confirm-connecting", "connecting", "正在连接…"),
            ("connect-confirm-failed", "failed", "连接未完成")
        ] {
            let app = launch(["-MoteConnectPreview"], appearance: appearance, environment: [
                "MOTE_TEST_STATE": state,
                "MOTE_TEST_PENDING": "3",
                "MOTE_TEST_INVITATION": invitation()
            ])
            let ready = state == "connecting" ? app.buttons[expected] : app.staticTexts[expected]
            XCTAssertTrue(ready.waitForExistence(timeout: 15), name)
            if state == "scan" {
                dismissCameraAlertIfNeeded()
            }
            capture(name, appearance, app)
        }
    }

    private func captureWidgets(_ appearance: String) {
        let app = launch(["-MoteWidgetPreview"], appearance: appearance)
        XCTAssertTrue(app.staticTexts["小组件"].waitForExistence(timeout: 15))
        capture("widgets", appearance, app)
    }

    private func dismissCameraAlertIfNeeded() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts.firstMatch
        guard alert.waitForExistence(timeout: 2) else { return }
        for label in ["允许", "Allow", "不允许", "Don't Allow"] {
            let button = alert.buttons[label]
            if button.exists {
                button.tap()
                usleep(300_000)
                return
            }
        }
    }

    private func invitation() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let payload: [String: Any] = [
            "format": "mote.connection",
            "version": 1,
            "serverUrl": "https://mote.example.net",
            "code": String(repeating: "a", count: 43),
            "expiresAt": formatter.string(from: Date().addingTimeInterval(600)),
            "platforms": ["android", "ios", "macos"]
        ]
        let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    private func launch(_ arguments: [String], appearance: String,
                        environment: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = arguments + ["-MoteAppearance", appearance]
        app.launchEnvironment = environment
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
