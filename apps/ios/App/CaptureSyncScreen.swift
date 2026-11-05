import MoteCore
import SwiftUI
import UIKit

/// The product presentation of the capture and sync screen. Configuration
/// operations owned by later units answer with the shared placeholder notice
/// instead of doing nothing.
struct CaptureSyncScreen: View {
    private let onBack: (() -> Void)?
    private let onOpenConnection: (() -> Void)?
    @State private var model = CaptureSyncModel()
    @State private var showingUnavailable = false

    init(onBack: (() -> Void)? = nil, onOpenConnection: (() -> Void)? = nil) {
        self.onBack = onBack
        self.onOpenConnection = onOpenConnection
    }

    var body: some View {
        CaptureSyncView(presentation: model.presentation, onBack: onBack) { action in
            handle(action)
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
        case .openSource, .openShortcutSetup, .handleMediaPermission, .openSendMethod, .openStorage, .addSource:
            showingUnavailable = true
        }
    }
}
