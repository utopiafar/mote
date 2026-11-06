import Foundation
import XCTest
import MoteCentral

final class MemoryDetailTests: XCTestCase {
    private let currentID = "00000000-0000-4000-8000-000000000001"
    private let olderID = "00000000-0000-4000-8000-000000000002"
    private let evidenceID = "00000000-0000-4000-8000-000000000003"

    func testMoreAndCorrectionWordingMatchTheCanvas() {
        XCTAssertEqual(MemoryDetailCopy.moreItems,
                       ["纠正这条记忆", "历史与有效时间", "生成信息", "删除记忆"])
        XCTAssertEqual(MemoryDetailCopy.correctionFields,
                       ["标题", "纠正后的内容", "判断的边界", "生效时间", "失效时间"])
        XCTAssertEqual(MemoryDetailCopy.correctionTitle, "纠正这条记忆")
        XCTAssertEqual(MemoryDetailCopy.correctionSave, "保存")
        XCTAssertEqual(MemoryDetailCopy.correctionCancel, "取消")
        XCTAssertFalse(MemoryDetailCopy.correctionFields.contains("保存校正"))
        XCTAssertNotEqual(MemoryDetailCopy.correctionSave, "保存校正")
    }

    func testDeleteConfirmationIsWordForWordTheWebDialog() {
        XCTAssertEqual(MemoryDetailCopy.deleteTitle, "删除这条记忆？")
        XCTAssertEqual(MemoryDetailCopy.deleteMessage,
                       "原始资料保留。同一批旧证据不会重新生成这个结论；有新证据时可以重新判断。")
        XCTAssertEqual(MemoryDetailCopy.deleteConfirm, "确认删除")
        XCTAssertEqual(MemoryDetailCopy.deleteCancel, "取消")
    }

    func testDeletionNoticesMatchTheWebReceipts() {
        XCTAssertEqual(MemoryDetailCopy.deletionNotice(MemoryDeleteReceipt(externalErase: "pending")),
                       "记忆已禁止使用；外部清除仍待确认。")
        XCTAssertEqual(MemoryDetailCopy.deletionNotice(
            MemoryDeleteReceipt(externalErase: "acknowledged", physicalEraseVerified: false)),
                       "记忆已禁止使用；外部已确认移除当前记录，物理擦除尚未核验。")
        XCTAssertEqual(MemoryDetailCopy.deletionNotice(MemoryDeleteReceipt()),
                       "记忆已禁止使用。")
    }

    func testCorrectionRequestEncodesThePanelFieldsAndVersion() throws {
        let request = MemoryCorrectionRequest(
            title: "Synthetic title",
            statement: "Synthetic statement",
            uncertainty: "Synthetic boundary",
            version: 3,
            validFrom: "2026-11-06T02:30:00.000Z",
            validUntil: "2026-11-07T02:00:00.000Z"
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        )
        XCTAssertEqual(object["title"] as? String, "Synthetic title")
        XCTAssertEqual(object["statement"] as? String, "Synthetic statement")
        XCTAssertEqual(object["uncertainty"] as? String, "Synthetic boundary")
        XCTAssertEqual(object["version"] as? Int, 3)
        XCTAssertEqual(object["validFrom"] as? String, "2026-11-06T02:30:00.000Z")
        XCTAssertEqual(object["validUntil"] as? String, "2026-11-07T02:00:00.000Z")

        let blank = MemoryCorrectionRequest(title: "Synthetic title", statement: "Synthetic statement",
                                            uncertainty: "", version: 1)
        let blankObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(blank)) as? [String: Any]
        )
        XCTAssertNil(blankObject["validFrom"])
        XCTAssertNil(blankObject["validUntil"])
    }

    func testCorrectionAndDeletionUseTheSameOwnerRoutesAsWebAndAndroid() async throws {
        let log = MemoryDetailRequestLog()
        let correctedData = try recordData(statement: "Synthetic corrected statement")
        MemoryDetailURLProtocol.handler = { request in
            log.append(request)
            if request.httpMethod == "POST" {
                return (200, correctedData)
            }
            return (200, Data(#"{"deleted":1,"externalErase":"acknowledged","physicalEraseVerified":false}"#.utf8))
        }
        defer { MemoryDetailURLProtocol.handler = nil }
        let client = try CentralClient(
            serverUrl: "http://127.0.0.1:3030",
            token: "generated",
            session: Self.session()
        )
        let id = try XCTUnwrap(UUID(uuidString: currentID))
        let corrected = try await client.correctMemory(
            id: id,
            request: MemoryCorrectionRequest(
                title: "Synthetic title",
                statement: "Synthetic corrected statement",
                uncertainty: "Synthetic boundary",
                version: 2
            )
        )
        XCTAssertEqual(corrected.statement, "Synthetic corrected statement")
        let receipt = try await client.deleteMemory(id: id)
        XCTAssertEqual(receipt.deleted, 1)
        XCTAssertEqual(MemoryDetailCopy.deletionNotice(receipt),
                       "记忆已禁止使用；外部已确认移除当前记录，物理擦除尚未核验。")

        XCTAssertEqual(log.values.map { "\($0.httpMethod ?? "?") \($0.url?.path ?? "?")" }, [
            "POST /api/memories/\(currentID)/correct",
            "DELETE /api/memories/\(currentID)",
        ])
        let body = try XCTUnwrap(log.values.first.flatMap(Self.bodyData))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["title"] as? String, "Synthetic title")
        XCTAssertEqual(object["statement"] as? String, "Synthetic corrected statement")
        XCTAssertEqual(object["uncertainty"] as? String, "Synthetic boundary")
        XCTAssertEqual(object["version"] as? Int, 2)
        XCTAssertNil(object["validFrom"])
        XCTAssertNil(object["validUntil"])
        XCTAssertNil(log.values.last.flatMap(Self.bodyData))
    }

    func testDetailKeepsTheCurrentAndReplacedStatementsWithValidity() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 8 * 3600)!
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 11, day: 6, hour: 20)))
        let record = try JSONDecoder().decode(MemoryRecord.self, from: recordData())
        let older = try JSONDecoder().decode(MemoryRecord.self, from: olderData())
        let content = MemoryDetailContent.present(record: record, history: [older], now: now, calendar: calendar)

        XCTAssertEqual(content.validityLabel, "今天起")
        XCTAssertEqual(content.versions.map(\.statement), [
            "押金为两个月租金，下个月退，需要收据。",
            "押金为一个月租金。",
        ])
        XCTAssertEqual(content.versions.map(\.subtitle), [
            "当前版本 · 今天起",
            "历史版本 · 10月1日 – 今天",
        ])
        XCTAssertEqual(content.info, [
            MemoryDetailInfoRow(label: "类型", value: "精选记忆"),
            MemoryDetailInfoRow(label: "来源", value: "模型生成"),
            MemoryDetailInfoRow(label: "生成时间", value: "今天 14:31"),
        ])
    }

    func testArchivedEvidenceKeepsItsOriginAndTime() throws {
        let json = #"""
        {"items":[{"id":"\#(evidenceID)","capturedAt":"2026-11-06T06:20:00Z","receivedAt":"2026-11-06T06:22:00Z","deviceId":"generated-device","deviceName":"生成的 iPhone","platform":"ios","source":"note","appName":"Mote","windowTitle":"","durationMs":0,"ocrText":"暖气费按实际用量分摊，月底前给账单照片","indexingStatus":"indexed","privacy":{"excluded":false,"redacted":false,"mode":"none"}}],"status":"published"}
        """#
        let page = try JSONDecoder().decode(MemoryEvidencePage.self, from: Data(json.utf8))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 8 * 3600)!
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 11, day: 6, hour: 20)))
        let record = try JSONDecoder().decode(MemoryRecord.self, from: recordData())
        let content = MemoryDetailContent.present(record: record, evidence: page.items, now: now, calendar: calendar)

        XCTAssertEqual(content.evidence.first?.title, "暖气费按实际用量分摊，月底前给账单照片")
        XCTAssertEqual(content.evidence.first?.subtitle, "记录 · 今天 14:20")
        XCTAssertEqual(content.evidence.first?.kind, .note)
        XCTAssertEqual(content.evidence.first?.id, evidenceID)
    }

    private func recordData(statement: String = "押金为两个月租金，下个月退，需要收据。") throws -> Data {
        let json = #"""
        {"id":"\#(currentID)","version":2,"title":"租房押金","statement":"\#(statement)","uncertainty":"",
        "evidenceIds":["\#(evidenceID)"],
        "evidence":[{"id":"\#(evidenceID)","capturedAt":"2026-11-06T06:20:00Z","receivedAt":"2026-11-06T06:22:00Z","contentHash":"\#(String(repeating: "a", count: 64))"}],
        "createdAt":"2026-11-06T06:31:00Z","status":"published","model":"generated-model","runId":"generated-run",
        "fingerprint":"\#(String(repeating: "b", count: 64))","domain":"personal","tier":"episode","kind":"episodic",
        "admission":{"layer":"memory","reason":"Generated reason","scope":"Generated scope","attribution":"user"},
        "validFrom":"2026-11-06T00:00:00Z",
        "relations":[{"kind":"supersedes","memoryId":"\#(olderID)","fingerprint":"\#(String(repeating: "c", count: 64))","version":1}]}
        """#
        return Data(json.utf8)
    }

    private func olderData() throws -> Data {
        let json = #"""
        {"id":"\#(olderID)","version":2,"title":"租房押金","statement":"押金为一个月租金。","uncertainty":"",
        "evidenceIds":["\#(evidenceID)"],
        "evidence":[{"id":"\#(evidenceID)","capturedAt":"2026-10-01T06:20:00Z","receivedAt":"2026-10-01T06:22:00Z","contentHash":"\#(String(repeating: "d", count: 64))"}],
        "createdAt":"2026-10-01T06:31:00Z","status":"published","model":"generated-model","runId":"generated-run",
        "fingerprint":"\#(String(repeating: "e", count: 64))","domain":"personal","tier":"episode","kind":"episodic",
        "admission":{"layer":"memory","reason":"Generated reason","scope":"Generated scope","attribution":"user"},
        "validFrom":"2026-10-01T00:00:00Z","supersededBy":"\#(currentID)","supersededAt":"2026-11-06T00:00:00Z"}
        """#
        return Data(json.utf8)
    }

    private static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MemoryDetailURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private static func bodyData(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data.isEmpty ? nil : data
    }
}

private final class MemoryDetailRequestLog: @unchecked Sendable {
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

private final class MemoryDetailURLProtocol: URLProtocol {
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
