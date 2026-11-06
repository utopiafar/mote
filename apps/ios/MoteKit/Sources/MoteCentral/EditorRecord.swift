import Foundation
import MoteStorage

public enum EditorSubmission {
    @discardableResult
    public static func save(
        draft: EditorDraft,
        attachments: [ShareAttachmentData],
        deviceId: String,
        deviceName: String,
        recordId: UUID = UUID(),
        capturedAt: String = CentralTimestamp.string(),
        queue: SendQueue,
        attachmentStore: ShareAttachmentStore
    ) throws -> ShareCapture {
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !deviceId.isEmpty, !deviceName.isEmpty,
              draft.text.count <= ShareRecord.maximumTextCharacters,
              draft.sourceDescription.count <= ShareRecord.maximumDescriptionCharacters,
              draft.attachments.count == attachments.count,
              attachments.count <= ShareAttachmentStore.maximumAttachments,
              attachments.allSatisfy({ $0.data.count <= ShareAttachmentStore.maximumAttachmentBytes }),
              CentralTimestamp.parse(capturedAt) != nil,
              !text.isEmpty || !attachments.isEmpty
        else { throw ShareRecordError.invalidRequest }
        let existing = try queue.pending()
        guard !existing.contains(where: { $0.id == recordId.uuidString.lowercased() }) else {
            throw SendQueueError.duplicateID
        }

        let originText = text.isEmpty ? attachments.map(\.fileName).joined(separator: "\n") : draft.text
        let metadata = RecordMetadata(
            version: 1,
            observedAt: capturedAt,
            collector: CollectorMetadata(method: "manual"),
            noteOrigin: NoteOrigin(kind: .manual, text: originText),
            ownerDescription: draft.sourceDescription.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil : draft.sourceDescription
        )
        let capture = CaptureUpload(
            id: recordId,
            deviceId: deviceId,
            deviceName: deviceName,
            capturedAt: capturedAt,
            source: .note,
            appId: "dev.mote.notes",
            appName: "记录",
            ocrText: draft.text,
            privacy: CapturePrivacy(mode: "none"),
            metadata: metadata
        )
        let stored = try attachmentStore.stage(recordId: recordId, attachments: attachments)
        do {
            try queue.enqueue(
                ShareRecord.payload(capture),
                id: capture.id,
                validatingAttachments: attachments.map(\.data)
            )
            return ShareCapture(capture: capture, attachments: stored)
        } catch {
            try? attachmentStore.remove(recordId: recordId)
            throw error
        }
    }
}
