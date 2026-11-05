import MoteCentral

@MainActor
final class AppSendPipeline {
    static let shared = AppSendPipeline()

    private var pipeline: SendPipeline?

    func register(_ pipeline: SendPipeline) {
        self.pipeline = pipeline
    }

    func reconcileAndSend() async {
        guard let pipeline else { return }
        try? await pipeline.reconcileAndSend()
    }
}
