import Foundation
import ImageIO
import MoteCentral
import MoteStorage
import Observation
import UIKit

/// The screenshot or photo kept with an original: on its way, shown, or not available.
enum OriginalHero {
    case loading
    case image(UIImage)
    case unavailable
}

@MainActor
@Observable
final class OriginalModel {
    private(set) var presentation: OriginalPresentation?
    private(set) var hero: OriginalHero?
    private(set) var isLoading = true
    private(set) var errorMessage: String?
    private(set) var canPlayAudio = false
    private(set) var fileNotice: String?
    private(set) var nextFileOffset: Int?
    private var fileRecord: OriginalRecord?
    private var fileArtifactID: String?
    private var loadingMore = false

    private let id: UUID?
    private let session: URLSession
    private let fileManager: FileManager
    private let highlightedPhrase: String?
    private var loadGeneration = 0

    init(id: String, highlightedPhrase: String? = nil,
         session: URLSession = .shared, fileManager: FileManager = .default) {
        self.id = UUID(uuidString: id)
        self.highlightedPhrase = highlightedPhrase
        self.session = session
        self.fileManager = fileManager
    }

    func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        errorMessage = nil
        canPlayAudio = false
        fileNotice = nil
        nextFileOffset = nil
        fileRecord = nil
        fileArtifactID = nil
        guard let id, let client = connectionClient() else {
            isLoading = false
            errorMessage = id == nil ? "原文不可用" : "没有连上中央"
            return
        }
        do {
            let record = try await client.original(id: id)
            guard record.id == id.uuidString.lowercased() else { throw CentralError.invalidResponse }
            let isArchivedFile = record.fileArchive?.captureId == record.id
            let file = isArchivedFile ? try? await client.originalFile(id: id) : nil
            let page = file != nil ? try? await client.originalFileText(id: id) : nil
            try Task.checkCancellation()
            guard generation == loadGeneration else { return }
            let fileImage = file?.canOpenOriginal == true && file?.item.mimeType?.hasPrefix("image/") == true
            let chunks = page?.items.map(\.readableText).joined(separator: "\n\n")
            let text = chunks?.isEmpty == false ? chunks : file?.item.text
            let presentation = try OriginalPresentation(record: record, conversations: nil,
                                                        highlightedPhrase: highlightedPhrase, fileText: text, fileImage: fileImage)
            fileRecord = file == nil ? nil : record
            fileArtifactID = page?.items.first?.artifactID
            nextFileOffset = page?.nextOffset
            canPlayAudio = file?.canOpenOriginal == true && file?.item.mimeType?.hasPrefix("audio/") == true
            if isArchivedFile && presentation.text.isEmpty && !fileImage && !canPlayAudio {
                fileNotice = file != nil && page != nil ? "正文尚未就绪" : "未能读取原文"
            }
            self.presentation = presentation
            hero = presentation.hasImage ? .loading : nil
            isLoading = false
            guard presentation.hasImage else { return }
            var image: UIImage?
            let data = fileImage ? try? await client.originalFileImage(id: id) : try? await client.originalImage(id: id)
            if let data { image = await Self.downsampled(data) }
            guard generation == loadGeneration else { return }
            hero = image.map(OriginalHero.image) ?? .unavailable
        } catch {
            guard generation == loadGeneration else { return }
            isLoading = false
            errorMessage = "未能读取原文"
        }
    }

    func loadMore() async {
        guard !loadingMore, let offset = nextFileOffset, let id, let record = fileRecord,
              let content = presentation, let client = connectionClient() else { return }
        let generation = loadGeneration
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await client.originalFileText(id: id, offset: offset)
            try Task.checkCancellation()
            guard generation == loadGeneration else { return }
            guard page.items.allSatisfy({ $0.artifactID == fileArtifactID }),
                  page.nextOffset.map({ $0 > offset }) ?? true else {
                await load()
                return
            }
            let text = ([content.text] + page.items.map(\.readableText)).filter { !$0.isEmpty }.joined(separator: "\n\n")
            presentation = try OriginalPresentation(record: record, conversations: nil,
                                                    highlightedPhrase: highlightedPhrase, fileText: text, fileImage: content.hasImage)
            nextFileOffset = page.nextOffset
            fileNotice = nil
        } catch {
            if generation == loadGeneration { fileNotice = "未能读取原文" }
        }
    }

    func downloadAudio() async throws -> URL {
        guard canPlayAudio, let id, let client = connectionClient() else { throw CentralError.invalidRequest }
        return try await client.downloadOriginalAudio(id: id)
    }

    func delete() async -> String? {
        guard let id, let kind = presentation?.deletionKind, let client = connectionClient() else {
            return "此引用不能直接删除原始记录。"
        }
        do {
            try await client.deleteOriginal(id: id, expectedKind: kind)
            return nil
        } catch OriginalDeletionError.unavailable {
            return "此引用不能直接删除原始记录。"
        } catch {
            return "未能确认删除完成。原文仍保留，刷新后可核对当前状态。"
        }
    }

    /// Screenshots can be far larger than the screen. Decode at most 2048 px on a side, away from the main actor.
    private nonisolated static func downsampled(_ data: Data) async -> UIImage? {
        await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                      kCGImageSourceCreateThumbnailFromImageAlways: true,
                      kCGImageSourceCreateThumbnailWithTransform: true,
                      kCGImageSourceShouldCacheImmediately: true,
                      kCGImageSourceThumbnailMaxPixelSize: 2048,
                  ] as CFDictionary)
            else { return nil }
            return UIImage(cgImage: image)
        }.value
    }

    private func connectionClient() -> CentralClient? {
        guard let connection = (try? MoteStorage.connectionStore(fileManager: fileManager).read()) ?? nil else { return nil }
        return try? CentralClient(serverUrl: connection.serverUrl, token: connection.token, session: session)
    }

}
