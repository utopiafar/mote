import XCTest
import MoteStorage

final class DraftStoreTests: XCTestCase {
    private struct Draft: Codable, Equatable {
        let text: String
        let sourceDescription: String
    }

    private var directoryURL: URL!

    override func setUpWithError() throws {
        directoryURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directoryURL)
    }

    func testOneDraftSurvivesReopenUntilExplicitlyCleared() throws {
        let store = DraftStore(directoryURL: directoryURL)
        XCTAssertNil(try store.read(Draft.self))

        try store.save(Draft(text: "生成的第一版草稿", sourceDescription: "生成的前期说明"))
        try store.save(Draft(text: "生成的最新草稿\n保留换行", sourceDescription: "生成的最新说明"))

        let reopened = DraftStore(directoryURL: directoryURL)
        XCTAssertEqual(try reopened.read(Draft.self), Draft(text: "生成的最新草稿\n保留换行", sourceDescription: "生成的最新说明"))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directoryURL.path), ["draft.json"])

        try reopened.clear()
        XCTAssertNil(try DraftStore(directoryURL: directoryURL).read(Draft.self))
        try reopened.clear()
    }

    func testQueueActivityDoesNotChangeTheDraft() throws {
        let store = DraftStore(directoryURL: directoryURL)
        let draft = Draft(text: "分享保存时保留这份草稿", sourceDescription: "生成的独立说明")
        try store.save(draft)

        let queue = SendQueue(directoryURL: directoryURL.appendingPathComponent("queue", isDirectory: true))
        try queue.enqueue(Data("生成的分享内容".utf8))

        XCTAssertEqual(try DraftStore(directoryURL: directoryURL).read(Draft.self), draft)
    }
}
