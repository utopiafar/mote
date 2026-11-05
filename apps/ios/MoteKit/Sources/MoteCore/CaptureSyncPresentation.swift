import Foundation

public enum CaptureSourceID: String, CaseIterable, Equatable, Sendable {
    case notification
    case screenshot
    case media
    case folder
}

public enum CaptureSourceTone: String, Equatable, Sendable {
    case normal
    case warning
}

public enum CaptureSourceAction: String, Equatable, Sendable {
    case openSource
    case openShortcutSetup
    case handleMediaPermission
}

public struct CaptureSourcePresentation: Equatable, Sendable, Identifiable {
    public let id: CaptureSourceID
    public let title: String
    public let detail: String
    public let tone: CaptureSourceTone
    public let actionTitle: String?
    public let action: CaptureSourceAction?

    public init(
        id: CaptureSourceID,
        title: String,
        detail: String,
        tone: CaptureSourceTone = .normal,
        actionTitle: String? = nil,
        action: CaptureSourceAction? = nil
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.tone = tone
        self.actionTitle = actionTitle
        self.action = action
    }
}

public enum AddSourceKind: String, CaseIterable, Equatable, Sendable {
    case file
    case folder
    case calendar
    case deviceEvents = "device_events"
    case cloud

    public var title: String {
        switch self {
        case .file: "文件"
        case .folder: "文件夹"
        case .calendar: "日历"
        case .deviceEvents: "设备事件"
        case .cloud: "云端来源"
        }
    }

    public var opensExternal: Bool { self == .cloud }
}

public enum SendSyncState: Equatable, Sendable {
    case synced(at: String?)
    case pending(count: Int)
    case paused
    case reconnect
}

public struct SendGroupPresentation: Equatable, Sendable {
    public let host: String
    public let status: SendSyncState

    public init(host: String, status: SendSyncState) {
        self.host = host
        self.status = status
    }

    public var statusText: String {
        switch status {
        case .synced(let time):
            if let time, !time.isEmpty { "已同步 · \(time)" } else { "已同步" }
        case .pending(let count):
            "待同步 \(count) 条"
        case .paused:
            "发送已暂停"
        case .reconnect:
            "需要重新连接"
        }
    }

    public var tone: CaptureSourceTone {
        status == .reconnect ? .warning : .normal
    }

    public var actionTitle: String? {
        switch status {
        case .pending: "立即发送"
        case .reconnect: "连接"
        case .synced, .paused: nil
        }
    }

    public var action: CaptureSyncAction? {
        switch status {
        case .pending: .sendNow
        case .reconnect: .reconnect
        case .synced, .paused: nil
        }
    }
}

public enum CaptureSyncAction: Equatable, Sendable {
    case openSource(CaptureSourceID)
    case openShortcutSetup(CaptureSourceID)
    case handleMediaPermission
    case openSendMethod
    case setSendPaused(Bool)
    case sendNow
    case reconnect
    case openStorage
    case addSource(AddSourceKind)
    case openCentralSources
}

public struct CaptureSyncFacts: Equatable, Sendable {
    public var shortcutEnabled: Bool
    public var notificationLastReceived: String?
    public var screenshotLastReceived: String?
    public var mediaAdded: Bool
    public var mediaPermissionMissing: Bool
    public var mediaLastReceived: String?
    public var folderCount: Int
    public var centralHost: String
    public var sendState: SendSyncState
    public var sendMethod: String
    public var sendPaused: Bool
    public var storageBytes: Int64?

    public init(
        shortcutEnabled: Bool = true,
        notificationLastReceived: String? = nil,
        screenshotLastReceived: String? = nil,
        mediaAdded: Bool = true,
        mediaPermissionMissing: Bool = false,
        mediaLastReceived: String? = nil,
        folderCount: Int = 0,
        centralHost: String,
        sendState: SendSyncState,
        sendMethod: String = "立即发送",
        sendPaused: Bool = false,
        storageBytes: Int64? = nil
    ) {
        self.shortcutEnabled = shortcutEnabled
        self.notificationLastReceived = notificationLastReceived
        self.screenshotLastReceived = screenshotLastReceived
        self.mediaAdded = mediaAdded
        self.mediaPermissionMissing = mediaPermissionMissing
        self.mediaLastReceived = mediaLastReceived
        self.folderCount = folderCount
        self.centralHost = centralHost
        self.sendState = sendState
        self.sendMethod = sendMethod
        self.sendPaused = sendPaused
        self.storageBytes = storageBytes
    }
}

public struct CaptureSyncPresentation: Equatable, Sendable {
    public static let title = "采集与同步"

    public let sources: [CaptureSourcePresentation]
    public let addSourceKinds: [AddSourceKind]
    public let send: SendGroupPresentation
    public let sendMethod: String
    public let sendPaused: Bool
    public let storageText: String?
    public let storageBytes: Int64?

    public init(facts: CaptureSyncFacts) {
        var sources: [CaptureSourcePresentation] = []
        let shortcutProblem = facts.shortcutEnabled ? nil : (detail: "快捷指令未启用", action: CaptureSourceAction.openShortcutSetup)
        sources.append(Self.fixedSource(
            .notification, title: "通知", lastReceived: facts.notificationLastReceived, shortcutProblem: shortcutProblem
        ))
        sources.append(Self.fixedSource(
            .screenshot, title: "截图", lastReceived: facts.screenshotLastReceived, shortcutProblem: shortcutProblem
        ))

        if facts.mediaAdded {
            if facts.mediaPermissionMissing {
                sources.append(CaptureSourcePresentation(
                    id: .media,
                    title: "媒体",
                    detail: "等待采集权限",
                    tone: .warning,
                    actionTitle: "处理",
                    action: .handleMediaPermission
                ))
            } else {
                sources.append(CaptureSourcePresentation(
                    id: .media,
                    title: "媒体",
                    detail: facts.mediaLastReceived ?? "",
                    action: .openSource
                ))
            }
        }

        if facts.folderCount > 0 {
            sources.append(CaptureSourcePresentation(
                id: .folder,
                title: "文件夹",
                detail: "\(facts.folderCount) 个",
                action: .openSource
            ))
        }

        self.sources = sources
        self.addSourceKinds = AddSourceKind.allCases
        self.send = SendGroupPresentation(host: facts.centralHost, status: facts.sendState)
        self.sendMethod = facts.sendMethod
        self.sendPaused = facts.sendPaused || facts.sendState == .paused
        self.storageBytes = facts.storageBytes
        self.storageText = facts.storageBytes.map(Self.formatStorage)
    }

    public func send(paused: Bool) -> SendGroupPresentation {
        if paused {
            return SendGroupPresentation(host: send.host, status: .paused)
        }
        if send.status == .paused {
            return SendGroupPresentation(host: send.host, status: .synced(at: nil))
        }
        return send
    }

    private static func fixedSource(
        _ id: CaptureSourceID,
        title: String,
        lastReceived: String?,
        shortcutProblem: (detail: String, action: CaptureSourceAction)?
    ) -> CaptureSourcePresentation {
        if let shortcutProblem {
            return CaptureSourcePresentation(
                id: id,
                title: title,
                detail: shortcutProblem.detail,
                tone: .warning,
                actionTitle: "设置",
                action: shortcutProblem.action
            )
        }
        return CaptureSourcePresentation(
            id: id,
            title: title,
            detail: lastReceived ?? "",
            action: .openSource
        )
    }

    static func formatStorage(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .decimal
        formatter.allowedUnits = [.useGB]
        formatter.includesUnit = true
        formatter.includesCount = true
        formatter.isAdaptive = true
        return formatter.string(fromByteCount: bytes)
    }
}
