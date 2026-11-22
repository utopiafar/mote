import MoteCentral
import MoteDesign
import MoteStorage
import SwiftUI

/// One navigation stack for 问一问: the server's main conversation is the root,
/// and citations push the original record highlighted at the quoted position.
enum ConversationRoute: Hashable {
    case conversation(id: String?, question: String?)
    case scoped(OriginalAskScope)
    case original(id: String, phrase: String?)
}

/// Keeps one model per route alive for the flow's lifetime; rebuilding the
/// model on every body evaluation would drop in-flight run state.
final class ConversationModelCache {
    private var models: [String: ConversationModel] = [:]

    func model(_ key: String, make: () -> ConversationModel) -> ConversationModel {
        if let model = models[key] { return model }
        let model = make()
        models[key] = model
        return model
    }
}

struct ConversationFlowView: View {
    /// When set, the stack roots at a fresh scoped conversation instead of
    /// the main conversation.
    var scope: OriginalAskScope? = nil
    let onDismiss: () -> Void
    let onAddImage: () -> Void
    var makeMainConversation: () async throws -> String = {
        guard let connection = try MoteStorage.connectionStore().read() else { throw ConversationFlowError.notConnected }
        let id = try await CentralClient(serverUrl: connection.serverUrl, token: connection.token).mainConversation().id
        guard UUID(uuidString: id) != nil else { throw ConversationFlowError.invalidIdentity }
        return id
    }
    var makeModel: (String?, OriginalAskScope?,
                    @escaping (ConversationCitationTarget) -> Void) -> ConversationModel
        = { id, scope, open in .live(conversationId: id, scope: scope, onOpenOriginal: open) }

    @State private var path: [ConversationRoute] = []
    @State private var mainConversationID: String?
    @State private var mainLoadFailed = false
    private let cache = ConversationModelCache()

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let scope {
                    conversationView(key: "scoped", id: nil, scope: scope, question: nil)
                } else if let mainConversationID {
                    conversationView(key: "main", id: mainConversationID, scope: nil, question: nil)
                } else {
                    mainLoading
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

    private var mainLoading: some View {
        VStack(spacing: 12) {
            if mainLoadFailed {
                Text("对话暂不可读取，请稍后重试。")
                    .font(MoteFont.body)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                Button("重试") { Task { await loadMainConversation() } }
                    .font(MoteFont.smallAction)
                    .frame(minHeight: MoteMetrics.touchTarget)
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MoteDesignTokens.background.color)
        .task { await loadMainConversation() }
    }

    private func loadMainConversation() async {
        guard mainConversationID == nil else { return }
        mainLoadFailed = false
        do {
            mainConversationID = try await makeMainConversation()
        } catch {
            mainLoadFailed = true
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

private enum ConversationFlowError: Error {
    case notConnected, invalidIdentity
}
