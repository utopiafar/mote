import Foundation
import MoteCore
import SwiftUI

/// Generated history for the simulator's visual and interaction tests.
struct ConversationHistoryPreview: View {
    @State private var lastAction = "none"
    @State private var model: ConversationHistoryModel
    private let state: String
    private let now = ISO8601DateFormatter().date(from: "2026-11-05T04:00:00Z")!
    private let calendar: Calendar = {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(secondsFromGMT: 8 * 60 * 60)!
        value.firstWeekday = 2
        value.minimumDaysInFirstWeek = 4
        return value
    }()

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let state = arguments.firstIndex(of: "-MoteHistoryState").flatMap {
            arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil
        } ?? "list"
        self.state = state
        let fixture = HistoryPreviewFixture(empty: state == "empty", fails: state == "deleteFailure")
        self._model = State(initialValue: ConversationHistoryModel { _ in
            HistoryPage(conversations: fixture.conversations, nextCursor: nil)
        } remove: { id in
            try fixture.remove(id)
        })
    }

    var body: some View {
        ConversationHistoryView(
            model: model, now: now, calendar: calendar,
            onBack: { lastAction = "back" },
            onOpen: { lastAction = "open.\($0)" },
            onSend: { lastAction = "send.\($0)" },
            onAddImage: { lastAction = "image" },
            initialQuestion: state == "typing" ? "牛肋排烤到几度出炉" : "",
            previewFocused: state == "typing"
        )
        .overlay(alignment: .topLeading) {
            Text(lastAction)
                .font(.system(size: 1))
                .opacity(0.01)
                .frame(width: 1, height: 1)
                .accessibilityIdentifier("history-preview-action")
        }
    }
}

@MainActor
private final class HistoryPreviewFixture {
    private(set) var conversations: [HistoryConversation]
    private let fails: Bool

    init(empty: Bool, fails: Bool) {
        self.fails = fails
        let formatter = ISO8601DateFormatter()
        let rows = [
            ("one", "暖气费是怎么约定的？", "2026-11-05T04:00:00Z"),
            ("two", "上周和陈老师聊了什么？", "2026-11-04T04:00:00Z"),
            ("three", "牛肋排低温烤几个小时？", "2026-11-02T04:00:00Z"),
            ("four", "合同里押金怎么退？", "2026-10-21T04:00:00Z"),
            ("five", "九月去过的几家书店叫什么？", "2026-10-09T04:00:00Z"),
            ("six", "我什么时候开始用快捷指令的？", "2026-10-03T04:00:00Z"),
            ("seven", "上次体检提到的注意事项", "2026-09-30T04:00:00Z"),
        ]
        conversations = empty ? [] : rows.map {
            HistoryConversation(id: $0.0, title: $0.1, updatedAt: formatter.date(from: $0.2)!)
        }
    }

    func remove(_ id: String) throws {
        if fails { throw PreviewError.offline }
        conversations.removeAll { $0.id == id }
    }

    private enum PreviewError: Error { case offline }
}
