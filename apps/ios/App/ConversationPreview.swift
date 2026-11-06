import Foundation
import MoteCentral
import MoteCore
import SwiftUI

/// Generated conversation thread for the simulator's visual and interaction
/// tests. `-MoteConversationState` selects answered / streaming / offline /
/// anchored / flow (history push for back-navigation checks).
struct ConversationPreview: View {
    static let conversationId = "11111111-2222-3333-4444-555555555555"
    static let evidenceA = "aaaaaaaa-1111-2222-3333-444444444444"
    static let evidenceB = "bbbbbbbb-1111-2222-3333-444444444444"
    static let runId = "dddddddd-1111-2222-3333-444444444444"

    /// Keeps the fixture model alive across body evaluations; recreating it
    /// per render would drop the cancelled run state back to streaming.
    final class ModelBox { var model: ConversationModel? }

    @State private var lastAction = "none"
    @State private var savedPayload = "none"
    private let box = ModelBox()
    private let state: String
    private let now = ISO8601DateFormatter().date(from: "2026-11-05T08:00:00Z")!
    private let calendar: Calendar = {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(secondsFromGMT: 8 * 60 * 60)!
        return value
    }()

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        state = arguments.firstIndex(of: "-MoteConversationState").flatMap {
            arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil
        } ?? "answered"
    }

    var body: some View {
        Group {
            if state == "flow" {
                flow
            } else {
                ConversationView(
                    model: box.model ?? fixtureModel(state: state), now: now, calendar: calendar,
                    onBack: { lastAction = "back" },
                    onAddImage: { lastAction = "image" },
                    saveAnswerRecord: { quote, note, description in
                        savedPayload = "\(quote.text)\u{1F}\(note)\u{1F}\(description)"
                        lastAction = "saved"
                    }
                )
            }
        }
        .overlay(alignment: .topLeading) {
            VStack(spacing: 0) {
                Text(lastAction)
                    .accessibilityIdentifier("conversation-preview-action")
                Text(box.model.map { "busy:\($0.busy) status:\($0.session.runStatus?.rawValue ?? "nil") draft:\($0.question)" } ?? "nomodel")
                    .accessibilityIdentifier("conversation-preview-state")
                Text(savedPayload)
                    .accessibilityIdentifier("conversation-preview-saved")
            }
            .font(.system(size: 1))
            .opacity(0.01)
            .frame(width: 1, height: 1)
        }
    }

    private var flow: some View {
        ConversationFlowView(
            onDismiss: { lastAction = "dismiss" },
            onAddImage: { lastAction = "image" },
            makeHistoryModel: {
                ConversationHistoryModel { _ in
                    HistoryPage(conversations: [
                        HistoryConversation(id: ConversationPreview.conversationId,
                                            title: "暖气费是怎么约定的？", updatedAt: now),
                    ], nextCursor: nil)
                } remove: { _ in }
            },
            makeModel: { id, scope, open in
                fixtureModel(state: "answered", conversationId: id,
                             onOpenOriginal: { target in
                                lastAction = "opened.\(target.id)"
                                open(target)
                             })
            }
        )
    }

    @MainActor
    private func fixtureModel(state: String, conversationId: String? = ConversationPreview.conversationId,
                            onOpenOriginal: ((ConversationCitationTarget) -> Void)? = nil) -> ConversationModel {
        let model = ConversationModel(
            conversationId: conversationId, scope: nil,
            transport: ConversationModel.Transport(
                conversation: { _ in try Self.fixtureConversation(streaming: state == "streaming") },
                runs: { [] },
                startRun: { _ in throw ConversationPreviewError.offline },
                pollRun: { _ in try Self.fixtureRun() },
                cancelRun: { _ in try Self.fixtureRun(status: .cancelled) },
                materialTitle: { _ in "租房合同 2026.pdf" },
                referenceAvailable: { _, _ in true }),
            onOpenOriginal: onOpenOriginal ?? { target in lastAction = "opened.\(target.id)" })
        var session = ConversationSession()
        session.restoreConversationId(Self.conversationId)
        switch state {
        case "streaming":
            session.editQuestion("押金是多少？")
            _ = session.admission(timeZone: "Asia/Shanghai", newId: { ConversationPreview.runId })
            // The composer clears the committed question, matching send().
            session.editQuestion("")
            _ = try! session.receive(try! Self.fixtureRun())
            model.applyFixture(conversation: try! Self.fixtureConversation(streaming: true),
                               session: session, partialAnswer: "合同第 4 页写的是两个月")
        case "offline":
            model.applyFixture(conversation: try! Self.fixtureConversation(), session: session, offline: true)
        case "anchored":
            let conversation = try! Self.fixtureConversation(scoped: true)
            session.restoreScope(conversation)
            model.applyFixture(conversation: conversation, session: session,
                               scopeTitle: "租房合同 2026.pdf")
        default:
            model.applyFixture(conversation: try! Self.fixtureConversation(), session: session)
        }
        box.model = model
        return model
    }

    private static func fixtureRun(status: QueryRunStatus = .running) throws -> QueryRun {
        try JSONDecoder().decode(QueryRun.self, from: Data("""
        {"id":"\(runId)","status":"\(status.rawValue)","createdAt":"2026-11-05T07:30:00Z",
         "updatedAt":"2026-11-05T07:30:00Z","conversationId":"\(conversationId)",
         "turnId":null,"events":[],"error":null}
        """.utf8))
    }

    private static func fixtureConversation(streaming: Bool = false, scoped: Bool = false) throws -> Conversation {
        let a = evidenceA, b = evidenceB
        let secondTurn = """
        ,{"id":"turn-2","question":"押金是多少？","scope":{},
         "result":{"answer":"合同第 4 页写的是两个月租金[\(b)]。","runId":"\(runId)",
         "citations":[{"id":"\(b)","capturedAt":"2026-11-04T10:00:00Z","appName":"文件",
         "excerpt":"押金为两个月租金","contentAt":null,"title":"租房合同 2026.pdf","location":"第 4 页"}],
         "trace":[],"usage":null,"modelSelection":null,"createdAt":null,"id":null},
         "status":"completed","error":null,"createdAt":"2026-11-05T07:00:00Z"}
        """
        return try JSONDecoder().decode(Conversation.self, from: Data("""
        {"id":"\(conversationId)","title":"暖气费是怎么约定的？","createdAt":"2026-11-05T06:00:00Z",
         "updatedAt":"2026-11-05T07:00:00Z","turnCount":2,
         "scope":\(scoped ? #"{"anchorMaterialRef":"material:mat_x@y"}"# : "{}"),"status":"completed",
         "turns":[
            {"id":"turn-1","question":"暖气费是怎么约定的？","scope":{},
             "result":{"answer":"按实际用量分摊[\(a)]，月底前把账单照片发给房东[\(a)]；押金下个月退，需要收据[\(b)]。",
             "runId":"\(runId)",
             "citations":[{"id":"\(a)","capturedAt":"2026-11-05T06:20:00Z","appName":"备忘录",
             "excerpt":"暖气费按实际用量分摊，月底前给账单照片","contentAt":null,
             "title":"暖气费按实际用量分摊，月底前给账单照片","location":null},
             {"id":"\(b)","capturedAt":"2026-11-04T10:00:00Z","appName":"文件",
             "excerpt":"押金为两个月租金","contentAt":null,"title":"租房合同 2026.pdf","location":"第 4 页"}],
             "trace":[],"usage":null,"modelSelection":null,"createdAt":null,"id":null},
             "status":"completed","error":null,"createdAt":"2026-11-05T06:30:00Z"}
            \(streaming ? "" : secondTurn)
         ],"revision":1,"nextCursor":null}
        """.utf8))
    }
}

private enum ConversationPreviewError: Error {
    case offline
}
