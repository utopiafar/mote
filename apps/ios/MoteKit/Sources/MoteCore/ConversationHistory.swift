import Foundation

public struct HistoryConversation: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let updatedAt: Date

    public init(id: String, title: String, updatedAt: Date) {
        self.id = id
        self.title = title
        self.updatedAt = updatedAt
    }
}

public struct ConversationHistoryGroup: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case thisWeek, earlier

        public var title: String { self == .thisWeek ? "本周" : "更早" }
    }

    public let kind: Kind
    public let conversations: [HistoryConversation]
    public var id: Kind { kind }
}

/// Groups by the owner's calendar week and keeps the most recently updated first.
public enum ConversationHistory {
    public static func groups(_ conversations: [HistoryConversation], now: Date = Date(),
                              calendar: Calendar = .current) -> [ConversationHistoryGroup] {
        let week = calendar.dateInterval(of: .weekOfYear, for: now)
        let ordered = conversations.enumerated().sorted {
            $0.element.updatedAt == $1.element.updatedAt
                ? $0.offset < $1.offset
                : $0.element.updatedAt > $1.element.updatedAt
        }.map(\.element)
        let current = ordered.filter { contains($0.updatedAt, in: week) }
        let earlier = ordered.filter { !contains($0.updatedAt, in: week) }
        return [(ConversationHistoryGroup.Kind.thisWeek, current), (.earlier, earlier)]
            .filter { !$0.1.isEmpty }
            .map { ConversationHistoryGroup(kind: $0.0, conversations: $0.1) }
    }

    public static func dateLabel(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return "今天" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) { return "昨天" }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = contains(date, in: calendar.dateInterval(of: .weekOfYear, for: now))
            ? "EEE" : "M月d日"
        return formatter.string(from: date)
    }

    private static func contains(_ date: Date, in interval: DateInterval?) -> Bool {
        guard let interval else { return false }
        return date >= interval.start && date < interval.end
    }
}
