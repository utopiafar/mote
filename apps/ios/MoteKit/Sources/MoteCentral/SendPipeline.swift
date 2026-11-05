import Foundation
import MoteStorage

public enum SendPipelineError: Error, Equatable {
    case invalidReconciliation
    case mismatchedReceipt
}

public protocol SendPipelineTransport: Sendable {
    func reconcile(deviceId: String, ids: [String]) async throws -> CaptureReconciliation
    func upload(_ item: SendQueueItem) async throws -> CaptureReceipt
}

public actor SendPipeline {
    private let queue: SendQueue
    private let transport: any SendPipelineTransport
    private let deviceId: String
    private var sending = false

    public init(queue: SendQueue, transport: any SendPipelineTransport, deviceId: String) {
        self.queue = queue
        self.transport = transport
        self.deviceId = deviceId
    }

    public static func background(queue: SendQueue, serverUrl: String, token: String, deviceId: String,
                                  sessionIdentifier: String = "dev.mote.ios.send") throws -> SendPipeline {
        let configuration = URLSessionConfiguration.background(withIdentifier: sessionIdentifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.waitsForConnectivity = true
        let session = URLSession(configuration: configuration)
        let client = try CentralClient(serverUrl: serverUrl, token: token, session: session)
        return SendPipeline(queue: queue, transport: client, deviceId: deviceId)
    }

    @discardableResult
    public func enqueue(_ capture: CaptureUpload) throws -> SendQueueItem {
        try queue.enqueue(JSONEncoder().encode(capture), id: capture.id)
    }

    public func reconcileAndSend() async throws {
        guard !sending else { return }
        sending = true
        defer { sending = false }

        try await reconcile()
        while let item = try queue.pending().first {
            let receipt = try await transport.upload(item)
            guard receipt.id == item.id else { throw SendPipelineError.mismatchedReceipt }
            try queue.acknowledge(id: item.id)
        }
    }

    private func reconcile() async throws {
        let pending = try queue.pending()
        for start in stride(from: 0, to: pending.count, by: 100) {
            let batch = Array(pending[start..<min(start + 100, pending.count)])
            let ids = batch.map(\.id)
            let response = try await transport.reconcile(deviceId: deviceId, ids: ids)
            guard response.items.count == ids.count,
                  Set(response.items.map(\.id)) == Set(ids),
                  response.items.allSatisfy({ ids.contains($0.id) })
            else { throw SendPipelineError.invalidReconciliation }
            for item in response.items where item.state == .present {
                try queue.acknowledge(id: item.id)
            }
        }
    }
}

extension CentralClient: SendPipelineTransport {
    public func upload(_ item: SendQueueItem) async throws -> CaptureReceipt {
        try await upload(payload: item.payload)
    }
}
