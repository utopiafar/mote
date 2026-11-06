import Foundation
import MoteCentral
import XCTest

final class CalendarActionsTests: XCTestCase {
    private let first = "00000000-0000-4000-8000-000000000001"
    private let second = "00000000-0000-4000-8000-000000000002"
    private let third = "00000000-0000-4000-8000-000000000003"

    func testHomeScansLaterPagesAndShowsOnlyTwoUnresolvedMissingTimes() async throws {
        let log = CalendarRequestLog()
        CalendarURLProtocol.handler = { request in
            log.append(request)
            let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value
            let rows: String
            let next: String
            switch cursor {
            case "0":
                rows = Self.row(self.first, status: "succeeded", start: "null", end: "null")
                next = "7"
            case "7":
                rows = [Self.row(self.first, status: "proposed", start: "null", end: "null"),
                        Self.row(self.second, status: "proposed", start: "null", end: "null"),
                        Self.row(self.third, status: "proposed", start: "null", end: "null")].joined(separator: ",")
                next = "8"
            default: XCTFail("scanned beyond the two visible items"); rows = ""; next = "null"
            }
            return (200, Data("{\"items\":[\(rows)],\"nextCursor\":\(next)}".utf8))
        }
        defer { CalendarURLProtocol.handler = nil }
        let highlights = try await client().calendarNeeds()
        XCTAssertEqual(highlights.map(\.id), [first, second])
        XCTAssertEqual(highlights.map(\.detail), ["时间待补充", "时间待补充"])
        XCTAssertEqual(log.values.count, 2)
        XCTAssertTrue(log.values.allSatisfy { $0.httpMethod == "GET" })
    }

    func testHomeStopsAfterFivePagesEvenWhenThereAreMoreResults() async throws {
        let log = CalendarRequestLog()
        CalendarURLProtocol.handler = { request in
            log.append(request)
            let cursor = Int(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value ?? "0")!
            let row = Self.row("00000000-0000-4000-8000-000000000001", status: "succeeded", start: "null", end: "null")
            return (200, Data("{\"items\":[\(row)],\"nextCursor\":\(cursor + 1)}".utf8))
        }
        defer { CalendarURLProtocol.handler = nil }
        let highlights = try await client().calendarNeeds()
        XCTAssertTrue(highlights.isEmpty)
        XCTAssertEqual(log.values.count, 5)
    }

    func testInformationCannotOverwriteKnownTimesOrConfirmNativeCreation() async throws {
        let log = CalendarRequestLog()
        CalendarURLProtocol.handler = { request in log.append(request); return (500, Data()) }
        defer { CalendarURLProtocol.handler = nil }
        let json = Self.row(first, status: "proposed", start: "\"2026-11-08T01:00:00Z\"", end: "null")
        let action = try JSONDecoder().decode(CalendarAction.self, from: Data(json.utf8))
        var edited = action.event
        edited.start = "2026-11-08T03:00:00Z"; edited.end = "2026-11-08T04:00:00Z"
        let client = try client()
        do { _ = try await client.supplyCalendarInformation(action, event: edited); XCTFail("changed known time") }
        catch { XCTAssertEqual(error as? CentralError, .invalidRequest) }
        do { _ = try await client.confirmCalendarActionWithoutNativeWrite(action); XCTFail("confirmed native creation") }
        catch { XCTAssertEqual(error as? CentralError, .invalidRequest) }
        XCTAssertTrue(log.values.isEmpty)
    }

    func testOnlyProposedCreateAndUpdateWithoutResolutionNeedTime() throws {
        let json = "[" + [
            Self.row(first, status: "proposed", start: "null", end: "null"),
            Self.row(second, kind: "calendar.update", status: "proposed", start: "null", end: "null"),
            Self.row(third, kind: "calendar.cancel", status: "proposed", start: "null", end: "null"),
            Self.row(third, status: "dismissed", start: "null", end: "null"),
            Self.row(third, status: "proposed", start: "null", end: "null", extra: ",\"resolution\":\"completed\""),
            Self.row(third, status: "proposed", start: "\"2026-11-08T01:00:00Z\"", end: "\"2026-11-08T02:00:00Z\"")
        ].joined(separator: ",") + "]"
        let items = try JSONDecoder().decode([CalendarAction].self, from: Data(json.utf8))
        XCTAssertEqual(items.map(\.needsTime), [true, true, false, false, false, false])
        XCTAssertEqual(CalendarActionPolicy.homeHighlights(items).map(\.id), [first, second])
    }

    func testPermissionRevocationAndUncertainMutationNeverPermitAnotherWrite() {
        XCTAssertFalse(CalendarDeliveryPolicy.mayExecute(permissionGranted: false, retained: nil))
        XCTAssertFalse(CalendarDeliveryPolicy.mayExecute(permissionGranted: false, retained: "attempting"))
        XCTAssertTrue(CalendarDeliveryPolicy.mayExecute(permissionGranted: false, retained: "retained-event"))
        XCTAssertTrue(CalendarDeliveryPolicy.mayExecute(permissionGranted: true, retained: nil))
        XCTAssertFalse(Self.mutationAllowed(serverAllowed: false, previous: nil))
        XCTAssertFalse(Self.mutationAllowed(serverAllowed: true, previous: "attempting"))
        XCTAssertFalse(Self.mutationAllowed(serverAllowed: true, previous: "retained-event"))
        XCTAssertTrue(Self.mutationAllowed(serverAllowed: true, previous: nil))
    }

    func testDateValidationRejectsInvalidOrderZonesAndLongIntervals() {
        let valid = CalendarEventDraft(title: "生成日程", start: "2026-11-08T01:00:00Z", end: "2026-11-08T02:00:00Z", timeZone: "Asia/Shanghai", allDay: false)
        XCTAssertTrue(CalendarActionPolicy.valid(valid))
        var event = valid; event.end = event.start; XCTAssertFalse(CalendarActionPolicy.valid(event))
        event = valid; event.end = "2028-11-08T02:00:00Z"; XCTAssertFalse(CalendarActionPolicy.valid(event))
        event = valid; event.timeZone = "invalid-zone"; XCTAssertFalse(CalendarActionPolicy.valid(event))
        event = valid; event.title = String(repeating: "字", count: 201); XCTAssertFalse(CalendarActionPolicy.valid(event))
        event = valid; event.allDay = true; XCTAssertFalse(CalendarActionPolicy.valid(event))
        event.start = "2026-11-08"; event.end = "2026-11-09"; XCTAssertTrue(CalendarActionPolicy.valid(event))
    }

    func testConfirmingUnwrittenRelatedActionDoesNotTargetADevice() async throws {
        let log = CalendarRequestLog()
        let event = CalendarEventDraft(title: "生成日程", start: nil, end: nil, timeZone: nil, allDay: false)
        let related = CalendarActionRelation(actionId: second, version: 1, status: .proposed, event: event)
        let action = CalendarAction(id: first, kind: .cancel, version: 3, status: .proposed, event: event, related: related)
        CalendarURLProtocol.handler = { request in
            log.append(request)
            return (200, Data(Self.row(self.first, kind: "calendar.cancel", status: "succeeded", start: "null", end: "null").utf8))
        }
        defer { CalendarURLProtocol.handler = nil }
        XCTAssertTrue(action.canConfirmWithoutNativeWrite)
        _ = try await client().confirmCalendarActionWithoutNativeWrite(action)
        let request = try XCTUnwrap(log.values.first)
        XCTAssertEqual(request.url?.path, "/api/actions/\(first)/confirm")
        let data = try XCTUnwrap(Self.bodyData(request))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body["version"] as? Int, 3)
        XCTAssertNil(body["target"])
        let sentEvent = try XCTUnwrap(body["event"] as? [String: Any])
        XCTAssertTrue(sentEvent["start"] is NSNull)
        XCTAssertTrue(sentEvent["timeZone"] is NSNull)
        let target = CalendarActionTargetChoice(deviceId: "another-device", calendarId: "calendar")
        let linked = CalendarActionRelation(actionId: second, version: 1, status: .succeeded, event: event,
                                            target: target, externalId: "existing-event")
        let native = CalendarAction(id: first, kind: .cancel, version: 3, status: .proposed, event: event, related: linked)
        XCTAssertFalse(native.canConfirmWithoutNativeWrite)
    }

    func testRepeatedWallTimeRequiresAnUnambiguousChoice() {
        let formatter = ISO8601DateFormatter()
        let repeated = formatter.date(from: "2026-11-01T05:30:00Z")!
        let clear = formatter.date(from: "2026-11-01T07:30:00Z")!
        XCTAssertFalse(CalendarActionPolicy.unambiguous(repeated, zone: "America/New_York"))
        XCTAssertTrue(CalendarActionPolicy.unambiguous(clear, zone: "America/New_York"))
        XCTAssertFalse(CalendarActionPolicy.unambiguous(clear, zone: "not-a-zone"))
    }

    func testInformationAndTodoRequestsUseVersionedExistingCentralRoutes() async throws {
        let log = CalendarRequestLog()
        let actionJSON = Self.row(first, status: "proposed", start: "null", end: "null")
        let action = try JSONDecoder().decode(CalendarAction.self, from: Data(actionJSON.utf8))
        CalendarURLProtocol.handler = { request in
            log.append(request)
            if request.url!.path.hasPrefix("/api/todos") {
                return (201, Data("{\"id\":\"\(self.second)\",\"version\":1,\"title\":\"生成待办\",\"description\":\"\",\"dueAt\":null,\"status\":\"open\"}".utf8))
            }
            return (200, Data(actionJSON.utf8))
        }
        defer { CalendarURLProtocol.handler = nil }
        var event = action.event; event.start = "2026-11-08T01:00:00Z"; event.end = "2026-11-08T02:00:00Z"
        let client = try client()
        _ = try await client.supplyCalendarInformation(action, event: event)
        let todo = try await client.createCalendarTodo(id: UUID(uuidString: second)!, title: "生成待办")
        _ = try await client.updateCalendarTodo(todo, status: "completed")
        XCTAssertEqual(log.values.map { "\($0.httpMethod!) \($0.url!.path)" }, [
            "POST /api/actions/\(first)/information", "POST /api/todos", "PATCH /api/todos/\(second)",
        ])
        let information = try XCTUnwrap(log.values.first.flatMap(Self.bodyData))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: information) as? [String: Any])
        XCTAssertEqual(body["version"] as? Int, 3)
        XCTAssertEqual(body["start"] as? String, event.start)
        XCTAssertEqual(body["timeZone"] as? String, "Asia/Shanghai")
        let statusBody = try XCTUnwrap(log.values.last.flatMap(Self.bodyData))
        let patch = try XCTUnwrap(JSONSerialization.jsonObject(with: statusBody) as? [String: Any])
        XCTAssertEqual(patch["version"] as? Int, 1)
        XCTAssertEqual(patch["status"] as? String, "completed")
    }

    private static func bodyData(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data.isEmpty ? nil : data
    }
    private static func mutationAllowed(serverAllowed: Bool, previous: String?) -> Bool {
        let event = CalendarActionEvent(title: "生成日程", start: nil, end: nil, timeZone: nil, allDay: false)
        let action = CalendarAction(id: "00000000-0000-4000-8000-000000000001", kind: .create,
                                    version: 1, status: .executing, event: event, mutationAllowed: serverAllowed)
        return CalendarActionRules.mutationAllowed(action, previous: previous)
    }
    private func client() throws -> CentralClient {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CalendarURLProtocol.self]
        return try CentralClient(serverUrl: "http://127.0.0.1:3030", token: "generated", session: URLSession(configuration: config))
    }
    private static func row(_ id: String, kind: String = "calendar.create", status: String, start: String, end: String, extra: String = "") -> String {
        "{\"id\":\"\(id)\",\"version\":3,\"kind\":\"\(kind)\",\"status\":\"\(status)\",\"event\":{\"title\":\"生成日程\",\"start\":\(start),\"end\":\(end),\"timeZone\":\"Asia/Shanghai\",\"allDay\":false,\"location\":\"\",\"description\":\"\"},\"createdAt\":\"2026-11-06T04:00:00Z\",\"updatedAt\":\"2026-11-06T04:00:00Z\",\"uncertainty\":\"\",\"evidence\":[]\(extra)}"
    }
}
private final class CalendarRequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    func append(_ request: URLRequest) { lock.lock(); defer { lock.unlock() }; requests.append(request) }
    var values: [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests }
}
private final class CalendarURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = Self.handler, let client else { return }
        let (status, data) = handler(request)
        client.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client.urlProtocol(self, didLoad: data)
        client.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
