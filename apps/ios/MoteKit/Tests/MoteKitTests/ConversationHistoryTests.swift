import Foundation
import MoteCore
import XCTest

final class ConversationHistoryTests: XCTestCase {
    private var calendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(secondsFromGMT: 8 * 60 * 60)!
        value.firstWeekday = 2
        value.minimumDaysInFirstWeek = 4
        return value
    }

    private func date(_ value: String) -> Date { ISO8601DateFormatter().date(from: value)! }

    func testGroupsUseLocalWeekBoundaryAndMostRecentUpdate() {
        let now = date("2026-11-05T04:00:00Z")
        let conversations = [
            HistoryConversation(id: "old", title: "旧", updatedAt: date("2026-11-01T15:59:00Z")),
            HistoryConversation(id: "monday", title: "周一", updatedAt: date("2026-11-01T16:00:00Z")),
            HistoryConversation(id: "today", title: "今天", updatedAt: now),
            HistoryConversation(id: "same-time", title: "同一时间", updatedAt: now),
        ]
        let groups = ConversationHistory.groups(conversations, now: now, calendar: calendar)
        XCTAssertEqual(groups.map(\.kind), [.thisWeek, .earlier])
        XCTAssertEqual(groups.map { $0.conversations.map(\.id) }, [["today", "same-time", "monday"], ["old"]])
        XCTAssertEqual(groups.map(\.kind.title), ["本周", "更早"])
        XCTAssertTrue(ConversationHistory.groups([], now: now, calendar: calendar).isEmpty)
        XCTAssertEqual(ConversationHistory.groups([conversations[0]], now: now, calendar: calendar).map(\.kind), [.earlier])
        let nextWeek = HistoryConversation(id: "next-week", title: "下周", updatedAt: date("2026-11-08T16:00:00Z"))
        XCTAssertEqual(ConversationHistory.groups([nextWeek], now: now, calendar: calendar).map(\.kind), [.earlier])
    }

    func testDateLabelsUseLocalDaysAndWeek() {
        let now = date("2026-11-05T04:00:00Z")
        XCTAssertEqual(ConversationHistory.dateLabel(date("2026-11-04T16:01:00Z"), now: now, calendar: calendar), "今天")
        XCTAssertEqual(ConversationHistory.dateLabel(date("2026-11-04T15:59:00Z"), now: now, calendar: calendar), "昨天")
        XCTAssertEqual(ConversationHistory.dateLabel(date("2026-11-02T04:00:00Z"), now: now, calendar: calendar), "周一")
        XCTAssertEqual(ConversationHistory.dateLabel(date("2026-10-21T04:00:00Z"), now: now, calendar: calendar), "10月21日")
    }
}
