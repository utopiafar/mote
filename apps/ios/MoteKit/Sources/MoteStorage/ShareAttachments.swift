import Foundation

/// Bytes received from a system share. The share extension stages them in the
/// App Group so the saved record keeps the shared media beyond the extension's
/// lifetime.
public struct ShareAttachmentData: Equatable, Sendable {
    public let data: Data
    public let fileName: String
    public let mimeType: String

    public init(data: Data, fileName: String, mimeType: String) {
        self.data = data
        self.fileName = fileName
        self.mimeType = mimeType
    }
}

/// One shared media item, recorded as a file attachment rather than a photo or
/// audio draft attachment. Central archives it through the file source.
public struct StoredShareAttachment: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        case file
    }

    public let id: String
    public let kind: Kind
    public let fileName: String
    public let mimeType: String
    public let sizeBytes: Int
    public let storedFileName: String

    public init(id: String, kind: Kind = .file, fileName: String, mimeType: String,
                sizeBytes: Int, storedFileName: String) {
        self.id = id
        self.kind = kind
        self.fileName = fileName
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.storedFileName = storedFileName
    }
}

public enum ShareAttachmentStoreError: Error, Equatable {
    case tooManyAttachments
    case attachmentTooLarge
}

/// Durable App Group journal for one shared record's media. The share extension
/// writes it before the note enters the send queue; deleting the record removes
/// its journal and bytes.
public final class ShareAttachmentStore: @unchecked Sendable {
    public static let maximumAttachments = 10
    public static let maximumAttachmentBytes = 50 * 1024 * 1024

    private let directoryURL: URL
    private let fileManager: FileManager
    private let lock = NSLock()

    public init(directoryURL: URL, fileManager: FileManager = .default) {
        self.directoryURL = directoryURL
        self.fileManager = fileManager
    }

    public func stage(recordId: UUID, attachments: [ShareAttachmentData]) throws -> [StoredShareAttachment] {
        guard attachments.count <= Self.maximumAttachments else { throw ShareAttachmentStoreError.tooManyAttachments }
        for attachment in attachments {
            guard attachment.data.count <= Self.maximumAttachmentBytes else {
                throw ShareAttachmentStoreError.attachmentTooLarge
            }
        }
        guard !attachments.isEmpty else { return [] }

        lock.lock()
        defer { lock.unlock() }
        let recordURL = directoryURL.appendingPathComponent(recordId.uuidString.lowercased(), isDirectory: true)
        do {
            try fileManager.createDirectory(at: recordURL, withIntermediateDirectories: true)
            var stored: [StoredShareAttachment] = []
            for attachment in attachments {
                let id = UUID().uuidString.lowercased()
                let pathExtension = URL(fileURLWithPath: attachment.fileName).pathExtension
                let storedFileName = pathExtension.isEmpty ? id : "\(id).\(pathExtension)"
                try attachment.data.write(to: recordURL.appendingPathComponent(storedFileName), options: .atomic)
                stored.append(StoredShareAttachment(
                    id: id,
                    fileName: attachment.fileName,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.data.count,
                    storedFileName: storedFileName
                ))
            }
            try writeManifest(stored, to: recordURL)
            return stored
        } catch {
            try? fileManager.removeItem(at: recordURL)
            throw error
        }
    }

    public func manifest(recordId: UUID) throws -> [StoredShareAttachment]? {
        lock.lock()
        defer { lock.unlock() }
        let url = recordURL(recordId).appendingPathComponent("media.json")
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode([StoredShareAttachment].self, from: Data(contentsOf: url))
    }

    public func fileURL(recordId: UUID, attachment: StoredShareAttachment) -> URL {
        recordURL(recordId).appendingPathComponent(attachment.storedFileName)
    }

    public func remove(recordId: UUID) throws {
        lock.lock()
        defer { lock.unlock() }
        let url = recordURL(recordId)
        guard fileManager.fileExists(atPath: url.path) else { return }
        try fileManager.removeItem(at: url)
    }

    private func recordURL(_ recordId: UUID) -> URL {
        directoryURL.appendingPathComponent(recordId.uuidString.lowercased(), isDirectory: true)
    }

    private func writeManifest(_ attachments: [StoredShareAttachment], to recordURL: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(attachments).write(to: recordURL.appendingPathComponent("media.json"), options: .atomic)
    }
}
