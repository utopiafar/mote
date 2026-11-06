public enum CaptureStatusLevel: String, Codable, Sendable {
    case normal
    case reminder
    case needsAction = "needs_action"
}

public enum CaptureStatusID: String, Codable, Sendable {
    case capturing
    case pendingSync = "pending_sync"
    case screenPaused = "screen_paused"
    case paused
    case sendPaused = "send_paused"
    case localOnly = "local_only"
    case reconnect
    case storageFull = "storage_full"
    case interrupted
    case permission
    case sendAttention = "send_attention"
    case disconnected
}

public enum CaptureStatusOperation: String, Codable, Sendable {
    case resumeCapture = "resume_capture"
    case resumeSend = "resume_send"
    case reconnect
    case restartCapture = "restart_capture"
    case openPermissions = "open_permissions"
    case openStorage = "open_storage"
    case openSync = "open_sync"
}

public enum CaptureStatusPlatform: String, Codable, Sendable {
    case ios
    case android
    case macos
}

public struct CaptureStatusHome: Codable, Equatable, Sendable {
    public let titleKey: String
    public let operation: CaptureStatusOperation
}

public struct CaptureStatusNotification: Codable, Equatable, Sendable {
    public let titleKey: String
    public let operation: CaptureStatusOperation
    public let platforms: [CaptureStatusPlatform]
}

public struct CaptureStatusCentral: Codable, Equatable, Sendable {
    public let textKey: String
    public let tone: Tone

    public enum Tone: String, Codable, Sendable {
        case ok
        case neutral
        case warn
    }
}

public struct CaptureStatusRow: Codable, Equatable, Sendable {
    public let id: CaptureStatusID
    public let level: CaptureStatusLevel
    public let home: CaptureStatusHome?
    public let notification: CaptureStatusNotification?
    public let androidOngoing: String?
    public let macIcon: MacIcon?
    public let central: CaptureStatusCentral?

    public enum MacIcon: String, Codable, Sendable {
        case normal
        case paused
        case alert
    }
}

public enum CaptureConnection: String, Decodable, Sendable {
    case connected
    case unconfigured
    case reconnect
}

public enum CaptureSyncState: String, Decodable, Sendable {
    case unconfigured
    case idle
    case waiting
    case uploading
    case paused
    case blocked
    case error
}

public enum CapturePermission: String, Decodable, Sendable {
    case missing
    case partial
}

public struct CaptureStatusFacts: Decodable, Sendable {
    public let connection: CaptureConnection
    public let captureEnabled: Bool
    public let captureLive: Bool
    public let screenPausedAt: String?
    public let permission: CapturePermission?
    public let storageFull: Bool?
    public let interrupted: Bool?
    public let syncState: CaptureSyncState
    public let pending: Int?
    public let disconnected: Bool?

    public init(
        connection: CaptureConnection,
        captureEnabled: Bool,
        captureLive: Bool,
        screenPausedAt: String? = nil,
        permission: CapturePermission? = nil,
        storageFull: Bool? = nil,
        interrupted: Bool? = nil,
        syncState: CaptureSyncState,
        pending: Int? = nil,
        disconnected: Bool? = nil
    ) {
        self.connection = connection
        self.captureEnabled = captureEnabled
        self.captureLive = captureLive
        self.screenPausedAt = screenPausedAt
        self.permission = permission
        self.storageFull = storageFull
        self.interrupted = interrupted
        self.syncState = syncState
        self.pending = pending
        self.disconnected = disconnected
    }
}

public enum CaptureStatusMapping {
    public static let table: [CaptureStatusRow] = [
        row(.capturing, .normal, androidOngoing: "采集中", macIcon: .normal, central: central("正在采集", .ok)),
        row(.pendingSync, .normal, androidOngoing: "采集中", macIcon: .normal, central: central("正在采集", .ok)),
        row(.screenPaused, .reminder, home: home("屏幕采集已暂停", .resumeCapture), androidOngoing: "屏幕采集已暂停", macIcon: .paused, central: central("正在采集", .ok)),
        row(.paused, .reminder, home: home("采集已暂停", .resumeCapture), androidOngoing: "采集已暂停", macIcon: .paused, central: central("已暂停", .neutral)),
        row(.sendPaused, .reminder, home: home("发送已暂停", .resumeSend), androidOngoing: "采集中 · 发送已暂停", macIcon: .normal),
        row(.localOnly, .reminder, androidOngoing: "采集中", macIcon: .normal),
        row(.reconnect, .needsAction, home: home("需要重新连接", .reconnect), notification: notification("需要重新连接", .reconnect), androidOngoing: "需要重新连接", macIcon: .alert, central: central("需要处理", .warn)),
        row(.storageFull, .needsAction, home: home("本机空间已满", .openStorage), notification: notification("本机空间已满", .openStorage), androidOngoing: "本机空间已满", macIcon: .alert, central: central("需要处理", .warn)),
        row(.interrupted, .needsAction, home: home("采集已中断", .restartCapture), notification: notification("采集已中断", .restartCapture, [.android, .macos]), macIcon: .alert, central: central("需要处理", .warn)),
        row(.permission, .needsAction, home: home("等待采集权限", .openPermissions), notification: notification("等待采集权限", .openPermissions), androidOngoing: "部分来源等待权限", macIcon: .alert, central: central("等待权限", .warn)),
        row(.sendAttention, .needsAction, home: home("发送需要处理", .openSync), notification: notification("发送需要处理", .openSync), androidOngoing: "采集中 · 发送需要处理", macIcon: .alert),
        row(.disconnected, .needsAction, central: central("失联", .warn)),
    ]

    public static func status(for facts: CaptureStatusFacts) -> CaptureStatusRow {
        if facts.disconnected == true { return row(.disconnected) }
        if facts.connection == .reconnect { return row(.reconnect) }
        if facts.storageFull == true { return row(.storageFull) }
        if facts.captureEnabled && facts.interrupted == true { return row(.interrupted) }
        if facts.captureEnabled && facts.permission != nil { return row(.permission) }
        if facts.captureEnabled && !facts.captureLive { return row(.permission) }
        if facts.connection == .connected && (facts.syncState == .error || facts.syncState == .blocked) {
            return row(.sendAttention)
        }
        if facts.captureEnabled && facts.screenPausedAt != nil { return row(.screenPaused) }
        if !facts.captureEnabled { return row(.paused) }
        if facts.connection == .unconfigured || facts.syncState == .unconfigured { return row(.localOnly) }
        if facts.connection == .connected && facts.syncState == .paused { return row(.sendPaused) }
        if let pending = facts.pending, pending > 0 { return row(.pendingSync) }
        return row(.capturing)
    }

    public static func row(_ id: CaptureStatusID) -> CaptureStatusRow {
        table.first { $0.id == id }!
    }

    private static func row(
        _ id: CaptureStatusID,
        _ level: CaptureStatusLevel,
        home: CaptureStatusHome? = nil,
        notification: CaptureStatusNotification? = nil,
        androidOngoing: String? = nil,
        macIcon: CaptureStatusRow.MacIcon? = nil,
        central: CaptureStatusCentral? = nil
    ) -> CaptureStatusRow {
        CaptureStatusRow(
            id: id,
            level: level,
            home: home,
            notification: notification,
            androidOngoing: androidOngoing,
            macIcon: macIcon,
            central: central
        )
    }

    private static func home(_ titleKey: String, _ operation: CaptureStatusOperation) -> CaptureStatusHome {
        CaptureStatusHome(titleKey: titleKey, operation: operation)
    }

    private static func notification(
        _ titleKey: String,
        _ operation: CaptureStatusOperation,
        _ platforms: [CaptureStatusPlatform] = [.ios, .android, .macos]
    ) -> CaptureStatusNotification {
        CaptureStatusNotification(titleKey: titleKey, operation: operation, platforms: platforms)
    }

    private static func central(_ textKey: String, _ tone: CaptureStatusCentral.Tone) -> CaptureStatusCentral {
        CaptureStatusCentral(textKey: textKey, tone: tone)
    }
}
