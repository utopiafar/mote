import MoteCentral
import XCTest

final class ConversationReadContractTests: XCTestCase {
    func testReadsTheSavedConversationAndKeepsIndependentlySavedOriginal() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let server = environment["MOTE_SWIFT_HISTORY_URL"],
              let token = environment["MOTE_SWIFT_HISTORY_TOKEN"],
              let conversation = environment["MOTE_SWIFT_CONTRACT_CONVERSATION"],
              let original = environment["MOTE_SWIFT_HISTORY_ORIGINAL"] else {
            throw XCTSkip("Use apps/ios/test-fixtures/central-swift-contract.ts --history-only")
        }
        let client = try CentralClient(serverUrl: server, token: token)
        let existing = try await client.conversation(id: try XCTUnwrap(UUID(uuidString: conversation)))
        XCTAssertEqual(existing.id, conversation)
        XCTAssertEqual(existing.turns.first?.result?.answer, "Generated saved answer")

        let retained = try await client.original(id: try XCTUnwrap(UUID(uuidString: original)))
        XCTAssertEqual(retained.ocrText, "Generated saved source body")
    }
}
