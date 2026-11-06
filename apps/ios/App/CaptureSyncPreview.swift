import MoteCore
import SwiftUI

/// Generated, in-memory states for visual and interaction checks.
struct CaptureSyncPreview: View {
    @State private var lastAction = "none"
    private let arguments = ProcessInfo.processInfo.arguments

    var body: some View {
        CaptureSyncView(
            presentation: presentation,
            initiallyShowingAddSource: argument("-MoteCaptureSyncAdding") == "true",
            onAction: { action in
                lastAction = action.identifier
            }
        )
        .statusBarHidden()
        .overlay(alignment: .topLeading) {
            Text(lastAction)
                .font(.system(size: 1))
                .opacity(0.01)
                .frame(width: 1, height: 1)
                .accessibilityIdentifier("capture-sync-action")
        }
    }

    private var state: String {
        argument("-MoteCaptureSyncState") ?? "permission"
    }

    private var presentation: CaptureSyncPresentation {
        let shortcutsOff = state == "shortcutsOff"
        let minimal = state == "minimal"
        let mediaMissing = state == "permission"
        let sendState: SendSyncState = switch state {
        case "pending": .pending(count: 3)
        case "sendPaused": .paused
        case "reconnect": .reconnect
        default: .synced(at: "21:42")
        }
        return CaptureSyncPresentation(facts: CaptureSyncFacts(
            notificationShortcutEnabled: !shortcutsOff,
            screenshotShortcutEnabled: !shortcutsOff,
            notificationLastReceived: "21:38",
            screenshotLastReceived: "18:02",
            mediaAdded: !minimal,
            mediaPermissionMissing: mediaMissing,
            mediaLastReceived: "昨天",
            folderCount: minimal ? 0 : 2,
            centralHost: "mote.example.net",
            sendState: sendState,
            sendMethod: "立即发送",
            sendPaused: state == "sendPaused",
            storageBytes: 1_200_000_000
        ))
    }

    private func argument(_ name: String) -> String? {
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
            return nil
        }
        return arguments[index + 1]
    }
}

private extension CaptureSyncAction {
    var identifier: String {
        switch self {
        case .openSource(let source):
            "openSource.\(source.rawValue)"
        case .openShortcutSetup(let source):
            "openShortcutSetup.\(source.rawValue)"
        case .handleMediaPermission:
            "handleMediaPermission"
        case .openSendMethod:
            "openSendMethod"
        case .setSendPaused(let paused):
            "setSendPaused.\(paused)"
        case .sendNow:
            "sendNow"
        case .reconnect:
            "reconnect"
        case .openStorage:
            "openStorage"
        case .addSource(let kind):
            "addSource.\(kind.rawValue)"
        case .openCentralSources:
            "openCentralSources"
        }
    }
}
