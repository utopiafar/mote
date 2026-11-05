import XCTest
import MoteCentral
import MoteStorage

final class SendPipelineTests: XCTestCase {
    private enum NetworkFailure: Error {
        case offline
    }

    fileprivate actor Transport: SendPipelineTransport {
        var present: Set<String> = []
        var duplicate: Set<String> = []
        var failures: [String: Int] = [:]
        var reconciliationBatches: [[String]] = []
        var uploads: [SendQueueItem] = []
        var receiptIDs: [String: String] = [:]

        func reconcile(deviceId: String, ids: [String]) async throws -> CaptureReconciliation {
            XCTAssertEqual(deviceId, "generated-iphone")
            reconciliationBatches.append(ids)
            return CaptureReconciliation(checkedAt: "2026-10-01T00:00:00Z", items: ids.map {
                CaptureReconciliation.Item(id: $0, state: present.contains($0) ? .present : .unavailable)
            })
        }

        func upload(_ item: SendQueueItem) async throws -> CaptureReceipt {
            uploads.append(item)
            if let remaining = failures[item.id], remaining > 0 {
                failures[item.id] = remaining - 1
                throw NetworkFailure.offline
            }
            return CaptureReceipt(id: receiptIDs[item.id] ?? item.id, duplicate: duplicate.contains(item.id))
        }
    }

    private var directoryURL: URL!

    override func setUpWithError() throws {
        directoryURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directoryURL)
    }

    private func capture(_ text: String) -> CaptureUpload {
        CaptureUpload(deviceId: "generated-iphone", deviceName: "Generated iPhone",
                      capturedAt: "2026-10-01T00:00:00Z", source: .note, ocrText: text)
    }

    func testNetworkFailureKeepsPayloadDurableAndNextAttemptSendsSameCapture() async throws {
        let capture = capture("generated offline note")
        let queue = SendQueue(directoryURL: directoryURL)
        let transport = Transport()
        await transport.setFailures([capture.id: 1])
        let pipeline = SendPipeline(queue: queue, transport: transport, deviceId: "generated-iphone")
        let item = try await pipeline.enqueue(capture)

        do {
            try await pipeline.reconcileAndSend()
            XCTFail("Offline upload unexpectedly succeeded")
        } catch {
            XCTAssertEqual(error as? NetworkFailure, .offline)
        }
        XCTAssertEqual(try SendQueue(directoryURL: directoryURL).pending(), [item])

        try await pipeline.reconcileAndSend()
        XCTAssertEqual(try queue.pending(), [])
        let uploads = await transport.uploads
        XCTAssertEqual(uploads.map(\.id), [capture.id, capture.id])
        XCTAssertEqual(uploads.map(\.payload), [item.payload, item.payload])
    }

    func testRestartReconcilesBeforeResumingAndAcknowledgesDuplicateReceipt() async throws {
        let first = capture("generated accepted before restart")
        let second = capture("generated resumed after restart")
        let queue = SendQueue(directoryURL: directoryURL)
        let originalPipeline = SendPipeline(queue: queue, transport: Transport(), deviceId: "generated-iphone")
        try await originalPipeline.enqueue(first)
        try await originalPipeline.enqueue(second)

        let transport = Transport()
        await transport.setPresent([first.id])
        await transport.setDuplicate([second.id])
        let restartedPipeline = SendPipeline(queue: SendQueue(directoryURL: directoryURL), transport: transport,
                                             deviceId: "generated-iphone")
        try await restartedPipeline.reconcileAndSend()

        XCTAssertEqual(try queue.pending(), [])
        let uploads = await transport.uploads
        XCTAssertEqual(uploads.map(\.id), [second.id])
        XCTAssertEqual(try JSONDecoder().decode(CaptureUpload.self, from: try XCTUnwrap(uploads.first).payload), second)
    }

    func testMismatchedReceiptDoesNotRemovePendingCapture() async throws {
        let capture = capture("generated ambiguous receipt")
        let queue = SendQueue(directoryURL: directoryURL)
        let transport = Transport()
        await transport.setReceiptIDs([capture.id: UUID().uuidString])
        let pipeline = SendPipeline(queue: queue, transport: transport, deviceId: "generated-iphone")
        let item = try await pipeline.enqueue(capture)

        do {
            try await pipeline.reconcileAndSend()
            XCTFail("Mismatched receipt unexpectedly acknowledged the capture")
        } catch {
            XCTAssertEqual(error as? SendPipelineError, .mismatchedReceipt)
        }
        XCTAssertEqual(try queue.pending(), [item])
    }

    func testReconciliationUsesCentralBatchLimit() async throws {
        let queue = SendQueue(directoryURL: directoryURL)
        let pipeline = SendPipeline(queue: queue, transport: Transport(), deviceId: "generated-iphone")
        let captures = (0..<101).map { capture("generated note \($0)") }
        for capture in captures {
            try await pipeline.enqueue(capture)
        }
        let transport = Transport()
        await transport.setPresent(Set(captures.map(\.id)))
        let reconcilingPipeline = SendPipeline(queue: queue, transport: transport, deviceId: "generated-iphone")

        try await reconcilingPipeline.reconcileAndSend()

        let batches = await transport.reconciliationBatches
        XCTAssertEqual(batches.map(\.count), [100, 1])
        XCTAssertEqual(try queue.pending(), [])
        let uploads = await transport.uploads
        XCTAssertTrue(uploads.isEmpty)
    }

    func testAttachmentLimitIsExactlyFiftyMiB() throws {
        let queue = SendQueue(directoryURL: directoryURL)
        let accepted = try queue.enqueue(Data(count: SendQueue.maximumAttachmentBytes))

        XCTAssertEqual(accepted.payload.count, 50 * 1024 * 1024)
        XCTAssertThrowsError(try queue.enqueue(Data(count: SendQueue.maximumAttachmentBytes + 1))) {
            XCTAssertEqual($0 as? SendQueueError, .attachmentTooLarge)
        }
        XCTAssertEqual(try queue.pending(), [accepted])
    }
}

private extension SendPipelineTests.Transport {
    func setFailures(_ value: [String: Int]) {
        failures = value
    }

    func setPresent(_ value: Set<String>) {
        present = value
    }

    func setDuplicate(_ value: Set<String>) {
        duplicate = value
    }

    func setReceiptIDs(_ value: [String: String]) {
        receiptIDs = value
    }
}
