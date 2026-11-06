import MoteCore
import SwiftUI
import UIKit

struct CaptureSyncScreen: View {
    private let onBack: (() -> Void)?
    private let onOpenConnection: (() -> Void)?
    private let onOpenOriginal: (String) -> Void
    @State private var model = CaptureSyncModel()
    @State private var selectedSource: ShortcutSourceKind?
    @State private var sourceOpensSetup = false
    @State private var showingUnavailable = false

    init(
        onBack: (() -> Void)? = nil,
        onOpenConnection: (() -> Void)? = nil,
        onOpenOriginal: @escaping (String) -> Void = { _ in }
    ) {
        self.onBack = onBack
        self.onOpenConnection = onOpenConnection
        self.onOpenOriginal = onOpenOriginal
    }

    var body: some View {
        Group {
            if let selectedSource {
                SourceDetailScreen(
                    kind: selectedSource,
                    initiallyShowingSetup: sourceOpensSetup,
                    onBack: {
                        self.selectedSource = nil
                        model.refresh()
                    },
                    onOpenOriginal: onOpenOriginal
                )
            } else {
                CaptureSyncView(presentation: model.presentation, onBack: onBack) { action in
                    handle(action)
                }
            }
        }
        .task {
            model.refresh()
        }
        .alert("此功能将在后续版本提供", isPresented: $showingUnavailable) {
            Button("好", role: .cancel) {}
        }
    }

    private func handle(_ action: CaptureSyncAction) {
        switch action {
        case .sendNow:
            Task {
                await AppSendPipeline.shared.reconcileAndSend()
                model.refresh()
            }
        case .reconnect:
            if let onOpenConnection {
                onOpenConnection()
            } else {
                showingUnavailable = true
            }
        case .openCentralSources:
            if let url = model.centralURL {
                UIApplication.shared.open(url)
            } else {
                showingUnavailable = true
            }
        case .setSendPaused:
            break
        case .openSource(let source):
            guard let kind = ShortcutSourceKind(source) else {
                showingUnavailable = true
                return
            }
            sourceOpensSetup = false
            selectedSource = kind
        case .openShortcutSetup(let source):
            guard let kind = ShortcutSourceKind(source) else {
                showingUnavailable = true
                return
            }
            sourceOpensSetup = true
            selectedSource = kind
        case .handleMediaPermission, .openSendMethod, .openStorage, .addSource:
            showingUnavailable = true
        }
    }
}

private extension ShortcutSourceKind {
    init?(_ source: CaptureSourceID) {
        switch source {
        case .notification: self = .notification
        case .screenshot: self = .screenshot
        case .media, .folder: return nil
        }
    }
}
