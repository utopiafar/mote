import XCTest

@MainActor
final class MoteRecordingUITests: XCTestCase {
    func testHomeBarReturnsToTheSameRecordingAndStopKeepsAttachment() {
        defer { resetDraft() }
        let app = XCUIApplication()
        app.launchArguments = ["-MoteRecordingTestInput", "-MoteEditorFixture", "empty"]
        app.launch()
        XCTAssertTrue(app.buttons["录音"].waitForExistence(timeout: 10))
        app.buttons["录音"].tap()
        XCTAssertTrue(app.buttons["mote-recording-stop"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["暂停录音"].exists)
        sleep(1) // Generated input writes an attachment while the recorder runs.

        app.buttons["返回"].tap()
        let bar = app.buttons["mote-recording-bar"]
        XCTAssertTrue(bar.waitForExistence(timeout: 10))
        bar.tap()
        XCTAssertTrue(app.buttons["暂停录音"].waitForExistence(timeout: 10))
        app.buttons["暂停录音"].tap()
        XCTAssertTrue(app.buttons["继续录音"].waitForExistence(timeout: 5))
        let elapsed = app.staticTexts["mote-recording-elapsed"].label
        sleep(2)
        XCTAssertEqual(app.staticTexts["mote-recording-elapsed"].label, elapsed)
        app.buttons["继续录音"].tap()
        XCTAssertTrue(app.buttons["暂停录音"].waitForExistence(timeout: 5))
        app.buttons["mote-recording-stop"].tap()
        XCTAssertTrue(app.buttons["播放录音"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons.matching(identifier: "播放录音").count, 1)
        app.buttons["返回"].tap()
        XCTAssertFalse(app.buttons["mote-recording-bar"].exists)
    }

    func testProcessExitKeepsUnfinishedAudioInTheDraft() {
        defer { resetDraft() }
        let app = XCUIApplication()
        app.launchArguments = ["-MoteRecordingTestInput", "-MoteEditorFixture", "empty"]
        app.launch()
        XCTAssertTrue(app.buttons["录音"].waitForExistence(timeout: 10))
        app.buttons["录音"].tap()
        XCTAssertTrue(app.buttons["mote-recording-stop"].waitForExistence(timeout: 10))
        sleep(1)
        app.terminate()
        app.launchArguments = ["-MoteEditorPreview"]
        app.launch()
        XCTAssertTrue(app.buttons["播放录音"].waitForExistence(timeout: 10))
        app.buttons["播放录音"].tap()
        XCTAssertTrue(app.buttons["暂停录音"].waitForExistence(timeout: 5))
    }

    func testInterruptedRecordingRequiresUserToContinue() {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteRecordingPreview", "-MoteRecordingTestInput", "-MoteRecordingState", "interrupted"]
        app.launch()
        XCTAssertTrue(app.staticTexts["录音已暂停"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["继续录音"].exists)
        XCTAssertFalse(app.buttons["暂停录音"].exists)
        app.buttons["继续录音"].tap()
        XCTAssertTrue(app.buttons["暂停录音"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["录音已暂停"].exists)
    }

    func testGrantingMicrophonePermissionStartsRecordingInEditor() {
        defer { resetDraft() }
        let app = XCUIApplication()
        app.resetAuthorizationStatus(for: .microphone)
        app.launchArguments = [
            "-MoteRecordingTestInput", "-MoteRecordingTestPermission", "-MoteEditorFixture", "empty",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["录音"].waitForExistence(timeout: 10))
        app.buttons["录音"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        let allow = alert.buttons.matching(NSPredicate(format: "label == '允许' OR label == 'Allow'")).firstMatch
        XCTAssertTrue(allow.waitForExistence(timeout: 5))
        allow.tap()
        XCTAssertTrue(app.buttons["mote-recording-stop"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textFields["mote-editor-text"].exists)
        app.buttons["mote-recording-stop"].tap()
    }

    func testRecordingReferencesLight() { captureReferences(appearance: "light") }
    func testRecordingReferencesDark() { captureReferences(appearance: "dark") }

    private func captureReferences(appearance: String) {
        for state in ["inApp", "interrupted", "away"] {
            let app = XCUIApplication()
            app.launchArguments = [
                "-MoteRecordingPreview", "-MoteRecordingTestInput",
                "-MoteRecordingState", state, "-MoteAppearance", appearance,
            ]
            app.launch()
            if state == "away" {
                XCTAssertTrue(app.buttons["mote-recording-bar"].waitForExistence(timeout: 10))
            } else {
                XCTAssertTrue(app.buttons["mote-recording-stop"].waitForExistence(timeout: 10))
            }
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "recording-\(state)-\(appearance)"
            attachment.lifetime = .keepAlways
            add(attachment)
            app.terminate()
        }
    }

    private func resetDraft() {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteEditorPreview", "-MoteEditorFixture", "empty"]
        app.launch()
        XCTAssertTrue(app.textFields["mote-editor-text"].waitForExistence(timeout: 10))
        app.terminate()
    }
}
