import Foundation
import XCTest

@MainActor
final class MoteReaderVisualAuditUITests: XCTestCase {
    func testLiveLibraryReaders() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let pointer = root.appending(path: ".mote/reader-visual/active-ios")
        guard let path = try? String(contentsOf: pointer, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) else {
            throw XCTSkip("Start the isolated material reader fixture to run this walkthrough")
        }
        let run = URL(fileURLWithPath: path, isDirectory: true)
        let data = try Data(contentsOf: run.appending(path: "fixture/fixture.json"))
        let fixture = try JSONDecoder().decode(ReaderFixture.self, from: data)
        let origin = try XCTUnwrap(URL(string: fixture.origin))
        XCTAssertTrue(fixture.generatedOnly && origin.host == "127.0.0.1")
        guard fixture.generatedOnly && origin.host == "127.0.0.1" else { return }

        var request = URLRequest(url: origin.appending(path: "api/connections/invitations"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(fixture.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["serverUrl": fixture.origin, "label": "Generated iOS reader"])
        let (receipt, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: receipt) as? [String: Any])
        let invitation = try JSONSerialization.data(withJSONObject: XCTUnwrap(payload["invitation"]))
        let output = run.appending(path: "ios")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

        let app = XCUIApplication()
        app.launchArguments = ["-MoteAppearance", "light", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN",
                               "-mote.deviceId", UUID().uuidString.lowercased()]
        app.launchEnvironment = [
            "MOTE_TEST_PASTE": String(decoding: invitation, as: UTF8.self),
            "MOTE_TEST_QUEUE_ITEMS": "0",
            "MOTE_TEST_CONNECTION_SERVICE": "dev.mote.ios.test.\(UUID().uuidString)",
        ]
        app.launch()
        try tap(app.buttons["连接"])
        try tap(app.buttons["粘贴邀请"])
        try tap(app.buttons["确认连接"])
        XCTAssertTrue(app.alerts["已连接"].waitForExistence(timeout: 20), app.debugDescription)
        try tap(app.alerts["已连接"].buttons["完成"], timeout: 20)
        try tap(app.buttons["我的 Mote"])
        try tap(app.buttons["menu-library"])

        let cases = fixture.examples.filter { $0.captureId != nil }
        XCTAssertFalse(cases.isEmpty)
        for example in cases {
            try XCTContext.runActivity(named: example.key) { _ in
                let id = try XCTUnwrap(example.captureId)
                let row = app.buttons["library-row-\(id)"]
                let list = app.scrollViews.firstMatch
                for _ in 0..<7 where !row.isHittable { list.swipeUp(velocity: .fast) }
                if !row.isHittable {
                    for _ in 0..<7 where !row.isHittable { list.swipeDown(velocity: .fast) }
                }
                try tap(row)
                let source = app.buttons["来源与处理"]
                XCTAssertTrue(source.waitForExistence(timeout: 10), example.key)
                let hasImage = ["screenshot", "image"].contains(example.key)
                if hasImage {
                    XCTAssertTrue(app.buttons["original-image"].waitForExistence(timeout: 10), example.key)
                }
                try screenshot(example.key, in: output)
                let marker = [
                    "device-event": "熄屏",
                    "activity": "前台应用采样时长",
                    "reference": "此来源仅保留引用与元数据，未导入正文。",
                ][example.key] ?? example.marker
                let body = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", marker)).firstMatch
                XCTAssertTrue(body.exists, "Expected visible content for \(example.key)")
                if example.key == "notification" {
                    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "notificationKey")).firstMatch.exists)
                }
                try tap(source)
                XCTAssertTrue(app.staticTexts["中央已接收"].exists)
                if ["note", "screenshot", "notification", "image"].contains(example.key) {
                    try screenshot(example.key + "-source", in: output)
                }
                try tap(app.buttons["关闭"])
                if hasImage {
                    try tap(app.buttons["original-image"])
                    try tap(app.buttons["放大"])
                    XCTAssertTrue(app.buttons["适应宽度"].exists)
                    try screenshot(example.key + "-zoom", in: output)
                    try tap(app.buttons["关闭原图"])
                }
                if example.key == "recording" {
                    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "[SPEAKER_0]")).firstMatch.exists)
                    try tap(app.buttons["播放录音"])
                    XCTAssertTrue(app.buttons["暂停"].waitForExistence(timeout: 10))
                    try screenshot("recording-playing", in: output)
                    try tap(app.buttons["暂停"])
                    XCTAssertTrue(app.buttons["播放录音"].exists)
                }
                try tap(app.buttons["返回"].firstMatch)
                XCTAssertTrue(app.textFields["library-search"].waitForExistence(timeout: 5))
            }
        }
    }

    private func tap(_ element: XCUIElement, timeout: TimeInterval = 10) throws {
        guard element.wait(for: \.isHittable, toEqual: true, timeout: timeout) else {
            XCTFail("Missing or unreachable control \(element)")
            throw CocoaError(.fileReadUnknown)
        }
        element.tap()
    }

    private func screenshot(_ name: String, in output: URL) throws {
        try XCUIScreen.main.screenshot().pngRepresentation.write(to: output.appending(path: name + ".png"))
    }
}

private struct ReaderFixture: Decodable {
    let generatedOnly: Bool
    let origin: String
    let token: String
    let examples: [Example]

    struct Example: Decodable {
        let key: String
        let captureId: String?
        let marker: String
    }
}
