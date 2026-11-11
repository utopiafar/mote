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
        guard let id, let client = connectionClient() else {
            isLoading = false
            errorMessage = id == nil ? "原文不可用" : "没有连上中央"
            return
        }
        do {
            let record = try await client.original(id: id)
            let conversations = try? await allConversations(client: client)
            guard generation == loadGeneration else { return }
            let presentation = try OriginalPresentation(record: record, conversations: conversations,
                                                        highlightedPhrase: highlightedPhrase)
            self.presentation = presentation
            hero = presentation.hasImage ? .loading : nil
            isLoading = false
            guard presentation.hasImage else { return }
            var image: UIImage?
            if let data = try? await client.originalImage(id: id) { image = await Self.downsampled(data) }
            guard generation == loadGeneration else { return }
            hero = image.map(OriginalHero.image) ?? .unavailable
        } catch {
            guard generation == loadGeneration else { return }
            isLoading = false
            errorMessage = "未能读取原文"
        }
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

    private func allConversations(client: CentralClient) async throws -> [ConversationSummary] {
        var cursor: String?
        var result: [ConversationSummary] = []
        repeat {
            let page = try await client.conversations(cursor: cursor, limit: 100)
            result.append(contentsOf: page.items)
            cursor = page.nextCursor
        } while cursor != nil
        return result
    }
}
