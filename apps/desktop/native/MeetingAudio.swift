import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

private final class MeetingSystemAudioSink: NSObject, SCStreamOutput {
    private let file: AVAudioFile
    private let format: AVAudioFormat
    private(set) var wroteAudio = false

    init(url: URL, format: AVAudioFormat) throws {
        self.format = format
        self.file = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: format.channelCount, AVEncoderBitRateKey: 128_000,
        ])
        super.init()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, sampleBuffer.numSamples > 0 else { return }
        do {
            try sampleBuffer.withAudioBufferList { list, _ in
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list.unsafePointer, deallocator: nil) else { return }
                buffer.frameLength = AVAudioFrameCount(sampleBuffer.numSamples)
                try file.write(from: buffer)
                wroteAudio = true
            }
        } catch {
            // A single malformed buffer must not stop the microphone track.
        }
    }
}

private final class MeetingMicrophoneSink {
    let engine = AVAudioEngine()
    private let file: AVAudioFile
    private let converter: AVAudioConverter?
    private let target: AVAudioFormat
    private(set) var wroteAudio = false
    private var started = false

    init(url: URL) throws {
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw NSError(domain: "Mote", code: 20) }
        let channels = min(2, format.channelCount)
        file = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: channels, AVEncoderBitRateKey: 96_000,
        ])
        target = file.processingFormat
        converter = format == target ? nil : AVAudioConverter(from: format, to: target)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            do {
                if let converter = self.converter {
                    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * self.target.sampleRate / format.sampleRate) + 32
                    guard let converted = AVAudioPCMBuffer(pcmFormat: self.target, frameCapacity: capacity) else { return }
                    var supplied = false
                    var conversionError: NSError?
                    converter.convert(to: converted, error: &conversionError) { _, status in
                        if supplied { status.pointee = .noDataNow; return nil }
                        supplied = true; status.pointee = .haveData; return buffer
                    }
                    if conversionError == nil, converted.frameLength > 0 { try self.file.write(from: converted); self.wroteAudio = true }
                } else {
                    try self.file.write(from: buffer); self.wroteAudio = true
                }
            } catch { }
        }
    }

    func start() throws {
        guard !started else { return }
        engine.prepare()
        try engine.start()
        started = true
    }

    func stop() {
        guard started else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        started = false
    }
}

private func meetingEmit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private func meetingInput() throws -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count > 0, data.count < 16384, let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw NSError(domain: "Mote", code: 21)
    }
    return value
}

private func meetingMerge(microphone: URL?, system: URL?, output: URL) throws -> Double {
    let composition = AVMutableComposition()
    var duration = CMTime.zero
    for url in [microphone, system].compactMap({ $0 }) {
        guard FileManager.default.fileExists(atPath: url.path) else { continue }
        let asset = AVURLAsset(url: url)
        guard asset.duration.seconds > 0, let track = asset.tracks(withMediaType: .audio).first else { continue }
        let destination = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
        try destination.insertTimeRange(CMTimeRange(start: .zero, duration: asset.duration), of: track, at: .zero)
        duration = CMTimeMaximum(duration, asset.duration)
    }
    guard composition.tracks(withMediaType: .audio).count > 0 else { throw NSError(domain: "Mote", code: 22) }
    guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetAppleM4A) else { throw NSError(domain: "Mote", code: 23) }
    try? FileManager.default.removeItem(at: output)
    exporter.outputURL = output
    exporter.outputFileType = .m4a
    let semaphore = DispatchSemaphore(value: 0)
    exporter.exportAsynchronously { semaphore.signal() }
    semaphore.wait()
    guard exporter.status == .completed, FileManager.default.fileExists(atPath: output.path) else { throw NSError(domain: "Mote", code: 24) }
    return max(0, duration.seconds * 1000)
}

private func meetingRecord(_ input: [String: Any]) throws {
    guard let directory = input["directory"] as? String, let output = input["outputFile"] as? String,
          let stopFile = input["stopFile"] as? String, let maxDurationMs = input["maxDurationMs"] as? Int,
          maxDurationMs > 0, maxDurationMs <= 24 * 60 * 60 * 1000 else { throw NSError(domain: "Mote", code: 25) }
    let root = URL(fileURLWithPath: directory, isDirectory: true)
    let outputURL = URL(fileURLWithPath: output)
    guard outputURL.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL else { throw NSError(domain: "Mote", code: 26) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let microphoneURL = root.appendingPathComponent("microphone.m4a")
    let systemURL = root.appendingPathComponent("system.m4a")
    var warnings: [String] = []

    guard CGPreflightScreenCaptureAccess() else { throw NSError(domain: "Mote", code: 27, userInfo: [NSLocalizedDescriptionKey: "系统音频权限未授予"]) }
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { throw NSError(domain: "Mote", code: 28, userInfo: [NSLocalizedDescriptionKey: "麦克风权限未授予"]) }

    var microphone: MeetingMicrophoneSink?
    do { microphone = try MeetingMicrophoneSink(url: microphoneURL) } catch { throw NSError(domain: "Mote", code: 29, userInfo: [NSLocalizedDescriptionKey: "麦克风不可用"]) }

    var stream: SCStream?
    var system: MeetingSystemAudioSink?
    let queue = DispatchQueue(label: "mote.meeting.audio")
    let contentSemaphore = DispatchSemaphore(value: 0)
    var content: SCShareableContent?
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { value, _ in content = value; contentSemaphore.signal() }
    contentSemaphore.wait()
    guard let display = content?.displays.first else { throw NSError(domain: "Mote", code: 30, userInfo: [NSLocalizedDescriptionKey: "系统音频不可用"]) }
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true
    configuration.excludesCurrentProcessAudio = true
    configuration.sampleRate = 48_000
    configuration.channelCount = 2
    configuration.width = 16
    configuration.height = 16
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let candidate = SCStream(filter: filter, configuration: configuration, delegate: nil)
    // The stream carries audio only; the tiny video surface exists because
    // ScreenCaptureKit requires a stream configuration, not to record screens.
    do {
        let audioFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
        let sink = try MeetingSystemAudioSink(url: systemURL, format: audioFormat)
        try candidate.addStreamOutput(sink, type: .audio, sampleHandlerQueue: queue)
        let startSemaphore = DispatchSemaphore(value: 0)
        var startError: Error?
        candidate.startCapture { error in startError = error; startSemaphore.signal() }
        startSemaphore.wait()
        if let startError { throw startError }
        system = sink
        stream = candidate
    } catch {
        stream = nil
        system = nil
        warnings.append("系统音频未开始，本次只包含麦克风。")
    }

    do { try microphone?.start() }
    catch {
        stream?.stopCapture { _ in }
        throw NSError(domain: "Mote", code: 31, userInfo: [NSLocalizedDescriptionKey: "麦克风未开始"])
    }

    try meetingEmit(["status": "recording", "microphone": microphone != nil, "systemAudio": system != nil, "warnings": warnings])
    let started = Date()
    while Date().timeIntervalSince(started) * 1000 < Double(maxDurationMs) {
        if FileManager.default.fileExists(atPath: stopFile) { break }
        if getppid() == 1 { break }
        Thread.sleep(forTimeInterval: 0.2)
    }
    let elapsedMs = Int(Date().timeIntervalSince(started) * 1000)
    microphone?.stop()
    if let stream {
        let stopSemaphore = DispatchSemaphore(value: 0)
        stream.stopCapture { _ in stopSemaphore.signal() }
        stopSemaphore.wait()
    }
    let systemWrote = system?.wroteAudio == true
    let microphoneWrote = microphone?.wroteAudio == true
    if system != nil && !systemWrote { warnings.append("系统音频没有可保存的声音。") }
    if !microphoneWrote { warnings.append("麦克风没有可保存的声音。") }
    guard microphoneWrote || systemWrote else { throw NSError(domain: "Mote", code: 32, userInfo: [NSLocalizedDescriptionKey: "没有可保存的音频"]) }
    let duration = try meetingMerge(microphone: microphoneWrote ? microphoneURL : nil, system: systemWrote ? systemURL : nil, output: outputURL)
    try? FileManager.default.removeItem(at: microphoneURL)
    try? FileManager.default.removeItem(at: systemURL)
    try? FileManager.default.removeItem(at: URL(fileURLWithPath: stopFile))
    try meetingEmit([
        "status": "recorded", "file": outputURL.path, "durationMs": Int(duration > 0 ? duration : Double(elapsedMs)),
        "microphone": microphoneWrote, "systemAudio": systemWrote, "warnings": warnings,
    ])
}

func meetingAudioCapture() throws {
    do {
        try meetingRecord(try meetingInput())
    } catch {
        let message = (error as NSError).userInfo[NSLocalizedDescriptionKey] as? String ?? "会议录音未完成"
        try? meetingEmit(["status": "failed", "error": message])
        exit(1)
    }
}
