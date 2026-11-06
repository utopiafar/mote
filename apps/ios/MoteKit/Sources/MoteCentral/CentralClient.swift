import Foundation

public enum CentralError: Error, Equatable {
    case invalidInvitation
    case invitationExpired
    case invalidEndpoint
    case invalidRequest
    case invalidResponse
    case incompatibleProtocol
    case unsupportedPlatform
    case http(status: Int, code: String?)
}

public struct CentralClient: Sendable {
    public static let protocolVersion = "1"

    public let serverUrl: String
    private let token: String
    private let session: URLSession

    public init(serverUrl: String, token: String, session: URLSession = .shared) throws {
        self.serverUrl = try CentralEndpoint.normalize(serverUrl)
        self.token = token
        self.session = session
    }

    public static func redeem(invitation: ConnectionInvitation, deviceId: String, deviceName: String,
                              session: URLSession = .shared) async throws -> DeviceCredential {
        guard invitation.platforms?.contains(.ios) == true else { throw CentralError.unsupportedPlatform }
        guard !deviceId.isEmpty, !deviceName.isEmpty, let expires = CentralTimestamp.parse(invitation.expiresAt), expires > Date() else {
            throw CentralError.invalidRequest
        }
        let client = try CentralClient(serverUrl: invitation.serverUrl, token: "", session: session)
        let request = RedemptionRequest(code: invitation.code, deviceId: deviceId, deviceName: deviceName, platform: .ios)
        let credential: DeviceCredential = try await client.request("POST", "/api/connections/redeem", body: request, authenticated: false)
        guard credential.serverUrl == invitation.serverUrl, credential.scope == "owner",
              !credential.token.isEmpty, !credential.credentialId.isEmpty else { throw CentralError.invalidResponse }
        return credential
    }

    public func verify(deviceId: String, credentialId: String) async throws -> ConnectionIdentity {
        let identity: ConnectionIdentity = try await request("GET", "/api/connections/self")
        guard identity.node.protocol.supportsMote() else { throw CentralError.incompatibleProtocol }
        guard identity.credential.id == credentialId, identity.credential.scope == "owner",
              identity.credential.deviceId == deviceId, identity.credential.platform == .ios,
              identity.credential.serverUrl == serverUrl, identity.capabilities.ingest
        else { throw CentralError.invalidResponse }
        return identity
    }

    public func sendHeartbeat(_ heartbeat: Heartbeat) async throws -> HeartbeatAcknowledgement {
        try await request("POST", "/api/devices/heartbeat", body: heartbeat)
    }

    @discardableResult
    public func upload(_ capture: CaptureUpload) async throws -> CaptureReceipt {
        try await upload(payload: JSONEncoder().encode(capture))
    }

    @discardableResult
    public func upload(payload: Data) async throws -> CaptureReceipt {
        var request = try captureUploadRequest()
        request.httpBody = payload
        return try await perform(request)
    }

    func captureUploadRequest() throws -> URLRequest {
        var request = try makeRequest("POST", "/api/captures", query: [], authenticated: true)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    public func reconcile(deviceId: String, ids: [String]) async throws -> CaptureReconciliation {
        try await request("POST", "/api/capture-browser/reconcile",
                          body: CaptureReconciliationRequest(deviceId: deviceId, ids: ids))
    }

    public func originals(after: String? = nil, before: String? = nil, source: CaptureSource? = nil,
                          cursor: String? = nil, limit: Int = 30) async throws -> CentralPage<CapturePreview> {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let after { query.append(URLQueryItem(name: "after", value: after)) }
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        if let source { query.append(URLQueryItem(name: "source", value: source.rawValue)) }
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("GET", "/api/capture-browser", query: query)
    }

    public func original(id: UUID) async throws -> OriginalRecord {
        try await request("GET", "/api/capture-browser/\(id.uuidString.lowercased())")
    }

    @discardableResult
    public func deleteOriginal(id: UUID, expectedKind: OriginalDeletionKind) async throws -> DeletionReceipt {
        let pathID = id.uuidString.lowercased()
        let current = try await original(id: id)
        guard current.id == pathID, current.deletion?.available == true,
              current.deletion?.kind == expectedKind
        else { throw OriginalDeletionError.unavailable }
        let receipt: DeletionReceipt = try await request("DELETE", "/api/captures/\(pathID)")
        try OriginalDeletion.requireCompleted(receipt)
        return receipt
    }

    public func conversations(cursor: String? = nil, limit: Int = 30) async throws -> CentralPage<ConversationSummary> {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("GET", "/api/conversations", query: query)
    }

    public func conversation(id: UUID, cursor: String? = nil, limit: Int = 20) async throws -> Conversation {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("GET", "/api/conversations/\(id.uuidString.lowercased())", query: query)
    }

    @discardableResult
    public func deleteConversation(id: UUID) async throws -> DeletionReceipt {
        try await request("DELETE", "/api/conversations/\(id.uuidString.lowercased())")
    }

    public func memories(query: String? = nil, tier: String? = nil, kind: String? = nil,
                         status: String? = nil, cursor: String? = nil,
                         limit: Int = 30) async throws -> CentralPage<MemorySummary> {
        var queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        for (name, value) in [("query", query), ("tier", tier), ("kind", kind), ("status", status), ("cursor", cursor)] {
            if let value { queryItems.append(URLQueryItem(name: name, value: value)) }
        }
        return try await request("GET", "/api/memories", query: queryItems)
    }

    public func memory(id: UUID) async throws -> MemoryRecord {
        try await request("GET", "/api/memories/\(id.uuidString.lowercased())")
    }

    public func memoryEvidence(id: UUID) async throws -> MemoryEvidencePage {
        try await request("GET", "/api/memories/\(id.uuidString.lowercased())/evidence")
    }

    /// The same owner correction route and body as the web and Android detail.
    @discardableResult
    public func correctMemory(id: UUID, request correction: MemoryCorrectionRequest) async throws -> MemoryRecord {
        try await request("POST", "/api/memories/\(id.uuidString.lowercased())/correct", body: correction)
    }

    /// The same owner DELETE as the web and Android detail. Central keeps the
    /// original evidence; the receipt only describes the memory erasure.
    @discardableResult
    public func deleteMemory(id: UUID) async throws -> MemoryDeleteReceipt {
        try await request("DELETE", "/api/memories/\(id.uuidString.lowercased())")
    }

    /// Existing owner library browse used by the web and native library lists.
    public func library(query: String? = nil, after: String? = nil, before: String? = nil,
                        cursor: String? = nil, limit: Int = 30) async throws -> LibraryBrowsePage {
        var queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        for (name, value) in [("query", query), ("after", after), ("before", before), ("cursor", cursor)] {
            if let value, !value.isEmpty { queryItems.append(URLQueryItem(name: name, value: value)) }
        }
        return try await request("GET", "/api/library/browse", query: queryItems)
    }

    /// The same context-tree catalog Android reads before its memory filters.
    public func contextTrees() async throws -> ContextTreeCatalog {
        try await request("GET", "/api/context-trees")
    }

    /// `level=detail` is the existing memory list mode that includes the
    /// statement; it does not add a new data access path.
    public func memoryRecords(query: String? = nil, includeHistory: Bool = false,
                              cursor: String? = nil, limit: Int = 30) async throws -> CentralPage<MemoryRecord> {
        var queryItems = [
            URLQueryItem(name: "level", value: "detail"),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        if let query, !query.isEmpty { queryItems.append(URLQueryItem(name: "query", value: query)) }
        if includeHistory { queryItems.append(URLQueryItem(name: "includeHistory", value: "true")) }
        if let cursor, !cursor.isEmpty { queryItems.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("GET", "/api/memories", query: queryItems)
    }

    /// One filtered memory page from the existing context-tree route. The
    /// route returns overview rows; the caller reads each exact memory body.
    public func memoryContextPage(treeID: String, nodeID: String, query: String? = nil,
                                  includeHistory: Bool = false, cursor: String? = nil,
                                  limit: Int = 30) async throws -> CentralPage<MemorySummary> {
        var queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        if let query, !query.isEmpty { queryItems.append(URLQueryItem(name: "query", value: query)) }
        if includeHistory { queryItems.append(URLQueryItem(name: "includeHistory", value: "true")) }
        if let cursor, !cursor.isEmpty { queryItems.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("GET", "/api/context-trees/\(treeID)/nodes/\(nodeID)", query: queryItems)
    }

    /// Literal capture search used by the library page and Android's search.
    /// The caller reads each exact capture body only when it needs row details.
    public func contextSearch(query: String, after: String? = nil, before: String? = nil,
                              cursor: String? = nil, limit: Int = 20) async throws -> ContextSearchPage {
        var queryItems = [
            URLQueryItem(name: "query", value: query),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        for (name, value) in [("after", after), ("before", before), ("cursor", cursor)] {
            if let value, !value.isEmpty { queryItems.append(URLQueryItem(name: name, value: value)) }
        }
        return try await request("GET", "/api/context/search", query: queryItems)
    }

    /// Archived insight history. This is a read of reports Central already
    /// saved; the client never asks Central to generate one.
    public func insights(limit: Int = 30, cursor: String? = nil) async throws -> CentralPage<InsightReport> {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor, !cursor.isEmpty { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("GET", "/api/insights", query: query)
    }

    /// One saved insight by its result identity, the same route Android reads.
    public func insight(id: String) async throws -> InsightReport {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        let encoded = id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id
        return try await request("GET", "/api/insights/\(encoded)")
    }

    func request<Response: Decodable>(_ method: String, _ path: String,
                                      query: [URLQueryItem] = [], authenticated: Bool = true) async throws -> Response {
        try await perform(try makeRequest(method, path, query: query, authenticated: authenticated))
    }

    func request<Body: Encodable, Response: Decodable>(_ method: String, _ path: String,
                                                       query: [URLQueryItem] = [], body: Body,
                                                       authenticated: Bool = true) async throws -> Response {
        var request = try makeRequest(method, path, query: query, authenticated: authenticated)
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await perform(request)
    }

    private func makeRequest(_ method: String, _ path: String, query: [URLQueryItem], authenticated: Bool) throws -> URLRequest {
        guard var components = URLComponents(string: serverUrl + path) else { throw CentralError.invalidEndpoint }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw CentralError.invalidEndpoint }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(Self.protocolVersion, forHTTPHeaderField: "X-Mote-Protocol-Version")
        if authenticated { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func perform<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        let (data, response) = try await session.data(for: request, delegate: RejectRedirects.shared)
        return try Self.decode(data: data, response: response)
    }

    static func decode<Response: Decodable>(data: Data, response: URLResponse) throws -> Response {
        guard let http = response as? HTTPURLResponse else { throw CentralError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CentralError.http(status: http.statusCode, code: Self.failureCode(data))
        }
        do { return try JSONDecoder().decode(Response.self, from: data) }
        catch { throw CentralError.invalidResponse }
    }

    private static func failureCode(_ data: Data) -> String? {
        guard let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        for candidate in [value["reason"], value["code"], (value["error"] as? [String: Any])?["code"], value["error"]] {
            if let code = candidate as? String,
               code.range(of: #"^[a-z][a-z0-9_.-]{0,99}$"#, options: .regularExpression) != nil { return code }
        }
        return nil
    }
}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    static let shared = RejectRedirects()

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private struct RedemptionRequest: Codable {
    let code: String
    let deviceId: String
    let deviceName: String
    let platform: CentralPlatform
}
