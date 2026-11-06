import Foundation
import MoteCentral
import MoteCore
import MoteStorage
import Observation

/// Reads the owner's central originals through the existing literal context
/// search. The page owns its query and cursor; iOS has no local original
/// archive, so it never mixes another client's local rows into these results.
@MainActor
@Observable
final class SearchRecordsModel {
    struct Row: Identifiable, Equatable, Sendable {
        let id: String
        let title: String
        let snippet: String
        let timeLabel: String
        let sourceLabel: String

        var meta: String {
            if timeLabel.isEmpty { return sourceLabel }
            if sourceLabel.isEmpty { return timeLabel }
            return timeLabel + " · " + sourceLabel
        }
    }

    struct Page: Sendable {
        let rows: [Row]
        let nextCursor: String?

        init(rows: [Row], nextCursor: String?) {
            self.rows = rows
            self.nextCursor = nextCursor
        }
    }

    typealias Loader = @MainActor (_ query: String, _ cursor: String?) async throws -> Page
    typealias ConnectionCheck = @MainActor () -> Bool

    var query = ""

    private(set) var rows: [Row] = []
    private(set) var loading = false
    private(set) var connected = true
    private(set) var errorMessage: String?
    private(set) var hasSearched = false

    private let loader: Loader?
    private let connectionCheck: ConnectionCheck?
    private var nextCursor: String?
    private var generation = 0

    init(
        rows: [Row] = [],
        query: String = "",
        hasSearched: Bool = false,
        connected: Bool = true,
        loader: Loader? = nil,
        connectionCheck: ConnectionCheck? = nil
    ) {
        self.rows = rows
        self.query = query
        self.hasSearched = hasSearched
        self.connected = connected
        self.loader = loader
        self.connectionCheck = connectionCheck
    }

    static func live() -> SearchRecordsModel {
        SearchRecordsModel(
            loader: { query, cursor in
                guard let connection = try MoteStorage.connectionStore().read() else {
                    throw SearchRecordsError.notConnected
                }
                let client = try CentralClient(serverUrl: connection.serverUrl, token: connection.token)
                let page = try await client.contextSearch(query: query, cursor: cursor)
                var rows: [SearchRecordsModel.Row] = []
                rows.reserveCapacity(page.items.count)
                for card in page.items {
                    guard let id = UUID(uuidString: card.id) else { throw CentralError.invalidResponse }
                    let record = try await client.original(id: id)
                    guard record.id == card.id else { throw CentralError.invalidResponse }
                    let date = CentralTimestamp.parse(record.capturedAt)
                    rows.append(Row(
                        id: record.id,
                        title: card.title,
                        snippet: card.snippet,
                        timeLabel: LibraryBrowsePresentation.timeLabel(date),
                        sourceLabel: LibraryBrowsePresentation.sourceLabel(
                            source: record.source.rawValue,
                            kind: "",
                            isMaterial: false,
                            appName: record.appName,
                            durationMs: record.durationMs
                        )
                    ))
                }
                return Page(rows: rows, nextCursor: page.nextCursor)
            },
            connectionCheck: {
                do {
                    return try MoteStorage.connectionStore().read() != nil
                } catch {
                    return false
                }
            }
        )
    }

    var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// True only after a completed query that returned no rows. The initial
    /// page and a blank query stay prompts instead of looking like "no match".
    var showsEmptyResult: Bool {
        connected && errorMessage == nil && !loading && hasSearched
            && rows.isEmpty && !trimmedQuery.isEmpty
    }

    func prepare() async {
        guard let connectionCheck else { return }
        connected = connectionCheck()
    }

    func searchAfterQueryChange() async {
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        await searchNow()
    }

    func searchNow() async {
        let term = String(trimmedQuery.prefix(500))
        guard !term.isEmpty else {
            generation += 1
            rows = []
            nextCursor = nil
            errorMessage = nil
            hasSearched = false
            loading = false
            return
        }
        guard let loader else {
            generation += 1
            rows = []
            nextCursor = nil
            errorMessage = nil
            hasSearched = true
            loading = false
            return
        }

        generation += 1
        let current = generation
        hasSearched = true
        loading = true
        errorMessage = nil
        nextCursor = nil
        do {
            let page = try await loader(term, nil)
            guard current == generation else { return }
            rows = page.rows
            nextCursor = page.nextCursor
            connected = true
        } catch SearchRecordsError.notConnected {
            guard current == generation else { return }
            connected = false
            rows = []
            nextCursor = nil
            errorMessage = nil
        } catch {
            guard current == generation else { return }
            rows = []
            nextCursor = nil
            errorMessage = "搜索暂不可用"
        }
        if current == generation { loading = false }
    }

    func loadMoreIfNeeded(after id: String) async {
        guard let loader, !loading, rows.last?.id == id, let cursor = nextCursor else { return }
        let term = String(trimmedQuery.prefix(500))
        guard !term.isEmpty else { return }
        let current = generation
        loading = true
        do {
            let page = try await loader(term, cursor)
            guard current == generation else { return }
            let known = Set(rows.map(\.id))
            rows += page.rows.filter { !known.contains($0.id) }
            nextCursor = page.nextCursor == cursor ? nil : page.nextCursor
            connected = true
        } catch SearchRecordsError.notConnected {
            guard current == generation else { return }
            connected = false
            rows = []
            nextCursor = nil
            errorMessage = nil
        } catch {
            guard current == generation else { return }
            errorMessage = "搜索暂不可用"
        }
        if current == generation { loading = false }
    }
}

enum SearchRecordsError: Error {
    case notConnected
}
