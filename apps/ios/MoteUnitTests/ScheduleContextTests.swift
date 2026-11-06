import Foundation
import MoteStorage
import XCTest
@testable import Mote

@MainActor
final class ScheduleContextTests: XCTestCase {
    func testOldDetailCannotDismissAnActionAfterConnectionChanges() async {
        let transport = ScheduleTestTransport(actions: ScheduleModel.actionJSON)
        ScheduleTestProtocol.handler = { transport.respond($0) }
        defer { ScheduleTestProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ScheduleTestProtocol.self]
        let session = URLSession(configuration: config)
        var connection = Self.connection("first")
        let model = ScheduleModel(connectionProvider: { connection }, session: session)
        await model.refresh()
        let oldAction = model.actions[0], oldContext = model.contextVersion

        // Both generated nodes deliberately return the same action ID and version.
        connection = Self.connection("second")
        await model.refresh()
        XCTAssertNotEqual(model.contextVersion, oldContext)
        XCTAssertEqual(model.actions.first?.id, oldAction.id)
        let changed = await model.dismiss(oldAction, context: oldContext)
        XCTAssertFalse(changed)
        XCTAssertEqual(transport.mutationCount, 0)
    }

    func testRevokedReviewWithdrawsActionsAndInvalidatesOpenDetail() async {
        let transport = ScheduleTestTransport(actions: ScheduleModel.actionJSON)
        ScheduleTestProtocol.handler = { transport.respond($0) }
        defer { ScheduleTestProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ScheduleTestProtocol.self]
        let model = ScheduleModel(connectionProvider: { Self.connection("first") }, session: URLSession(configuration: config))
        await model.refresh()
        let oldAction = model.actions[0], oldContext = model.contextVersion
        transport.revoke()
        await model.refresh()
        XCTAssertTrue(model.actions.isEmpty)
        XCTAssertNotEqual(model.contextVersion, oldContext)
        let changed = await model.dismiss(oldAction, context: oldContext)
        XCTAssertFalse(changed)
        XCTAssertEqual(transport.mutationCount, 0)
    }

    private static func connection(_ name: String) -> StoredConnection {
        StoredConnection(serverUrl: "http://127.0.0.1:3030", token: "generated-\(name)",
                         credentialId: "generated-\(name)", scope: "owner")
    }
}

private final class ScheduleTestTransport: @unchecked Sendable {
    private let lock = NSLock()
    private var revoked = false
    private var mutations = 0
    private let actions: String
    init(actions: String) { self.actions = actions }
    func revoke() { lock.lock(); defer { lock.unlock() }; revoked = true }
    var mutationCount: Int { lock.lock(); defer { lock.unlock() }; return mutations }
    func respond(_ request: URLRequest) -> (Int, Data) {
        lock.lock(); defer { lock.unlock() }
        if request.httpMethod != "GET" { mutations += 1; return (500, Data()) }
        if request.url?.path == "/api/actions" {
            if revoked { return (403, Data("{}".utf8)) }
            return (200, Data("{\"items\":\(actions),\"nextCursor\":null}".utf8))
        }
        return (200, Data("{\"items\":[],\"nextCursor\":null}".utf8))
    }
}

private final class ScheduleTestProtocol: URLProtocol, @unchecked Sendable {
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
