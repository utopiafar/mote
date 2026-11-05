import Foundation

public enum QueryRunStatus: String, Codable, Equatable, Sendable {
    case running, completed, failed, cancelled

    public var terminal: Bool { self != .running }
}

public struct QueryRunEvent: Codable, Equatable, Sendable {
    public let stage: String
    public let at: String
    public let tool: String?
    public let message: String?
    public let count: Int?
    public let phase: String?
    public let step: Int?
}

public struct QueryRun: Codable, Equatable, Sendable {
    public struct Failure: Codable, Equatable, Sendable {
        public let code: String?
        public let message: String
    }

    public let id: String
    public let status: QueryRunStatus
    public let createdAt: String
    public let updatedAt: String
    public let conversationId: String?
    public let turnId: String?
    public let events: [QueryRunEvent]
    public let error: Failure?
}

public struct QueryRunList: Codable, Equatable, Sendable {
    public let items: [QueryRun]
}

/// One retryable question admission. Scope fields are tri-state so clearing a
/// restored conversation scope sends explicit nulls instead of silently
/// keeping the previous scope.
public struct QueryRunInput: Equatable, Sendable {
    public enum ReferenceField: Equatable, Sendable {
        case unset
        case cleared
        case values([String])
    }

    public var question: String
    public var timeZone: String
    public var conversationId: String?
    public var attachmentIds: [String]?
    public var evidenceIds: ReferenceField = .unset
    public var anchorEvidenceIds: ReferenceField = .unset
    public var anchorMaterialRef: ReferenceField = .unset

    public init(question: String, timeZone: String, conversationId: String? = nil,
                attachmentIds: [String]? = nil) {
        self.question = question
        self.timeZone = timeZone
        self.conversationId = conversationId
        self.attachmentIds = attachmentIds
    }
}

extension QueryRunInput: Codable {
    private enum CodingKeys: String, CodingKey {
        case question, timeZone, conversationId, attachmentIds
        case evidenceIds, anchorEvidenceIds, anchorMaterialRef
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(question, forKey: .question)
        try container.encode(timeZone, forKey: .timeZone)
        try container.encodeIfPresent(conversationId, forKey: .conversationId)
        try container.encodeIfPresent(attachmentIds, forKey: .attachmentIds)
        try encodeReference(evidenceIds, into: &container, key: .evidenceIds)
        try encodeReference(anchorEvidenceIds, into: &container, key: .anchorEvidenceIds)
        try encodeReference(anchorMaterialRef, into: &container, key: .anchorMaterialRef)
    }

    private func encodeReference(_ field: ReferenceField,
                                 into container: inout KeyedEncodingContainer<CodingKeys>,
                                 key: CodingKeys) throws {
        switch field {
        case .unset: break
        case .cleared: try container.encodeNil(forKey: key)
        case .values(let values): try container.encode(values, forKey: key)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        question = try container.decode(String.self, forKey: .question)
        timeZone = try container.decode(String.self, forKey: .timeZone)
        conversationId = try container.decodeIfPresent(String.self, forKey: .conversationId)
        attachmentIds = try container.decodeIfPresent([String].self, forKey: .attachmentIds)
        evidenceIds = try Self.decodeReference(container, key: .evidenceIds)
        anchorEvidenceIds = try Self.decodeReference(container, key: .anchorEvidenceIds)
        anchorMaterialRef = try Self.decodeReference(container, key: .anchorMaterialRef)
    }

    private static func decodeReference(_ container: KeyedDecodingContainer<CodingKeys>,
                                        key: CodingKeys) throws -> ReferenceField {
        guard container.contains(key) else { return .unset }
        if try container.decodeNil(forKey: key) { return .cleared }
        return .values(try container.decode([String].self, forKey: key))
    }
}

public struct QueryRunAdmission: Equatable, Sendable {
    public let id: String
    public let input: QueryRunInput

    public init(id: String, input: QueryRunInput) {
        self.id = id
        self.input = input
    }
}

extension QueryRunAdmission: Codable {}

public enum QueryRunAdmissionError: Error, Equatable {
    case unconfirmed
}

public struct MaterialTitle: Codable, Equatable, Sendable {
    public let title: String?
}

public struct ConversationReference: Codable, Equatable, Sendable {
    public let id: String
    public let available: Bool
}

/// Run admission identity and draft ownership for one conversation. Mirrors the
/// shared run receipt rules: a run id is validated before it applies, a
/// completed run clears only the draft that produced it, and terminal runs
/// release the active request.
public struct ConversationSession: Equatable, Sendable {
    public struct RunUpdate: Equatable, Sendable {
        public let runId: String
        public let status: QueryRunStatus
        public let conversationId: String?
        public let clearDraft: Bool
    }

    public struct RunFailure: Equatable, Sendable {
        public let requestId: String
        public let message: String
    }

    public private(set) var conversationId: String?
    public private(set) var questionDraft = ""
    /// Scope inherited from the loaded conversation or a scoped entry point.
    public private(set) var scope = ConversationScope()
    /// A cleared server-side scope is rewritten as explicit nulls on send.
    public private(set) var scopeCleared = false
    public private(set) var pending: QueryRunAdmission?
    public private(set) var activeRequest: QueryRunAdmission?
    public private(set) var runId: String?
    public private(set) var runStatus: QueryRunStatus?
    public private(set) var failureDetails: RunFailure?

    public init() {}

    public var busy: Bool { pending != nil || runStatus == .running }
    public var currentId: String { pending?.id ?? runId ?? "" }
    public var hasDraft: Bool { !questionDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The question committed to the in-flight admission, shown as its own
    /// bubble while the run is unresolved.
    public var inFlightQuestion: String? {
        busy ? (activeRequest ?? pending)?.input.question : nil
    }

    public var scoped: Bool {
        !scopeCleared && (scope.evidenceIds?.isEmpty == false
                          || scope.anchorEvidenceIds?.isEmpty == false
                          || scope.anchorMaterialRef?.isEmpty == false)
    }

    public mutating func editQuestion(_ text: String) { questionDraft = text }

    /// Selecting another conversation clears the unsent composer and the
    /// accepted run identity instead of carrying either across.
    public mutating func selectConversation(_ conversation: Conversation) {
        conversationId = conversation.id
        questionDraft = ""
        scope = conversation.scope
        scopeCleared = false
        clearRunIdentity()
    }

    public mutating func newConversation(scope: ConversationScope = ConversationScope()) {
        conversationId = nil
        questionDraft = ""
        self.scope = scope
        scopeCleared = false
        clearRunIdentity()
    }

    private mutating func clearRunIdentity() {
        pending = nil
        activeRequest = nil
        runId = nil
        runStatus = nil
        failureDetails = nil
    }

    /// A restored run belongs to this conversation when its conversationId
    /// matches (or this page has no conversation yet).
    public mutating func adoptRunning(_ runs: [QueryRun]) {
        guard !busy else { return }
        guard let run = runs.first(where: { $0.status == .running
            && (conversationId == nil || $0.conversationId == conversationId) }) else { return }
        runId = run.id
        runStatus = .running
        if let id = run.conversationId, !id.isEmpty { conversationId = id }
    }

    public mutating func clearScope() {
        guard !busy else { return }
        let hadScope = scope.evidenceIds?.isEmpty == false
            || scope.anchorEvidenceIds?.isEmpty == false
            || scope.anchorMaterialRef?.isEmpty == false
        scopeCleared = conversationId != nil && hadScope
        scope = ConversationScope()
    }

    /// Build the one retryable admission body for the current draft. An
    /// existing unconfirmed admission keeps its exact identity.
    public mutating func admission(timeZone: String, newId: () -> String = { UUID().uuidString }) -> QueryRunAdmission? {
        if let pending { return pending }
        guard runStatus != .running else { return nil }
        let question = questionDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, question.utf8.count <= 8000 else { return nil }
        var input = QueryRunInput(question: question, timeZone: timeZone, conversationId: conversationId)
        if scopeCleared {
            input.evidenceIds = .cleared
            input.anchorEvidenceIds = .cleared
            input.anchorMaterialRef = .cleared
        } else {
            if let ids = scope.evidenceIds, !ids.isEmpty { input.evidenceIds = .values(ids) }
            if let ids = scope.anchorEvidenceIds, !ids.isEmpty { input.anchorEvidenceIds = .values(ids) }
            if let ref = scope.anchorMaterialRef, !ref.isEmpty { input.anchorMaterialRef = .values([ref]) }
        }
        let admission = QueryRunAdmission(id: newId(), input: input)
        pending = admission
        return admission
    }

    /// Apply the exact accepted run receipt. A run that does not match the
    /// expected identity fails instead of touching the session.
    @discardableResult
    public mutating func receive(_ run: QueryRun, expected: String? = nil) throws -> RunUpdate {
        let expectedId = expected ?? currentId
        guard UUID(uuidString: run.id) != nil, run.id == expectedId else {
            throw QueryRunAdmissionError.unconfirmed
        }
        if let pending, pending.id == run.id { activeRequest = pending }
        pending = nil
        failureDetails = nil
        if run.status == .failed, let error = run.error {
            failureDetails = RunFailure(requestId: run.id, message: error.message)
        }
        let clearDraft = run.status == .completed && completesCurrentDraft(run)
        runId = run.id
        runStatus = run.status
        if let conversation = run.conversationId, !conversation.isEmpty { conversationId = conversation }
        if clearDraft { questionDraft = "" }
        if run.status.terminal { activeRequest = nil }
        return RunUpdate(runId: run.id, status: run.status, conversationId: run.conversationId, clearDraft: clearDraft)
    }

    /// The page can hold the selected conversation id before its full body
    /// loads; the stored conversation replaces it once available.
    public mutating func restoreConversationId(_ id: String) {
        conversationId = id
    }

    /// Restore the server-side scope after a conversation reload. The stored
    /// conversation is authoritative for what the next question searches;
    /// an in-flight run already carries its own scope inside its input.
    public mutating func restoreScope(_ conversation: Conversation) {
        conversationId = conversation.id
        scope = conversation.scope
        scopeCleared = false
    }

    /// A 404 for the held run id re-queues the retained admission when its
    /// request body is still known; adopted runs keep their identity held.
    @discardableResult
    public mutating func missingRun() -> Bool {
        if pending != nil { return true }
        if let request = activeRequest, request.id == runId {
            pending = request
            return true
        }
        return false
    }

    private func completesCurrentDraft(_ run: QueryRun) -> Bool {
        guard let request = activeRequest, request.id == run.id else { return false }
        return questionDraft.trimmingCharacters(in: .whitespacesAndNewlines) == request.input.question
    }
}

public extension CentralClient {
    /// 202-admits one question run. Retrying with the same admission body is
    /// idempotent on the server.
    func startQueryRun(_ admission: QueryRunAdmission) async throws -> QueryRun {
        try await request("POST", "/api/query-runs", body: admission)
    }

    func queryRun(id: UUID) async throws -> QueryRun {
        try await request("GET", "/api/query-runs/\(id.uuidString.lowercased())")
    }

    func queryRuns() async throws -> QueryRunList {
        try await request("GET", "/api/query-runs")
    }

    @discardableResult
    func cancelQueryRun(id: UUID) async throws -> QueryRun {
        try await request("POST", "/api/query-runs/\(id.uuidString.lowercased())/cancel")
    }

    /// The scope chip label for a material anchor, when the material still
    /// resolves. Malformed refs carry no title instead of a guess.
    func materialTitle(ref: String) async throws -> String? {
        guard ref.hasPrefix("material:mat_"), ref.contains("@") else { return nil }
        let id = String(ref.dropFirst("material:".count).prefix(while: { $0 != "@" }))
        let material: MaterialTitle = try await request("GET", "/api/materials/\(id)")
        return material.title
    }

    func conversationReference(conversationId: UUID, evidenceId: UUID) async throws -> ConversationReference {
        let path = "/api/conversations/\(conversationId.uuidString.lowercased())/references/\(evidenceId.uuidString.lowercased())"
        return try await request("GET", path)
    }
}
