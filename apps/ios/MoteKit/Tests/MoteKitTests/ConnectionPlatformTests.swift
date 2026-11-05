import Foundation
import XCTest
import MoteCentral

private final class ConnectionFixture: URLProtocol, @unchecked Sendable {
    private final class RecordedRequests: @unchecked Sendable {
        let lock = NSLock()
        var values: [URLRequest] = []
        var identityDeviceId = "generated-device"
    }

    private static let recorded = RecordedRequests()

    static func reset(identityDeviceId: String = "generated-device") {
        recorded.lock.lock()
        defer { recorded.lock.unlock() }
        recorded.values.removeAll()
        recorded.identityDeviceId = identityDeviceId
    }

    static func requests() -> [URLRequest] {
        recorded.lock.lock()
        defer { recorded.lock.unlock() }
        return recorded.values
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var captured = request
        if captured.httpBody == nil, let stream = captured.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
            captured.httpBody = data
        }
        Self.recorded.lock.lock()
        Self.recorded.values.append(captured)
        let identityDeviceId = Self.recorded.identityDeviceId
        Self.recorded.lock.unlock()
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        let body: String
        if request.url?.path == "/api/connections/self" {
            body = #"{"credential":{"id":"generated-credential","scope":"owner","label":"Generated","serverUrl":"https://mote.example.net","deviceId":""# + identityDeviceId + #"","platform":"ios"},"node":{"version":"generated","profile":"dev","protocol":{"min":1,"max":1}},"capabilities":{"ingest":true,"ingressVersion":2,"ownSources":true,"archiveRead":true}}"#
        } else {
            body = #"{"serverUrl":"https://mote.example.net","token":"generated-token","credentialId":"generated-credential","scope":"owner"}"#
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class ConnectionPlatformTests: XCTestCase {
    private func invitation(platforms: String) throws -> ConnectionInvitation {
        let expiry = CentralTimestamp.string(Date().addingTimeInterval(600))
        let input = #"{"format":"mote.connection","version":1,"serverUrl":"https://mote.example.net","code":""#
            + String(repeating: "a", count: 43) + #"","expiresAt":""# + expiry + #"""# + platforms + "}"
        return try ConnectionInvitation.parse(input)
    }

    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConnectionFixture.self]
        return URLSession(configuration: configuration)
    }

    func testUnsupportedCentralNeverReceivesRedemptionOrRecords() async throws {
        for platforms in ["", #",\"platforms\":[\"android\",\"macos\"]"#] {
            ConnectionFixture.reset()
            let invitation = try invitation(platforms: platforms.replacingOccurrences(of: "\\\"", with: "\""))
            do {
                _ = try await ConnectionService.establish(invitation: invitation, deviceId: "generated-device", deviceName: "Generated iPhone", session: session())
                XCTFail("A central without an iOS declaration must not be contacted")
            } catch {
                XCTAssertEqual(error as? CentralError, .unsupportedPlatform)
            }
            XCTAssertTrue(ConnectionFixture.requests().isEmpty, "An unsupported central must receive no connection or capture requests")
        }
    }

    func testInvalidPlatformDeclarationsAreRejected() {
        for platforms in [#",\"platforms\":[]"#, #",\"platforms\":[\"ios\",\"ios\"]"#,
                          #",\"platforms\":[\"import\"]"#, #",\"platforms\":null"#] {
            XCTAssertThrowsError(try invitation(platforms: platforms.replacingOccurrences(of: "\\\"", with: "\"")))
        }
    }

    func testSupportedCentralReceivesAnIOSRedemption() async throws {
        ConnectionFixture.reset()
        let invitation = try invitation(platforms: #",\"platforms\":[\"android\",\"ios\",\"macos\"]"#.replacingOccurrences(of: "\\\"", with: "\""))
        let connection = try await ConnectionService.establish(invitation: invitation, deviceId: "generated-device", deviceName: "Generated iPhone", session: session())
        XCTAssertEqual(connection.credential.credentialId, "generated-credential")
        let request = try XCTUnwrap(ConnectionFixture.requests().first)
        XCTAssertEqual(request.url?.path, "/api/connections/redeem")
        let body = try XCTUnwrap(request.httpBody)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(payload["platform"], "ios")
        XCTAssertEqual(payload["deviceId"], "generated-device")
        let requests = ConnectionFixture.requests()
        XCTAssertEqual(requests.map { $0.url?.path }, ["/api/connections/redeem", "/api/connections/self"])
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer generated-token")
    }

    func testConnectionIsNotReturnedWhenTheCentralVerifiesAnotherDevice() async throws {
        ConnectionFixture.reset(identityDeviceId: "different-device")
        let invitation = try invitation(platforms: #",\"platforms\":[\"ios\"]"#.replacingOccurrences(of: "\\\"", with: "\""))
        do {
            _ = try await ConnectionService.establish(invitation: invitation, deviceId: "generated-device", deviceName: "Generated iPhone", session: session())
            XCTFail("An unverified credential must never be returned for saving")
        } catch {
            XCTAssertEqual(error as? CentralError, .invalidResponse)
        }
        XCTAssertEqual(ConnectionFixture.requests().map { $0.url?.path }, ["/api/connections/redeem", "/api/connections/self"])
    }
}
