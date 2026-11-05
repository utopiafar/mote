import SwiftUI
import MoteStorage

@MainActor
final class EditorModel: ObservableObject {
    @Published private(set) var session = EditorDraftSession()
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

    func save() {
        persist()
    }

    func back() {
        persist()
        isEditorVisible = false
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
