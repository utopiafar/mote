import MoteCentral
import MoteDesign
import SwiftUI

/// One navigation stack for 问一问: the history list is the root, opened or
/// sent questions push the conversation page, and citations push the original
/// record highlighted at the quoted position.
enum ConversationRoute: Hashable {
    case conversation(id: String?, question: String?)
    case scoped(OriginalAskScope)
    case original(id: String, phrase: String?)
}

/// Keeps one model per route alive for the flow's lifetime; rebuilding the
/// model on every body evaluation would drop in-flight run state.
final class ConversationModelCache {
    private var models: [String: ConversationModel] = [:]
    private var history: ConversationHistoryModel?

    func historyModel(make: () -> ConversationHistoryModel) -> ConversationHistoryModel {
        if let history { return history }
        let model = make()
        history = model
        return model
    }

    func model(_ key: String, make: () -> ConversationModel) -> ConversationModel {
        if let model = models[key] { return model }
        let model = make()
        models[key] = model
        return model
    }
}

struct ConversationFlowView: View {
    /// When set, the stack roots at a fresh scoped conversation instead of
    /// the history list.
    var scope: OriginalAskScope? = nil
    let onDismiss: () -> Void
    let onAddImage: () -> Void
    var makeHistoryModel: () -> ConversationHistoryModel = { .live() }
    var makeModel: (String?, OriginalAskScope?,
                    @escaping (ConversationCitationTarget) -> Void) -> ConversationModel
        = { id, scope, open in .live(conversationId: id, scope: scope, onOpenOriginal: open) }

    @State private var path: [ConversationRoute] = []
    private let cache = ConversationModelCache()

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let scope {
                    conversationView(key: "scoped", id: nil, scope: scope, question: nil)
                } else {
                    ConversationHistoryView(
                        model: cache.historyModel(make: makeHistoryModel), now: Date(), calendar: .current,
                        onBack: onDismiss,
                        onOpen: { path.append(.conversation(id: $0, question: nil)) },
                        onSend: { path.append(.conversation(id: nil, question: $0)) },
                        onAddImage: onAddImage
                    )
                }
            }
            .navigationDestination(for: ConversationRoute.self) { route in
                switch route {
                case .conversation(let id, let question):
                    conversationView(key: "conv.\(id ?? "new").\(question ?? "")",
                                     id: id, scope: nil, question: question)
                case .scoped(let scope):
                    conversationView(key: "scoped", id: nil, scope: scope, question: nil)
                case .original(let id, let phrase):
                    OriginalRootView(id: id, highlightedPhrase: phrase,
                                     onDeleted: { path.removeLast() },
                                     onAsk: { path.append(.scoped($0)) })
                }
            }
        }
    }

    private func conversationView(key: String, id: String?, scope: OriginalAskScope?, question: String?) -> some View {
        ConversationView(
            model: cache.model(key) {
                makeModel(id, scope, { path.append(.original(id: $0.id, phrase: $0.phrase)) })
            },
            now: Date(), calendar: .current,
            initialQuestion: question,
            onBack: {
                if path.isEmpty { onDismiss() } else { path.removeLast() }
            },
            onAddImage: onAddImage
        )
    }
}
