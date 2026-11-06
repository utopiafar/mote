import Foundation
import MoteCentral
import XCTest

final class ConversationPresentationTests: XCTestCase {
    private func turn(answer: String, citations: [(id: String, title: String?, location: String?)],
                      extra: String = "") throws -> ConversationTurn {
        let citationJSON = citations.map { citation -> String in
            """
            {"id":"\(citation.id)","capturedAt":"2026-11-05T06:20:00Z","appName":"备忘录",
             "excerpt":"摘录","contentAt":null,"title":\(citation.title.map { "\"\($0)\"" } ?? "null"),
             "location":\(citation.location.map { "\"\($0)\"" } ?? "null")}
            """
        }.joined(separator: ",")
        return try JSONDecoder().decode(ConversationTurn.self, from: Data("""
        {"id":"t1","question":"q","scope":{},
         "result":{"answer":"\(answer)","runId":"r","citations":[\(citationJSON)],"trace":[],"createdAt":null,"id":null},
         "status":"completed","error":null,"createdAt":"2026-11-05T06:00:00Z"\(extra)}
        """.utf8))
    }

    func testCitationNumbersAccumulateAcrossTurnsInFirstAppearanceOrder() throws {
        let first = try turn(answer: "a", citations: [("ev_1", nil, nil), ("ev_2", nil, nil)])
        let second = try turn(answer: "b", citations: [("ev_2", nil, nil), ("ev_3", nil, nil)])
        let numbers = ConversationPresentation.citationNumbers(turns: [first, second])
        XCTAssertEqual(numbers, ["ev_1": 1, "ev_2": 2, "ev_3": 3])
    }

    func testFormatAnswerReplacesVerifiedMarkersWithTheirNumbers() throws {
        let display = ConversationPresentation.formatAnswer(
            "按实际用量分摊[ev_1]，月底前给账单照片[ev_1]；押金需要收据[ev_2]。",
            numbers: ["ev_1": 1, "ev_2": 2])
        XCTAssertEqual(display.text, "按实际用量分摊\u{2009}1\u{2009}，月底前给账单照片\u{2009}1\u{2009}；押金需要收据\u{2009}2\u{2009}。")
        XCTAssertEqual(display.citations.map(\.number), [1, 1, 2])
        XCTAssertEqual(display.citations.map(\.id), ["ev_1", "ev_1", "ev_2"])
    }

    func testQuotedAnswerKeepsReadableProseWithoutCitationChips() throws {
        let quote = ConversationPresentation.quotedAnswer(
            "按实际用量分摊[ev_1]，月底前给账单照片[ev_1]；押金需要收据[ev_2]。",
            numbers: ["ev_1": 1, "ev_2": 2])
        XCTAssertEqual(quote, "按实际用量分摊，月底前给账单照片；押金需要收据。")
    }

    func testFormatAnswerLeavesUnknownMarkersAndProtectedRangesAlone() throws {
        let display = ConversationPresentation.formatAnswer(
            "未见引用[other]，代码 `[ev_1]`，链接 [ev_1](https://x)，图片 ![ev_1]，定义\n[ev_1]: https://x",
            numbers: ["ev_1": 1])
        XCTAssertTrue(display.text.contains("[other]"))
        XCTAssertTrue(display.text.contains("`[ev_1]`"))
        XCTAssertTrue(display.text.contains("[ev_1](https://x)"))
        XCTAssertTrue(display.text.contains("![ev_1]"))
        XCTAssertTrue(display.text.contains("[ev_1]: https://x"))
        XCTAssertTrue(display.citations.isEmpty)
    }

    func testFormatAnswerStripsEmphasisAndLineMarksOutsideCode() throws {
        let display = ConversationPresentation.formatAnswer(
            "## 结论\n- **重点** 与 *细节*\n> 引用\n```\n**保留**\n```",
            numbers: [:])
        XCTAssertEqual(display.text, "结论\n• 重点 与 细节\n引用\n```\n**保留**\n```")
        XCTAssertEqual(display.emphasis, [
            .init(start: 5, end: 7, bold: true),
            .init(start: 10, end: 12, bold: false),
        ])
    }

    func testNewCitationsOnlyCardTheFirstAppearance() throws {
        let first = try turn(answer: "a", citations: [("ev_1", nil, nil), ("ev_1", nil, nil)])
        let second = try turn(answer: "b", citations: [("ev_1", nil, nil), ("ev_2", nil, nil)])
        var shown = Set<String>()
        XCTAssertEqual(ConversationPresentation.newCitations(turn: first, shown: &shown).map(\.id), ["ev_1"])
        XCTAssertEqual(ConversationPresentation.newCitations(turn: second, shown: &shown).map(\.id), ["ev_2"])
    }

    func testCitationCardsUseStoredTitleAndLocationThenFallback() throws {
        let named = try turn(answer: "a", citations: [("ev_1", "租房合同 2026.pdf", "第 4 页")]).result!.citations[0]
        XCTAssertEqual(ConversationPresentation.citationName(named), "租房合同 2026.pdf")
        XCTAssertEqual(ConversationPresentation.citationSubtitle(named), "第 4 页")
        let plain = try turn(answer: "a", citations: [("ev_1", nil, nil)]).result!.citations[0]
        XCTAssertEqual(ConversationPresentation.citationName(plain), "备忘录")
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 8 * 60 * 60)!
        let subtitle = ConversationPresentation.citationSubtitle(
            plain, now: ISO8601DateFormatter().date(from: "2026-11-05T07:00:00Z")!, calendar: calendar)
        XCTAssertEqual(subtitle, "记录 · 今天 14:20")
    }

    func testTurnNoticesFollowTheSharedOrdering() throws {
        let deleted = try turn(answer: "a", citations: [], extra: ",\"evidenceDeleted\":true")
        XCTAssertEqual(ConversationPresentation.turnNotice(deleted),
                       "相关证据已删除，这条历史回答已清除。可以继续提问查阅现有记录。")
        let unavailable = try turn(answer: "a", citations: [], extra: ",\"evidenceUnavailable\":true")
        XCTAssertEqual(ConversationPresentation.turnNotice(unavailable), "引用原文已删除，历史问答仍保留。")
        let stale = try turn(answer: "a", citations: [], extra: ",\"evidenceStale\":true")
        XCTAssertEqual(ConversationPresentation.turnNotice(stale), "这是历史版本，当前资料已更新。")
        let plain = try turn(answer: "a", citations: [])
        XCTAssertNil(ConversationPresentation.turnNotice(plain))
    }

    func testScopeLabelsFollowTheAnchorKind() {
        XCTAssertEqual(ConversationPresentation.scopeLabel(
            scope: ConversationScope(anchorMaterialRef: "material:mat_x@y"), materialTitle: "租房合同 2026.pdf"),
            "租房合同 2026.pdf")
        XCTAssertEqual(ConversationPresentation.scopeLabel(
            scope: ConversationScope(anchorMaterialRef: "material:mat_x@y"), materialTitle: nil), "参考整份资料")
        XCTAssertEqual(ConversationPresentation.scopeLabel(
            scope: ConversationScope(anchorEvidenceIds: ["ev_1"]), materialTitle: nil),
            "参考这条记录，自动查找相关上下文")
        XCTAssertEqual(ConversationPresentation.scopeLabel(
            scope: ConversationScope(anchorEvidenceIds: ["ev_1"]), materialTitle: "暖气费按实际用量分摊"),
            "暖气费按实际用量分摊")
        XCTAssertEqual(ConversationPresentation.scopeLabel(
            scope: ConversationScope(evidenceIds: ["ev_1"]), materialTitle: nil), "仅查这条记录")
        XCTAssertNil(ConversationPresentation.scopeLabel(scope: ConversationScope(), materialTitle: nil))
    }
}
