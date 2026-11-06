import Foundation
import MoteCore
import MoteStorage
import Observation

/// Reads and clears the one saved connection shown by 设置 › 连接与设备.
@MainActor
@Observable
final class SettingsModel {
    private(set) var connection: StoredConnection?

    private let fileManager: FileManager
    private let usesPreview: Bool

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
        usesPreview = false
        connection = (try? MoteStorage.connectionStore(fileManager: fileManager).read()) ?? nil
    }

    init(previewConnection: StoredConnection?) {
        fileManager = .default
        usesPreview = true
        connection = previewConnection
    }

    func refresh() {
        guard !usesPreview else { return }
        connection = (try? MoteStorage.connectionStore(fileManager: fileManager).read()) ?? nil
    }

    func disconnect() {
        guard !usesPreview else {
            connection = nil
            return
        }
        try? MoteStorage.connectionStore(fileManager: fileManager).clear()
        connection = nil
    }

    var presentation: ConnectionDevicePresentation {
        ConnectionDevicePresentation(
            serverUrl: connection?.serverUrl,
            scope: connection?.scope,
            deviceName: connection?.deviceName,
            connectedAt: connection?.connectedAt
        )
    }
}
