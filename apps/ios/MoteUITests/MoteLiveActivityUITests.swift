import XCTest

@MainActor
final class MoteLiveActivityUITests: XCTestCase {
    func testExpandedIslandControlsTheRecorderAndDisappearsAfterStop() {
        let app = XCUIApplication()
        app.launchArguments = ["-MoteRecordingPreview", "-MoteRecordingTestInput", "-MoteRecordingState", "inApp"]
        app.launch()
        XCTAssertTrue(app.buttons["mote-recording-stop"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["暂停录音"].exists)

        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let island = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.043))
        let compact = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS '录音'")).firstMatch
        XCTAssertTrue(compact.waitForExistence(timeout: 15))
        sleep(2) // Allow a preceding activity's dismissal and the new island's presentation to settle.
        island.press(forDuration: 1.5)
        let expanded = springboard.otherElements.matching(identifier: "regular.view").firstMatch
        XCTAssertTrue(expanded.waitForExistence(timeout: 15))
        XCTAssertTrue(expanded.label.contains("暂停录音"))
        XCTAssertTrue(expanded.label.contains("停止录音"))
        sleep(2) // SpringBoard reports the archived view before its expansion animation finishes.
        attachScreenshot("live-activity-expanded")

        // SpringBoard exposes the archived activity as one accessibility group;
        // tap the two 44pt controls inside it using their observed positions.
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.714, dy: 0.108)).tap()
        app.activate()
        XCTAssertTrue(app.buttons["继续录音"].waitForExistence(timeout: 10))

        XCUIDevice.shared.press(.home)
        island.press(forDuration: 1.5)
        XCTAssertTrue(expanded.waitForExistence(timeout: 10))
        XCTAssertTrue(expanded.label.contains("继续录音"))
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.714, dy: 0.108)).tap()
        app.activate()
        XCTAssertTrue(app.buttons["暂停录音"].waitForExistence(timeout: 10))

        XCUIDevice.shared.press(.home)
        island.press(forDuration: 1.5)
        XCTAssertTrue(expanded.waitForExistence(timeout: 10))
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.855, dy: 0.108)).tap()
        app.activate()
        XCTAssertTrue(app.buttons["播放录音"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["mote-recording-stop"].exists)
    }

    func testExpandedIslandLightAndDarkScreenshots() {
        for (appearance, name) in [(XCUIDevice.Appearance.light, "light"), (.dark, "dark")] {
            XCUIDevice.shared.appearance = appearance
            let app = XCUIApplication()
            app.launchArguments = ["-MoteRecordingPreview", "-MoteRecordingTestInput", "-MoteRecordingState", "inApp"]
            app.launch()
            XCTAssertTrue(app.buttons["mote-recording-stop"].waitForExistence(timeout: 10))
            XCUIDevice.shared.press(.home)
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            XCTAssertTrue(springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS '录音'")).firstMatch.waitForExistence(timeout: 15))
            sleep(2)
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.043)).press(forDuration: 1.5)
            XCTAssertTrue(springboard.otherElements.matching(identifier: "regular.view").firstMatch.waitForExistence(timeout: 15))
            sleep(2) // Capture the rendered activity after the system animation.
            attachScreenshot("live-activity-expanded-\(name)")
            app.activate()
            app.buttons["mote-recording-stop"].tap()
            app.terminate()
        }
        XCUIDevice.shared.appearance = .light
    }

    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
