import Foundation

/// Writes mono, 16-bit PCM as independently playable WAV attachments. Every
/// append updates the container header, so a process exit needs no finalizer.
public final class RecordingWriter {
    public struct Segment {
        public let url: URL
        public let register: () throws -> Void

        public init(url: URL, register: @escaping () throws -> Void) {
            self.url = url
            self.register = register
        }
    }

    public enum WriterError: Error {
        case invalidFormat
        case cannotCreateFile
    }

    private static let headerBytes = 44
    private let sampleRate: UInt32
    private let maximumSegmentBytes: Int
    private let makeSegment: () throws -> Segment
    private var file: FileHandle?
    private var dataBytes = 0

    public init(
        sampleRate: UInt32,
        maximumSegmentBytes: Int = SendQueue.maximumAttachmentBytes,
        makeSegment: @escaping () throws -> Segment
    ) throws {
        guard sampleRate > 0, maximumSegmentBytes >= Self.headerBytes + 2,
              maximumSegmentBytes <= Int(UInt32.max) else { throw WriterError.invalidFormat }
        self.sampleRate = sampleRate
        self.maximumSegmentBytes = maximumSegmentBytes
        self.makeSegment = makeSegment
    }

    public func appendPCM16(_ bytes: Data) throws {
        guard bytes.count.isMultiple(of: 2) else { throw WriterError.invalidFormat }
        var offset = 0
        while offset < bytes.count {
            if file == nil { try startSegment() }
            let capacity = (maximumSegmentBytes - Self.headerBytes - dataBytes) & ~1
            if capacity == 0 {
                try close()
                continue
            }
            let count = min(capacity, bytes.count - offset)
            guard let file else { throw WriterError.cannotCreateFile }
            try file.seek(toOffset: UInt64(Self.headerBytes + dataBytes))
            try file.write(contentsOf: bytes[offset..<(offset + count)])
            dataBytes += count
            try file.seek(toOffset: 0)
            try file.write(contentsOf: header(dataBytes: dataBytes))
            offset += count
        }
    }

    public func close() throws {
        try file?.close()
        file = nil
        dataBytes = 0
    }

    private func startSegment() throws {
        let segment = try makeSegment()
        guard FileManager.default.createFile(atPath: segment.url.path, contents: nil) else {
            throw WriterError.cannotCreateFile
        }
        do {
            let handle = try FileHandle(forWritingTo: segment.url)
            try handle.write(contentsOf: header(dataBytes: 0))
            try segment.register()
            file = handle
        } catch {
            try? FileManager.default.removeItem(at: segment.url)
            throw error
        }
    }

    private func header(dataBytes: Int) -> Data {
        var data = Data()
        data.append(contentsOf: "RIFF".utf8)
        data.appendLittleEndian(UInt32(36 + dataBytes))
        data.append(contentsOf: "WAVEfmt ".utf8)
        data.appendLittleEndian(UInt32(16))
        data.appendLittleEndian(UInt16(1)) // PCM
        data.appendLittleEndian(UInt16(1)) // mono
        data.appendLittleEndian(sampleRate)
        data.appendLittleEndian(sampleRate * 2)
        data.appendLittleEndian(UInt16(2))
        data.appendLittleEndian(UInt16(16))
        data.append(contentsOf: "data".utf8)
        data.appendLittleEndian(UInt32(dataBytes))
        return data
    }
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}
