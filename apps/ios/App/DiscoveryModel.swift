import Foundation
import MoteCentral
import MoteCore
import MoteStorage
import Observation

/// Reads archived insight history from Central. This is a read-only page:
/// the client lists reports Central already saved and never asks it to
/// generate one.
@MainActor
@Observable
final class DiscoveryModel {
    private(set) var items: [InsightReport] = []
    private(set) var loading = false
    private(set) var connected = false
    private(set) var denied = false
    private(set) var failed = false
    private(set) var canGoBack = false
    private(set) var canGoNext = false

    private var cursors: [String?] = [nil]
    private var nextCursor: String?
    private var generation = 0
    private var loader: ((String?) async throws -> CentralPage<InsightReport>)?
    private var isPreview = false
    private var previewReports: [InsightReport] = []
    private var checksConnection = true

    var previewMode: Bool { isPreview }
    var rows: [InsightReport] { items }
    var state: DiscoveryLoadState {
        if denied { return .denied }
        if failed { return .failed }
        if items.isEmpty { return .empty }
        return .ready
    }

    init() {}

    /// Injected readers for unit tests. Real connection storage is not consulted.
    init(pageLoader: @escaping (String?) async throws -> CentralPage<InsightReport>,
         detailLoader: ((String) async throws -> InsightReport)?) {
        self.loader = pageLoader
        self.checksConnection = false
        self.connected = true
    }

    private init(preview reports: [InsightReport], denied: Bool, failed: Bool, connected: Bool) {
        isPreview = true
        previewReports = reports
        items = reports
        self.connected = connected
        self.denied = denied
        self.failed = failed
    }

    static func live() -> DiscoveryModel {
        let model = DiscoveryModel()
        model.loader = { cursor in
            try await Self.client().insights(limit: 30, cursor: cursor)
        }
        return model
    }

    /// Generated states for visual and interaction checks; they never touch a
    /// profile or Central.
    static func preview(state: String) -> DiscoveryModel {
        switch state {
        case "empty":
            return DiscoveryModel(preview: [], denied: false, failed: false, connected: true)
        case "denied":
            return DiscoveryModel(preview: previewReports(), denied: true, failed: false, connected: true)
        case "error":
            return DiscoveryModel(preview: [], denied: false, failed: true, connected: true)
        case "unconnected":
            return DiscoveryModel(preview: [], denied: false, failed: false, connected: false)
        default:
            return DiscoveryModel(preview: previewReports(), denied: false, failed: false, connected: true)
        }
    }

    func refresh() async { await load() }

    func load() async {
        if isPreview { return }
        if checksConnection {
            guard Self.isConnected() else {
                connected = false
                items = []
                denied = false
                failed = false
                canGoBack = false
                canGoNext = false
                loading = false
                return
            }
        }
        connected = true
        guard let loader else { return }
        generation += 1
        let current = generation
        loading = true
        denied = false
        failed = false
        do {
            let page = try await loader(cursors.last ?? nil)
            guard current == generation else { return }
            items = page.items.filter { InsightPresentation.id($0) != nil }
            nextCursor = page.nextCursor
            canGoBack = cursors.count > 1
            canGoNext = page.nextCursor != nil
        } catch {
            guard current == generation else { return }
            items = []
            nextCursor = nil
            canGoBack = cursors.count > 1
            canGoNext = false
            denied = InsightPresentation.isDenied(error)
            failed = !denied
        }
        loading = false
    }

    func next() async {
        guard !isPreview, let nextCursor else { return }
        cursors.append(nextCursor)
        await load()
    }

    func previous() async {
        guard !isPreview, cursors.count > 1 else { return }
        cursors.removeLast()
        await load()
    }

    func detailModel(for id: String) -> InsightDetailModel {
        if isPreview,
           let report = previewReports.first(where: { $0.runId == id || $0.id == id }) {
            return InsightDetailModel.preview(report)
        }
        return InsightDetailModel.live(id: id)
    }

    private static func isConnected() -> Bool {
        ((try? MoteStorage.connectionStore().read()) ?? nil) != nil
    }

    static func client() throws -> CentralClient {
        guard let connection = (try? MoteStorage.connectionStore().read()) ?? nil else {
            throw DiscoveryError.notConnected
        }
        return try CentralClient(serverUrl: connection.serverUrl, token: connection.token)
    }

    private enum DiscoveryError: Error {
        case notConnected
    }

    static func previewReports() -> [InsightReport] {
        [
            InsightReport(
                id: "generated-insight-heating",
                runId: "generated-insight-heating",
                answer: "这个月的暖气费按实际用量分摊，月底前把账单照片交给室友。[generated-evidence]",
                citations: [
                    Answer.Citation(id: "generated-evidence", capturedAt: "2026-10-28T11:20:00Z",
                                    appName: "信息", excerpt: "和室友的约定",
                                    contentAt: "2026-10-28T11:20:00Z", title: "和室友的约定"),
                ],
                artifact: InsightArtifact(id: "generated-insight-heating", title: "这个月的暖气费约定",
                                          createdAt: "2026-11-05T09:30:00Z"),
                createdAt: "2026-11-05T09:30:00Z"
            ),
            InsightReport(
                id: "generated-insight-week",
                runId: "generated-insight-week",
                answer: "这一周你反复回到两件事：月底的暖气费分摊，和退租押金的收据。两边都在等同一份凭证，建议把账单照片和交接单放在一起存档。[generated-evidence-fee] 另外周三的电话里提到下周要定装修方案，和之前的记录一致。[generated-evidence-call]",
                citations: [
                    Answer.Citation(id: "generated-evidence-fee", capturedAt: "2026-11-05T10:20:00Z",
                                    appName: "生成的记录", excerpt: "暖气费按实际用量分摊，月底前给账单照片",
                                    contentAt: "2026-11-05T10:20:00Z", title: "暖气费按实际用量分摊，月底前给账单照片"),
                    Answer.Citation(id: "generated-evidence-call", capturedAt: "2026-11-04T16:40:00Z",
                                    appName: "生成的录音", excerpt: "和陈老师的电话 12:40",
                                    contentAt: "2026-11-04T16:40:00Z", title: "和陈老师的电话"),
                ],
                artifact: InsightArtifact(id: "generated-insight-week", title: "一周回顾：费用与约定",
                                          createdAt: "2026-11-05T09:30:00Z"),
                createdAt: "2026-11-05T09:30:00Z"
            ),
            InsightReport(
                id: "generated-insight-month",
                runId: "generated-insight-month",
                answer: "这个月有三条线索反复出现：搬家前的清单、给爸妈的体检安排、以及一直没写完的读书笔记。它们都不紧急，但拖得越久越容易忘记当时的决定依据。[generated-evidence-note]",
                citations: [
                    Answer.Citation(id: "generated-evidence-note", capturedAt: "2026-10-28T21:15:00Z",
                                    appName: "生成的记录", excerpt: "读书笔记第三章：注意力的残留",
                                    contentAt: "2026-10-28T21:15:00Z", title: "读书笔记：注意力的残留"),
                ],
                artifact: InsightArtifact(id: "generated-insight-month", title: "这个月的工作线索",
                                          createdAt: "2026-10-31T08:00:00Z"),
                createdAt: "2026-10-31T08:00:00Z"
            ),
            InsightReport(
                id: "generated-insight-old",
                runId: "generated-insight-old",
                answer: "上个月的回顾显示，最常被翻出来的是合同模板和报销单据，建议把它们固定到资料库的固定分类里。[generated-evidence-contract]",
                citations: [
                    Answer.Citation(id: "generated-evidence-contract", capturedAt: "2026-09-30T19:02:00Z",
                                    appName: "生成的文件", excerpt: "租房合同 2026.pdf",
                                    contentAt: "2026-09-30T19:02:00Z", title: "租房合同 2026.pdf"),
                ],
                artifact: InsightArtifact(id: "generated-insight-old", title: nil,
                                          createdAt: "2026-09-30T20:00:00Z"),
                createdAt: "2026-09-30T20:00:00Z"
            ),
        ]
    }
}

/// Reads one archived insight for the read-only detail page.
@MainActor
@Observable
final class InsightDetailModel {
    private(set) var content: InsightDetailContent?
    private(set) var loading = false
    private(set) var unavailable = false
    private(set) var failed = false

    private let id: String
    private var loader: ((String) async throws -> InsightReport)?
    private var isPreview = false

    private init(id: String) {
        self.id = id
    }

    static func live(id: String) -> InsightDetailModel {
        let model = InsightDetailModel(id: id)
        model.loader = { try await DiscoveryModel.client().insight(id: $0) }
        return model
    }

    static func preview(_ report: InsightReport) -> InsightDetailModel {
        let model = InsightDetailModel(id: InsightPresentation.id(report) ?? report.id ?? "preview")
        model.isPreview = true
        model.content = InsightDetailContent.present(report)
        return model
    }

    func load() async {
        if isPreview { return }
        guard let loader else { return }
        loading = true
        unavailable = false
        failed = false
        do {
            let report = try await loader(id)
            guard InsightPresentation.id(report) == id,
                  let content = InsightDetailContent.present(report)
            else {
                unavailable = true
                loading = false
                return
            }
            self.content = content
        } catch {
            if InsightPresentation.isUnavailable(error) {
                unavailable = true
            } else {
                failed = true
            }
        }
        loading = false
    }
}

enum DiscoveryLoadState: Equatable {
    case ready, empty, denied, failed
}
