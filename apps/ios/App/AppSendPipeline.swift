import MoteCentral
import MoteCore
import MoteStorage
import OSLog

@MainActor
final class AppSendPipeline {
    static let shared = AppSendPipeline()

    private var pipeline: SendPipeline?
    private let logger = Logger(subsystem: "dev.mote.ios", category: "send-pipeline")

    func register(_ pipeline: SendPipeline) {
        self.pipeline = pipeline
        Task { await reconcileAndSend() }
    }

    func reconcileAndSend() async {
        guard !MoteSendPause.isPaused(), let pipeline else { return }
        try? MoteStorage.runtimeLog().record(.sendStarted)
        do {
            try await pipeline.reconcileAndSend()
            try? MoteStorage.runtimeLog().record(.sendCompleted)
        } catch {
            try? MoteStorage.runtimeLog().record(.sendFailed)
            logger.error("Reconciliation or upload scheduling failed: \(String(describing: error), privacy: .private)")
        }
    }

    func handleBackgroundEvents(identifier: String, completionHandler: @escaping () -> Void) {
        do {
            let queue = try MoteStorage.sendQueue()
            let session = try BackgroundUploadSession.shared(queue: queue, identifier: identifier)
            session.handleEvents(completionHandler: completionHandler)
        } catch {
            try? MoteStorage.runtimeLog().record(.backgroundRestoreFailed)
            logger.error("Could not restore the background upload session: \(String(describing: error), privacy: .private)")
            completionHandler()
        }
    }
}
