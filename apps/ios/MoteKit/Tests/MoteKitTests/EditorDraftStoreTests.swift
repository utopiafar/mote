import XCTest
import MoteStorage

final class EditorDraftStoreTests: XCTestCase {
    private var directoryURL: URL!

    override func setUpWithError() throws {
        directoryURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directoryURL)
    }

    func testClearUndoRestoresTextNotesAndEveryAttachmentAfterPersistence() throws {
        let store = EditorDraftStore(directoryURL: directoryURL)
        let photo = try store.importData(Data("生成的照片".utf8), kind: .photo, fileName: "照片.png")
        let audio = try store.importData(Data("生成的录音".utf8), kind: .audio, fileName: "录音.wav", duration: 134)
        let file = try store.importData(Data("生成的文件".utf8), kind: .file, fileName: "账单.pdf")
        let original = EditorDraft(
            text: "生成的正文\n保留换行",
            sourceDescription: "生成的资料说明",
            attachments: [photo, audio, file]
        )
        var session = EditorDraftSession(draft: original)
        try store.save(session.draft)

        session.clear()
        try store.save(session.draft)
        XCTAssertTrue(session.draft.isEmpty)
        XCTAssertTrue(session.canUndoClear)
        XCTAssertTrue(try EditorDraftStore(directoryURL: directoryURL).load().isEmpty)
        for attachment in original.attachments {
            XCTAssertTrue(FileManager.default.fileExists(atPath: store.fileURL(for: attachment).path))
        }

        session.undoClear()
        try store.save(session.draft)
        XCTAssertFalse(session.canUndoClear)
        XCTAssertEqual(session.draft, original)
        let reopened = EditorDraftStore(directoryURL: directoryURL)
        XCTAssertEqual(try reopened.load(), original)
        for attachment in original.attachments {
            XCTAssertEqual(try Data(contentsOf: reopened.fileURL(for: attachment)), try Data(contentsOf: store.fileURL(for: attachment)))
        }
    }

    func testSavingAndReopeningKeepTheOnlyDraftUnchanged() throws {
        let store = EditorDraftStore(directoryURL: directoryURL)
        let draft = EditorDraft(text: "保存和重启后仍保留", sourceDescription: "生成的说明")
        try store.save(draft)
        try store.save(draft)

        XCTAssertEqual(try EditorDraftStore(directoryURL: directoryURL).load(), draft)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directoryURL.path), ["draft.json"])
    }

    func testRemovingRecordingPersistsAndDeletesOnlyItsFile() throws {
        let store = EditorDraftStore(directoryURL: directoryURL)
        let photo = try store.importData(Data("保留的照片".utf8), kind: .photo, fileName: "照片.png")
        let audio = try store.importData(Data("移除的录音".utf8), kind: .audio, fileName: "录音.wav")
        var session = EditorDraftSession(draft: EditorDraft(attachments: [photo, audio]))
        let audioURL = store.fileURL(for: audio)

        session.update { draft in
            draft.attachments.removeAll { $0.id == audio.id }
        }
        try store.save(session.draft)
        try store.delete(audio)

        XCTAssertFalse(FileManager.default.fileExists(atPath: audioURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.fileURL(for: photo).path))
        XCTAssertEqual(try EditorDraftStore(directoryURL: directoryURL).load().attachments, [photo])
    }
}
