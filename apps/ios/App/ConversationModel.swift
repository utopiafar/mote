import Foundation
import MoteCentral
import MoteStorage
import Observation

struct ConversationCitationTarget: Equatable {
    let id: String
    let phrase: String?
}

/// Drives one conversation thread: loads turns, admits question runs through
/// the existing query-run endpoints, polls while running, stops on cancel and
/// keeps draft/run identity semantics identical to the other clients.
@MainActor
@Observable
final class ConversationModel {
    struct Transport {
        var conversation: (UUID) async throws -> Conversation
        var runs: () async throws -> [QueryRun]
        var startRun: (QueryRunAdmission) async throws -> QueryRun
        var pollRun: (UUID) async throws -> QueryRun
        var cancelRun: (UUID) async throws -> QueryRun
        var materialTitle: (String) async -> String?
        var referenceAvailable: (UUID, UUID) async throws -> Bool
    }

    private(set) var conversation: Conversation?
    private(set) var loading = true
    private(set) var offline = false
    private(set) var sending = false
    private(set) var session = ConversationSession()
    private(set) var scopeTitle: String?
    private(set) var latestEventMessage: String?
    /// Preview hook: the streamed partial answer shown while a run resolves.
    var previewPartialAnswer: String?
    private(set) var citationUnavailable = false
    private(set) var turnFailure: String?
    private(set) var detailTurn: ConversationTurn?

    private let transport: Transport
    private let newId: () -> String
    private let pollIntervalNs: UInt64
    private let onOpenOriginal: (ConversationCitationTarget) -> Void
    private var generation = 0
    private var pollTask: Task<Void, Never>?

    init(conversationId: String?, scope: OriginalAskScope?,
         transport: Transport, pollIntervalNs: UInt64 = 1_000_000_000,
         newId: @escaping () -> String = { UUID().uuidString },
         onOpenOriginal: @escaping (ConversationCitationTarget) -> Void) {
        self.transport = transport
        self.pollIntervalNs = pollIntervalNs
        self.newId = newId
        self.onOpenOriginal = onOpenOriginal
        if let scope {
            session.newConversation(scope: scope.conversationScope)
            scopeTitle = scope.title
        }
        if let conversationId {
            session.restoreConversationId(conversationId)
        }
    }

    static func live(conversationId: String?, scope: OriginalAskScope?,
                     onOpenOriginal: @escaping (ConversationCitationTarget) -> Void) -> ConversationModel {
        func client() throws -> CentralClient {
            guard let connection = try MoteStorage.connectionStore().read() else { throw ConversationError.notConnected }
            return try CentralClient(serverUrl: connection.serverUrl, token: connection.token)
        }
        return ConversationModel(conversationId: conversationId, scope: scope, transport: Transport(
            conversation: { try await client().conversation(id: $0) },
            runs: { try await client().queryRuns().items },
            startRun: { try await client().startQueryRun($0) },
            pollRun: { try await client().queryRun(id: $0) },
            cancelRun: { try await client().cancelQueryRun(id: $0) },
            materialTitle: { try? await client().materialTitle(ref: $0) },
            referenceAvailable: { conversation, evidence in
                do {
                    return try await client().conversationReference(conversationId: conversation, evidenceId: evidence).available
                } catch let error as CentralError {
                    if case .http(let status, _) = error, status == 404 { return false }
                    throw error
                }
            }), onOpenOriginal: onOpenOriginal)
    }

    var question: String {
        get { session.questionDraft }
        set { session.editQuestion(newValue) }
    }

    var turns: [ConversationTurn] { conversation?.turns ?? [] }
    var busy: Bool { session.busy || sending }
    var inFlightQuestion: String? { session.inFlightQuestion }
    var citationNumbers: [String: Int] { ConversationPresentation.citationNumbers(turns: turns) }
    var scopeLabel: String? {
        session.scoped ? ConversationPresentation.scopeLabel(scope: session.scope, materialTitle: scopeTitle) : nil
    }
    /// The text shown while a run is unresolved: a streamed partial in
    /// previews, otherwise the latest run progress message.
    var runningText: String { previewPartialAnswer ?? latestEventMessage ?? "中央正在回答…" }
    /// True when `runningText` is a progress note rather than partial answer.
    var runningTextIsStatusOnly: Bool { previewPartialAnswer == nil }

    func open() async {
        generation += 1
        let current = generation
        offline = false
        loading = conversation == nil && session.conversationId == nil
        do {
            if let id = session.conversationId.flatMap(UUID.init(uuidString:)), conversation == nil {
                let loaded = try await transport.conversation(id)
                guard current == generation else { return }
                session.selectConversation(loaded)
                conversation = loaded
            }
            let runs = (try? await transport.runs()) ?? []
            guard current == generation else { return }
            session.adoptRunning(runs)
            if let adopted = session.conversationId.flatMap(UUID.init(uuidString:)), conversation?.id != adopted.uuidString.lowercased() {
                let loaded = try await transport.conversation(adopted)
                guard current == generation else { return }
                conversation = loaded
                session.restoreScope(loaded)
            }
            await loadScopeTitle()
            if session.busy { startPolling() }
        } catch {
            guard current == generation else { return }
            offline = true
        }
        guard current == generation else { return }
        loading = false
    }

    func send() async {
        guard !session.busy, !sending else { return }
        guard let admission = session.admission(timeZone: TimeZone.current.identifier, newId: newId) else { return }
        // The committed question moves into the thread as its own bubble.
        question = ""
        sending = true
        defer { sending = false }
        do {
            let run = try await transport.startRun(admission)
            try session.receive(run)
            latestEventMessage = run.events.last?.message
            handleTerminal(run, sentQuestion: admission.input.question)
        } catch QueryRunAdmissionError.unconfirmed {
            offline = true
        } catch {
            // The admission stays pending with its identity; the composer
            // keeps the question so the same request retries unchanged.
            question = admission.input.question
            offline = true
        }
    }

    /// The offline banner action: retry the pending admission unchanged when
    /// one is held, otherwise reconnect and reload the thread.
    func retry() async {
        if session.pending != nil {
            offline = false
            await resendPending()
        } else {
            await open()
        }
    }

    private func resendPending() async {
        guard let pending = session.pending, !sending else { return }
        sending = true
        defer { sending = false }
        do {
            let run = try await transport.startRun(pending)
            try session.receive(run)
            latestEventMessage = run.events.last?.message
            handleTerminal(run, sentQuestion: pending.input.question)
        } catch {
            offline = true
        }
    }

    func stop() async {
        guard let uuid = UUID(uuidString: session.currentId) else { return }
        pollTask?.cancel()
        // Let an in-flight poll settle first so its stale receipt cannot
        // re-mark the run running after the cancel response lands.
        _ = await pollTask?.value
        let stopped = session.inFlightQuestion
        do {
            let run = try await transport.cancelRun(uuid)
            try session.receive(run)
            if let stopped { question = stopped }
        } catch {
            startPolling()
        }
    }

    func clearScope() {
        session.clearScope()
        scopeTitle = nil
    }

    /// A citation opens the original location only while the conversation
    /// still references the evidence; anything else shows the shared notice.
    func openCitation(turn: ConversationTurn, citation: Answer.Citation) async {
        guard let conversationIdString = conversation?.id,
              let conversationId = UUID(uuidString: conversationIdString),
              let evidenceId = UUID(uuidString: citation.id),
              turn.evidenceDeleted != true,
              turn.result?.citations.contains(where: { $0.id == citation.id }) == true else {
            citationUnavailable = true
            return
        }
        do {
            if try await transport.referenceAvailable(conversationId, evidenceId) {
                onOpenOriginal(ConversationCitationTarget(
                    id: citation.id, phrase: citation.excerpt.isEmpty ? nil : citation.excerpt))
            } else {
                citationUnavailable = true
            }
        } catch {
            citationUnavailable = true
        }
    }

    func showDetails(_ turn: ConversationTurn) { detailTurn = turn }
    func showFailure(_ turn: ConversationTurn) { turnFailure = turn.error?.message ?? "回答未完成" }
    func dismissDetails() { detailTurn = nil }
    func dismissCitationNotice() { citationUnavailable = false }
    func dismissFailure() { turnFailure = nil }

    private func handleTerminal(_ run: QueryRun, sentQuestion: String) {
        guard run.status.terminal else { startPolling(); return }
        pollTask?.cancel()
        if run.status == .cancelled || run.status == .failed {
            question = sentQuestion
        }
        if run.status != .cancelled {
            Task { await reloadConversation() }
        }
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, session.runStatus == .running, let uuid = UUID(uuidString: session.currentId) {
                try? await Task.sleep(nanoseconds: pollIntervalNs)
                guard !Task.isCancelled else { return }
                do {
                    let run = try await transport.pollRun(uuid)
                    guard !Task.isCancelled else { return }
                    let sentQuestion = session.inFlightQuestion
                    latestEventMessage = run.events.last?.message ?? latestEventMessage
                    try session.receive(run)
                    if run.status.terminal { handleTerminal(run, sentQuestion: sentQuestion ?? ""); return }
                } catch let error as CentralError {
                    if case .http(let status, _) = error, status == 404 {
                        if session.missingRun() { question = session.pending?.input.question ?? question }
                        offline = true
                    } else {
                        offline = true
                    }
                    return
                } catch {
                    offline = true
                    return
                }
            }
        }
    }

    private func reloadConversation() async {
        guard let id = session.conversationId.flatMap(UUID.init(uuidString:)) else { return }
        if let loaded = try? await transport.conversation(id) {
            conversation = loaded
            session.restoreScope(loaded)
            await loadScopeTitle()
        }
    }

    private func loadScopeTitle() async {
        guard session.scoped, let ref = session.scope.anchorMaterialRef, !ref.isEmpty else { return }
        scopeTitle = await transport.materialTitle(ref)
    }

    /// Preview/screenshot fixtures place the model straight into one state.
    func applyFixture(conversation: Conversation?, session: ConversationSession,
                      offline: Bool = false, scopeTitle: String? = nil,
                      partialAnswer: String? = nil, eventMessage: String? = nil) {
        self.conversation = conversation
        self.session = session
        self.offline = offline
        self.scopeTitle = scopeTitle
        self.previewPartialAnswer = partialAnswer
        self.latestEventMessage = eventMessage
        loading = false
    }
}

private enum ConversationError: Error {
    case notConnected
}
