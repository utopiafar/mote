import MoteCentral
import MoteDesign
import SwiftUI

/// Generated Memory detail states for visual and interaction checks. They use
/// the same views as live reads and never touch a profile.
struct MemoryDetailPreview: View {
    @State private var model: MemoryDetailModel
    @State private var evidenceID: String?

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let state = arguments.firstIndex(of: "-MoteMemoryDetailState").flatMap {
            arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil
        } ?? "base"
        _model = State(initialValue: MemoryDetailModel.preview(state: state))
    }

    var body: some View {
        ZStack {
            if let evidenceID {
                OriginalView(
                    presentation: presentation(for: evidenceID),
                    onBack: { self.evidenceID = nil },
                    onAsk: { _ in },
                    onDelete: { nil },
                    onDeleted: { self.evidenceID = nil }
                )
            } else if let content = model.content {
                MemoryDetailView(
                    model: model,
                    content: content,
                    onBack: {},
                    onOpenCapture: { id in evidenceID = id }
                )
            }
        }
        .statusBarHidden()
    }

    private func presentation(for id: String) -> OriginalPresentation {
        let row = model.content?.evidence.first { $0.id == id }
        let title = row?.title ?? "查看原始记录"
        return OriginalPresentation(
            id: id,
            title: title,
            text: "第 4 页：押金为两个月租金，下个月退，需要收据。退租时按交接单核对房屋和物品。",
            capturedAt: Date(),
            receivedAt: Date(),
            indexingStatus: "indexed",
            sourceDescription: "文件 · 我的 iPhone",
            referenceCount: 1,
            deletionKind: .capture
        )
    }
}
