import Foundation
import MoteCore
import MoteStorage
import SwiftUI

/// Generated, in-memory states for the menu, settings and device pages.
struct ProfileMenuPreview: View {
    private let state: String
    private let connectedAt = ISO8601DateFormatter().date(from: "2026-10-03T04:00:00Z")!

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        state = arguments.firstIndex(of: "-MoteProfileState").flatMap {
            arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil
        } ?? "menu-normal"
    }

    var body: some View {
        Group {
            switch state {
            case "settings":
                SettingsScreen(model: settingsModel, onBack: {})
            case "connection":
                SettingsScreen(model: settingsModel, page: .connection, onBack: {})
            default:
                ProfileMenuView(
                    model: ProfileMenuModel(previewStatus: status),
                    settingsModel: settingsModel
                )
            }
        }
        .statusBarHidden()
    }

    private var settingsModel: SettingsModel {
        SettingsModel(previewConnection: StoredConnection(
            serverUrl: "https://mote.example.net",
            token: "generated-token",
            credentialId: "generated-credential",
            scope: "owner",
            deviceName: "我的 iPhone",
            connectedAt: connectedAt
        ))
    }

    private var status: MoteMenuStatus? {
        let facts = switch state {
        case "menu-permission":
            CaptureStatusFacts(
                connection: .connected,
                captureEnabled: true,
                captureLive: false,
                permission: .missing,
                syncState: .idle,
                pending: 0
            )
        case "menu-sendPaused":
            CaptureStatusFacts(
                connection: .connected,
                captureEnabled: true,
                captureLive: true,
                syncState: .paused,
                pending: 3
            )
        default:
            CaptureStatusFacts(
                connection: .connected,
                captureEnabled: true,
                captureLive: true,
                syncState: .idle,
                pending: 0
            )
        }
        return MoteMenuPresentation(facts: facts).captureStatus
    }
}
