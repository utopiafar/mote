import XCTest
import MoteCentral
import MoteStorage
@testable import Mote

@MainActor
final class DiscoveryHomeTests: XCTestCase {
    private let connection = StoredConnection(
        serverUrl: "http://127.0.0.1:3030",
        token: "generated-owner-token",
        credentialId: "generated-credential",
        scope: "owner",
        deviceName: "生成的 iPhone"
    )

    private func localState(connected: Bool = true) -> HomeLocalState {
        HomeLocalState(connection: connected ? connection : nil, hasDraft: false, pendingCount: 0)
    }

    private func report(id: String = "generated-insight",
                        title: String = "这个月的暖气费约定",
                        answer: String = "约定的内容。[generated-evidence]",
                        citations: [Answer.Citation] = [
                            Answer.Citation(id: "generated-evidence", capturedAt: "2026-10-28T11:20:00Z",
                                            appName: "信息", excerpt: "生成的摘录", title: "和室友的约定")
                        ],
                        createdAt: String? = "2026-11-05T09:30:00Z") -> InsightReport {
        InsightReport(
            runId: id,
            answer: answer,
            citations: citations,
            artifact: InsightArtifact(id: id, title: title, createdAt: createdAt),
            createdAt: createdAt
        )
    }

    private func model(insights: @escaping HomeModel.InsightLoader) -> HomeModel {
        HomeModel(
            localState: { self.localState() },
            insightLoader: insights,
            originalsLoader: { _ in [] }
        )
    }

    func testReadableArchiveFillsTheSameSingleHomeDiscoveryRow() async {
        let model = model { _ in [self.report()] }
        await model.refresh()

        XCTAssertEqual(model.presentation.highlights.count, 1)
        let highlight = model.presentation.highlights[0]
        XCTAssertEqual(highlight.kind, .discovery)
        XCTAssertEqual(highlight.id, "generated-insight")
        XCTAssertEqual(highlight.title, "这个月的暖气费约定")
        XCTAssertEqual(highlight.detail, "发现 · 2026年11月5日")
    }

    func testUnavailableInsightCapabilityLeavesNoDiscoveryBlock() async {
        let model = model { _ in throw CentralError.http(status: 503, code: "feature_unavailable") }
        await model.refresh()

        XCTAssertTrue(model.presentation.highlights.isEmpty)
    }

    func testRevokedReadClearsDiscoveryWithoutKeepingOldData() async {
        let box = InsightResultBox()
        let model = model { _ in try box.result.get() }
        box.result = .success([self.report()])
        await model.refresh()
        XCTAssertEqual(model.presentation.highlights.map(\.id), ["generated-insight"])

        box.result = .failure(CentralError.http(status: 403, code: nil))
        await model.refresh()
        XCTAssertTrue(model.presentation.highlights.isEmpty)
    }

    func testDisconnectedHomeNeverReadsOrShowsDiscovery() async {
        var reads = 0
        let model = HomeModel(
            localState: { self.localState(connected: false) },
            insightLoader: { _ in
                reads += 1
                return [self.report()]
            },
            originalsLoader: { _ in [] }
        )
        await model.refresh()

        XCTAssertEqual(reads, 0)
        XCTAssertTrue(model.presentation.highlights.isEmpty)
    }

    func testArchiveWithoutACitedAnswerStaysOffTheHome() async {
        let model = model { _ in [self.report(citations: [])] }
        await model.refresh()

        XCTAssertTrue(model.presentation.highlights.isEmpty)
    }

    func testDiscoveryHighlightRoutesToHistoryInsteadOfThePlaceholder() {
        let router = HomeRouter()
        router.open(.highlight(.discovery, "generated-insight"))

        XCTAssertEqual(router.destination, .discovery)
        XCTAssertEqual(router.destination?.title, "发现历史")
    }

    func testDiscoveryPageKeepsDeniedAndEmptyReadsApart() async {
        let denied = DiscoveryModel(pageLoader: { _ in
            throw CentralError.http(status: 403, code: nil)
        }, detailLoader: nil)
        await denied.refresh()
        XCTAssertEqual(denied.state, .denied)
        XCTAssertTrue(denied.rows.isEmpty)

        let empty = DiscoveryModel(pageLoader: { _ in
            CentralPage(items: [], nextCursor: nil, totalCount: nil)
        }, detailLoader: nil)
        await empty.refresh()
        XCTAssertEqual(empty.state, .empty)
        XCTAssertTrue(empty.rows.isEmpty)
    }
}

@MainActor
private final class InsightResultBox {
    var result: Result<[InsightReport], Error> = .success([])
}
