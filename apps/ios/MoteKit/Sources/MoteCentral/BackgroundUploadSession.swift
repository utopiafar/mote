import Foundation
import OSLog
import MoteStorage

protocol BackgroundUploadSessionManaging: Sendable {
    func inFlightItemIDs() async -> Set<String>
    func schedule(request: URLRequest, body: URL, itemID: String) async throws
}

protocol BackgroundSystemTask: AnyObject, Sendable {
    var taskIdentifier: Int { get }
    var taskDescription: String? { get set }
    func resume()
}

extension URLSessionTask: BackgroundSystemTask {}

protocol BackgroundSystemSession: Sendable {
    func allTasks() async -> [any BackgroundSystemTask]
    func uploadTask(request: URLRequest, body: URL) -> any BackgroundSystemTask
}

/// Serializes task creation for a capture even when separate pipeline instances race.
final class BackgroundTaskScheduler: @unchecked Sendable {
    private let queue: SendQueue
    private let session: any BackgroundSystemSession
    private let lock = NSLock()
    private var scheduling: Set<String> = []

    init(queue: SendQueue, session: any BackgroundSystemSession) {
        self.queue = queue
        self.session = session
    }

    func inFlightItemIDs() async -> Set<String> {
        Set(await session.allTasks().compactMap(\.taskDescription))
    }

    func schedule(request: URLRequest, body: URL, itemID: String) async throws {
        guard lock.withLock({ scheduling.insert(itemID).inserted }) else { return }
        defer { lock.withLock { _ = scheduling.remove(itemID) } }
        guard !(await inFlightItemIDs()).contains(itemID),
              try queue.pending().contains(where: { $0.id == itemID }) else { return }
        let task = session.uploadTask(request: request, body: body)
        task.taskDescription = itemID
        task.resume()
    }
}

struct BackgroundSendTransport: BackgroundSendPipelineTransport {
    let queue: SendQueue
    let reconciler: any SendPipelineReconciler
    let request: URLRequest
    let session: any BackgroundUploadSessionManaging

    func reconcile(deviceId: String, ids: [String]) async throws -> CaptureReconciliation {
        try await reconciler.reconcile(deviceId: deviceId, ids: ids)
    }

    func inFlightItemIDs() async -> Set<String> { await session.inFlightItemIDs() }

    func schedule(_ item: SendQueueItem) async throws {
        guard let body = try queue.bodyFile(for: item) else { return }
        try await session.schedule(request: request, body: body, itemID: item.id)
    }
}

/// Handles task callbacks without needing credentials or a live SendPipeline after relaunch.
final class BackgroundUploadEvents: @unchecked Sendable {
    private let queue: SendQueue
    private let lock = NSLock()
    private var responseData: [Int: Data] = [:]
    private let logger = Logger(subsystem: "dev.mote.ios", category: "background-upload")

    init(queue: SendQueue) { self.queue = queue }

    func received(_ data: Data, taskID: Int) {
        lock.withLock { responseData[taskID, default: Data()].append(data) }
    }

    func completed(taskID: Int, itemID: String?, response: URLResponse?, error: Error?) {
        let data = lock.withLock { responseData.removeValue(forKey: taskID) ?? Data() }
        do {
            if let error { throw error }
            guard let itemID, !itemID.isEmpty, let response else { throw CentralError.invalidResponse }
            let receipt: CaptureReceipt = try CentralClient.decode(data: data, response: response)
            guard receipt.id == itemID else { throw SendPipelineError.mismatchedReceipt }
            try queue.acknowledge(id: itemID)
        } catch {
            // A failed or ambiguous receipt must leave the capture and its body in place.
            logger.error("Background upload or cleanup failed: \(String(describing: error), privacy: .private)")
        }
    }
}

public enum BackgroundUploadSessionError: Error {
    case queueMismatch
}

/// Owns the system session and survives app reconstruction through its stable identifier.
public final class BackgroundUploadSession: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    public static let defaultIdentifier = "dev.mote.ios.send"

    private final class Registry: @unchecked Sendable {
        let lock = NSLock()
        var sessions: [String: BackgroundUploadSession] = [:]
    }
    private final class Completion: @unchecked Sendable {
        let handler: () -> Void
        init(_ handler: @escaping () -> Void) { self.handler = handler }
    }
    private static let registry = Registry()

    private let queue: SendQueue
    private let identifier: String
    private let events: BackgroundUploadEvents
    private let lock = NSLock()
    private var storedSession: URLSession?
    private var completions: [Completion] = []
    private var scheduler: BackgroundTaskScheduler!

    private init(queue: SendQueue, identifier: String) {
        self.queue = queue
        self.identifier = identifier
        self.events = BackgroundUploadEvents(queue: queue)
        super.init()
        self.scheduler = BackgroundTaskScheduler(queue: queue, session: self)
    }

    public static func shared(queue: SendQueue, identifier: String = defaultIdentifier) throws -> BackgroundUploadSession {
        try registry.lock.withLock {
            if let session = registry.sessions[identifier] {
                guard session.queue.directoryURL == queue.directoryURL else { throw BackgroundUploadSessionError.queueMismatch }
                return session
            }
            let session = BackgroundUploadSession(queue: queue, identifier: identifier)
            registry.sessions[identifier] = session
            return session
        }
    }

    /// Called by UIApplicationDelegate before recreating the session after a system relaunch.
    public func handleEvents(completionHandler: @escaping () -> Void) {
        lock.withLock { completions.append(Completion(completionHandler)) }
        _ = session()
    }

    private func session() -> URLSession {
        lock.withLock {
            if let storedSession { return storedSession }
            let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
            configuration.sessionSendsLaunchEvents = true
            configuration.waitsForConnectivity = true
            let delegateQueue = OperationQueue()
            delegateQueue.maxConcurrentOperationCount = 1
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
            storedSession = session
            return session
        }
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        events.received(data, taskID: dataTask.taskIdentifier)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        events.completed(taskID: task.taskIdentifier, itemID: task.taskDescription, response: task.response, error: error)
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let handlers = lock.withLock {
            let handlers = completions
            completions.removeAll()
            return handlers
        }
        DispatchQueue.main.async { for completion in handlers { completion.handler() } }
    }
}

extension BackgroundUploadSession: BackgroundUploadSessionManaging {
    func inFlightItemIDs() async -> Set<String> { await scheduler.inFlightItemIDs() }

    func schedule(request: URLRequest, body: URL, itemID: String) async throws {
        try await scheduler.schedule(request: request, body: body, itemID: itemID)
    }
}

extension BackgroundUploadSession: BackgroundSystemSession {
    func allTasks() async -> [any BackgroundSystemTask] {
        await withCheckedContinuation { continuation in
            session().getAllTasks { tasks in continuation.resume(returning: tasks) }
        }
    }

    func uploadTask(request: URLRequest, body: URL) -> any BackgroundSystemTask {
        session().uploadTask(with: request, fromFile: body)
    }
}
