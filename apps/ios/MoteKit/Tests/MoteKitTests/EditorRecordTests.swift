import XCTest
import MoteCentral
import MoteStorage

final class EditorRecordTests: XCTestCase {
    private var directoryURL: URL!

    override func setUpWithError() throws {
        directoryURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directoryURL)
    }

    func testManualSaveQueuesTextDescriptionAndAttachmentsAsOneRecord() throws {
        let attachment = EditorAttachment(
            id: "00000000-0000-4000-8000-000000000010",
            kind: .photo,
            fileName: "照片.png",
            storedFileName: "generated-photo.png"
        )
        let draft = EditorDraft(
            text: "生成的正文\n保留换行",
            sourceDescription: "生成的资料说明",
            attachments: [attachment]
        )
        let bytes = Data("生成的照片".utf8)
        let queue = SendQueue(directoryURL: directoryURL.appendingPathComponent("Queue"))
        let attachments = ShareAttachmentStore(directoryURL: directoryURL.appendingPathComponent("Attachments"))
        let recordId = UUID(uuidString: "00000000-0000-4000-8000-000000000011")!

        let saved = try EditorSubmission.save(
            draft: draft,
            attachments: [ShareAttachmentData(data: bytes, fileName: attachment.fileName, mimeType: "image/png")],
            deviceId: "generated-iphone",
            deviceName: "Generated iPhone",
            recordId: recordId,
            capturedAt: "2026-11-06T02:00:00.000Z",
            queue: queue,
            attachmentStore: attachments
        )

        let pending = try queue.pending()
        XCTAssertEqual(pending.map(\.id), [recordId.uuidString.lowercased()])
        let capture = try JSONDecoder().decode(CaptureUpload.self, from: XCTUnwrap(pending.first).payload)
        XCTAssertEqual(capture, saved.capture)
        XCTAssertEqual(capture.source, .note)
        XCTAssertEqual(capture.ocrText, draft.text)
        XCTAssertEqual(capture.metadata?.noteOrigin?.kind, .manual)
        XCTAssertEqual(capture.metadata?.noteOrigin?.text, draft.text)
        XCTAssertEqual(capture.metadata?.ownerDescription, draft.sourceDescription)
        XCTAssertEqual(capture.metadata?.collector?.method, "manual")
        let manifest = try XCTUnwrap(attachments.manifest(recordId: recordId))
        XCTAssertEqual(manifest.map(\.fileName), [attachment.fileName])
        XCTAssertEqual(try Data(contentsOf: attachments.fileURL(recordId: recordId, attachment: manifest[0])), bytes)
    }

    func testDescriptionOnlyDraftDoesNotBecomeARecord() throws {
        let queue = SendQueue(directoryURL: directoryURL.appendingPathComponent("Queue"))
        let attachments = ShareAttachmentStore(directoryURL: directoryURL.appendingPathComponent("Attachments"))

        XCTAssertThrowsError(try EditorSubmission.save(
            draft: EditorDraft(sourceDescription: "只有资料说明"),
            attachments: [],
            deviceId: "generated-iphone",
            deviceName: "Generated iPhone",
            queue: queue,
            attachmentStore: attachments
        )) {
            XCTAssertEqual($0 as? ShareRecordError, .invalidRequest)
        }
        XCTAssertTrue(try queue.pending().isEmpty)
    }
}
