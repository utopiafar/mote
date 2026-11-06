import MoteCentral
import MoteStorage
import SwiftUI
import UIKit

typealias SaveAnswerRecordAction = @MainActor (ShareConversationQuote, String, String) async throws -> Void

/// Saves one answer exactly as the owner sees it: the quoted original, their
/// supplement and the optional description land in one queued record without
/// opening or changing the editor draft.
@MainActor
enum SaveAnswerRecord {
    static func save(_ quote: ShareConversationQuote, note: String, description: String) async throws {
        let queue = try MoteStorage.sendQueue()
        let attachmentStore = try MoteStorage.shareAttachmentStore()
        let id = UIDevice.current.identifierForVendor?.uuidString.lowercased() ?? UUID().uuidString.lowercased()
        _ = try ShareSubmission.save(
            request: ShareRequest(conversation: quote),
            note: note,
            description: description,
            deviceId: id,
            deviceName: UIDevice.current.name,
            queue: queue,
            attachmentStore: attachmentStore
        )
    }
}

/// The answer variant of the compact share panel: same surface, header and
/// fields, with 保存为记录 as its title and the answer quoted above the note.
struct SaveAnswerPanel: View {
    let quote: ShareConversationQuote
    let save: SaveAnswerRecordAction
    let onClose: () -> Void

    @State private var note = ""
    @State private var descriptionText = ""
    @State private var isDescriptionExpanded = false
    @State private var saving = false
    @State private var saved = false
    @State private var errorMessage: String?

    var body: some View {
        SharePanelView(
            content: SharePanelContent(quote: quote.displayAnswer),
            note: $note,
            descriptionText: $descriptionText,
            isDescriptionExpanded: $isDescriptionExpanded,
            saved: saved,
            errorMessage: errorMessage,
            saveEnabled: !saved && !saving,
            onCancel: onClose,
            onSave: { Task { await submit() } }
        )
    }

    private func submit() async {
        guard !saving, !saved else { return }
        saving = true
        errorMessage = nil
        defer { saving = false }
        do {
            try await save(quote, note, descriptionText)
            saved = true
            try? await Task.sleep(for: .milliseconds(2_000))
            onClose()
        } catch {
            errorMessage = "未能保存"
        }
    }
}
