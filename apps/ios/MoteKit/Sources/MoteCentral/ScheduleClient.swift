import Foundation
import MoteCore

public typealias CalendarEventDraft = CalendarActionEvent

public struct CalendarTodo: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let version: Int
    public let title: String
    public let description: String
    public let dueAt: String?
    public let status: String

    public init(id: String, version: Int, title: String, description: String = "", dueAt: String? = nil, status: String) {
        self.id = id; self.version = version; self.title = title; self.description = description
        self.dueAt = dueAt; self.status = status
    }
}

public enum CalendarActionPolicy {
    public static func homeHighlights(_ items: [CalendarAction]) -> [HomeHighlight] {
        CalendarNeeds.missingTime(items).prefix(CalendarNeeds.shown).map {
            HomeHighlight(id: $0.id, kind: .schedule, title: $0.event.title, detail: CalendarActionPresentation.homeDetail)
        }
    }
    public static func valid(_ event: CalendarEventDraft) -> Bool {
        (try? CalendarActionRules.times(event)) != nil
    }
    /// A date picker cannot express which occurrence of a repeated wall time was intended.
    public static func unambiguous(_ date: Date, zone: String) -> Bool {
        guard let timeZone = TimeZone(identifier: zone) else { return false }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.hour, .minute, .second], from: date)
        guard let hour = parts.hour, let minute = parts.minute, let second = parts.second else { return false }
        let day = calendar.startOfDay(for: date)
        let first = calendar.date(bySettingHour: hour, minute: minute, second: second, of: day,
                                  matchingPolicy: .strict, repeatedTimePolicy: .first, direction: .forward)
        let last = calendar.date(bySettingHour: hour, minute: minute, second: second, of: day,
                                 matchingPolicy: .strict, repeatedTimePolicy: .last, direction: .forward)
        return first != nil && first == last
    }
}

extension CalendarAction {
    public var needsTime: Bool { !CalendarNeeds.missingTime([self]).isEmpty }
    public var canSupplyInformation: Bool {
        status == .proposed && resolution == nil && (kind == .create || kind == .update)
            && (event.start == nil || event.end == nil || event.timeZone == nil)
            && managed == nil && operationId == nil
    }
    public var canConfirmWithoutNativeWrite: Bool {
        status == .proposed && resolution == nil && related != nil && related?.target == nil
            && related?.externalId == nil && kind != .create
    }
    public var statusLabel: String { CalendarActionPresentation.stateLabel(self) }
    public var kindLabel: String { CalendarActionRules.kindLabel(kind) }
}

extension CentralClient {
    public func calendarNeeds() async throws -> [HomeHighlight] {
        let actions = try await CalendarNeeds.scan { cursor in try await calendarActions(cursor: cursor) }
        return CalendarActionPolicy.homeHighlights(actions)
    }
    @discardableResult public func supplyCalendarInformation(_ action: CalendarAction, event: CalendarEventDraft) async throws -> CalendarAction {
        guard let id = UUID(uuidString: action.id), action.canSupplyInformation, CalendarActionPolicy.valid(event),
              let start = event.start, let end = event.end, let zone = event.timeZone,
              action.event.start == nil || action.event.start == start,
              action.event.end == nil || action.event.end == end,
              action.event.timeZone == nil || action.event.timeZone == zone else { throw CentralError.invalidRequest }
        return try await request("POST", "/api/actions/\(id.uuidString.lowercased())/information",
                                 body: ScheduleInformation(version: action.version, start: start, end: end, timeZone: zone))
    }
    @discardableResult public func dismissCalendarAction(_ action: CalendarAction) async throws -> CalendarAction {
        guard UUID(uuidString: action.id) != nil, action.status == .proposed, action.resolution == nil else { throw CentralError.invalidRequest }
        return try await dismissCalendarAction(id: action.id, version: action.version)
    }
    @discardableResult public func confirmCalendarActionWithoutNativeWrite(_ action: CalendarAction) async throws -> CalendarAction {
        guard UUID(uuidString: action.id) != nil, action.canConfirmWithoutNativeWrite,
              action.kind != .update || CalendarActionPolicy.valid(action.event) else { throw CentralError.invalidRequest }
        return try await confirmCalendarAction(id: action.id, request: CalendarActionConfirmation(version: action.version, event: action.event, target: nil))
    }
    public func calendarTodos(cursor: String? = nil) async throws -> CentralPage<CalendarTodo> {
        var query = [URLQueryItem(name: "limit", value: "30")]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("GET", "/api/todos", query: query)
    }
    @discardableResult public func createCalendarTodo(id: UUID, title: String) async throws -> CalendarTodo {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf16.count <= 200 else { throw CentralError.invalidRequest }
        return try await request("POST", "/api/todos", body: ScheduleNewTodo(id: id.uuidString.lowercased(), title: trimmed))
    }
    @discardableResult public func updateCalendarTodo(_ todo: CalendarTodo, status: String) async throws -> CalendarTodo {
        guard let id = UUID(uuidString: todo.id), ["open", "completed", "cancelled"].contains(status) else { throw CentralError.invalidRequest }
        return try await request("PATCH", "/api/todos/\(id.uuidString.lowercased())", body: ScheduleTodoStatus(version: todo.version, status: status))
    }
}
private struct ScheduleInformation: Encodable { let version: Int; let start: String; let end: String; let timeZone: String }
private struct ScheduleNewTodo: Encodable { let id: String; let title: String }
private struct ScheduleTodoStatus: Encodable { let version: Int; let status: String }
