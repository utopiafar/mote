import MoteCentral
import MoteDesign
import SwiftUI

/// Generated discovery states for visual and interaction checks. They reuse
/// the live views and never touch a profile or Central.
struct DiscoveryPreview: View {
    @State private var model: DiscoveryModel
    @State private var detail: InsightDetailModel?
    @State private var originalID: String?

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let state = arguments.firstIndex(of: "-MoteDiscoveryState").flatMap {
            arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil
        } ?? "list"
        _model = State(initialValue: .preview(state: state))
        if state == "detail" {
            _detail = State(initialValue: InsightDetailModel.preview(DiscoveryModel.previewReports().first!))
        }
    }

    var body: some View {
        Group {
            if let originalID {
                OriginalRootView(
                    id: originalID,
                    onDeleted: { self.originalID = nil },
                    onAsk: { _ in }
                )
            } else if let detail {
                InsightDetailView(model: detail, onBack: { self.detail = nil }, onOpenOriginal: { originalID = $0 })
            } else {
                DiscoveryHistoryView(model: model, onBack: {}, onOpenConnection: nil)
            }
        }
        .statusBarHidden()
    }
}
