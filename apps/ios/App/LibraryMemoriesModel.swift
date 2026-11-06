import Foundation
import MoteCentral
import MoteCore
import MoteStorage
import Observation

/// Reads the two owner library pages through the existing Central endpoints.
/// Preview states use generated in-memory rows and never touch a profile.
@MainActor
@Observable
final class LibraryMemoriesModel {
    enum Tab: String, CaseIterable, Identifiable {
        case library
        case memories

        var id: String { rawValue }
        var title: String { self == .library ? "资料" : "记忆" }
    }

    struct LibraryRequest: Sendable {
        let query: String
        let after: String?
        let before: String?
        let cursor: String?
    }

    struct LibraryPage: Sendable {
        let rows: [LibraryBrowseRow]
        let nextCursor: String?
    }

    struct MemoryRequest: Sendable {
        let category: MemoryBrowseCategory
        let query: String
        let includeHistory: Bool
        let cursor: String?
    }

    struct MemoryPage: Sendable {
        let rows: [MemoryBrowseRow]
        let nextCursor: String?
    }

    typealias LibraryLoader = @MainActor (LibraryRequest) async throws -> LibraryPage
    typealias MemoryLoader = @MainActor (MemoryRequest) async throws -> MemoryPage
    typealias CatalogLoader = @MainActor () async throws -> ContextTreeCatalog

    var tab: Tab = .library
    var libraryQuery = ""
    var memoryQuery = ""
    var libraryCategory: LibraryBrowseCategory = .all
    var memoryCategory: MemoryBrowseCategory = .all
    var includeHistory = false
    var reviewDay: Date?
    var filterPresented = false
    var datePickerPresented = false

    private(set) var libraryRows: [LibraryBrowseRow] = []
    private(set) var memoryRows: [MemoryBrowseRow] = []
    private(set) var libraryLoading = false
    private(set) var memoryLoading = false
    private(set) var libraryError: String?
    private(set) var memoryError: String?
    private(set) var connected = true

    private var libraryNextCursor: String?
    private var memoryNextCursor: String?
    private var libraryGeneration = 0
    private var memoryGeneration = 0
    private var catalogLoaded = false
    private var catalogTreeIDs: [String: Set<String>] = [:]
    private var libraryLoader: LibraryLoader?
    private var memoryLoader: MemoryLoader?
    private var catalogLoader: CatalogLoader?
    private var isPreview = false
    private var previewLibraryRows: [LibraryBrowseRow] = []
    private var previewMemoryRows: [MemoryBrowseRow] = []
    private var previewHistoricalRows: [MemoryBrowseRow] = []

    init() {}

    init(
        previewLibrary: [LibraryBrowseRow],
        previewMemories: [MemoryBrowseRow],
        previewHistorical: [MemoryBrowseRow] = [],
        tab: Tab = .library,
        libraryQuery: String = "",
        memoryQuery: String = "",
        libraryCategory: LibraryBrowseCategory = .all,
        memoryCategory: MemoryBrowseCategory = .all,
        includeHistory: Bool = false,
        filterPresented: Bool = false
    ) {
        self.tab = tab
        self.libraryQuery = libraryQuery
        self.memoryQuery = memoryQuery
        self.libraryCategory = libraryCategory
        self.memoryCategory = memoryCategory
        self.includeHistory = includeHistory
        self.filterPresented = filterPresented
        isPreview = true
        previewLibraryRows = previewLibrary
        previewMemoryRows = previewMemories
        previewHistoricalRows = previewHistorical
        applyPreviewFilters()
    }

    static func live() -> LibraryMemoriesModel {
        let model = LibraryMemoriesModel()
        model.libraryLoader = { request in
            let client = try Self.client()
            if request.query.isEmpty {
                let page = try await client.originals(
                    after: request.after,
                    before: request.before,
                    cursor: request.cursor
                )
                return LibraryPage(
                    rows: page.items.map { Self.libraryRow($0) },
                    nextCursor: page.nextCursor
                )
            }
            let page = try await client.contextSearch(
                query: request.query,
                after: request.after,
                before: request.before,
                cursor: request.cursor
            )
            var rows: [LibraryBrowseRow] = []
            rows.reserveCapacity(page.items.count)
            for card in page.items {
                guard let id = UUID(uuidString: card.id) else { throw CentralError.invalidResponse }
                let record = try await client.original(id: id)
                guard record.id == card.id else { throw CentralError.invalidResponse }
                rows.append(Self.libraryRow(record))
            }
            return LibraryPage(rows: rows, nextCursor: page.nextCursor)
        }
        model.memoryLoader = { request in
            let client = try Self.client()
            if let treeID = request.category.treeID, let nodeID = request.category.nodeID {
                let page = try await client.memoryContextPage(
                    treeID: treeID,
                    nodeID: nodeID,
                    query: request.query.isEmpty ? nil : request.query,
                    includeHistory: request.includeHistory,
                    cursor: request.cursor
                )
                var rows: [MemoryBrowseRow] = []
                rows.reserveCapacity(page.items.count)
                for summary in page.items {
                    guard let id = UUID(uuidString: summary.id) else { throw CentralError.invalidResponse }
                    let record = try await client.memory(id: id)
                    guard record.id == summary.id, record.version == summary.version,
                          record.fingerprint == summary.revision else {
                        throw CentralError.invalidResponse
                    }
                    rows.append(Self.memoryRow(record))
                }
                return MemoryPage(rows: rows, nextCursor: page.nextCursor)
            }
            let page = try await client.memoryRecords(
                query: request.query.isEmpty ? nil : request.query,
                includeHistory: request.includeHistory,
                cursor: request.cursor
            )
            return MemoryPage(
                rows: page.items.map(Self.memoryRow),
                nextCursor: page.nextCursor
            )
        }
        model.catalogLoader = {
            try await Self.client().contextTrees()
        }
        return model
    }

    func reloadCurrent() async {
        switch tab {
        case .library:
            await loadLibrary(reset: true)
        case .memories:
            await loadMemories(reset: true)
        }
    }

    func loadLibraryAfterQueryChange() async {
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled, tab == .library else { return }
        await loadLibrary(reset: true)
    }

    func loadMemoriesAfterQueryChange() async {
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled, tab == .memories else { return }
        await loadMemories(reset: true)
    }

    func selectLibraryCategory(_ category: LibraryBrowseCategory) async {
        guard libraryCategory != category else { return }
        libraryCategory = category
        await loadLibrary(reset: true)
    }

    func selectMemoryCategory(_ category: MemoryBrowseCategory) async {
        guard memoryCategory != category else { return }
        memoryCategory = category
        await loadMemories(reset: true)
    }

    func setIncludeHistory(_ value: Bool) async {
        includeHistory = value
        await loadMemories(reset: true)
    }

    func setReviewDay(_ day: Date?) async {
        reviewDay = day
        await loadLibrary(reset: true)
    }

    func loadMoreLibraryIfNeeded(after id: String) async {
        guard !isPreview, libraryRows.last?.id == id, libraryNextCursor != nil else { return }
        await loadLibrary(reset: false)
    }

    func loadMoreMemoriesIfNeeded(after id: String) async {
        guard !isPreview, memoryRows.last?.id == id, memoryNextCursor != nil else { return }
        await loadMemories(reset: false)
    }

    private func loadLibrary(reset: Bool) async {
        if isPreview {
            applyPreviewFilters()
            return
        }
        if reset {
            libraryGeneration += 1
            libraryNextCursor = nil
            libraryError = nil
        } else if libraryLoading {
            return
        }
        guard let libraryLoader else { return }
        let generation = libraryGeneration
        let cursor = reset ? nil : libraryNextCursor
        libraryLoading = true
        do {
            let range = reviewRange
            let pageLimit = libraryQuery.isEmpty ? 8 : 3
            var collected: [LibraryBrowseRow] = []
            var nextCursor = cursor
            var pages = 0
            repeat {
                let page = try await libraryLoader(LibraryRequest(
                    query: libraryQuery.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500).description,
                    after: range?.after,
                    before: range?.before,
                    cursor: nextCursor
                ))
                guard generation == libraryGeneration else { return }
                collected += page.rows.filter { libraryCategory.matches($0) }
                nextCursor = page.nextCursor == nextCursor ? nil : page.nextCursor
                pages += 1
            } while collected.isEmpty && nextCursor != nil && pages < pageLimit && !Task.isCancelled
            guard generation == libraryGeneration else { return }
            if reset {
                libraryRows = collected
            } else {
                let known = Set(libraryRows.map(\.id))
                libraryRows += collected.filter { !known.contains($0.id) }
            }
            libraryNextCursor = nextCursor
            connected = true
        } catch LibraryMemoriesError.notConnected {
            guard generation == libraryGeneration else { return }
            connected = false
            libraryRows = []
            libraryError = nil
        } catch {
            guard generation == libraryGeneration else { return }
            libraryError = "资料暂不可读取"
        }
        if generation == libraryGeneration { libraryLoading = false }
    }

    private func loadMemories(reset: Bool) async {
        if isPreview {
            applyPreviewFilters()
            return
        }
        if reset {
            memoryGeneration += 1
            memoryNextCursor = nil
            memoryError = nil
        } else if memoryLoading {
            return
        }
        guard let memoryLoader else { return }
        let generation = memoryGeneration
        await loadCatalogIfNeeded()
        guard generation == memoryGeneration else { return }
        let category = catalogLoaded ? memoryCategory.resolved(treeIDs: catalogTreeIDs) : memoryCategory
        let cursor = reset ? nil : memoryNextCursor
        memoryLoading = true
        do {
            let page = try await memoryLoader(MemoryRequest(
                category: category,
                query: memoryQuery.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500).description,
                includeHistory: includeHistory,
                cursor: cursor
            ))
            guard generation == memoryGeneration else { return }
            if reset {
                memoryRows = page.rows
            } else {
                let known = Set(memoryRows.map(\.id))
                memoryRows += page.rows.filter { !known.contains($0.id) }
            }
            memoryNextCursor = page.nextCursor == cursor ? nil : page.nextCursor
            connected = true
        } catch LibraryMemoriesError.notConnected {
            guard generation == memoryGeneration else { return }
            connected = false
            memoryRows = []
            memoryError = nil
        } catch {
            guard generation == memoryGeneration else { return }
            memoryError = "记忆暂不可读取"
        }
        if generation == memoryGeneration { memoryLoading = false }
    }

    private func loadCatalogIfNeeded() async {
        guard !catalogLoaded, let catalogLoader else { return }
        guard let catalog = try? await catalogLoader() else { return }
        catalogTreeIDs = Dictionary(uniqueKeysWithValues: catalog.items.map { tree in
            (tree.id, Set(tree.nodes.map(\.id)))
        })
        catalogLoaded = true
    }

    private func applyPreviewFilters() {
        let libraryTerm = libraryQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        libraryRows = previewLibraryRows.filter { row in
            guard libraryCategory.matches(row) else { return false }
            if let reviewDay {
                guard let date = row.date, Calendar.current.isDate(date, inSameDayAs: reviewDay) else { return false }
            }
            guard !libraryTerm.isEmpty else { return true }
            return row.title.localizedCaseInsensitiveContains(libraryTerm)
                || row.sourceLabel.localizedCaseInsensitiveContains(libraryTerm)
        }
        let memoryTerm = memoryQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        memoryRows = (previewMemoryRows + (includeHistory ? previewHistoricalRows : [])).filter { row in
            guard row.matches(memoryCategory) else { return false }
            guard !memoryTerm.isEmpty else { return true }
            return row.title.localizedCaseInsensitiveContains(memoryTerm)
                || row.statement.localizedCaseInsensitiveContains(memoryTerm)
        }
    }

    private var reviewRange: (after: String, before: String)? {
        guard let reviewDay else { return nil }
        let calendar = Calendar.current
        guard let interval = calendar.dateInterval(of: .day, for: reviewDay) else { return nil }
        return (CentralTimestamp.string(interval.start), CentralTimestamp.string(interval.end))
    }

    private static func client() throws -> CentralClient {
        guard let connection = try MoteStorage.connectionStore().read() else {
            throw LibraryMemoriesError.notConnected
        }
        return try CentralClient(serverUrl: connection.serverUrl, token: connection.token)
    }

    private static func libraryRow(_ capture: CapturePreview) -> LibraryBrowseRow {
        let source = capture.source.rawValue
        let date = CentralTimestamp.parse(capture.capturedAt)
        let isImage = LibraryBrowsePresentation.isImage(
            source: source,
            kind: "",
            isMaterial: false,
            durationMs: capture.durationMs
        )
        return LibraryBrowseRow(
            id: capture.id,
            title: LibraryBrowsePresentation.title(
                source: source,
                textPreview: capture.textPreview,
                windowTitle: capture.windowTitle,
                appName: capture.appName
            ),
            timeLabel: LibraryBrowsePresentation.timeLabel(date),
            sourceLabel: LibraryBrowsePresentation.sourceLabel(
                source: source,
                kind: "",
                isMaterial: false,
                appName: capture.appName,
                durationMs: capture.durationMs
            ),
            date: date,
            source: source,
            kind: "",
            isMaterial: false,
            isImage: isImage,
            captureID: capture.id
        )
    }

    private static func libraryRow(_ record: OriginalRecord) -> LibraryBrowseRow {
        let source = record.source.rawValue
        let date = CentralTimestamp.parse(record.capturedAt)
        let isImage = LibraryBrowsePresentation.isImage(
            source: source,
            kind: "",
            isMaterial: false,
            durationMs: record.durationMs
        )
        return LibraryBrowseRow(
            id: record.id,
            title: LibraryBrowsePresentation.title(
                source: source,
                textPreview: record.ocrText,
                windowTitle: record.windowTitle,
                appName: record.appName
            ),
            timeLabel: LibraryBrowsePresentation.timeLabel(date),
            sourceLabel: LibraryBrowsePresentation.sourceLabel(
                source: source,
                kind: "",
                isMaterial: false,
                appName: record.appName,
                durationMs: record.durationMs
            ),
            date: date,
            source: source,
            kind: "",
            isMaterial: false,
            isImage: isImage,
            captureID: record.id
        )
    }

    private static func memoryRow(_ record: MemoryRecord) -> MemoryBrowseRow {
        MemoryBrowseRow(
            id: record.id,
            title: record.title,
            statement: record.statement,
            domain: record.domain,
            kind: record.kind
        )
    }
}

private enum LibraryMemoriesError: Error {
    case notConnected
}
