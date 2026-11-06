import EventKit
import Foundation
import MoteCentral
import MoteCore
import MoteStorage
import Observation

@MainActor
@Observable
final class ScheduleModel {
    private(set) var actions: [CalendarAction] = []
    private(set) var todos: [CalendarTodo] = []
    private(set) var actionCursor: Int?
    private(set) var todoCursor: String?
    private(set) var loading = false
    private(set) var contextVersion = 0
    var message: String?
    private let fixture: Bool
    private let connectionProvider: () -> StoredConnection?
    private let session: URLSession
    private var identity: StoredConnection?
    private var generation = 0
    private var pendingTodo: (title: String, id: UUID)?

    init(fixture: String? = nil,
         connectionProvider: @escaping () -> StoredConnection? = { (try? MoteStorage.connectionStore().read()) ?? nil },
         session: URLSession = .shared) {
        self.fixture = fixture != nil
        self.connectionProvider = connectionProvider
        self.session = session
        if fixture == "list" || fixture == "home" {
            actions = Self.decode([CalendarAction].self, Self.actionJSON)
            todos = Self.decode([CalendarTodo].self, Self.todoJSON)
        }
    }

    private func currentConnection() -> StoredConnection? {
        connectionProvider()
    }
    private func client(_ connection: StoredConnection?) throws -> CentralClient {
        guard let connection else { throw CentralError.invalidEndpoint }
        return try CentralClient(serverUrl: connection.serverUrl, token: connection.token, session: session)
    }
    private func isCurrent(_ expected: StoredConnection?, _ stamp: Int) -> Bool {
        guard generation == stamp else { return false }
        guard currentConnection() == expected else {
            generation += 1; contextVersion += 1; identity = nil; actions = []; todos = []
            actionCursor = nil; todoCursor = nil; loading = false; message = "连接你的 Mote"
            return false
        }
        return true
    }

    func refresh() async {
        guard !fixture else { return }
        generation += 1
        let stamp = generation, connection = currentConnection()
        if connection != identity {
            contextVersion += 1
            identity = connection
            pendingTodo = nil
            actions = []; todos = []; actionCursor = nil; todoCursor = nil
        }
        guard connection != nil, let client = try? client(connection) else { loading = false; message = "连接你的 Mote"; return }
        loading = true; message = nil
        do {
            let page = try await client.calendarActions()
            guard isCurrent(connection, stamp) else { return }
            actions = page.items; actionCursor = page.nextCursor
        } catch {
            guard isCurrent(connection, stamp) else { return }
            if case CentralError.http(let status, _) = error, status == 401 || status == 403 {
                contextVersion += 1; actions = []; actionCursor = nil
            }
            message = "这条日程暂不可用。"
        }
        do {
            let page = try await client.calendarTodos()
            guard isCurrent(connection, stamp) else { return }
            todos = page.items; todoCursor = page.nextCursor
        } catch {
            guard isCurrent(connection, stamp) else { return }
            if case CentralError.http(let status, _) = error, status == 401 || status == 403 {
                contextVersion += 1; todos = []; todoCursor = nil; pendingTodo = nil
            }
            message = "操作失败"
        }
        if isCurrent(connection, stamp) { loading = false }
    }

    func moreActions() async {
        let expected = identity, stamp = generation
        guard !fixture, let cursor = actionCursor, isCurrent(expected, stamp), let client = try? client(expected) else { return }
        do {
            let page = try await client.calendarActions(cursor: cursor)
            guard isCurrent(expected, stamp) else { return }
            actions += page.items; actionCursor = page.nextCursor == cursor ? nil : page.nextCursor
        } catch {
            guard isCurrent(expected, stamp) else { return }
            if accessDenied(error) { contextVersion += 1; actions = []; actionCursor = nil }
            message = "操作失败"
        }
    }
    func moreTodos() async {
        let expected = identity, stamp = generation
        guard !fixture, let cursor = todoCursor, isCurrent(expected, stamp), let client = try? client(expected) else { return }
        do {
            let page = try await client.calendarTodos(cursor: cursor)
            guard isCurrent(expected, stamp) else { return }
            todos += page.items; todoCursor = page.nextCursor == cursor ? nil : page.nextCursor
        } catch {
            guard isCurrent(expected, stamp) else { return }
            if accessDenied(error) { contextVersion += 1; todos = []; todoCursor = nil; pendingTodo = nil }
            message = "操作失败"
        }
    }
    private func accessDenied(_ error: Error) -> Bool {
        if case CentralError.http(let status, _) = error { return status == 401 || status == 403 }
        return false
    }
    func dismiss(_ action: CalendarAction, context: Int) async -> Bool {
        guard context == contextVersion else { return false }
        if fixture { replace(action, status: .dismissed); return true }
        return await change(context: context) { client in _ = try await client.dismissCalendarAction(action) }
    }
    func supply(_ action: CalendarAction, event: CalendarEventDraft, context: Int) async -> Bool {
        guard context == contextVersion else { return false }
        guard CalendarActionPolicy.valid(event), let zone = event.timeZone else { message = "开始、结束时间或时区无效"; return false }
        if !event.allDay {
            for (original, value) in [(action.event.start, event.start), (action.event.end, event.end)] where original == nil {
                guard let value, let date = try? CalendarActionRules.parse(value, timeZone: zone, allDay: false),
                      CalendarActionPolicy.unambiguous(date, zone: zone) else {
                    message = "开始、结束时间或时区无效"; return false
                }
            }
        }
        if fixture { replace(action, event: event); return true }
        return await change(context: context) { client in _ = try await client.supplyCalendarInformation(action, event: event) }
    }
    func confirm(_ action: CalendarAction, context: Int) async -> Bool {
        guard context == contextVersion else { return false }
        if fixture { replace(action, status: .succeeded); return true }
        return await change(context: context) { client in _ = try await client.confirmCalendarActionWithoutNativeWrite(action) }
    }
    func addTodo(_ title: String, context: Int) async -> Bool {
        guard context == contextVersion else { return false }
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.utf16.count <= 200 else {
            message = "待办标题"; return false
        }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if fixture {
            todos.insert(CalendarTodo(id: UUID().uuidString.lowercased(), version: 1, title: trimmed, status: "open"), at: 0)
            return true
        }
        let id = pendingTodo?.title == trimmed ? pendingTodo!.id : UUID()
        pendingTodo = (trimmed, id)
        let success = await change(context: context) { client in _ = try await client.createCalendarTodo(id: id, title: trimmed) }
        if success { pendingTodo = nil }
        return success
    }
    func setTodo(_ todo: CalendarTodo, status: String, context: Int) async {
        guard context == contextVersion else { return }
        if fixture {
            if let index = todos.firstIndex(where: { $0.id == todo.id }) {
                todos[index] = CalendarTodo(id: todo.id, version: todo.version + 1, title: todo.title,
                                            description: todo.description, dueAt: todo.dueAt, status: status)
            }
            return
        }
        await change(context: context) { client in _ = try await client.updateCalendarTodo(todo, status: status) }
    }
    private func replace(_ action: CalendarAction, status: CalendarActionStatus? = nil, event: CalendarEventDraft? = nil) {
        guard let index = actions.firstIndex(where: { $0.id == action.id }) else { return }
        actions[index] = CalendarAction(id: action.id, kind: action.kind, version: action.version + 1,
                                        status: status ?? action.status, event: event ?? action.event,
                                        uncertainty: action.uncertainty, evidence: action.evidence,
                                        createdAt: action.createdAt, updatedAt: action.updatedAt,
                                        resolution: action.resolution, target: action.target,
                                        externalId: action.externalId, operationId: action.operationId,
                                        related: action.related, managed: action.managed,
                                        mutationAllowed: action.mutationAllowed, error: action.error)
    }
    private func change(context: Int, _ operation: (CentralClient) async throws -> Void) async -> Bool {
        let expected = identity, stamp = generation
        guard context == contextVersion, isCurrent(expected, stamp), let client = try? client(expected) else { message = "连接你的 Mote"; return false }
        do {
            try await operation(client)
            guard isCurrent(expected, stamp) else { return false }
            await refresh()
            return true
        } catch {
            guard isCurrent(expected, stamp) else { return false }
            if accessDenied(error) {
                contextVersion += 1; actions = []; todos = []
                actionCursor = nil; todoCursor = nil; pendingTodo = nil
            }
            message = "操作失败"
            return false
        }
    }
    func requestCalendarAccess() async {
        if fixture { message = "未授权，不读取或写入日历。可随时重新连接。"; return }
        do {
            let granted = try await EKEventStore().requestFullAccessToEvents()
            message = granted ? "这条日程暂不可用。" : "未授权，不读取或写入日历。可随时重新连接。"
        } catch { message = "未授权，不读取或写入日历。可随时重新连接。" }
    }
    private static func decode<T: Decodable>(_ type: T.Type, _ json: String) -> T {
        try! JSONDecoder().decode(type, from: Data(json.utf8))
    }
    static let actionJSON = #"""
    [{"id":"00000000-0000-4000-8000-000000000001","version":1,"kind":"calendar.create","status":"proposed","event":{"title":"和陈老师讨论方案","start":null,"end":null,"timeZone":"Asia/Shanghai","allDay":false,"location":"","description":""},"createdAt":"2026-11-06T04:00:00Z","updatedAt":"2026-11-06T04:00:00Z","uncertainty":"","evidence":[{"id":"00000000-0000-4000-8000-000000000009","source":"记录","capturedAt":"2026-11-06T04:00:00Z","quote":"下周找时间讨论方案"}]},
    {"id":"00000000-0000-4000-8000-000000000002","version":1,"kind":"calendar.create","status":"proposed","event":{"title":"复查租房合同","start":null,"end":null,"timeZone":"Asia/Shanghai","allDay":false,"location":"","description":""},"createdAt":"2026-11-06T04:00:00Z","updatedAt":"2026-11-06T04:00:00Z","uncertainty":"","evidence":[]},
    {"id":"00000000-0000-4000-8000-000000000003","version":2,"kind":"calendar.create","status":"succeeded","event":{"title":"团队周会","start":"2026-11-06T02:00:00Z","end":"2026-11-06T03:00:00Z","timeZone":"Asia/Shanghai","allDay":false,"location":"","description":""},"createdAt":"2026-11-06T04:00:00Z","updatedAt":"2026-11-06T04:00:00Z","uncertainty":"","evidence":[]}]
    """#
    static let todoJSON = #"[{"id":"00000000-0000-4000-8000-000000000010","version":1,"title":"整理会议记录","description":"","dueAt":null,"status":"open"}]"#
}
