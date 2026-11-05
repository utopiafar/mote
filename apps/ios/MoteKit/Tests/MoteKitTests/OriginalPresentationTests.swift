import XCTest
import MoteCentral

final class OriginalPresentationTests: XCTestCase {
    private let id = "00000000-0000-4000-8000-000000000001"

    func testOriginalEntryCreatesClearableAnchorScopeWithoutStrictEvidenceFilter() throws {
        let presentation = try OriginalPresentation(record: record(), conversations: [])

        XCTAssertEqual(presentation.askScope.id, id)
        XCTAssertEqual(presentation.askScope.conversationScope.anchorEvidenceIds, [id])
        XCTAssertNil(presentation.askScope.conversationScope.evidenceIds)
        XCTAssertNil(presentation.askScope.conversationScope.anchorMaterialRef)
        XCTAssertNil(ConversationScope().anchorEvidenceIds)
    }

    func testDetailUsesReceiptTimesAndCountsEveryExistingReferenceKind() throws {
        let material = "material:mat_" + String(repeating: "a", count: 64) + "@" + String(repeating: "b", count: 64)
        let conversations = try [
            conversation(scope: #"{"anchorEvidenceIds":[""# + id + #""]}"#),
            conversation(scope: #"{"evidenceIds":[""# + id + #""]}"#),
            conversation(scope: #"{"anchorMaterialRef":""# + material + #""}"#),
            conversation(scope: "{}"),
        ]
        let presentation = try OriginalPresentation(record: record(materialRef: material), conversations: conversations)

        XCTAssertEqual(presentation.referenceCount, 3)
        XCTAssertEqual(presentation.sourceDescription, "记录 · 生成的 iPhone")
        XCTAssertEqual(presentation.timeline.map(\.title), ["本机已保存", "中央已接收", "已整理，可搜索"])
        XCTAssertEqual(presentation.timeline.map(\.completed), [true, true, true])
        XCTAssertEqual(presentation.timeline[0].date, CentralTimestamp.parse("2026-11-06T06:20:00Z"))
        XCTAssertEqual(presentation.timeline[1].date, CentralTimestamp.parse("2026-11-06T06:22:00Z"))
        XCTAssertNil(presentation.timeline[2].date)
    }

    func testOnlyPositiveIntegerDeletionReceiptsConfirmCompletion() throws {
        for value in [0, -1] {
            let receipt = try JSONDecoder().decode(DeletionReceipt.self, from: Data(#"{"deleted":\#(value)}"#.utf8))
            XCTAssertThrowsError(try OriginalDeletion.requireCompleted(receipt)) {
                XCTAssertEqual($0 as? OriginalDeletionError, .unconfirmed)
            }
        }
        for body in [#"{"deleted":0.5}"#, #"{"deleted":"1"}"#, #"{"deleted":true}"#, #"{"deleted":null}"#, #"{}"#] {
            XCTAssertThrowsError(try JSONDecoder().decode(DeletionReceipt.self, from: Data(body.utf8)), body)
        }
        for value in [1, 2] {
            let receipt = try JSONDecoder().decode(DeletionReceipt.self, from: Data(#"{"deleted":\#(value)}"#.utf8))
            XCTAssertNoThrow(try OriginalDeletion.requireCompleted(receipt))
        }
    }

    func testDeletionRechecksCapabilityAndZeroReceiptDoesNotCloseOrRetry() async throws {
        let log = RequestLog()
        let record = try recordData()
        StubURLProtocol.handler = { request in
            log.append(request)
            if request.httpMethod == "GET" {
                return (200, record)
            }
            return (200, Data(#"{"deleted":0}"#.utf8))
        }
        defer { StubURLProtocol.handler = nil }
        let client = try CentralClient(serverUrl: "http://127.0.0.1:3030", token: "generated", session: Self.session())

        await XCTAssertThrowsErrorAsync(try await client.deleteOriginal(id: UUID(uuidString: id)!, expectedKind: .capture)) {
            XCTAssertEqual($0 as? OriginalDeletionError, .unconfirmed)
        }
        XCTAssertEqual(log.values.map { "\($0.httpMethod!) \($0.url!.path)" }, [
            "GET /api/capture-browser/\(id)",
            "DELETE /api/captures/\(id)",
        ])
    }

    func testWithdrawnOrMismatchedDeletionCapabilityNeverSendsDelete() async throws {
        for body in [try recordData(available: false), try recordData(kind: "file"), try recordData(id: "00000000-0000-4000-8000-000000000002")] {
            let log = RequestLog()
            StubURLProtocol.handler = { request in
                log.append(request)
                return (200, body)
            }
            let client = try CentralClient(serverUrl: "http://127.0.0.1:3030", token: "generated", session: Self.session())
            await XCTAssertThrowsErrorAsync(try await client.deleteOriginal(id: UUID(uuidString: id)!, expectedKind: .capture)) {
                XCTAssertEqual($0 as? OriginalDeletionError, .unavailable)
            }
            XCTAssertEqual(log.values.map(\.httpMethod), ["GET"])
        }
        StubURLProtocol.handler = nil
    }

    private func record(id: String? = nil, kind: String = "capture", available: Bool = true, materialRef: String? = nil) throws -> OriginalRecord {
        try JSONDecoder().decode(OriginalRecord.self, from: recordData(id: id, kind: kind, available: available, materialRef: materialRef))
    }

    private func recordData(id: String? = nil, kind: String = "capture", available: Bool = true, materialRef: String? = nil) throws -> Data {
        var object: [String: Any] = [
            "id": id ?? self.id,
            "capturedAt": "2026-11-06T06:20:00Z",
            "receivedAt": "2026-11-06T06:22:00Z",
            "deviceId": "generated-device",
            "deviceName": "生成的 iPhone",
            "platform": "ios",
            "source": "note",
            "appName": "Mote",
            "windowTitle": "生成的记录",
            "durationMs": 0,
            "ocrText": "生成的完整原文",
            "indexingStatus": "indexed",
            "privacy": ["excluded": false, "redacted": false, "mode": "none"],
            "deletion": ["available": available, "kind": kind],
        ]
        if let materialRef { object["memoryMaterialRef"] = materialRef }
        return try JSONSerialization.data(withJSONObject: object)
    }

    private func conversation(scope: String) throws -> ConversationSummary {
        let json = #"{"id":"00000000-0000-4000-8000-000000000009","title":"生成的对话","createdAt":"2026-11-06T06:25:00Z","updatedAt":"2026-11-06T06:25:00Z","turnCount":1,"status":"completed","scope":"# + scope + "}"
        return try JSONDecoder().decode(ConversationSummary.self, from: Data(json.utf8))
    }

    private static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

private final class RequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []

    var values: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }

    func append(_ request: URLRequest) {
        lock.lock()
        requests.append(request)
        lock.unlock()
    }
}

private final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw CentralError.invalidResponse }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ errorHandler: (Error) -> Void
) async {
    do {
        _ = try await expression()
        XCTFail("Expected an error")
    } catch {
        errorHandler(error)
    }
}
