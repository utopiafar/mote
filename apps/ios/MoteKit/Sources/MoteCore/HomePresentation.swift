import Foundation

/// Data already supplied to the home screen. Loading and opening an original
/// remain the responsibility of the feature that owns those operations.
public struct HomeOriginal: Equatable, Sendable, Identifiable {
    public let id: String
    public let deviceId: String
    public let capturedAt: Date
    public let title: String
    public let detail: String
    public let thumbnail: Data?
    public let saved: Bool
    public let archiveOrigin: String?

    public init(
        id: String,
        deviceId: String = "",
        capturedAt: Date,
        title: String,
        detail: String,
        thumbnail: Data? = nil,
        saved: Bool = false,
        archiveOrigin: String? = nil
    ) {
        self.id = id
        self.deviceId = deviceId
        self.capturedAt = capturedAt
        self.title = title
        self.detail = detail
        self.thumbnail = thumbnail
        self.saved = saved
        self.archiveOrigin = archiveOrigin
    }
}

public enum HomeFeed {
    private struct Key: Hashable {
        let scope: String
        let deviceId: String
        let id: String
    }

    public static func merge(local: [HomeOriginal], central: [HomeOriginal], origin: String) -> [HomeOriginal] {
        var rows: [Key: HomeOriginal] = [:]
        var keys: [Key] = []
        for item in local {
            let archiveOrigin = item.archiveOrigin ?? ""
            let scope = archiveOrigin.isEmpty ? "local:\(item.deviceId)" : archiveOrigin
            let key = Key(scope: scope, deviceId: item.deviceId, id: item.id)
            if rows[key] == nil { keys.append(key) }
            rows[key] = item
        }
        for item in central {
            let key = Key(scope: origin, deviceId: item.deviceId, id: item.id)
            if rows[key] == nil { keys.append(key) }
            rows[key] = item
        }
        return keys.compactMap { rows[$0] }
    }

    public static func detail(capturedAt: Date, kind: String, saved: Bool, timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeStyle = .short
        formatter.timeZone = timeZone
        return "\(formatter.string(from: capturedAt)) · \(kind)" + (saved ? " · 已保存" : "")
    }
}

public struct HomeHighlight: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable {
        case schedule
        case discovery
    }

    public let id: String
    public let kind: Kind
    public let title: String
    public let detail: String

    public init(id: String, kind: Kind, title: String, detail: String) {
        self.id = id
        self.kind = kind
        self.title = title
        self.detail = detail
    }
}

public struct HomeDay: Equatable, Sendable, Identifiable {
    public let date: Date
    public let originals: [HomeOriginal]
    public var id: Date { date }
}

public struct HomeNotice: Equatable, Sendable {
    public enum Operation: Equatable, Sendable {
        case connect
        case capture(CaptureStatusOperation)
    }

    public let title: String
    public let actionTitle: String
    public let level: CaptureStatusLevel
    public let operation: Operation
}

/// Projects existing status facts and supplied content into the home layout.
/// It does not read or write the draft, connection, or central data.
public struct HomePresentation: Equatable, Sendable {
    public let notice: HomeNotice?
    public let hasDraft: Bool
    public let highlights: [HomeHighlight]
    public let days: [HomeDay]

    public init(
        facts: CaptureStatusFacts,
        hasDraft: Bool,
        highlights: [HomeHighlight],
        originals: [HomeOriginal],
        calendar: Calendar = .current
    ) {
        self.notice = Self.notice(for: facts)
        self.hasDraft = hasDraft
        self.highlights = highlights

        let ordered = originals.enumerated().sorted {
            if $0.element.capturedAt == $1.element.capturedAt { return $0.offset < $1.offset }
            return $0.element.capturedAt > $1.element.capturedAt
        }.map(\.element)
        var grouped: [HomeDay] = []
        for original in ordered {
            let day = calendar.startOfDay(for: original.capturedAt)
            if let last = grouped.last, last.date == day {
                grouped[grouped.count - 1] = HomeDay(date: day, originals: last.originals + [original])
            } else {
                grouped.append(HomeDay(date: day, originals: [original]))
            }
        }
        self.days = grouped
    }

    private static func notice(for facts: CaptureStatusFacts) -> HomeNotice? {
        let status = CaptureStatusMapping.status(for: facts)
        if facts.connection == .unconfigured && status.level != .needsAction {
            return HomeNotice(title: "连接你的 Mote", actionTitle: "连接", level: .reminder, operation: .connect)
        }
        guard let home = status.home else { return nil }
        let actionTitle: String
        switch home.operation {
        case .resumeCapture, .resumeSend: actionTitle = "恢复"
        case .reconnect: actionTitle = "连接"
        case .restartCapture: actionTitle = "重新开启"
        case .openPermissions, .openStorage, .openSync: actionTitle = "处理"
        }
        return HomeNotice(title: home.titleKey, actionTitle: actionTitle, level: status.level, operation: .capture(home.operation))
    }
}
