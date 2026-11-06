import XCTest

/// G05 / G06 simulator sweep: every icon-only control keeps an accessibility
/// name and every visible control keeps a 44 pt touch target. States use the
/// generated preview fixtures only.
@MainActor
final class MoteAccessibilityUITests: XCTestCase {
    private let namedControls: [(String, [String], [String])] = [
        ("home", ["-MoteHomePreview", "-MoteHomeState", "normal"], ["我的 Mote", "搜索", "拍照", "录音"]),
        ("history", ["-MoteHistoryPreview", "-MoteHistoryState", "list"], ["返回", "添加图片"]),
        ("history-typing", ["-MoteHistoryPreview", "-MoteHistoryState", "typing"], ["发送"]),
        ("ask-streaming", ["-MoteConversationPreview", "-MoteConversationState", "streaming"], ["停止"]),
        ("ask-answered", ["-MoteConversationPreview", "-MoteConversationState", "answered"], ["复制", "更多"]),
        ("ask-anchored", ["-MoteConversationPreview", "-MoteConversationState", "anchored"], ["清除范围"]),
        ("reader", ["-MoteReaderPreview", "-MoteReaderState", "reader"], ["返回", "分享", "更多"]),
        ("library", ["-MoteLibraryPreview", "-MoteLibraryState", "library"], ["筛选"]),
        ("capture-sync-adding", ["-MoteCaptureSyncPreview", "-MoteCaptureSyncState", "permission"], ["添加来源"]),
        ("recording", ["-MoteRecordingPreview", "-MoteRecordingTestInput", "-MoteRecordingState", "inApp"], ["暂停录音", "停止录音"])
    ]

    func testIconOnlyButtonsHaveNames() {
        for (name, arguments, labels) in namedControls {
            let app = launch(arguments)
            switch name {
            case "home": XCTAssertTrue(app.buttons["我的 Mote"].waitForExistence(timeout: 15), name)
            case "history": XCTAssertTrue(app.buttons["conversation-one"].waitForExistence(timeout: 15), name)
            case "history-typing": XCTAssertTrue(app.buttons["history-send"].waitForExistence(timeout: 15), name)
            case "ask-streaming": XCTAssertTrue(app.buttons["停止"].waitForExistence(timeout: 15), name)
            case "ask-answered": XCTAssertTrue(app.buttons["conversation-back"].waitForExistence(timeout: 15), name)
            case "ask-anchored": XCTAssertTrue(app.buttons["清除范围"].waitForExistence(timeout: 15), name)
            case "reader": XCTAssertTrue(app.buttons["更多"].waitForExistence(timeout: 15), name)
            case "library": XCTAssertTrue(app.buttons["library-filter"].waitForExistence(timeout: 15), name)
            case "capture-sync-adding":
                XCTAssertTrue(app.buttons["添加来源"].waitForExistence(timeout: 15), name)
                app.buttons["添加来源"].tap()
                XCTAssertTrue(app.buttons["关闭"].waitForExistence(timeout: 5), name)
                assertNamed(app.buttons["关闭"], "关闭")
            case "recording": XCTAssertTrue(app.buttons["mote-recording-stop"].waitForExistence(timeout: 15), name)
            default: break
            }
            for label in labels {
                let control = app.buttons[label].firstMatch
                XCTAssertTrue(control.exists, "\(name): \(label) is missing")
                assertNamed(control, "\(name): \(label)")
                XCTAssertFalse(control.label.lowercased() == label.lowercased() && label.contains("."),
                               "\(name): \(label) exposes a symbol name")
            }
            app.terminate()
        }
    }

    func testPauseSendingSwitchHasAName() {
        let app = launch(["-MoteCaptureSyncPreview", "-MoteCaptureSyncState", "sendPaused"])
        let pause = app.switches["暂停发送"]
        XCTAssertTrue(pause.waitForExistence(timeout: 15))
        XCTAssertEqual(pause.label, "暂停发送")
        XCTAssertGreaterThanOrEqual(pause.frame.width, 44 - 0.01)
        XCTAssertGreaterThanOrEqual(pause.frame.height, 44 - 0.01)
    }

    func testRecordingPauseAndStopKeepTheirNames() {
        let app = launch(["-MoteRecordingPreview", "-MoteRecordingTestInput", "-MoteRecordingState", "inApp"])
        XCTAssertTrue(app.buttons["mote-recording-stop"].waitForExistence(timeout: 15))
        assertNamed(app.buttons["暂停录音"], "暂停录音")
        assertNamed(app.buttons["停止录音"], "停止录音")
        app.buttons["暂停录音"].tap()
        let resume = app.buttons["继续录音"]
        XCTAssertTrue(resume.waitForExistence(timeout: 5))
        assertNamed(resume, "继续录音")
        XCTAssertGreaterThanOrEqual(resume.frame.width, 44 - 0.01)
        XCTAssertGreaterThanOrEqual(resume.frame.height, 44 - 0.01)
    }

    func testVisibleTargetsAreAtLeast44Points() {
        for (name, arguments) in scanScreens {
            let app = launch(arguments)
            XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 15), name)
            if name == "capture-sync-adding" {
                XCTAssertTrue(app.buttons["添加来源"].waitForExistence(timeout: 15), name)
                app.buttons["添加来源"].tap()
                XCTAssertTrue(app.staticTexts["添加来源"].firstMatch.waitForExistence(timeout: 5), name)
            }
            scanTargets(app, screen: name)
            app.terminate()
        }
    }

    private var scanScreens: [(String, [String])] {
        [
            ("home", ["-MoteHomePreview", "-MoteHomeState", "normal"]),
            ("home-draft", ["-MoteHomePreview", "-MoteHomeState", "draft"]),
            ("home-permission", ["-MoteHomePreview", "-MoteHomeState", "permission"]),
            ("editor", ["-MoteEditorPreview", "-MoteEditorFixture", "typed"]),
            ("recording", ["-MoteRecordingPreview", "-MoteRecordingTestInput", "-MoteRecordingState", "inApp"]),
            ("share", ["-MoteSharePreview", "-MoteShareState", "link"]),
            ("share-answer", ["-MoteSharePreview", "-MoteShareState", "answer"]),
            ("history", ["-MoteHistoryPreview", "-MoteHistoryState", "list"]),
            ("history-typing", ["-MoteHistoryPreview", "-MoteHistoryState", "typing"]),
            ("ask", ["-MoteConversationPreview", "-MoteConversationState", "answered"]),
            ("ask-streaming", ["-MoteConversationPreview", "-MoteConversationState", "streaming"]),
            ("reader", ["-MoteReaderPreview", "-MoteReaderState", "reader"]),
            ("reader-panel", ["-MoteReaderPreview", "-MoteReaderState", "panel-more"]),
            ("library", ["-MoteLibraryPreview", "-MoteLibraryState", "library"]),
            ("library-filter", ["-MoteLibraryPreview", "-MoteLibraryState", "library-filter"]),
            ("memories", ["-MoteLibraryPreview", "-MoteLibraryState", "memories"]),
            ("memories-filter", ["-MoteLibraryPreview", "-MoteLibraryState", "memories-filter"]),
            ("memory-detail", ["-MoteMemoryDetailPreview", "-MoteMemoryDetailState", "base"]),
            ("memory-more", ["-MoteMemoryDetailPreview", "-MoteMemoryDetailState", "more"]),
            ("menu", ["-MoteProfilePreview", "-MoteProfileState", "menu-normal"]),
            ("settings", ["-MoteProfilePreview", "-MoteProfileState", "settings"]),
            ("settings-connection", ["-MoteProfilePreview", "-MoteProfileState", "connection"]),
            ("capture-sync", ["-MoteCaptureSyncPreview", "-MoteCaptureSyncState", "permission"]),
            ("capture-sync-adding", ["-MoteCaptureSyncPreview", "-MoteCaptureSyncState", "permission"]),
            ("source", ["-MoteSourcePreview", "-MoteSourceKind", "notify", "-MoteSourceState", "receiving"]),
            ("source-empty", ["-MoteSourcePreview", "-MoteSourceKind", "notify", "-MoteSourceState", "empty"]),
            ("shortcut", ["-MoteShortcutSetupPreview", "-MoteSourceKind", "notify", "-MoteShortcutState", "start"]),
            ("connect", ["-MoteConnectPreview"]),
            ("widgets", ["-MoteWidgetPreview"])
        ]
    }

    private func scanTargets(_ app: XCUIApplication, screen: String,
                             file: StaticString = #filePath, line: UInt = #line) {
        if screen == "widgets" {
            for entry in ["record", "photo", "recording", "ask"] {
                for size in ["small", "medium"] {
                    let target = app.descendants(matching: .any)["mote-widget-\(size)-\(entry)"].firstMatch
                    XCTAssertTrue(target.exists, "widgets: \(size) \(entry) is missing", file: file, line: line)
                    XCTAssertFalse(target.label.isEmpty, "widgets: \(size) \(entry) has no name", file: file, line: line)
                    XCTAssertGreaterThanOrEqual(target.frame.width, 44 - 0.01, "widgets: \(entry) is too narrow",
                                                file: file, line: line)
                    XCTAssertGreaterThanOrEqual(target.frame.height, 44 - 0.01, "widgets: \(entry) is too short",
                                                file: file, line: line)
                }
            }
            return
        }
        let window = app.windows.firstMatch.frame
        let keyboard = app.keyboards.firstMatch
        let controls = app.buttons.allElementsBoundByIndex + app.switches.allElementsBoundByIndex
        XCTAssertFalse(controls.isEmpty, "\(screen): no controls were exposed to the audit",
                       file: file, line: line)
        var scanned = 0
        for control in controls where control.exists {
            let frame = control.frame
            guard frame.width > 0, frame.height > 0, frame.intersects(window) else { continue }
            if keyboard.exists, keyboard.frame.intersects(frame) { continue }
            scanned += 1
            let label = control.label.trimmingCharacters(in: .whitespacesAndNewlines)
            XCTAssertFalse(label.isEmpty, "\(screen): a visible control has no accessibility name",
                           file: file, line: line)
            XCTAssertGreaterThanOrEqual(frame.width, 44 - 0.01,
                                        "\(screen): \(label) is narrower than 44 pt", file: file, line: line)
            XCTAssertGreaterThanOrEqual(frame.height, 44 - 0.01,
                                        "\(screen): \(label) is shorter than 44 pt", file: file, line: line)
        }
        XCTAssertGreaterThan(scanned, 0, "\(screen): no visible control was measured",
                             file: file, line: line)
    }

    private func assertNamed(_ control: XCUIElement, _ name: String,
                             file: StaticString = #filePath, line: UInt = #line) {
        let label = control.label.trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertFalse(label.isEmpty, "\(name) has no accessibility name", file: file, line: line)
        XCTAssertFalse(label.contains("."), "\(name) exposes \(label)", file: file, line: line)
    }

    private func launch(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = arguments + ["-MoteAppearance", "light"]
        app.launch()
        return app
    }
}
