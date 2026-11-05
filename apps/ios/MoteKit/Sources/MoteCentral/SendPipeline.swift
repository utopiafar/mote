import Foundation
import MoteStorage

public enum SendPipelineError: Error, Equatable {
    case invalidReconciliation
    case mismatchedReceipt
}

public protocol SendPipelineReconciler: Sendable {
    func reconcile(deviceId: String, ids: [String]) async throws -> CaptureReconciliation
}

public protocol SendPipelineTransport: SendPipelineReconciler {
    func upload(_ item: SendQueueItem) async throws -> CaptureReceipt
}

public protocol BackgroundSendPipelineTransport: SendPipelineReconciler {
    func inFlightItemIDs() async -> Set<String>
    func schedule(_ item: SendQueueItem) async throws
}

public actor SendPipeline {
    private enum Transport {
        case foreground(any SendPipelineTransport)
        case background(any BackgroundSendPipelineTransport)
    }

    private let queue: SendQueue
    private let transport: Transport
    private let reconciler: any SendPipelineReconciler
    private let deviceId: String
    private var sending = false

    public init(queue: SendQueue, transport: any SendPipelineTransport, deviceId: String) {
        self.queue = queue
        self.transport = .foreground(transport)
        self.reconciler = transport
        self.deviceId = deviceId
    }

    public init(queue: SendQueue, backgroundTransport: any BackgroundSendPipelineTransport, deviceId: String) {
        self.queue = queue
        self.transport = .background(backgroundTransport)
        self.reconciler = backgroundTransport
        self.deviceId = deviceId
    }

    public static func background(queue: SendQueue, serverUrl: String, token: String, deviceId: String,
                                  sessionIdentifier: String = BackgroundUploadSession.defaultIdentifier) throws -> SendPipeline {
        let client = try CentralClient(serverUrl: serverUrl, token: token)
        let session = try BackgroundUploadSession.shared(queue: queue, identifier: sessionIdentifier)
        let transport = BackgroundSendTransport(queue: queue, reconciler: client,
                                                request: try client.captureUploadRequest(), session: session)
        return SendPipeline(queue: queue, backgroundTransport: transport, deviceId: deviceId)
    }

    @discardableResult
    public func enqueue(_ capture: CaptureUpload, validatingAttachments: [Data] = []) throws -> SendQueueItem {
        try queue.enqueue(JSONEncoder().encode(capture), id: capture.id, validatingAttachments: validatingAttachments)
    }

    public func reconcileAndSend() async throws {
        guard !sending else { return }
        sending = true
        defer { sending = false }

        try queue.removeAcknowledgedBodies()
        try await reconcile()
        switch transport {
        case .foreground(let transport):
            while let item = try queue.pending().first {
                let receipt = try await transport.upload(item)
                guard receipt.id == item.id else { throw SendPipelineError.mismatchedReceipt }
                try queue.acknowledge(id: item.id)
            }
        case .background(let transport):
            let inFlight = await transport.inFlightItemIDs()
            for item in try queue.pending() where !inFlight.contains(item.id) {
                try await transport.schedule(item)
            }
        }
    }

    private func reconcile() async throws {
        let pending = try queue.pending()
        for start in stride(from: 0, to: pending.count, by: 100) {
            let batch = Array(pending[start..<min(start + 100, pending.count)])
            let ids = batch.map(\.id)
            let response = try await reconciler.reconcile(deviceId: deviceId, ids: ids)
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
