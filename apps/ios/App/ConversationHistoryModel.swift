import Foundation
import MoteCentral
import MoteCore
import MoteStorage
import Observation

struct HistoryPage {
    let conversations: [HistoryConversation]
    let nextCursor: String?
}

@MainActor
@Observable
final class ConversationHistoryModel {
    typealias Loader = (String?) async throws -> HistoryPage
    typealias Deleter = (String) async throws -> Void

    private(set) var conversations: [HistoryConversation] = []
    private(set) var failures: [String: String] = [:]
    private(set) var deleting: Set<String> = []
    private(set) var loading = false
    private(set) var loadFailed = false
    private var nextCursor: String?
    private var deleted: Set<String> = []
    private var generation = 0
    private let load: Loader
    private let remove: Deleter

    init(load: @escaping Loader, remove: @escaping Deleter) {
        self.load = load
        self.remove = remove
    }

    static func live() -> ConversationHistoryModel {
        func client() throws -> CentralClient {
            guard let connection = try MoteStorage.connectionStore().read() else { throw HistoryError.notConnected }
            return try CentralClient(serverUrl: connection.serverUrl, token: connection.token)
        }
        return ConversationHistoryModel { cursor in
            let page = try await client().conversations(cursor: cursor)
            return HistoryPage(conversations: page.items.compactMap { item in
                guard let date = CentralTimestamp.parse(item.updatedAt) else { return nil }
                return HistoryConversation(id: item.id, title: item.title, updatedAt: date)
            }, nextCursor: page.nextCursor)
        } remove: { id in
            guard let uuid = UUID(uuidString: id) else { throw HistoryError.invalidID }
            _ = try await client().deleteConversation(id: uuid)
        }
    }

    func refresh() async {
        generation += 1
        let current = generation
        loading = true
        loadFailed = false
        do {
            let page = try await load(nil)
            guard current == generation else { return }
            conversations = page.conversations.filter { !deleted.contains($0.id) }
            nextCursor = page.nextCursor
        } catch {
            guard current == generation else { return }
            loadFailed = true
        }
        if current == generation { loading = false }
    }

    func loadMoreIfNeeded(after id: String) async {
        guard !loading, let cursor = nextCursor, conversations.last?.id == id else { return }
        let current = generation
        loading = true
        do {
            let page = try await load(cursor)
            guard current == generation else { return }
            let known = Set(conversations.map(\.id)).union(deleted)
            conversations.append(contentsOf: page.conversations.filter { !known.contains($0.id) })
            nextCursor = page.nextCursor == cursor ? nil : page.nextCursor
            loadFailed = false
        } catch {
            guard current == generation else { return }
            loadFailed = true
        }
        if current == generation { loading = false }
    }

    func delete(_ conversation: HistoryConversation) async {
        guard deleting.insert(conversation.id).inserted else { return }
        defer { deleting.remove(conversation.id) }
        do {
            try await remove(conversation.id)
            deleted.insert(conversation.id)
            conversations.removeAll { $0.id == conversation.id }
            failures.removeValue(forKey: conversation.id)
        } catch {
            failures[conversation.id] = Self.failureDetails(error)
        }
    }

    private static func failureDetails(_ error: Error) -> String {
        if let central = error as? CentralError, case let .http(status, code) = central {
            return code.map { "删除未完成（\(status)，\($0)）" } ?? "删除未完成（\(status)）"
        }
        return "删除未完成，连接或中央暂不可用。"
    }
}

private enum HistoryError: Error {
    case notConnected, invalidID
}
