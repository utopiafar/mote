import Foundation
import MoteCore
import MoteStorage
import Observation

@MainActor
@Observable
final class CaptureSyncModel {
    private(set) var presentation: CaptureSyncPresentation
    private(set) var centralURL: URL?

    private let fileManager: FileManager

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
        let state = Self.readState(fileManager: fileManager)
        presentation = state.presentation
        centralURL = state.centralURL
    }

    func refresh() {
        let state = Self.readState(fileManager: fileManager)
        presentation = state.presentation
        centralURL = state.centralURL
    }

    private struct State {
        let presentation: CaptureSyncPresentation
        let centralURL: URL?
    }

    private static func readState(fileManager: FileManager) -> State {
        let connection = (try? MoteStorage.connectionStore(fileManager: fileManager).read()) ?? nil
        let pending = (try? MoteStorage.sendQueue(fileManager: fileManager).pending().count) ?? 0
        let sourceStore = try? MoteStorage.shortcutSourceStore(fileManager: fileManager)
        let notifications = (try? sourceStore?.snapshot(for: .notification)) ?? nil
        let screenshots = (try? sourceStore?.snapshot(for: .screenshot)) ?? nil
        let centralURL = connection.flatMap { URL(string: $0.serverUrl) }
        let host = centralURL?.host ?? connection?.serverUrl ?? "未连接"
        let sendState: SendSyncState
        if pending > 0 {
            sendState = .pending(count: pending)
        } else if connection != nil {
            sendState = .synced(at: nil)
        } else {
            sendState = .reconnect
        }
        let facts = CaptureSyncFacts(
            notificationShortcutEnabled: notifications?.settings.setupPhase == .enabled,
            screenshotShortcutEnabled: screenshots?.settings.setupPhase == .enabled,
            notificationLastReceived: notifications?.received.first.flatMap { SourceReceiptTime.format($0.capturedAt) },
            screenshotLastReceived: screenshots?.received.first.flatMap { SourceReceiptTime.format($0.capturedAt) },
            centralHost: host,
            sendState: sendState,
            storageBytes: storageBytes(fileManager: fileManager)
        )
        return State(presentation: CaptureSyncPresentation(facts: facts), centralURL: centralURL)
    }

    private static func storageBytes(fileManager: FileManager) -> Int64? {
        guard let container = fileManager.containerURL(
            forSecurityApplicationGroupIdentifier: MoteCore.appGroupIdentifier
        ) else { return nil }
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .totalFileAllocatedSizeKey, .fileAllocatedSizeKey]
        guard let enumerator = fileManager.enumerator(
            at: container,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles]
        ) else { return nil }
        var total: Int64 = 0
        for case let url as URL in enumerator {
            guard let values = try? url.resourceValues(forKeys: keys), values.isRegularFile == true else { continue }
            total += Int64(values.totalFileAllocatedSize ?? values.fileAllocatedSize ?? 0)
        }
        return total
    }
}
