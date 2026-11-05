import XCTest
import CoreImage
import UIKit

@MainActor
final class ConnectionUITests: XCTestCase {
    private func invitation(platforms: [String] = ["android", "ios", "macos"], server: String = "http://127.0.0.1:9") throws -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let payload: [String: Any] = ["format": "mote.connection", "version": 1,
                                     "serverUrl": server, "code": String(repeating: "a", count: 43),
                                     "expiresAt": formatter.string(from: Date().addingTimeInterval(600)), "platforms": platforms]
        return String(decoding: try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]), as: UTF8.self)
    }

    private func launch(_ environment: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = environment.merging(["MOTE_TEST_PENDING": "3"]) { value, _ in value }
        app.launch()
        return app
    }

    private func assertConfirmation(_ app: XCUIApplication) {
        XCTAssertTrue(app.staticTexts["127.0.0.1:9"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["本人设备"].exists)
        XCTAssertEqual(app.textFields["设备名称"].value as? String, "我的 iPhone")
        XCTAssertTrue(app.staticTexts["3 条记录"].exists)
    }

    func testPasteInvalidInvitationAndConnectionFailure() throws {
        let app = launch(["MOTE_TEST_PASTE": "generated invalid invitation"])
        app.buttons["粘贴邀请"].tap()
        XCTAssertTrue(app.staticTexts["邀请已失效"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["扫描二维码"].exists)
        app.terminate()

        app.launchEnvironment["MOTE_TEST_PASTE"] = try invitation()
        app.launch()
        app.buttons["粘贴邀请"].tap()
        assertConfirmation(app)
        let field = app.textFields["设备名称"]
        field.tap()
        field.typeText(" 测试")
        XCTAssertTrue((field.value as? String)?.contains("测试") == true)
        app.buttons["确认连接"].tap()
        XCTAssertTrue(app.staticTexts["连接未完成"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["重试"].exists)
    }

    func testUnsupportedCentralShowsUpgradeMessage() throws {
        let app = launch(["MOTE_TEST_PASTE": try invitation(platforms: ["android", "macos"])])
        app.buttons["粘贴邀请"].tap()
        XCTAssertTrue(app.staticTexts["此中央尚不支持 iOS，升级中央后重试"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.textFields["设备名称"].exists)
    }

    func testConfirmationCountsTheActualSendQueue() throws {
        let app = XCUIApplication()
        app.launchEnvironment = ["MOTE_TEST_PASTE": try invitation(), "MOTE_TEST_QUEUE_ITEMS": "3"]
        app.launch()
        app.buttons["粘贴邀请"].tap()
        assertConfirmation(app)
        app.terminate()
        app.launchEnvironment = ["MOTE_TEST_QUEUE_ITEMS": "0"]
        app.launch()
    }

    func testVerifiedConnectionSurvivesRelaunchAndProtectsQueuedRecords() throws {
        let central = try ConnectionFixtureServer()
        defer { central.stop() }
        let service = "dev.mote.ios.test.\(UUID().uuidString)"
        let app = XCUIApplication()
        app.launchEnvironment = ["MOTE_TEST_PASTE": try invitation(server: central.origin),
                                 "MOTE_TEST_QUEUE_ITEMS": "0", "MOTE_TEST_CONNECTION_SERVICE": service]
        app.launch()
        app.buttons["粘贴邀请"].tap()
        XCTAssertTrue(app.staticTexts["本人设备"].waitForExistence(timeout: 10))
        app.buttons["确认连接"].tap()
        let didConnect = app.alerts["已连接"].waitForExistence(timeout: 20)
        XCTAssertTrue(didConnect, app.debugDescription)
        guard didConnect else { return }
        XCTAssertEqual(central.requests, ["/api/connections/redeem", "/api/connections/self"])
        app.terminate()

        app.launchEnvironment = ["MOTE_TEST_PASTE": try invitation(), "MOTE_TEST_QUEUE_ITEMS": "1",
                                 "MOTE_TEST_CONNECTION_SERVICE": service]
        app.launch()
        app.buttons["粘贴邀请"].tap()
        app.buttons["确认连接"].tap()
        XCTAssertTrue(app.staticTexts["有待发送记录，无法更换中央"].waitForExistence(timeout: 10))
        XCTAssertEqual(central.requests, ["/api/connections/redeem", "/api/connections/self"])
    }

    func testScannerRecognizesInjectedQRCodeImage() throws {
        let input = try invitation()
        let filter = try XCTUnwrap(CIFilter(name: "CIQRCodeGenerator"))
        filter.setValue(Data(input.utf8), forKey: "inputMessage")
        let code = try XCTUnwrap(filter.outputImage)
        let bounds = code.extent.insetBy(dx: -4, dy: -4)
        let image = code.composited(over: CIImage(color: .white).cropped(to: bounds))
            .cropped(to: bounds).transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        let cgImage = try XCTUnwrap(CIContext().createCGImage(image, from: image.extent))
        let png = try XCTUnwrap(UIImage(cgImage: cgImage).pngData())
        let detector = try XCTUnwrap(CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(),
                                                options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]))
        XCTAssertEqual((detector.features(in: CIImage(cgImage: cgImage)).first as? CIQRCodeFeature)?.messageString, input)
        let app = launch(["MOTE_TEST_QR_IMAGE": png.base64EncodedString()])
        app.buttons["扫描二维码"].tap()
        assertConfirmation(app)
    }

    func testSelectInvitationFile() throws {
        let app = launch(["MOTE_TEST_FILE": try invitation()])
        app.buttons["选择邀请文件"].tap()
        let file = app.cells.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Mote-invitation.json")).firstMatch
        if !file.waitForExistence(timeout: 5) {
            let browse = app.buttons["浏览"].firstMatch
            if browse.exists { browse.tap() }
            let onPhone = app.cells.matching(NSPredicate(format: "label CONTAINS %@", "我的iPhone")).firstMatch
            if onPhone.waitForExistence(timeout: 5) { onPhone.tap() }
            let folder = app.cells.matching(NSPredicate(format: "label BEGINSWITH %@", "Mote")).firstMatch
            if folder.waitForExistence(timeout: 5) { folder.tap() }
        }
        XCTAssertTrue(file.waitForExistence(timeout: 10), "Generated invitation should be selectable in the system file picker")
        file.tap()
        assertConfirmation(app)
    }

    func testLightScreens() throws { try captureScreens("light") }
    func testDarkScreens() throws { try captureScreens("dark") }

    func testConnectingCannotSubmitTwice() throws {
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            app.launchArguments = ["-MoteAppearance", appearance]
            app.launchEnvironment = ["MOTE_TEST_STATE": "connecting", "MOTE_TEST_PENDING": "3",
                                     "MOTE_TEST_INVITATION": try invitation(server: "https://mote.example.net")]
            app.launch()
            let button = app.buttons["正在连接…"]
            XCTAssertTrue(button.waitForExistence(timeout: 10))
            XCTAssertFalse(button.isEnabled, "A second connection must be unavailable")
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "connecting-\(appearance)"
            attachment.lifetime = .keepAlways
            add(attachment)
            app.terminate()
        }
    }

    private func captureScreens(_ appearance: String) throws {
        for state in ["start", "invalid", "scan", "confirm", "connecting", "failed"] {
            let app = XCUIApplication()
            app.launchArguments = ["-MoteAppearance", appearance]
            let visualInvitation = try invitation(server: "https://mote.example.net")
            app.launchEnvironment = ["MOTE_TEST_STATE": state, "MOTE_TEST_PENDING": "3", "MOTE_TEST_INVITATION": visualInvitation]
            app.launch()
            let expected = ["start": "连接你的 Mote", "invalid": "邀请已失效", "scan": "将二维码放入取景框",
                            "confirm": "本人设备", "connecting": "正在连接…", "failed": "连接未完成"][state]!
            let element = state == "connecting" ? app.buttons[expected] : app.staticTexts[expected]
            XCTAssertTrue(element.waitForExistence(timeout: 10), "Missing \(state)")
            let buttons: [String]
            switch state {
            case "start", "invalid": buttons = ["返回", "扫描二维码", "粘贴邀请", "选择邀请文件", "还没有自己的 Mote？"]
            case "scan": buttons = ["关闭", "粘贴邀请"]
            case "connecting": buttons = ["取消", "正在连接…"]
            case "failed": buttons = ["取消", "重试"]
            default: buttons = ["取消", "确认连接"]
            }
            for label in buttons {
                let button = app.buttons[label].firstMatch
                XCTAssertTrue(button.exists, "Missing \(label)")
                XCTAssertGreaterThanOrEqual(button.frame.width, 44, "\(label) is narrower than 44pt")
                XCTAssertGreaterThanOrEqual(button.frame.height, 44, "\(label) is shorter than 44pt")
            }
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "\(state)-\(appearance)"
            attachment.lifetime = .keepAlways
            add(attachment)
            app.terminate()
        }
    }
}
