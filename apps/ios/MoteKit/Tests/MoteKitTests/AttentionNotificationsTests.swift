import XCTest
import MoteCore

final class AttentionNotificationsTests: XCTestCase {
    private struct Fixture: Decodable {
        let name: String
        let facts: CaptureStatusFacts
        let expected: CaptureStatusRow
    }

    private var fixtures: [Fixture]!
    private var directoryURL: URL!

    override func setUpWithError() throws {
        fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: Self.fixtureURL))
        directoryURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directoryURL)
    }

    func testPostsOnlyForNeedsActionRowsSharedWithIOS() throws {
        XCTAssertEqual(fixtures.count, 20)
        for fixture in fixtures {
            var dedup = AttentionDedup()
            let post = dedup.update(CaptureStatusMapping.status(for: fixture.facts))
            guard let expected = fixture.expected.notification else {
                XCTAssertNil(post, fixture.name)
                continue
            }
            if expected.platforms.contains(.ios) {
                XCTAssertEqual(post?.status, fixture.expected.id, fixture.name)
                XCTAssertEqual(post?.text, expected.titleKey, fixture.name)
                XCTAssertEqual(post?.operation, expected.operation, fixture.name)
                XCTAssertTrue(post?.identifier.hasSuffix(fixture.expected.id.rawValue) == true, fixture.name)
            } else {
                XCTAssertNil(post, fixture.name)
            }
        }
    }

    func testBodiesForIOSNeedsActionRows() throws {
        let context = AttentionContext(centralHost: "mote.example.net", waitingSources: ["媒体"])
        let expected: [(name: String, id: CaptureStatusID, title: String, body: String)] = [
            ("reconnect", .reconnect, "需要重新连接", "mote.example.net"),
            ("storage-full", .storageFull, "本机空间已满", "新的记录暂时无法保存"),
            ("permission-missing", .permission, "等待采集权限", "媒体"),
            ("send-attention", .sendAttention, "发送需要处理", "发送失败"),
        ]
        for row in expected {
            var dedup = AttentionDedup()
            let post = try XCTUnwrap(dedup.update(try status(row.name), context: context), row.name)
            XCTAssertEqual(post.status, row.id, row.name)
            XCTAssertEqual(post.text, row.title, row.name)
            XCTAssertEqual(post.body, row.body, row.name)
        }
    }

    func testPermissionBodyJoinsWaitingSources() throws {
        var dedup = AttentionDedup()
        let post = try XCTUnwrap(dedup.update(try status("partial-permission"), context: AttentionContext(waitingSources: ["媒体", "通知"])))
        XCTAssertEqual(post.text, "等待采集权限")
        XCTAssertEqual(post.body, "媒体、通知")
    }

    func testReconnectBodyUsesHostFromCentralEndpoint() throws {
        var dedup = AttentionDedup()
        let post = try XCTUnwrap(dedup.update(
            try status("reconnect"),
            context: AttentionContext(centralEndpoint: "https://mote.example.net:8443/central")
        ))
        XCTAssertEqual(post.text, "需要重新连接")
        XCTAssertEqual(post.body, "mote.example.net")
    }

    func testSameIssueAlertsOnceUntilRecovery() throws {
        let storage = try status("storage-full")
        let send = try status("send-attention")
        let capture = try status("capturing")
        var dedup = AttentionDedup()

        XCTAssertEqual(dedup.update(storage)?.status, .storageFull)
        XCTAssertNil(dedup.update(storage))
        XCTAssertEqual(dedup.update(send)?.status, .sendAttention)
        XCTAssertNil(dedup.update(send))
        XCTAssertEqual(dedup.update(storage)?.status, .storageFull)
        XCTAssertNil(dedup.update(capture))
        XCTAssertEqual(dedup.update(storage)?.status, .storageFull)
        XCTAssertNil(dedup.update(storage))
    }

    func testNotifierPersistsDedupAcrossInstances() throws {
        let stateFile = directoryURL.appendingPathComponent("state.json")
        let text = try XCTUnwrap(fixture("storage-full").expected.notification?.titleKey)
        var posts: [AttentionPost] = []
        let recorder: (AttentionPost) -> Void = { posts.append($0) }

        let notifier = AttentionNotifier(stateFileURL: stateFile, poster: recorder)
        notifier.update(facts: try facts("storage-full"))
        notifier.update(facts: try facts("storage-full"))
        XCTAssertEqual(posts.map(\.text), [text])

        let relaunched = AttentionNotifier(stateFileURL: stateFile, poster: recorder)
        relaunched.update(facts: try facts("storage-full"))
        XCTAssertEqual(posts.map(\.text), [text])

        relaunched.update(facts: try facts("capturing"))
        relaunched.update(facts: try facts("storage-full"))
        XCTAssertEqual(posts.map(\.text), [text, text])

        let third = AttentionNotifier(stateFileURL: stateFile, poster: recorder)
        third.update(facts: try facts("capturing"))
        third.update(facts: try facts("storage-full"))
        XCTAssertEqual(posts.map(\.text), [text, text, text])
    }

    private func fixture(_ name: String) throws -> Fixture {
        try XCTUnwrap(fixtures.first { $0.name == name }, name)
    }

    private func facts(_ name: String) throws -> CaptureStatusFacts {
        try fixture(name).facts
    }

    private func status(_ name: String) throws -> CaptureStatusRow {
        CaptureStatusMapping.status(for: try facts(name))
    }

    private static let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("../../../../../packages/shared/test-fixtures/capture-status-cases.json")
}
