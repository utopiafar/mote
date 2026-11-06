import SwiftUI
import UIKit
import UniformTypeIdentifiers
import MoteCentral
import MoteStorage

@MainActor
final class EditorModel: ObservableObject {
    @Published private(set) var session = EditorDraftSession()
    @Published private(set) var isSaving = false
    @Published var isEditorVisible = true
    @Published var isDescriptionExpanded = false
    @Published var errorMessage: String?

    let store: EditorDraftStore
    private var clearedDescriptionExpanded = false
    private var didLoad = false

    init(store: EditorDraftStore) {
        self.store = store
    }

    var hasDraft: Bool {
        !session.draft.isEmpty
    }

    var canSave: Bool {
        !session.draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !session.draft.attachments.isEmpty
    }

    func load(fixtureName: String?, descriptionExpanded: Bool) {
        guard !didLoad else { return }
        didLoad = true
        do {
            if let fixtureName {
                session = EditorDraftSession(draft: try EditorFixture.makeDraft(name: fixtureName, store: store))
                if fixtureName == "cleared" {
                    session.clear()
                }
                try store.save(session.draft)
            } else {
                session = EditorDraftSession(draft: try store.load())
            }
            isDescriptionExpanded = descriptionExpanded
        } catch {
            errorMessage = "草稿未能打开"
        }
    }

    func updateText(_ text: String) {
        session.update { $0.text = text }
        persist()
    }

    func updateSourceDescription(_ sourceDescription: String) {
        session.update { $0.sourceDescription = sourceDescription }
        persist()
    }

    func add(_ attachment: EditorAttachment) {
        session.update { $0.attachments.append(attachment) }
        persist()
    }

    func addRecording(_ attachment: EditorAttachment) throws {
        var draft = session.draft
        draft.attachments.append(attachment)
        try store.save(draft)
        session.update { $0 = draft }
    }

    func remove(_ attachment: EditorAttachment) {
        session.update { draft in
            draft.attachments.removeAll { $0.id == attachment.id }
        }
        persist()
        do {
            try store.delete(attachment)
        } catch {
            errorMessage = "附件文件未能移除"
        }
    }

    func clear() {
        clearedDescriptionExpanded = isDescriptionExpanded
        session.clear()
        isDescriptionExpanded = false
        persist()
    }

    func undoClear() {
        session.undoClear()
        isDescriptionExpanded = clearedDescriptionExpanded
        clearedDescriptionExpanded = false
        persist()
    }

    @discardableResult
    func save() -> Bool {
        guard canSave, !isSaving else { return false }
        isSaving = true
        defer { isSaving = false }
        do {
            let draft = session.draft
            let attachments = try draft.attachments.map(attachmentData)
            let queue = try MoteStorage.sendQueue()
            let attachmentStore = try MoteStorage.shareAttachmentStore()
            let defaults = UserDefaults.standard
            let deviceId = defaults.string(forKey: "mote.deviceId")
                ?? UIDevice.current.identifierForVendor?.uuidString.lowercased()
                ?? UUID().uuidString.lowercased()
            _ = try EditorSubmission.save(
                draft: draft,
                attachments: attachments,
                deviceId: deviceId,
                deviceName: UIDevice.current.name,
                queue: queue,
                attachmentStore: attachmentStore
            )
            try store.save(EditorDraft())
            for attachment in draft.attachments { try? store.delete(attachment) }
            session = EditorDraftSession()
            clearedDescriptionExpanded = false
            isDescriptionExpanded = false
            isEditorVisible = false
            errorMessage = nil
            return true
        } catch ShareAttachmentStoreError.tooManyAttachments {
            errorMessage = "最多 10 个附件"
        } catch ShareAttachmentStoreError.attachmentTooLarge, SendQueueError.attachmentTooLarge {
            errorMessage = "附件超过 50 MiB"
        } catch {
            errorMessage = "记录未能保存，草稿已保留"
        }
        return false
    }

    func back() {
        persist()
        isEditorVisible = false
    }

    private func attachmentData(for attachment: EditorAttachment) throws -> ShareAttachmentData {
        let url = store.fileURL(for: attachment)
        let type = UTType(filenameExtension: url.pathExtension)
        return ShareAttachmentData(
            data: try Data(contentsOf: url),
            fileName: attachment.fileName,
            mimeType: type?.preferredMIMEType ?? "application/octet-stream"
        )
    }

    private func persist() {
        do {
            try store.save(session.draft)
            errorMessage = nil
        } catch {
            errorMessage = "草稿未能保存"
        }
    }
}
