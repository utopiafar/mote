import MoteCentral
import XCTest

final class ConversationDeletionContractTests: XCTestCase {
    func testDeleteRemovesHistoryAndKeepsIndependentlySavedOriginal() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let server = environment["MOTE_SWIFT_HISTORY_URL"],
              let token = environment["MOTE_SWIFT_HISTORY_TOKEN"],
              let conversation = environment["MOTE_SWIFT_CONTRACT_CONVERSATION"],
              let original = environment["MOTE_SWIFT_HISTORY_ORIGINAL"] else {
            throw XCTSkip("Use apps/ios/test-fixtures/central-swift-contract.ts --history-only")
        }
        let client = try CentralClient(serverUrl: server, token: token)
        let before = try await client.conversations()
        XCTAssertTrue(before.items.contains { $0.id == conversation })
        let existing = try await client.conversation(id: try XCTUnwrap(UUID(uuidString: conversation)))
        XCTAssertEqual(existing.turns.first?.result?.answer, "Generated saved answer")

        let receipt = try await client.deleteConversation(id: try XCTUnwrap(UUID(uuidString: conversation)))
        XCTAssertEqual(receipt.deleted, 1)
        let after = try await client.conversations()
        XCTAssertFalse(after.items.contains { $0.id == conversation })
        let retained = try await client.original(id: try XCTUnwrap(UUID(uuidString: original)))
        XCTAssertEqual(retained.ocrText, "Generated saved source body")
    }
}
