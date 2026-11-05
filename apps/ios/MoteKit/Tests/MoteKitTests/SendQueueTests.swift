import XCTest
import MoteStorage

final class SendQueueTests: XCTestCase {
    private var directoryURL: URL!

    override func setUpWithError() throws {
        directoryURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directoryURL)
    }

    func testPayloadIsDurableBeforeAcknowledgement() throws {
        let payload = Data([0, 1, 2, 255])
        let queue = SendQueue(directoryURL: directoryURL)
        let item = try queue.enqueue(payload, id: "generated-send")

        let persistedBeforeSend = try SendQueue(directoryURL: directoryURL).pending()
        XCTAssertEqual(persistedBeforeSend, [item])
        XCTAssertEqual(persistedBeforeSend.first?.payload, payload)

        XCTAssertEqual(try SendQueue(directoryURL: directoryURL).pending(), [item])
    }

    func testAcknowledgementRemovesOnlyTheAcceptedItem() throws {
        let queue = SendQueue(directoryURL: directoryURL)
        let first = try queue.enqueue(Data("generated first".utf8), id: "generated-first")
        let second = try queue.enqueue(Data("generated second".utf8), id: "generated-second")

        XCTAssertEqual(try queue.pending(), [first, second])
        try queue.acknowledge(id: first.id)
        XCTAssertEqual(try SendQueue(directoryURL: directoryURL).pending(), [second])

        try queue.acknowledge(id: "generated-unknown")
        XCTAssertEqual(try queue.pending(), [second])
        try queue.acknowledge(id: second.id)
        XCTAssertEqual(try SendQueue(directoryURL: directoryURL).pending(), [])
    }
}
