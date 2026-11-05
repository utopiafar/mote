import XCTest
import MoteStorage

final class ConnectionStoreTests: XCTestCase {
    private var directoryURL: URL!

    override func setUpWithError() throws {
        directoryURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directoryURL)
    }

    func testOneConnectionSurvivesReopenUntilExplicitlyCleared() throws {
        let store = ConnectionStore(directoryURL: directoryURL)
        XCTAssertNil(try store.read())

        let connection = StoredConnection(
            serverUrl: "https://mote.example.com",
            token: "generated-token",
            credentialId: "generated-credential",
            scope: "owner"
        )
        try store.save(connection)

        XCTAssertEqual(try ConnectionStore(directoryURL: directoryURL).read(), connection)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directoryURL.path), ["connection.json"])

        try store.clear()
        XCTAssertNil(try ConnectionStore(directoryURL: directoryURL).read())
        try store.clear()
    }

    func testDraftPresenceDoesNotDependOnTheDraftShape() throws {
        let store = DraftStore(directoryURL: directoryURL)
        XCTAssertFalse(store.exists())

        try store.save(["text": "生成的草稿正文"])
        XCTAssertTrue(DraftStore(directoryURL: directoryURL).exists())

        try store.clear()
        XCTAssertFalse(store.exists())
    }
}
