import XCTest
import MoteCentral
import MoteStorage

final class ShareRecordTests: XCTestCase {
    private var directoryURL: URL!

    override func setUpWithError() throws {
        directoryURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directoryURL)
    }

    func testLinkShareEncodesManualCollectorAndSharedOrigin() throws {
        let link = ShareLinkPreview(
            url: "https://www.seriouseats.com/ribs",
            title: "低温慢烤牛肋排的时间表",
            domain: "seriouseats.com"
        )
        let request = ShareRequest(text: "低温慢烤牛肋排的时间表", link: link)
        let shared = try ShareRecord.make(
            request: request,
            note: "周末试一下，6 小时那版。",
            description: "生成的资料说明",
            attachments: [],
            deviceId: "generated-iphone",
            deviceName: "Generated iPhone",
            id: UUID(uuidString: "00000000-0000-4000-8000-000000000001")!,
            capturedAt: "2026-11-06T02:00:00.000Z"
        )
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: ShareRecord.payload(shared.capture)) as? [String: Any])
        XCTAssertEqual(object["id"] as? String, "00000000-0000-4000-8000-000000000001")
        XCTAssertEqual(object["source"] as? String, "note")
        XCTAssertEqual(object["platform"] as? String, "ios")
        XCTAssertEqual(object["appId"] as? String, "dev.mote.notes")
        XCTAssertEqual(object["appName"] as? String, "记录")
        XCTAssertEqual(object["ocrText"] as? String, "周末试一下，6 小时那版。")
        XCTAssertNil(object["imageBase64"])

        let metadata = try XCTUnwrap(object["metadata"] as? [String: Any])
        XCTAssertEqual(metadata["version"] as? Int, 1)
        XCTAssertEqual(metadata["ownerDescription"] as? String, "生成的资料说明")
        XCTAssertNil(metadata["attachments"])
        let collector = try XCTUnwrap(metadata["collector"] as? [String: Any])
        XCTAssertEqual(collector["method"] as? String, "manual")
        let origin = try XCTUnwrap(metadata["noteOrigin"] as? [String: Any])
        XCTAssertEqual(origin["kind"] as? String, "share")
        XCTAssertEqual(origin["url"] as? String, link.url)
        XCTAssertEqual(origin["text"] as? String, "低温慢烤牛肋排的时间表")
    }

    func testSharedMediaIsStagedAsFileAndTheDraftStaysUntouched() throws {
        let draftStore = EditorDraftStore(directoryURL: directoryURL.appendingPathComponent("Draft", isDirectory: true))
        let draft = EditorDraft(text: "草稿保持原样", sourceDescription: "生成的草稿说明")
        try draftStore.save(draft)
        let queue = SendQueue(directoryURL: directoryURL.appendingPathComponent("Queue", isDirectory: true))
        let attachments = ShareAttachmentStore(directoryURL: directoryURL.appendingPathComponent("Shared", isDirectory: true))
        let recordId = UUID(uuidString: "00000000-0000-4000-8000-000000000002")!

        let image = Data("生成的照片".utf8)
        let file = Data("生成的文件".utf8)
        let request = ShareRequest(attachments: [
            ShareAttachmentData(data: image, fileName: "照片.png", mimeType: "image/png"),
            ShareAttachmentData(data: file, fileName: "季度计划.pdf", mimeType: "application/pdf"),
        ])
        let shared = try ShareSubmission.save(
            request: request,
            note: "",
            description: "",
            deviceId: "generated-iphone",
            deviceName: "Generated iPhone",
            recordId: recordId,
            capturedAt: "2026-11-06T02:01:00.000Z",
            queue: queue,
            attachmentStore: attachments
        )

        XCTAssertEqual(try queue.pending().count, 1)
        XCTAssertEqual(try queue.pending().first?.id, recordId.uuidString.lowercased())
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(queue.pending().first).payload) as? [String: Any])
        let metadata = try XCTUnwrap(object["metadata"] as? [String: Any])
        XCTAssertEqual((metadata["collector"] as? [String: Any])?["method"] as? String, "manual")
        XCTAssertNil(metadata["attachments"])
        let origin = try XCTUnwrap(metadata["noteOrigin"] as? [String: Any])
        XCTAssertEqual(origin["kind"] as? String, "share")
        XCTAssertEqual(origin["text"] as? String, "照片.png\n季度计划.pdf")

        let manifest = try XCTUnwrap(try attachments.manifest(recordId: recordId))
        XCTAssertEqual(manifest.map(\.kind), [.file, .file])
        XCTAssertEqual(manifest.map(\.fileName), ["照片.png", "季度计划.pdf"])
        let encodedManifest = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(manifest)) as? [[String: Any]])
        XCTAssertEqual(encodedManifest.map { $0["kind"] as? String }, ["file", "file"])
        XCTAssertEqual(try Data(contentsOf: attachments.fileURL(recordId: recordId, attachment: manifest[0])), image)
        XCTAssertEqual(try Data(contentsOf: attachments.fileURL(recordId: recordId, attachment: manifest[1])), file)

        XCTAssertEqual(shared.capture.source, .note)
        XCTAssertEqual(try draftStore.load(), draft)
    }

    func testConversationSaveKeepsQuotedOriginalSupplementAndDescription() throws {
        let queue = SendQueue(directoryURL: directoryURL.appendingPathComponent("Queue", isDirectory: true))
        let attachments = ShareAttachmentStore(directoryURL: directoryURL.appendingPathComponent("Shared", isDirectory: true))
        let recordId = UUID(uuidString: "00000000-0000-4000-8000-000000000004")!
        let quote = ShareConversationQuote(
            question: "暖气费是怎么约定的？",
            answer: "按实际用量分摊[ev_1]，月底前把账单照片发给房东[ev_1]。",
            displayAnswer: "按实际用量分摊，月底前把账单照片发给房东。",
            conversationId: "11111111-2222-3333-4444-555555555555",
            turnId: "turn-1"
        )

        let shared = try ShareSubmission.save(
            request: ShareRequest(conversation: quote),
            note: "周五前把账单照片发给房东。",
            description: "生成的资料说明",
            deviceId: "generated-iphone",
            deviceName: "Generated iPhone",
            recordId: recordId,
            capturedAt: "2026-11-06T02:03:00.000Z",
            queue: queue,
            attachmentStore: attachments
        )

        XCTAssertEqual(shared.capture.ocrText, "周五前把账单照片发给房东。")
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(queue.pending().first).payload) as? [String: Any])
        XCTAssertEqual(object["ocrText"] as? String, "周五前把账单照片发给房东。")
        let metadata = try XCTUnwrap(object["metadata"] as? [String: Any])
        XCTAssertEqual(metadata["ownerDescription"] as? String, "生成的资料说明")
        let origin = try XCTUnwrap(metadata["noteOrigin"] as? [String: Any])
        XCTAssertEqual(origin["kind"] as? String, "conversation")
        XCTAssertEqual(origin["text"] as? String, "暖气费是怎么约定的？\n\n按实际用量分摊[ev_1]，月底前把账单照片发给房东[ev_1]。")
        XCTAssertEqual(origin["conversationId"] as? String, quote.conversationId)
        XCTAssertEqual(origin["messageIds"] as? [String], ["turn-1"])
        XCTAssertNil(origin["url"])
        XCTAssertNil(metadata["attachments"])
    }

    func testConversationSaveWithoutSupplementKeepsQuotedOriginal() throws {
        let queue = SendQueue(directoryURL: directoryURL.appendingPathComponent("Queue", isDirectory: true))
        let attachments = ShareAttachmentStore(directoryURL: directoryURL.appendingPathComponent("Shared", isDirectory: true))
        let quote = ShareConversationQuote(
            question: "押金是多少？",
            answer: "合同第 4 页写的是两个月租金[ev_2]。",
            displayAnswer: "合同第 4 页写的是两个月租金。",
            conversationId: "11111111-2222-3333-4444-555555555555",
            turnId: "turn-2"
        )

        _ = try ShareSubmission.save(
            request: ShareRequest(conversation: quote),
            note: "",
            description: "  ",
            deviceId: "generated-iphone",
            deviceName: "Generated iPhone",
            capturedAt: "2026-11-06T02:04:00.000Z",
            queue: queue,
            attachmentStore: attachments
        )

        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(queue.pending().first).payload) as? [String: Any])
        XCTAssertEqual(object["ocrText"] as? String, "")
        let metadata = try XCTUnwrap(object["metadata"] as? [String: Any])
        XCTAssertNil(metadata["ownerDescription"])
        let origin = try XCTUnwrap(metadata["noteOrigin"] as? [String: Any])
        XCTAssertEqual(origin["kind"] as? String, "conversation")
        XCTAssertEqual(origin["text"] as? String, "押金是多少？\n\n合同第 4 页写的是两个月租金[ev_2]。")
        XCTAssertEqual(origin["messageIds"] as? [String], ["turn-2"])
    }

    func testConversationSaveRejectsIncompleteIdentity() throws {
        let queue = SendQueue(directoryURL: directoryURL.appendingPathComponent("Queue", isDirectory: true))
        let attachments = ShareAttachmentStore(directoryURL: directoryURL.appendingPathComponent("Shared", isDirectory: true))
        let quote = ShareConversationQuote(
            question: "问题", answer: "回答", displayAnswer: "回答",
            conversationId: "11111111-2222-3333-4444-555555555555", turnId: ""
        )
        XCTAssertThrowsError(try ShareSubmission.save(
            request: ShareRequest(conversation: quote), note: "", description: "",
            deviceId: "generated-iphone", deviceName: "Generated iPhone",
            capturedAt: "2026-11-06T02:03:00.000Z", queue: queue, attachmentStore: attachments
        )) {
            XCTAssertEqual($0 as? ShareRecordError, .invalidRequest)
        }
        XCTAssertEqual(try queue.pending().count, 0)
    }

    func testDuplicateSaveKeepsOneQueueItemAndOneJournal() throws {
        let queue = SendQueue(directoryURL: directoryURL.appendingPathComponent("Queue", isDirectory: true))
        let attachments = ShareAttachmentStore(directoryURL: directoryURL.appendingPathComponent("Shared", isDirectory: true))
        let recordId = UUID(uuidString: "00000000-0000-4000-8000-000000000003")!
        let request = ShareRequest(text: "分享的文字")

        _ = try ShareSubmission.save(
            request: request, note: "", description: "", deviceId: "generated-iphone",
            deviceName: "Generated iPhone", recordId: recordId,
            capturedAt: "2026-11-06T02:02:00.000Z", queue: queue, attachmentStore: attachments
        )
        XCTAssertThrowsError(try ShareSubmission.save(
            request: request, note: "", description: "", deviceId: "generated-iphone",
            deviceName: "Generated iPhone", recordId: recordId,
            capturedAt: "2026-11-06T02:04:00.000Z", queue: queue, attachmentStore: attachments
        )) {
            XCTAssertEqual($0 as? SendQueueError, .duplicateID)
        }
        XCTAssertEqual(try queue.pending().count, 1)
    }
}
