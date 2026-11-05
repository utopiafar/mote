import XCTest
@testable import MoteCentral
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

    fileprivate actor BackgroundSession: BackgroundUploadSessionManaging {
        struct Task: Sendable {
            let taskID: Int
            let itemID: String
            let body: URL
        }
        private(set) var tasks: [Task] = []
        private(set) var created: [Task] = []

        func inFlightItemIDs() async -> Set<String> { Set(tasks.map(\.itemID)) }

        func schedule(request: URLRequest, body: URL, itemID: String) async throws {
            XCTAssertEqual(request.httpMethod, "POST")
            let task = Task(taskID: created.count + 1, itemID: itemID, body: body)
            tasks.append(task)
            created.append(task)
        }

        func finish(_ task: Task) { tasks.removeAll { $0.taskID == task.taskID } }
    }

    private final class SystemTask: BackgroundSystemTask, @unchecked Sendable {
        let taskIdentifier: Int
        let body: URL
        private let lock = NSLock()
        private var descriptionValue: String?
        private var resumedValue = false
        var taskDescription: String? {
            get { lock.withLock { descriptionValue } }
            set { lock.withLock { descriptionValue = newValue } }
        }
        var resumed: Bool { lock.withLock { resumedValue } }

        init(taskIdentifier: Int, body: URL) {
            self.taskIdentifier = taskIdentifier
            self.body = body
        }
        func resume() { lock.withLock { resumedValue = true } }
    }

    private final class SystemSession: BackgroundSystemSession, @unchecked Sendable {
        private let lock = NSLock()
        private var storedTasks: [SystemTask] = []
        var tasks: [SystemTask] { lock.withLock { storedTasks } }

        func allTasks() async -> [any BackgroundSystemTask] { tasks }
        func uploadTask(request: URLRequest, body: URL) -> any BackgroundSystemTask {
            lock.withLock {
                let task = SystemTask(taskIdentifier: storedTasks.count + 1, body: body)
                storedTasks.append(task)
                return task
            }
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

    private func backgroundPipeline(queue: SendQueue, reconciler: Transport, session: BackgroundSession) -> SendPipeline {
        var request = URLRequest(url: URL(string: "https://generated.example/api/captures")!)
        request.httpMethod = "POST"
        let transport = BackgroundSendTransport(queue: queue, reconciler: reconciler, request: request, session: session)
        return SendPipeline(queue: queue, backgroundTransport: transport, deviceId: "generated-iphone")
    }

    private var successfulResponse: HTTPURLResponse {
        HTTPURLResponse(url: URL(string: "https://generated.example/api/captures")!, statusCode: 200,
                        httpVersion: nil, headerFields: nil)!
    }

    private func finish(_ task: BackgroundSession.Task, receipt: CaptureReceipt, events: BackgroundUploadEvents) throws {
        events.received(try JSONEncoder().encode(receipt), taskID: task.taskID)
        events.completed(taskID: task.taskID, itemID: task.itemID, response: successfulResponse, error: nil)
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
        let maximum = Data(count: SendQueue.maximumAttachmentBytes)
        let accepted = try queue.enqueue(maximum, validatingAttachments: [maximum])

        XCTAssertEqual(accepted.payload.count, 50 * 1024 * 1024)
        let oversized = Data(count: SendQueue.maximumAttachmentBytes + 1)
        XCTAssertThrowsError(try queue.enqueue(oversized, validatingAttachments: [oversized])) {
            XCTAssertEqual($0 as? SendQueueError, .attachmentTooLarge)
        }
        XCTAssertEqual(try queue.pending(), [accepted])
    }

    func testPayloadSizeIsNotAnAttachmentLimitAndEachAttachmentIsCheckedSeparately() throws {
        let queue = SendQueue(directoryURL: directoryURL)
        let largePayload = Data(count: SendQueue.maximumAttachmentBytes + 1)
        let attachment = Data(count: 26 * 1024 * 1024)
        let accepted = try queue.enqueue(largePayload, validatingAttachments: [attachment, attachment])
        XCTAssertEqual(try queue.pending(), [accepted])

        let oversized = Data(count: SendQueue.maximumAttachmentBytes + 1)
        XCTAssertThrowsError(try queue.enqueue(Data(), validatingAttachments: [attachment, oversized])) {
            XCTAssertEqual($0 as? SendQueueError, .attachmentTooLarge)
        }
        XCTAssertEqual(try queue.pending(), [accepted])
    }

    func testInterleavedResponsesAreMatchedToTheirTaskAndQueueItem() async throws {
        let queue = SendQueue(directoryURL: directoryURL)
        let session = BackgroundSession()
        let pipeline = backgroundPipeline(queue: queue, reconciler: Transport(), session: session)
        let first = try await pipeline.enqueue(capture("generated first"))
        let second = try await pipeline.enqueue(capture("generated second"))
        try await pipeline.reconcileAndSend()
        let tasks = await session.tasks
        XCTAssertEqual(tasks.map(\.itemID), [first.id, second.id])
        XCTAssertNotEqual(tasks[0].taskID, tasks[1].taskID)
        let events = BackgroundUploadEvents(queue: queue)
        let firstData = try JSONEncoder().encode(CaptureReceipt(id: first.id, duplicate: false))
        let secondData = try JSONEncoder().encode(CaptureReceipt(id: second.id, duplicate: true))
        let split = firstData.count / 2
        events.received(firstData.prefix(split), taskID: tasks[0].taskID)
        events.received(secondData, taskID: tasks[1].taskID)
        events.received(firstData.suffix(from: split), taskID: tasks[0].taskID)
        events.completed(taskID: tasks[1].taskID, itemID: tasks[1].itemID, response: successfulResponse, error: nil)
        XCTAssertEqual(try queue.pending(), [first])
        XCTAssertTrue(FileManager.default.fileExists(atPath: tasks[0].body.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: tasks[1].body.path))
        events.completed(taskID: tasks[0].taskID, itemID: tasks[0].itemID, response: successfulResponse, error: nil)
        XCTAssertTrue(try queue.pending().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: tasks[0].body.path))
    }

    func testSystemTaskDescriptionsBindReceiptsToItemsAndPreventDuplicateScheduling() async throws {
        let queue = SendQueue(directoryURL: directoryURL)
        let first = try queue.enqueue(Data("generated first".utf8), id: "generated-first")
        let second = try queue.enqueue(Data("generated second".utf8), id: "generated-second")
        let session = SystemSession()
        let scheduler = BackgroundTaskScheduler(queue: queue, session: session)
        let request = URLRequest(url: URL(string: "https://generated.example/api/captures")!)
        let firstBody = try XCTUnwrap(queue.bodyFile(for: first))
        let secondBody = try XCTUnwrap(queue.bodyFile(for: second))

        async let original: Void = scheduler.schedule(request: request, body: firstBody, itemID: first.id)
        async let duplicate: Void = scheduler.schedule(request: request, body: firstBody, itemID: first.id)
        _ = try await (original, duplicate)
        try await scheduler.schedule(request: request, body: secondBody, itemID: second.id)
        let tasks = session.tasks
        XCTAssertEqual(tasks.map(\.taskDescription), [first.id, second.id])
        XCTAssertEqual(tasks.map(\.body), [firstBody, secondBody])
        XCTAssertTrue(tasks.allSatisfy(\.resumed))
        XCTAssertEqual(Set(tasks.map(\.taskIdentifier)).count, 2)

        let events = BackgroundUploadEvents(queue: queue)
        events.received(try JSONEncoder().encode(CaptureReceipt(id: second.id, duplicate: false)),
                        taskID: tasks[1].taskIdentifier)
        events.completed(taskID: tasks[1].taskIdentifier, itemID: tasks[1].taskDescription,
                         response: successfulResponse, error: nil)
        XCTAssertEqual(try queue.pending(), [first])
        XCTAssertTrue(FileManager.default.fileExists(atPath: firstBody.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: secondBody.path))
    }

    func testBackgroundMismatchedReceiptKeepsItemAndDurableBody() async throws {
        let queue = SendQueue(directoryURL: directoryURL)
        let session = BackgroundSession()
        let pipeline = backgroundPipeline(queue: queue, reconciler: Transport(), session: session)
        let item = try await pipeline.enqueue(capture("generated mismatched background receipt"))
        try await pipeline.reconcileAndSend()
        let tasks = await session.tasks
        let task = try XCTUnwrap(tasks.first)
        let events = BackgroundUploadEvents(queue: queue)
        try finish(task, receipt: CaptureReceipt(id: UUID().uuidString, duplicate: false), events: events)

        XCTAssertEqual(try queue.pending(), [item])
        XCTAssertEqual(try Data(contentsOf: task.body), item.payload)
    }

    func testBodySurvivesFailureAndNewPipelineUntilAcknowledged() async throws {
        let queue = SendQueue(directoryURL: directoryURL)
        let session = BackgroundSession()
        let pipeline = backgroundPipeline(queue: queue, reconciler: Transport(), session: session)
        let item = try await pipeline.enqueue(capture("generated upload interrupted by termination"))
        try await pipeline.reconcileAndSend()
        let initialTasks = await session.tasks
        let firstTask = try XCTUnwrap(initialTasks.first)
        let events = BackgroundUploadEvents(queue: queue)
        events.completed(taskID: firstTask.taskID, itemID: firstTask.itemID, response: nil, error: NetworkFailure.offline)
        await session.finish(firstTask)

        let reopened = SendQueue(directoryURL: directoryURL)
        XCTAssertEqual(try reopened.pending(), [item])
        XCTAssertEqual(try Data(contentsOf: firstTask.body), item.payload)
        let restarted = backgroundPipeline(queue: reopened, reconciler: Transport(), session: session)
        try await restarted.reconcileAndSend()
        let retryTasks = await session.tasks
        let retry = try XCTUnwrap(retryTasks.first)
        XCTAssertEqual(retry.body, firstTask.body)
        XCTAssertEqual(try Data(contentsOf: retry.body), item.payload)
        try finish(retry, receipt: CaptureReceipt(id: item.id, duplicate: false), events: BackgroundUploadEvents(queue: reopened))
        XCTAssertEqual(try reopened.pending(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: retry.body.path))
    }

    func testRelaunchReconcilesAndDoesNotRescheduleInFlightTasks() async throws {
        let queue = SendQueue(directoryURL: directoryURL)
        let session = BackgroundSession()
        let firstPipeline = backgroundPipeline(queue: queue, reconciler: Transport(), session: session)
        let inFlight = try await firstPipeline.enqueue(capture("generated in flight"))
        try await firstPipeline.reconcileAndSend()

        let reconciler = Transport()
        let restarted = backgroundPipeline(queue: SendQueue(directoryURL: directoryURL), reconciler: reconciler, session: session)
        let newItem = try await restarted.enqueue(capture("generated awaiting scheduling"))
        try await restarted.reconcileAndSend()
        let created = await session.created
        XCTAssertEqual(created.map(\.itemID), [inFlight.id, newItem.id])
        let batches = await reconciler.reconciliationBatches
        XCTAssertEqual(batches, [[inFlight.id, newItem.id]])
        XCTAssertEqual(try queue.pending(), [inFlight, newItem])
    }

    func testReconciliationPresentDeletesBodyWithoutSchedulingAnotherUpload() async throws {
        let queue = SendQueue(directoryURL: directoryURL)
        let session = BackgroundSession()
        let pipeline = backgroundPipeline(queue: queue, reconciler: Transport(), session: session)
        let item = try await pipeline.enqueue(capture("generated accepted before response was lost"))
        try await pipeline.reconcileAndSend()
        let tasks = await session.tasks
        let task = try XCTUnwrap(tasks.first)
        await session.finish(task)
        let reconciler = Transport()
        await reconciler.setPresent([item.id])
        let restarted = backgroundPipeline(queue: SendQueue(directoryURL: directoryURL), reconciler: reconciler, session: session)
        try await restarted.reconcileAndSend()

        XCTAssertEqual(try queue.pending(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: task.body.path))
        let created = await session.created
        XCTAssertEqual(created.count, 1)
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
