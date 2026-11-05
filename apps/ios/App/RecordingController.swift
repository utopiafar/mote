import AVFoundation
import Combine
import CallKit
import Foundation
import MoteCore
import MoteStorage
import UIKit

/// Lives with the home screen rather than the editor, so navigation does not
/// end a recording. All draft mutations and writer calls are serialized here.
@MainActor
final class RecordingController: ObservableObject {
    @Published private(set) var state = RecordingState()
    @Published private(set) var elapsed: TimeInterval = 0
    @Published var errorMessage: String?
    @Published private(set) var interruptionCause: String?

    let model: EditorModel?
    private let syntheticInput: Bool
    private let requestSyntheticPermission: Bool
    private let visualFixture: Bool
    private var engine: AVAudioEngine?
    private var writer: RecordingWriter?
    private var generation: UUID?
    private var observer: NSObjectProtocol?
    private var fixtureTask: Task<Void, Never>?
    private var currentSampleRate: Double = 0

    init(store: EditorDraftStore?, arguments: [String]) {
        model = store.map(EditorModel.init(store:))
        syntheticInput = arguments.contains("-MoteRecordingTestInput")
        requestSyntheticPermission = arguments.contains("-MoteRecordingTestPermission")
        visualFixture = arguments.contains("-MoteRecordingPreview")
        observer = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt else { return }
            Task { @MainActor [weak self] in
                if raw == AVAudioSession.InterruptionType.began.rawValue {
                    self?.pause(interrupted: true)
                } else if raw == AVAudioSession.InterruptionType.ended.rawValue {
                    self?.state.interruptionEnded()
                }
            }
        }
    }

    var isActive: Bool { state.phase != .idle }
    var isPaused: Bool { state.phase == .paused }

    func start() async {
        guard !isActive, let model, model.isEditorVisible,
              UIApplication.shared.applicationState == .active else { return }
        if !syntheticInput || requestSyntheticPermission {
            let granted = await AVAudioApplication.requestRecordPermission()
            guard granted else {
                errorMessage = "麦克风权限未开启"
                return
            }
        }
        // The permission sheet can dismiss just before the app becomes active.
        // Wait for that transition, but never begin after leaving the editor or
        // after the app moves to the background.
        while UIApplication.shared.applicationState == .inactive && model.isEditorVisible {
            do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
        }
        guard model.isEditorVisible, UIApplication.shared.applicationState == .active, !isActive else { return }
        elapsed = 0
        do {
            try startInput()
            state.start()
            errorMessage = nil
        } catch {
            tearDownInput(closeWriter: true)
            errorMessage = "录音未能开始"
        }
    }

    func pause(interrupted: Bool = false) {
        guard state.phase == .recording else { return }
        interruptionCause = interrupted && CXCallObserver().calls.contains(where: { !$0.hasEnded }) ? "来电" : nil
        state.pause(interrupted: interrupted)
        tearDownInput(closeWriter: false)
    }

    func resume() {
        guard isPaused else { return }
        do {
            try startInput()
            state.resume()
            errorMessage = nil
        } catch {
            tearDownInput(closeWriter: false)
            errorMessage = "录音未能继续"
        }
    }

    func stop() {
        guard isActive else { return }
        state.stop()
        tearDownInput(closeWriter: true)
    }

    func preparePreview(interrupted: Bool) async {
        guard syntheticInput else { return }
        await start()
        elapsed = 134
        if interrupted {
            pause(interrupted: true)
            interruptionCause = "来电"
        }
    }

    private func startInput() throws {
        guard let model else { return }
        let inputEngine: AVAudioEngine?
        let sampleRate: Double
        if syntheticInput {
            inputEngine = nil
            sampleRate = 16_000
        } else {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
            let engine = AVAudioEngine()
            let format = engine.inputNode.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { throw RecordingWriter.WriterError.invalidFormat }
            inputEngine = engine
            sampleRate = format.sampleRate
        }
        if writer == nil || currentSampleRate != sampleRate {
            try writer?.close()
            writer = try RecordingWriter(sampleRate: UInt32(sampleRate)) { [weak model] in
                guard let model else { throw RecordingWriter.WriterError.cannotCreateFile }
                let attachment = try model.store.recordingAttachment()
                return RecordingWriter.Segment(url: model.store.fileURL(for: attachment)) {
                    try model.addRecording(attachment)
                }
            }
        }
        currentSampleRate = sampleRate
        let id = UUID()
        generation = id
        if let inputEngine {
            let input = inputEngine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
                let data = Self.pcm16(buffer)
                Task { @MainActor [weak self] in self?.consume(data, generation: id) }
            }
            engine = inputEngine
            try inputEngine.start()
        } else {
            fixtureTask = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(250))
                    guard !Task.isCancelled else { return }
                    self?.consume(Data(count: 8_000), generation: id)
                }
            }
        }
    }

    private func consume(_ data: Data, generation id: UUID) {
        guard generation == id, state.phase == .recording, !data.isEmpty else { return }
        do {
            try writer?.appendPCM16(data)
            if !visualFixture { elapsed += Double(data.count / 2) / currentSampleRate }
        } catch {
            pause()
            errorMessage = "录音未能保存"
        }
    }

    private func tearDownInput(closeWriter: Bool) {
        generation = nil
        fixtureTask?.cancel()
        fixtureTask = nil
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        if closeWriter {
            do { try writer?.close() } catch { errorMessage = "录音未能保存" }
            writer = nil
        }
        if !syntheticInput {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    private nonisolated static func pcm16(_ buffer: AVAudioPCMBuffer) -> Data {
        guard let channels = buffer.floatChannelData else { return Data() }
        let channelCount = Int(buffer.format.channelCount)
        var output = Data(capacity: Int(buffer.frameLength) * 2)
        for index in 0..<Int(buffer.frameLength) {
            var value: Float = 0
            for channel in 0..<channelCount { value += channels[channel][index] }
            value = min(1, max(-1, value / Float(channelCount)))
            var sample = Int16(value * Float(Int16.max)).littleEndian
            withUnsafeBytes(of: &sample) { output.append(contentsOf: $0) }
        }
        return output
    }
}
