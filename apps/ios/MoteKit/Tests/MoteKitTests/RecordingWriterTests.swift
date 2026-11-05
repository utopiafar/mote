import AVFoundation
import Foundation
import XCTest
@testable import MoteStorage

final class RecordingWriterTests: XCTestCase {
    func testUnfinishedRecordingIsAlreadyInDraftAndPlayable() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = EditorDraftStore(directoryURL: directory)
        var writer: RecordingWriter? = try makeWriter(store: store)
        let samples = generatedAudio(bytes: 32_000)
        try writer?.appendPCM16(samples)

        // Reopen both the draft and audio while the writer is still alive. A
        // crash cannot rely on a stop callback to publish the WAV header.
        let recovered = try EditorDraftStore(directoryURL: directory).load()
        let attachment = try XCTUnwrap(recovered.attachments.first)
        XCTAssertEqual(recovered.attachments.count, 1)
        XCTAssertEqual(attachment.kind, .audio)
        let url = store.fileURL(for: attachment)
        let audio = try AVAudioFile(forReading: url)
        XCTAssertEqual(audio.length, 16_000)
        XCTAssertEqual(try Data(contentsOf: url).suffix(samples.count), samples)
        writer = nil
        XCTAssertEqual(try AVAudioFile(forReading: url).length, 16_000)
    }

    func testFiftyMiBBoundaryKeepsBothSegmentsPlayableAndInDraft() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = EditorDraftStore(directoryURL: directory)
        let writer = try makeWriter(store: store)
        let block = generatedAudio(bytes: 1024 * 1024)
        for _ in 0..<50 { try writer.appendPCM16(block) }
        try writer.appendPCM16(block)

        let attachments = try store.load().attachments
        XCTAssertEqual(attachments.count, 2)
        let urls = attachments.map { store.fileURL(for: $0) }
        let sizes = try urls.map { try Data(contentsOf: $0, options: .mappedIfSafe).count }
        XCTAssertEqual(sizes[0], SendQueue.maximumAttachmentBytes)
        XCTAssertLessThanOrEqual(sizes[1], SendQueue.maximumAttachmentBytes)
        XCTAssertEqual(sizes.reduce(0, +) - 88, 51 * block.count)
        let first = try AVAudioFile(forReading: urls[0])
        let second = try AVAudioFile(forReading: urls[1])
        XCTAssertEqual(first.length + second.length, AVAudioFramePosition(51 * block.count / 2))
        let firstData = try Data(contentsOf: urls[0], options: .mappedIfSafe)
        let secondData = try Data(contentsOf: urls[1], options: .mappedIfSafe)
        XCTAssertEqual(firstData.suffix(32), block[(block.count - 44 - 32)..<(block.count - 44)])
        XCTAssertEqual(secondData.dropFirst(44).prefix(44), block[(block.count - 44)..<block.count])
    }

    private func makeWriter(store: EditorDraftStore) throws -> RecordingWriter {
        try RecordingWriter(sampleRate: 16_000) {
            let attachment = try store.recordingAttachment()
            return RecordingWriter.Segment(url: store.fileURL(for: attachment)) {
                var draft = try store.load()
                draft.attachments.append(attachment)
                try store.save(draft)
            }
        }
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }

    private func generatedAudio(bytes: Int) -> Data {
        Data((0..<bytes).map { UInt8(truncatingIfNeeded: $0 / 2) })
    }
}
