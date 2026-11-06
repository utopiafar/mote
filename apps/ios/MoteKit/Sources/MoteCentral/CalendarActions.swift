import Foundation
import MoteCore

/// The calendar action contract Central already serves to Android and the web.
/// These types only describe received facts; nothing here decides that a
/// calendar write may happen.
public enum CalendarActionKind: String, Codable, Equatable, Sendable {
    case create = "calendar.create"
    case update = "calendar.update"
    case cancel = "calendar.cancel"
    case complete = "calendar.complete"
}

public enum CalendarActionStatus: String, Codable, Equatable, Sendable {
    case proposed
    case dismissed
    case approved
    case executing
    case succeeded
    case uncertain
    case stale
}

public enum CalendarActionResolution: String, Codable, Equatable, Sendable {
    case cancelled
    case completed
}

public enum CalendarOperationStatus: String, Codable, Equatable, Sendable {
    case succeeded
    case uncertain
}

public enum CalendarManagedState: String, Codable, Equatable, Sendable {
    case waitingDevice = "waiting_device"
    case executing
    case cancelRequested = "cancel_requested"
    case cancelled
    case succeeded
    case uncertain
}

public struct CalendarChoice: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String

    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

public struct CalendarActionEvent: Codable, Equatable, Sendable {
    public var title: String
    public var start: String?
    public var end: String?
    public var timeZone: String?
    public var allDay: Bool
    public var location: String
    public var description: String

    public init(title: String, start: String?, end: String?, timeZone: String?, allDay: Bool,
                location: String = "", description: String = "") {
        self.title = title
        self.start = start
        self.end = end
        self.timeZone = timeZone
        self.allDay = allDay
        self.location = location
        self.description = description
    }

    // Central requires explicit nulls in incomplete drafts.
    public func encode(to encoder: Encoder) throws {
        var box = encoder.container(keyedBy: CodingKeys.self)
        try box.encode(title, forKey: .title); try box.encode(start, forKey: .start)
        try box.encode(end, forKey: .end); try box.encode(timeZone, forKey: .timeZone)
        try box.encode(allDay, forKey: .allDay); try box.encode(location, forKey: .location)
        try box.encode(description, forKey: .description)
    }

    public var hasMissingTime: Bool {
        let startBlank = start?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true
        let endBlank = end?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true
        return startBlank || endBlank
    }
}

public struct CalendarActionEvidence: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let quote: String
    public let fingerprint: String?
    public let source: String
    public let capturedAt: String

    public init(id: String, quote: String, fingerprint: String? = nil,
                source: String, capturedAt: String) {
        self.id = id
        self.quote = quote
        self.fingerprint = fingerprint
        self.source = source
        self.capturedAt = capturedAt
    }
}

public struct CalendarActionTargetChoice: Codable, Equatable, Sendable {
    public let deviceId: String
    public let calendarId: String

    public init(deviceId: String, calendarId: String) {
        self.deviceId = deviceId
        self.calendarId = calendarId
    }
}

public struct CalendarActionTarget: Codable, Equatable, Sendable, Identifiable {
    public let deviceId: String
    public let deviceName: String
    public let calendars: [CalendarChoice]
    public let updatedAt: String?

    public var id: String { deviceId }

    public init(deviceId: String, deviceName: String, calendars: [CalendarChoice], updatedAt: String? = nil) {
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.calendars = calendars
        self.updatedAt = updatedAt
    }
}

public struct CalendarActionRelation: Codable, Equatable, Sendable {
    public let actionId: String
    public let version: Int
    public let status: CalendarActionStatus
    public let event: CalendarActionEvent
    public let target: CalendarActionTargetChoice?
    public let externalId: String?
    public let operationId: String?

    public init(actionId: String, version: Int, status: CalendarActionStatus, event: CalendarActionEvent,
                target: CalendarActionTargetChoice? = nil, externalId: String? = nil,
                operationId: String? = nil) {
        self.actionId = actionId
        self.version = version
        self.status = status
        self.event = event
        self.target = target
        self.externalId = externalId
        self.operationId = operationId
    }
}

public struct CalendarManagedAction: Codable, Equatable, Sendable {
    public let state: CalendarManagedState
    public let cancelRequestedAt: String?
    public let grantId: String?
    public let grantRevision: Int?
    public let connectionId: String?

    public init(state: CalendarManagedState, cancelRequestedAt: String? = nil,
                grantId: String? = nil, grantRevision: Int? = nil, connectionId: String? = nil) {
        self.state = state
        self.cancelRequestedAt = cancelRequestedAt
        self.grantId = grantId
        self.grantRevision = grantRevision
        self.connectionId = connectionId
    }
}

public struct CalendarAction: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: CalendarActionKind
    public let version: Int
    public let status: CalendarActionStatus
    public let event: CalendarActionEvent
    public let uncertainty: String
    public let evidence: [CalendarActionEvidence]
    public let createdAt: String
    public let updatedAt: String
    public let resolution: CalendarActionResolution?
    public let target: CalendarActionTargetChoice?
    public let externalId: String?
    public let operationId: String?
    public let related: CalendarActionRelation?
    public let managed: CalendarManagedAction?
    /// Only the claim response can authorize a new native mutation.
    public let mutationAllowed: Bool?
    public let error: String?

    public init(id: String, kind: CalendarActionKind, version: Int, status: CalendarActionStatus,
                event: CalendarActionEvent, uncertainty: String = "", evidence: [CalendarActionEvidence] = [],
                createdAt: String = "", updatedAt: String = "", resolution: CalendarActionResolution? = nil,
                target: CalendarActionTargetChoice? = nil, externalId: String? = nil,
                operationId: String? = nil, related: CalendarActionRelation? = nil,
                managed: CalendarManagedAction? = nil, mutationAllowed: Bool? = nil, error: String? = nil) {
        self.id = id
        self.kind = kind
        self.version = version
        self.status = status
        self.event = event
        self.uncertainty = uncertainty
        self.evidence = evidence
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.resolution = resolution
        self.target = target
        self.externalId = externalId
        self.operationId = operationId
        self.related = related
        self.managed = managed
        self.mutationAllowed = mutationAllowed
        self.error = error
    }
}

public struct CalendarActionPage: Codable, Equatable, Sendable {
    public let items: [CalendarAction]
    public let nextCursor: Int?
    public let targets: [CalendarActionTarget]?

    public init(items: [CalendarAction], nextCursor: Int? = nil, targets: [CalendarActionTarget]? = nil) {
        self.items = items
        self.nextCursor = nextCursor
        self.targets = targets
    }

    public func calendars(for deviceId: String?) -> [CalendarChoice] {
        guard let deviceId else { return [] }
        return targets?.first(where: { $0.deviceId == deviceId })?.calendars ?? []
    }
}

public struct CalendarDeliveriesPage: Codable, Equatable, Sendable {
    public let items: [CalendarAction]

    public init(items: [CalendarAction]) {
        self.items = items
    }
}

public struct CalendarActionConfirmation: Codable, Equatable, Sendable {
    public let version: Int
    public let event: CalendarActionEvent
    public let target: CalendarActionTargetChoice?

    public init(version: Int, event: CalendarActionEvent, target: CalendarActionTargetChoice?) {
        self.version = version
        self.event = event
        self.target = target
    }
}

public struct CalendarActionReceipt: Codable, Equatable, Sendable {
    public let deviceId: String
    public let operationId: String
    public let status: CalendarOperationStatus
    public let externalId: String?

    public init(deviceId: String, operationId: String, status: CalendarOperationStatus,
                externalId: String? = nil) {
        self.deviceId = deviceId
        self.operationId = operationId
        self.status = status
        self.externalId = externalId
    }
}

public struct CalendarTargetRegistration: Codable, Equatable, Sendable {
    public let deviceId: String
    public let deviceName: String
    public let calendars: [CalendarChoice]

    public init(deviceId: String, deviceName: String, calendars: [CalendarChoice]) {
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.calendars = calendars
    }
}

/// Android's CalendarNeeds: only proposals the owner still has to complete,
/// newest first, at most two on the home screen. The calendar page keeps the
/// complete history.
public enum CalendarNeeds {
    public static let shown = 2
    public static let pages = 5

    public static func missingTime(_ actions: [CalendarAction]) -> [CalendarAction] {
        actions.filter { action in
            guard action.status == .proposed, action.resolution == nil,
                  action.kind == .create || action.kind == .update else { return false }
            return action.event.hasMissingTime
        }
    }

    public static func scan(read: (Int) async throws -> CalendarActionPage) async rethrows -> [CalendarAction] {
        var found: [CalendarAction] = []
        var cursor = 0
        for _ in 0..<pages {
            let page = try await read(cursor)
            found += missingTime(page.items)
            if found.count >= shown { return Array(found.prefix(shown)) }
            guard let next = page.nextCursor, next != cursor else { return Array(found.prefix(shown)) }
            cursor = next
        }
        return Array(found.prefix(shown))
    }
}

public enum CalendarActionRuleError: Error, Equatable, Sendable {
    case missingTimeZone, invalidTimeZone, invalidTime, invalidRange, invalidTitle
}

/// Android's CalendarActionRules: the mutation gate, exact time checks, the
/// stable origin marker and all-day/timed conversion.
public enum CalendarActionRules {
    public static func mutationAllowed(_ action: CalendarAction, previous: String?) -> Bool {
        action.mutationAllowed == true && previous == nil
    }

    public static func timeZone(_ event: CalendarActionEvent) throws -> TimeZone {
        guard let value = event.timeZone, !value.isEmpty else { throw CalendarActionRuleError.missingTimeZone }
        guard let zone = TimeZone(identifier: value) else { throw CalendarActionRuleError.invalidTimeZone }
        return zone
    }

    public static func parse(_ value: String, timeZone: String, allDay: Bool) throws -> Date {
        guard let zone = TimeZone(identifier: timeZone) else { throw CalendarActionRuleError.invalidTimeZone }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw CalendarActionRuleError.invalidTime }
        if allDay {
            let formatter = DateFormatter()
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = "yyyy-MM-dd"
            formatter.isLenient = false
            guard let date = formatter.date(from: trimmed),
                  formatter.string(from: date) == trimmed else { throw CalendarActionRuleError.invalidTime }
            return date
        }
        _ = zone
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: trimmed) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: trimmed) { return date }
        throw CalendarActionRuleError.invalidTime
    }

    public static func times(_ event: CalendarActionEvent) throws -> (start: Date, end: Date) {
        guard let timeZone = event.timeZone else { throw CalendarActionRuleError.missingTimeZone }
        guard let startValue = event.start, let endValue = event.end else { throw CalendarActionRuleError.invalidTime }
        let start = try parse(startValue, timeZone: timeZone, allDay: event.allDay)
        let end = try parse(endValue, timeZone: timeZone, allDay: event.allDay)
        let span = end.timeIntervalSince(start)
        guard span > 0, span <= 366 * 86_400 else { throw CalendarActionRuleError.invalidRange }
        let title = event.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.utf16.count <= 200 else { throw CalendarActionRuleError.invalidTitle }
        return (start, end)
    }

    /// A human label only; it never authorizes a write.
    public static func kindLabel(_ kind: CalendarActionKind) -> String {
        switch kind {
        case .create: "添加日程"
        case .update: "更新日程"
        case .cancel: "取消日程"
        case .complete: "标记安排完成"
        }
    }
}

/// Android's CalendarActionPresentation, word for word. Later resolutions and
/// pending cancellation never revert to an earlier successful label.
public enum CalendarActionPresentation {
    public static let homeDetail = "时间待补充"

    public static func stateKey(kind: CalendarActionKind, status: CalendarActionStatus,
                                resolution: CalendarActionResolution? = nil,
                                managedState: CalendarManagedState? = nil) -> String? {
        if managedState == .cancelRequested { return "已请求取消，写入结果仍待核实" }
        if managedState == .cancelled { return "已取消等待执行" }
        if resolution == .cancelled { return "已取消" }
        if resolution == .completed { return "已标记完成" }
        if status == .succeeded {
            switch kind {
            case .create: return "已写入日历"
            case .update: return "已更新日历"
            case .cancel: return "已取消日程"
            case .complete: return "已标记完成"
            }
        }
        if managedState == .waitingDevice && status == .approved { return "等待已授权设备" }
        switch status {
        case .proposed: return "待确认"
        case .approved: return "等待客户端写入"
        case .executing: return "等待保存回执"
        case .uncertain: return "保存结果待核实"
        case .dismissed: return "已忽略"
        case .stale: return "原文已更新或删除"
        case .succeeded: return nil
        }
    }

    public static func stateLabel(_ action: CalendarAction) -> String {
        stateKey(kind: action.kind, status: action.status, resolution: action.resolution,
                 managedState: action.managed?.state) ?? action.status.rawValue
    }
}

/// Android's CalendarDeliveryPolicy: a revoked permission blocks every new
/// write; only an external event id retained from a completed write may be
/// reconciled, so a lost acknowledgement never hides a real event.
public enum CalendarDeliveryPolicy {
    public static func mayExecute(permissionGranted: Bool, retained: String?) -> Bool {
        permissionGranted || (retained != nil && retained != "attempting")
    }
}
