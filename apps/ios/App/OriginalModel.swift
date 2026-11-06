import Foundation
import MoteCentral
import MoteStorage
import Observation

@MainActor
@Observable
final class OriginalModel {
    private(set) var presentation: OriginalPresentation?
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
            presentation = try OriginalPresentation(record: record, conversations: conversations,
                                                    highlightedPhrase: highlightedPhrase)
            isLoading = false
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
