import XCTest
import MoteCentral
import MoteCore

final class InsightPresentationTests: XCTestCase {
    private func citation(_ id: String, title: String? = nil, appName: String = "生成的来源",
                          capturedAt: String = "2026-11-01T02:03:04Z",
                          contentAt: String? = nil) -> Answer.Citation {
        Answer.Citation(id: id, capturedAt: capturedAt, appName: appName, excerpt: "生成的摘录",
                        contentAt: contentAt, title: title)
    }

    private func report(
        id: String? = "run-1",
        runId: String? = "run-1",
        answer: String? = "生成的回答 [evidence-1] 与 [evidence-2]。",
        citations: [Answer.Citation]? = nil,
        title: String? = "生成的报告",
        createdAt: String? = "2026-11-05T01:00:00Z"
    ) -> InsightReport {
        InsightReport(
            id: id,
            runId: runId,
            answer: answer,
            citations: citations ?? [citation("evidence-1"), citation("evidence-2", title: "暖气费记录")],
            artifact: InsightArtifact(id: runId, title: title, createdAt: createdAt),
            createdAt: createdAt
        )
    }

    private func page(_ items: [InsightReport], nextCursor: String? = nil) throws -> CentralPage<InsightReport> {
        let encoded = try items.map { String(decoding: try JSONEncoder().encode($0), as: UTF8.self) }
        let json = """
        {"items":[\(encoded.joined(separator: ","))],"nextCursor":\(nextCursor.map { "\"\($0)\"" } ?? "null")}
        """
        return try JSONDecoder().decode(CentralPage<InsightReport>.self, from: Data(json.utf8))
    }

    func testReportDecodesTheArchivedWireShape() throws {
        let json = #"""
        {"id":"run-9","runId":"run-9","answer":"生成的回答 [e1]。","citations":[{"id":"e1","capturedAt":"2026-10-01T00:00:00Z","appName":"Generated source","excerpt":"Generated excerpt","contentAt":"2026-09-30T23:00:00Z","title":"Generated title"}],"trace":[],"artifact":{"id":"run-9","title":"生成的周回顾","html":"<p>x</p>","createdAt":"2026-10-02T00:00:00Z","skillId":"personal-insight","skillVersion":"1"},"createdAt":"2026-10-02T01:00:00Z"}
        """#
        let report = try JSONDecoder().decode(InsightReport.self, from: Data(json.utf8))
        XCTAssertEqual(report.id, "run-9")
        XCTAssertEqual(report.runId, "run-9")
        XCTAssertEqual(report.citations.first?.contentAt, "2026-09-30T23:00:00Z")
        XCTAssertEqual(report.artifact?.title, "生成的周回顾")
        XCTAssertEqual(report.createdAt, "2026-10-02T01:00:00Z")
    }

    func testValidIDRejectsBlankSeparatorsAndControls() {
        XCTAssertTrue(InsightPresentation.validID("run-1"))
        XCTAssertTrue(InsightPresentation.validID(String(repeating: "a", count: 128)))
        XCTAssertFalse(InsightPresentation.validID(""))
        XCTAssertFalse(InsightPresentation.validID("   "))
        XCTAssertFalse(InsightPresentation.validID("a/b"))
        XCTAssertFalse(InsightPresentation.validID("a\\b"))
        XCTAssertFalse(InsightPresentation.validID("a\nb"))
        XCTAssertFalse(InsightPresentation.validID(String(repeating: "a", count: 129)))
    }

    func testFeaturedPicksFirstCompleteReport() {
        let blank = report(runId: "blank", answer: "   ")
        let noCitations = report(runId: "no-citations", citations: [])
        let badID = report(runId: "bad/id")
        let good = report(runId: "good")
        XCTAssertEqual(InsightPresentation.featured([blank, noCitations, badID, good])?.runId, "good")
        XCTAssertNil(InsightPresentation.featured([blank, noCitations, badID]))
        XCTAssertNil(InsightPresentation.featured([]))
    }

    func testPreviewStripsMarkersCollapsesWhitespaceAndTruncates() {
        let sample = report(answer: "第一行 [evidence-1] 换行\n\n第二行   [evidence-2] 结尾")
        XCTAssertEqual(InsightPresentation.preview(sample), "第一行 换行 第二行 结尾")

        let long = report(answer: String(repeating: "字", count: 200))
        let preview = InsightPresentation.preview(long)
        XCTAssertEqual(preview.count, 126)
        XCTAssertTrue(preview.hasSuffix("…"))
    }

    func testTitleFallsBackToPersonalReview() {
        XCTAssertEqual(InsightPresentation.title(report(title: "生成的报告")), "生成的报告")
        XCTAssertEqual(InsightPresentation.title(report(title: "  ")), "个人回顾")
        XCTAssertEqual(InsightPresentation.title(report(title: nil)), "个人回顾")
    }

    func testAnswerRewritesMarkersToNumberedSources() {
        XCTAssertEqual(
            InsightPresentation.answer(report()),
            "生成的回答 （来源 1） 与 （来源 2）。"
        )
    }

    func testTimestampPrefersArchiveTime() {
        XCTAssertEqual(InsightPresentation.timestamp(report(createdAt: "2026-11-05T01:00:00Z")), "2026-11-05T01:00:00Z")
        let fallback = InsightReport(id: "r", runId: "r", answer: "a", citations: [],
                                     artifact: InsightArtifact(createdAt: "2026-10-01T00:00:00Z"), createdAt: "")
        XCTAssertEqual(InsightPresentation.timestamp(fallback), "2026-10-01T00:00:00Z")
    }

    func testHomeHighlightsOnlyFeaturesOneDiscoveryRow() throws {
        XCTAssertTrue(InsightPresentation.homeHighlights(nil).isEmpty)
        XCTAssertTrue(InsightPresentation.homeHighlights(try page([])).isEmpty)
        XCTAssertTrue(InsightPresentation.homeHighlights(try page([report(answer: "  ")])).isEmpty)

        let highlights = InsightPresentation.homeHighlights(try page([report(runId: "older", answer: "旧的 [evidence-1]")]))
        XCTAssertEqual(highlights.count, 1)
        XCTAssertEqual(highlights.first?.kind, .discovery)
        XCTAssertEqual(highlights.first?.id, "older")
        XCTAssertEqual(highlights.first?.title, "生成的报告")
        XCTAssertTrue(highlights.first?.detail.hasPrefix("发现 · ") == true)
    }

    func testDeniedAndUnavailableClassifyReadFailures() {
        XCTAssertTrue(InsightPresentation.isDenied(CentralError.http(status: 401, code: nil)))
        XCTAssertTrue(InsightPresentation.isDenied(CentralError.http(status: 403, code: nil)))
        XCTAssertFalse(InsightPresentation.isDenied(CentralError.http(status: 404, code: nil)))
        XCTAssertFalse(InsightPresentation.isDenied(CentralError.invalidResponse))
        XCTAssertTrue(InsightPresentation.isUnavailable(CentralError.http(status: 410, code: nil)))
        XCTAssertFalse(InsightPresentation.isUnavailable(CentralError.invalidResponse))
    }

    func testDetailContentMapsTitleMetaAnswerAndCitations() throws {
        let duplicate = citation("evidence-1", title: "重复来源")
        let sample = report(citations: [citation("evidence-1", title: "暖气费记录"), duplicate,
                                        citation("evidence-2", title: nil, appName: "")])
        let content = try XCTUnwrap(InsightDetailContent.present(sample))
        XCTAssertEqual(content.id, "run-1")
        XCTAssertEqual(content.title, "生成的报告")
        XCTAssertTrue(content.meta.hasPrefix("发现 · "))
        XCTAssertTrue(content.meta.hasSuffix("2 份依据"))
        // Source numbers follow the raw citation order, duplicates included,
        // matching the Android detail.
        XCTAssertEqual(content.answer, "生成的回答 （来源 1） 与 （来源 3）。")
        XCTAssertEqual(content.citations.map(\.id), ["evidence-1", "evidence-2"])
        XCTAssertEqual(content.citations.first?.title, "暖气费记录")
        XCTAssertEqual(content.citations.last?.title, "原始记录")
        XCTAssertFalse(content.citations.last?.subtitle.isEmpty ?? true)
    }

    func testDetailContentRequiresAValidIdentity() {
        XCTAssertNil(InsightDetailContent.present(report(runId: "bad/id")))
        XCTAssertNil(InsightDetailContent.present(report(runId: nil)))
    }
}
