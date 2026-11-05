import XCTest
import MoteCore

final class CaptureStatusMappingTests: XCTestCase {
    private struct Fixture: Decodable {
        let name: String
        let facts: CaptureStatusFacts
        let expected: CaptureStatusRow
    }

    func testSharedCaptureStatusCases() throws {
        let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: Self.fixtureURL))
        XCTAssertEqual(fixtures.count, 20)
        for fixture in fixtures {
            XCTAssertEqual(CaptureStatusMapping.status(for: fixture.facts), fixture.expected, fixture.name)
        }
    }

    func testTableUsesSharedStateOrder() {
        XCTAssertEqual(CaptureStatusMapping.table.map(\.id), [
            .capturing, .pendingSync, .screenPaused, .paused, .sendPaused, .localOnly,
            .reconnect, .storageFull, .interrupted, .permission, .sendAttention, .disconnected,
        ])
    }

    private static let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("../../../../../packages/shared/test-fixtures/capture-status-cases.json")
}
