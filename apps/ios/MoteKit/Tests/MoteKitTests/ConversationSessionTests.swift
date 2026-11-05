import Foundation
import MoteCentral
import XCTest

final class ConversationSessionTests: XCTestCase {
    private func run(_ id: String, status: QueryRunStatus = .running,
                     conversationId: String? = nil, message: String? = nil) -> QueryRun {
        let error = message.map { #"{"code":"failed","message":"\#($0)"}"# } ?? "null"
        return try! JSONDecoder().decode(QueryRun.self, from: Data("""
        {"id":"\(id)","status":"\(status.rawValue)","createdAt":"2026-11-05T06:00:00Z",
         "updatedAt":"2026-11-05T06:00:00Z","conversationId":\(conversationId.map { "\"\($0)\"" } ?? "null"),
         "turnId":null,"events":[],"error":\(error)}
        """.utf8))
    }

    private var runId: String { "11111111-2222-3333-4444-555555555555" }
    private var otherId: String { "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }
    private var conversationId: String { "99999999-8888-7777-6666-555555555555" }

    private func conversation(scope: ConversationScope = ConversationScope()) throws -> Conversation {
        try JSONDecoder().decode(Conversation.self, from: Data("""
        {"id":"\(conversationId)","title":"对话","createdAt":"2026-11-05T06:00:00Z",
         "updatedAt":"2026-11-05T06:00:00Z","turnCount":0,
         "scope":\(String(data: JSONEncoder().encode(scope), encoding: .utf8)!),
         "status":"completed","turns":[],"revision":1,"nextCursor":null}
        """.utf8))
    }

    func testAdmissionKeepsOneIdentityAcrossRetries() throws {
        var session = ConversationSession()
        session.editQuestion("  暖气费是怎么约定的？  ")
        let first = try XCTUnwrap(session.admission(timeZone: "Asia/Shanghai", newId: { self.runId }))
        XCTAssertEqual(first.id, runId)
        XCTAssertEqual(first.input.question, "暖气费是怎么约定的？")
        XCTAssertEqual(first.input.timeZone, "Asia/Shanghai")
        XCTAssertNil(first.input.conversationId)
        let retry = try XCTUnwrap(session.admission(timeZone: "Asia/Shanghai", newId: { "unused" }))
        XCTAssertEqual(retry, first)
        XCTAssertTrue(session.busy)
        XCTAssertEqual(session.inFlightQuestion, "暖气费是怎么约定的？")
    }

    func testRunningBlocksNewAdmissionAndExposesInFlightQuestion() throws {
        var session = ConversationSession()
        session.editQuestion("押金是多少？")
        _ = session.admission(timeZone: "Asia/Shanghai", newId: { self.runId })
        try session.receive(run(runId, status: .running))
        XCTAssertTrue(session.busy)
        XCTAssertEqual(session.inFlightQuestion, "押金是多少？")
        XCTAssertNil(session.admission(timeZone: "Asia/Shanghai"))
    }

    func testReceiveRejectsRunIdsThatDoNotMatchTheExpectedIdentity() throws {
        var session = ConversationSession()
        session.editQuestion("押金是多少？")
        _ = session.admission(timeZone: "Asia/Shanghai", newId: { self.runId })
        XCTAssertThrowsError(try session.receive(run(otherId))) { error in
            XCTAssertEqual(error as? QueryRunAdmissionError, .unconfirmed)
        }
        XCTAssertEqual(session.currentId, runId)
        XCTAssertNil(session.runStatus)
    }

    func testCancelledRunReleasesTheRequestAndRestoresNothingElse() throws {
        var session = ConversationSession()
        session.editQuestion("押金是多少？")
        _ = session.admission(timeZone: "Asia/Shanghai", newId: { self.runId })
        session.editQuestion("")
        try session.receive(run(runId, status: .cancelled))
        XCTAssertFalse(session.busy)
        XCTAssertNil(session.inFlightQuestion)
        XCTAssertEqual(session.runStatus, .cancelled)
    }

    func testCompletedRunClearsOnlyTheDraftThatProducedIt() throws {
        var session = ConversationSession()
        session.editQuestion("押金是多少？")
        _ = session.admission(timeZone: "Asia/Shanghai", newId: { self.runId })
        try session.receive(run(runId, status: .running))
        session.editQuestion("后来又改了")
        let update = try session.receive(run(runId, status: .completed, conversationId: conversationId))
        XCTAssertFalse(update.clearDraft)
        XCTAssertEqual(session.conversationId, conversationId)
        XCTAssertEqual(session.inFlightQuestion, nil)

        var same = ConversationSession()
        same.editQuestion("押金是多少？")
        _ = same.admission(timeZone: "Asia/Shanghai", newId: { self.runId })
        try same.receive(run(runId, status: .completed, conversationId: conversationId))
        XCTAssertEqual(same.conversationId, conversationId)
        XCTAssertFalse(same.hasDraft)
    }

    func testFailedRunKeepsFailureDetailsAndComposerRestoredQuestion() throws {
        var session = ConversationSession()
        session.editQuestion("押金是多少？")
        _ = session.admission(timeZone: "Asia/Shanghai", newId: { self.runId })
        session.editQuestion("")
        try session.receive(run(runId, status: .failed, message: "模型暂时不可用"))
        XCTAssertEqual(session.failureDetails?.requestId, runId)
        XCTAssertEqual(session.failureDetails?.message, "模型暂时不可用")
        XCTAssertFalse(session.busy)
        // The view restores the question from the failed admission on its own.
    }

    func testMissingRunRequeuesTheRetainedAdmission() throws {
        var session = ConversationSession()
        session.editQuestion("押金是多少？")
        let admission = try XCTUnwrap(session.admission(timeZone: "Asia/Shanghai", newId: { self.runId }))
        try session.receive(run(runId, status: .running))
        XCTAssertTrue(session.missingRun())
        XCTAssertEqual(session.pending, admission)
        XCTAssertEqual(session.currentId, runId)
    }

    func testRestoredScopeWritesAnchorAndClearWritesNulls() throws {
        let scoped = ConversationScope(anchorEvidenceIds: ["ev_1"])
        var session = ConversationSession()
        session.selectConversation(try conversation(scope: scoped))
        session.editQuestion("这份记录说了什么？")
        let anchored = try XCTUnwrap(session.admission(timeZone: "Asia/Shanghai", newId: { self.runId }))
        XCTAssertEqual(anchored.input.conversationId, conversationId)
        XCTAssertEqual(anchored.input.anchorEvidenceIds, .values(["ev_1"]))
        let body = String(data: try JSONEncoder().encode(anchored), encoding: .utf8)!
        XCTAssertTrue(body.contains("\"anchorEvidenceIds\":[\"ev_1\"]"))
        XCTAssertFalse(body.contains("\"evidenceIds\""))

        var cleared = ConversationSession()
        cleared.selectConversation(try conversation(scope: scoped))
        cleared.clearScope()
        cleared.editQuestion("换个范围")
        let clearedAdmission = try XCTUnwrap(cleared.admission(timeZone: "Asia/Shanghai", newId: { self.runId }))
        let clearedBody = String(data: try JSONEncoder().encode(clearedAdmission), encoding: .utf8)!
        XCTAssertTrue(clearedBody.contains("\"anchorEvidenceIds\":null"))
        XCTAssertTrue(clearedBody.contains("\"evidenceIds\":null"))
        XCTAssertTrue(clearedBody.contains("\"anchorMaterialRef\":null"))
    }

    func testSelectConversationClearsTheAcceptedRunIdentity() throws {
        var session = ConversationSession()
        session.editQuestion("押金是多少？")
        _ = session.admission(timeZone: "Asia/Shanghai", newId: { self.runId })
        try session.receive(run(runId, status: .running))
        session.selectConversation(try conversation())
        XCTAssertFalse(session.busy)
        XCTAssertNil(session.runStatus)
        XCTAssertEqual(session.conversationId, conversationId)
    }

    func testAdoptRunningOnlyAdoptsRunsForThisConversation() throws {
        var session = ConversationSession()
        session.selectConversation(try conversation())
        session.adoptRunning([run(runId, status: .running, conversationId: otherId)])
        XCTAssertFalse(session.busy)
        session.adoptRunning([run(runId, status: .running, conversationId: conversationId)])
        XCTAssertTrue(session.busy)
        XCTAssertEqual(session.runStatus, .running)
    }
}
