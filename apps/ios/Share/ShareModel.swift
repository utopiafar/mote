import SwiftUI
import UIKit
import UniformTypeIdentifiers
import MoteCentral
import MoteStorage

@MainActor
final class ShareModel: ObservableObject {
    @Published private(set) var request: ShareRequest?
    @Published private(set) var isLoading = true
    @Published private(set) var saved = false
    @Published private(set) var errorMessage: String?
    @Published var note = ""
    @Published var descriptionText = ""
    @Published var isDescriptionExpanded = false
    var onFinish: (() -> Void)?

    private var isSaving = false

    var content: SharePanelContent {
        request?.panelContent ?? SharePanelContent()
    }

    var canSave: Bool {
        guard let request, !saved, !isLoading, !isSaving else { return false }
        return !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !request.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || request.link != nil
            || !request.attachments.isEmpty
    }

    func load(providers: [NSItemProvider], contentText: String?) async {
        request = await ShareLoader.load(providers: providers, contentText: contentText)
        isLoading = false
    }

    func save() async {
        guard let request, canSave else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let queue = try MoteStorage.sendQueue()
            let attachmentStore = try MoteStorage.shareAttachmentStore()
            let identity = Self.identity()
            _ = try ShareSubmission.save(
                request: request,
                note: note,
                description: descriptionText,
                deviceId: identity.id,
                deviceName: identity.name,
                queue: queue,
                attachmentStore: attachmentStore
            )
            saved = true
            try? await Task.sleep(for: .milliseconds(800))
            onFinish?()
        } catch ShareAttachmentStoreError.tooManyAttachments {
            errorMessage = "最多 10 个附件"
        } catch ShareAttachmentStoreError.attachmentTooLarge {
            errorMessage = "附件超过 50 MiB"
        } catch {
            errorMessage = "未能保存"
        }
    }

    private static func identity() -> (id: String, name: String) {
        let id = UIDevice.current.identifierForVendor?.uuidString.lowercased() ?? UUID().uuidString.lowercased()
        return (id, UIDevice.current.name)
    }
}

struct ShareFlowView: View {
    @ObservedObject var model: ShareModel
    let onCancel: () -> Void
    var onHeight: ((CGFloat) -> Void)?

    var body: some View {
        ZStack(alignment: .bottom) {
            ShareScrim()
            if model.isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            } else {
                SharePanelView(
                    content: model.content,
                    note: Binding(get: { model.note }, set: { model.note = $0 }),
                    descriptionText: Binding(get: { model.descriptionText }, set: { model.descriptionText = $0 }),
                    isDescriptionExpanded: Binding(get: { model.isDescriptionExpanded }, set: { model.isDescriptionExpanded = $0 }),
                    saved: model.saved,
                    errorMessage: model.errorMessage,
                    saveEnabled: model.canSave,
                    onCancel: onCancel,
                    onSave: { Task { await model.save() } }
                )
                .background {
                    GeometryReader { proxy in
                        Color.clear.preference(key: SharePanelHeightKey.self, value: proxy.size.height)
                    }
                }
                .onPreferenceChange(SharePanelHeightKey.self) { height in
                    guard height > 0 else { return }
                    onHeight?(height)
                }
            }
        }
        .ignoresSafeArea(edges: .bottom)
    }
}

private struct SharePanelHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

@MainActor
enum ShareLoader {
    static func load(providers: [NSItemProvider], contentText: String?) async -> ShareRequest {
        var text = contentText ?? ""
        var link: URL?
        var linkTitle: String?
        var attachments: [ShareAttachmentData] = []
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                if let url = await loadURL(provider, type: UTType.url.identifier) {
                    if url.isFileURL {
                        if let attachment = await loadFile(url: url) {
                            attachments.append(attachment)
                        }
                    } else if let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) {
                        link = link ?? url
                        if let name = await loadString(provider, type: "public.url-name"), !name.isEmpty {
                            linkTitle = linkTitle ?? name
                        }
                    }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                if let attachment = await loadImage(provider) {
                    attachments.append(attachment)
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                if let url = await loadURL(provider, type: UTType.fileURL.identifier),
                   let attachment = await loadFile(url: url) {
                    attachments.append(attachment)
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), text.isEmpty,
                      let value = await loadString(provider, type: UTType.plainText.identifier) {
                text = value
            }
        }
        let limitedAttachments = Array(attachments.prefix(ShareAttachmentStore.maximumAttachments))
        let preview: ShareLinkPreview?
        if let link, let host = link.host {
            let title = linkTitle?.isEmpty == false ? linkTitle! : (text.isEmpty ? host : text)
            preview = ShareLinkPreview(url: link.absoluteString, title: String(title.prefix(300)), domain: String(host.prefix(300)))
        } else {
            preview = nil
        }
        return ShareRequest(text: text, link: preview, attachments: limitedAttachments)
    }

    private static func loadURL(_ provider: NSItemProvider, type: String) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, _ in
                if let url = item as? URL {
                    continuation.resume(returning: url)
                } else if let url = item as? NSURL {
                    continuation.resume(returning: url as URL)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    private static func loadString(_ provider: NSItemProvider, type: String) async -> String? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, _ in
                continuation.resume(returning: item as? String)
            }
        }
    }

    private static func loadImage(_ provider: NSItemProvider) async -> ShareAttachmentData? {
        let type = provider.registeredTypeIdentifiers.first {
            UTType($0)?.conforms(to: .image) == true
        } ?? UTType.image.identifier
        let data: Data? = await withCheckedContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                continuation.resume(returning: data)
            }
        }
        guard let data, data.count <= ShareAttachmentStore.maximumAttachmentBytes else { return nil }
        let mimeType = UTType(type)?.preferredMIMEType ?? "image/jpeg"
        let suggested = provider.suggestedName.map {
            URL(fileURLWithPath: $0).deletingPathExtension().lastPathComponent
        }
        let base = suggested?.isEmpty == false ? suggested! : "照片"
        let pathExtension = UTType(mimeType: mimeType)?.preferredFilenameExtension ?? "jpg"
        let fileName = "\(base).\(pathExtension)"
        return ShareAttachmentData(data: data, fileName: fileName, mimeType: mimeType)
    }

    private static func loadFile(url: URL) async -> ShareAttachmentData? {
        let accessing = url.startAccessingSecurityScopedResource()
        defer {
            if accessing { url.stopAccessingSecurityScopedResource() }
        }
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
              let size = values.fileSize, size <= ShareAttachmentStore.maximumAttachmentBytes,
              let data = try? Data(contentsOf: url)
        else { return nil }
        let mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        return ShareAttachmentData(data: data, fileName: url.lastPathComponent, mimeType: mimeType)
    }
}
