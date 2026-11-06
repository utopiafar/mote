import Foundation

/// The five catalogue categories from the library design. They are display
/// filters over the owner's existing reads; they never classify or write data.
public enum LibraryBrowseCategory: String, CaseIterable, Identifiable, Sendable {
    case all
    case records
    case images
    case notifications
    case files

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .all: "全部"
        case .records: "记录"
        case .images: "截图与照片"
        case .notifications: "通知"
        case .files: "网页与文件"
        }
    }

    public func matches(_ row: LibraryBrowseRow) -> Bool {
        switch self {
        case .all:
            true
        case .records:
            row.source == "note" || row.kind == "mote.note"
        case .images:
            row.isImage
        case .notifications:
            row.source == "notification"
        case .files:
            !row.isImage && (row.source == "file" || row.source == "ui_page" || row.isMaterial)
        }
    }
}

/// One row of the 资料 list. The server owns search and pagination; this value
/// only carries what the page displays.
public struct LibraryBrowseRow: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let timeLabel: String
    public let sourceLabel: String
    public let date: Date?
    public let source: String
    public let kind: String
    public let isMaterial: Bool
    public let isImage: Bool
    public let captureID: String?

    public init(
        id: String,
        title: String,
        timeLabel: String,
        sourceLabel: String,
        date: Date?,
        source: String,
        kind: String,
        isMaterial: Bool,
        isImage: Bool,
        captureID: String? = nil
    ) {
        self.id = id
        self.title = title
        self.timeLabel = timeLabel
        self.sourceLabel = sourceLabel
        self.date = date
        self.source = source
        self.kind = kind
        self.isMaterial = isMaterial
        self.isImage = isImage
        self.captureID = captureID
    }

    public var meta: String {
        timeLabel.isEmpty ? sourceLabel : timeLabel + " · " + sourceLabel
    }
}

public struct LibraryBrowseDayGroup: Identifiable, Equatable, Sendable {
    public let label: String
    public let rows: [LibraryBrowseRow]

    public var id: String { label }

    public init(label: String, rows: [LibraryBrowseRow]) {
        self.label = label
        self.rows = rows
    }
}

/// Pure display rules for the 资料 list, shared by the live page and the
/// generated preview states.
public enum LibraryBrowsePresentation {
    public static func title(
        source: String,
        textPreview: String,
        windowTitle: String,
        appName: String,
        materialTitle: String? = nil
    ) -> String {
        if let materialTitle, !materialTitle.isEmpty { return materialTitle }
        let preview = firstLine(textPreview)
        let window = windowTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        switch source {
        case "note", "notification", "device_event":
            return firstNonEmpty([preview, window, appName])
        default:
            return firstNonEmpty([window, preview, appName])
        }
    }

    public static func sourceLabel(
        source: String,
        kind: String,
        isMaterial: Bool,
        appName: String,
        durationMs: Int
    ) -> String {
        if isMaterial {
            switch kind {
            case "mote.note": return "记录"
            case "mote.file": return "文件"
            case "mote.ui-page-object": return "网页"
            case "mote.screen-segment": return "截图"
            case "mote.coding-session": return "Coding 会话"
            case "mote.message": return "消息"
            case "mote.calendar": return "日历"
            default: return kind.contains("image") ? "照片" : "资料"
            }
        }
        switch source {
        case "note": return "记录"
        case "screen": return "截图"
        case "notification": return "通知"
        case "file": return "文件"
        case "ui_page": return appName.isEmpty ? "网页" : appName
        case "media": return durationMs > 0 ? "录音 " + durationLabel(durationMs) : "照片"
        case "device_event": return "设备事件"
        case "activity": return "活动"
        case "calendar": return "日历"
        case "message": return "消息"
        case "metric": return "指标"
        case "memory": return "记忆"
        default: return appName.isEmpty ? "记录" : appName
        }
    }

    public static func isImage(source: String, kind: String, isMaterial: Bool, durationMs: Int) -> Bool {
        if isMaterial { return kind.contains("image") }
        return source == "screen" || source == "media" && durationMs == 0
    }

    public static func timeLabel(_ date: Date?, calendar: Calendar = .current) -> String {
        guard let date else { return "" }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }

    public static func durationLabel(_ milliseconds: Int) -> String {
        let total = max(0, milliseconds / 1000)
        let hours = total / 3600
        let minutes = total % 3600 / 60
        let seconds = total % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }
        return String(format: "%02d:%02d", minutes, seconds)
    }

    /// Keeps the server order inside a day, sorts days newest first, and uses
    /// the same 今天 / 昨天 / date labels as the rest of the timeline.
    public static func groups(
        _ rows: [LibraryBrowseRow],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [LibraryBrowseDayGroup] {
        let ordered = rows.enumerated().sorted { lhs, rhs in
            switch (lhs.element.date, rhs.element.date) {
            case let (left?, right?) where left != right:
                return left > right
            default:
                return lhs.offset < rhs.offset
            }
        }.map(\.element)
        var groups: [LibraryBrowseDayGroup] = []
        var indexByStart: [Date: Int] = [:]
        for row in ordered {
            let key = row.date.map { calendar.startOfDay(for: $0) } ?? .distantPast
            let label = row.date.map { ConversationHistory.dateLabel($0, now: now, calendar: calendar) } ?? "资料"
            if let index = indexByStart[key] {
                let existing = groups[index]
                groups[index] = LibraryBrowseDayGroup(label: existing.label, rows: existing.rows + [row])
            } else {
                indexByStart[key] = groups.count
                groups.append(LibraryBrowseDayGroup(label: label, rows: [row]))
            }
        }
        return groups
    }

    private static func firstLine(_ value: String) -> String {
        value.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
    }

    private static func firstNonEmpty(_ values: [String]) -> String {
        values.first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? ""
    }
}

/// The three memory filters from the design. Personal and event use the same
/// context-tree nodes as Android; all reads remain the existing memory reads.
public enum MemoryBrowseCategory: String, CaseIterable, Identifiable, Sendable {
    case all
    case personal
    case events

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .all: "全部记忆"
        case .personal: "个人记忆"
        case .events: "事件记忆"
        }
    }

    public var treeID: String? {
        switch self {
        case .all: nil
        case .personal: "topics"
        case .events: "knowledge"
        }
    }

    public var nodeID: String? {
        switch self {
        case .all: nil
        case .personal: "personal"
        case .events: "episodic"
        }
    }

    /// Falls back to all memories when the server catalog no longer contains
    /// the node, instead of sending a request that must fail.
    public func resolved(treeIDs: [String: Set<String>]) -> MemoryBrowseCategory {
        guard let treeID, let nodeID, treeIDs[treeID]?.contains(nodeID) == true else { return .all }
        return self
    }
}

public struct MemoryBrowseRow: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let statement: String
    public let domain: String
    public let kind: String

    public init(id: String, title: String, statement: String, domain: String = "personal", kind: String = "episodic") {
        self.id = id
        self.title = title
        self.statement = statement
        self.domain = domain
        self.kind = kind
    }

    public func matches(_ category: MemoryBrowseCategory) -> Bool {
        switch category {
        case .all: true
        case .personal: domain == "personal"
        case .events: kind == "episodic"
        }
    }
}

/// Literal search terms are highlights only; they never become a memory
/// classification. Matching mirrors the Android highlighter.
public enum MemorySearchHighlight {
    public static func ranges(in text: String, query: String) -> [Range<String.Index>] {
        let terms = query.split(whereSeparator: \.isWhitespace).map(String.init)
            .filter { !$0.isEmpty }
            .prefix(12)
        guard !terms.isEmpty else { return [] }
        var found: [Range<String.Index>] = []
        for term in terms {
            var searchRange = text.startIndex..<text.endIndex
            while let range = text.range(
                of: term,
                options: [.caseInsensitive, .diacriticInsensitive],
                range: searchRange
            ) {
                found.append(range)
                if range.upperBound == text.endIndex { break }
                searchRange = range.upperBound..<text.endIndex
            }
        }
        let ordered = found.sorted {
            $0.lowerBound < $1.lowerBound || ($0.lowerBound == $1.lowerBound && $0.upperBound < $1.upperBound)
        }
        var merged: [Range<String.Index>] = []
        for range in ordered {
            if let last = merged.last, range.lowerBound <= last.upperBound {
                merged[merged.count - 1] = last.lowerBound..<max(last.upperBound, range.upperBound)
            } else {
                merged.append(range)
            }
        }
        return merged
    }

    public static func matches(_ text: String, query: String) -> Bool {
        !ranges(in: text, query: query).isEmpty
    }
}
