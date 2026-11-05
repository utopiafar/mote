import Foundation
import MoteStorage

public enum ShareRecordError: Error, Equatable {
    case invalidRequest
}

public struct ShareLinkPreview: Equatable, Sendable {
    public let url: String
    public let title: String
    public let domain: String

    public init(url: String, title: String, domain: String) {
        self.url = url
        self.title = title
        self.domain = domain
    }
}

/// What another app handed to the share extension. Attachments keep their bytes
/// so the extension can stage them before the panel closes.
public struct ShareRequest: Equatable, Sendable {
    public let text: String
    public let link: ShareLinkPreview?
    public let attachments: [ShareAttachmentData]

    public init(text: String = "", link: ShareLinkPreview? = nil, attachments: [ShareAttachmentData] = []) {
        self.text = text
        self.link = link
        self.attachments = attachments
    }
}

public struct ShareCapture: Equatable, Sendable {
    public let capture: CaptureUpload
    public let attachments: [StoredShareAttachment]

    public init(capture: CaptureUpload, attachments: [StoredShareAttachment]) {
        self.capture = capture
        self.attachments = attachments
    }
}

/// One shared note. A link keeps its URL, media is recorded as a file
/// attachment, and the collector is always the owner's explicit save.
public enum ShareRecord {
    public static let maximumTextCharacters = 100_000
    public static let maximumDescriptionCharacters = 12_000

    public static func make(request: ShareRequest, note: String, description: String,
                            attachments: [StoredShareAttachment], deviceId: String, deviceName: String,
                            id: UUID = UUID(), capturedAt: String = CentralTimestamp.string()) throws -> ShareCapture {
        guard !deviceId.isEmpty, !deviceName.isEmpty,
              note.count <= maximumTextCharacters,
              description.count <= maximumDescriptionCharacters,
              request.text.count <= maximumTextCharacters,
              attachments.count <= ShareAttachmentStore.maximumAttachments,
              attachments.allSatisfy({ $0.sizeBytes <= ShareAttachmentStore.maximumAttachmentBytes }),
              CentralTimestamp.parse(capturedAt) != nil
        else { throw ShareRecordError.invalidRequest }
        if let link = request.link {
            guard link.url.count <= 4000, link.title.count <= 300, link.domain.count <= 300,
                  let components = URLComponents(string: link.url),
                  let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
                  let host = components.host, !host.isEmpty
            else { throw ShareRecordError.invalidRequest }
        }

        let trimmedText = request.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = request.link.map { $0.title.isEmpty ? $0.url : $0.title }
            ?? attachments.map(\.fileName).joined(separator: "\n")
        let originText = trimmedText.isEmpty ? fallback : request.text
        guard !originText.isEmpty else { throw ShareRecordError.invalidRequest }

        let metadata = RecordMetadata(
            version: 1,
            observedAt: capturedAt,
            collector: CollectorMetadata(method: "manual"),
            noteOrigin: NoteOrigin(kind: .share, text: String(originText.prefix(maximumTextCharacters)),
                                   url: request.link?.url),
            ownerDescription: description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : description
        )
        let capture = CaptureUpload(
            id: id,
            deviceId: deviceId,
            deviceName: deviceName,
            capturedAt: capturedAt,
            source: .note,
            appId: "dev.mote.notes",
            appName: "记录",
            ocrText: note,
            privacy: CapturePrivacy(mode: "none"),
            metadata: metadata
        )
        return ShareCapture(capture: capture, attachments: attachments)
    }

    public static func payload(_ capture: CaptureUpload) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(capture)
    }
}

/// Writes a shared note into the durable send queue and its media into the App
/// Group journal. It never opens or changes the editor draft.
public enum ShareSubmission {
    @discardableResult
    public static func save(request: ShareRequest, note: String, description: String,
                            deviceId: String, deviceName: String, recordId: UUID = UUID(),
                            capturedAt: String = CentralTimestamp.string(), queue: SendQueue,
                            attachmentStore: ShareAttachmentStore) throws -> ShareCapture {
        let existing = try queue.pending()
        guard !existing.contains(where: { $0.id == recordId.uuidString.lowercased() }) else {
            throw SendQueueError.duplicateID
        }
        let stored = try attachmentStore.stage(recordId: recordId, attachments: request.attachments)
        do {
            let shared = try ShareRecord.make(
                request: request,
                note: note,
                description: description,
                attachments: stored,
                deviceId: deviceId,
                deviceName: deviceName,
                id: recordId,
                capturedAt: capturedAt
            )
            try queue.enqueue(ShareRecord.payload(shared.capture),
                              id: recordId.uuidString.lowercased(),
                              validatingAttachments: request.attachments.map(\.data))
            return shared
        } catch {
            try? attachmentStore.remove(recordId: recordId)
            throw error
        }
    }
}
