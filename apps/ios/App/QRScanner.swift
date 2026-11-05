import SwiftUI
@preconcurrency import AVFoundation
#if DEBUG && targetEnvironment(simulator)
import CoreImage
#endif

/// Live camera input and the simulator's injected image both deliver the
/// decoded QR payload to the same invitation validation path.
struct QRScanner: UIViewRepresentable {
    let onCode: @MainActor @Sendable (String) -> Void

    func makeUIView(context: Context) -> Preview {
        let view = Preview()
        #if DEBUG && targetEnvironment(simulator)
        if let encoded = ProcessInfo.processInfo.environment["MOTE_TEST_QR_IMAGE"],
           let data = Data(base64Encoded: encoded), let image = CIImage(data: data) {
            let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(),
                                      options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
            if let text = (detector?.features(in: image).first as? CIQRCodeFeature)?.messageString {
                DispatchQueue.main.async { onCode(text) }
            }
            return view
        }
        #endif
        let engine = CameraEngine(onCode: onCode)
        view.engine = engine
        view.previewLayer.session = engine.session
        view.startTask = Task {
            let status = AVCaptureDevice.authorizationStatus(for: .video)
            let allowed: Bool
            if status == .notDetermined {
                allowed = await AVCaptureDevice.requestAccess(for: .video)
            } else {
                allowed = status == .authorized
            }
            if allowed && !Task.isCancelled { engine.start() }
        }
        return view
    }

    func updateUIView(_ uiView: Preview, context: Context) {}

    static func dismantleUIView(_ uiView: Preview, coordinator: ()) {
        uiView.startTask?.cancel()
        uiView.engine?.stop()
    }

    final class Preview: UIView {
        var engine: CameraEngine?
        var startTask: Task<Void, Never>?
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
        override init(frame: CGRect) {
            super.init(frame: frame)
            previewLayer.backgroundColor = UIColor(red: 20 / 255, green: 19 / 255, blue: 18 / 255, alpha: 1).cgColor
            previewLayer.videoGravity = .resizeAspectFill
        }
        required init?(coder: NSCoder) { nil }
    }
}

final class CameraEngine: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "dev.mote.ios.camera")
    private let onCode: @MainActor @Sendable (String) -> Void
    private var delivered = false

    init(onCode: @escaping @MainActor @Sendable (String) -> Void) {
        self.onCode = onCode
    }

    func start() {
        queue.async { [self] in
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return }
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.beginConfiguration()
            session.addInput(input)
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: queue)
            output.metadataObjectTypes = [.qr]
            session.commitConfiguration()
            session.startRunning()
        }
    }

    func stop() {
        queue.async { [self] in if session.isRunning { session.stopRunning() } }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !delivered, let text = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        delivered = true
        Task { @MainActor in onCode(text) }
    }
}
