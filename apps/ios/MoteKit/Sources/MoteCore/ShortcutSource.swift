import Foundation

public enum ShortcutSourceKind: String, Codable, CaseIterable, Equatable, Sendable {
    case notification
    case screenshot

    public var title: String {
        switch self {
        case .notification: "通知"
        case .screenshot: "截图"
        }
    }

    public var captureSourceID: CaptureSourceID {
        switch self {
        case .notification: .notification
        case .screenshot: .screenshot
        }
    }
}

public enum ShortcutSetupPhase: String, Codable, Equatable, Sendable {
    case notEnabled
    case waiting
    case enabled
}

public enum NotificationContentMode: String, Codable, CaseIterable, Equatable, Sendable {
    case titleAndBody
    case titleOnly

    public var title: String {
        switch self {
        case .titleAndBody: "标题和正文"
        case .titleOnly: "仅标题"
        }
    }
}

public struct ShortcutSourceSettings: Codable, Equatable, Sendable {
    public var setupPhase: ShortcutSetupPhase
    public var isPaused: Bool
    public var allowedApps: [String]
    public var notificationContent: NotificationContentMode
    public var excludedText: [String]
    public var sourceDescription: String

    public init(
        setupPhase: ShortcutSetupPhase = .notEnabled,
        isPaused: Bool = false,
        allowedApps: [String] = [],
        notificationContent: NotificationContentMode = .titleAndBody,
        excludedText: [String] = [],
        sourceDescription: String = ""
    ) {
        self.setupPhase = setupPhase
        self.isPaused = isPaused
        self.allowedApps = allowedApps
        self.notificationContent = notificationContent
        self.excludedText = excludedText
        self.sourceDescription = sourceDescription
    }

    public var acceptsCaptures: Bool {
        setupPhase != .notEnabled && !isPaused
    }
}

public struct SourceReceivedItem: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let meta: String

    public init(id: String, title: String, meta: String) {
        self.id = id
        self.title = title
        self.meta = meta
    }
}

public enum SourceSettingID: String, Equatable, Sendable, Identifiable {
    case allowedApps
    case notificationContent
    case textRules
    case sourceDescription

    public var id: String { rawValue }
}

public struct SourceSettingRow: Equatable, Sendable, Identifiable {
    public let id: SourceSettingID
    public let title: String
    public let value: String

    public init(id: SourceSettingID, title: String, value: String) {
        self.id = id
        self.title = title
        self.value = value
    }
}

public struct SourceNoticePresentation: Equatable, Sendable {
    public let title: String
    public let actionTitle: String
    public let isWarning: Bool

    public init(title: String, actionTitle: String, isWarning: Bool) {
        self.title = title
        self.actionTitle = actionTitle
        self.isWarning = isWarning
    }
}

public struct ShortcutSourcePresentation: Equatable, Sendable {
    public let kind: ShortcutSourceKind
    public let settings: ShortcutSourceSettings
    public let items: [SourceReceivedItem]

    public init(kind: ShortcutSourceKind, settings: ShortcutSourceSettings, items: [SourceReceivedItem]) {
        self.kind = kind
        self.settings = settings
        self.items = items
    }

    public var title: String { kind.title }
    public var showsItems: Bool { settings.setupPhase != .notEnabled && !items.isEmpty }
    public var canPause: Bool { settings.setupPhase == .enabled && !settings.isPaused }
    public var shortcutValue: String { settings.setupPhase == .notEnabled ? "未启用" : "已启用" }

    public var notice: SourceNoticePresentation? {
        if settings.setupPhase == .notEnabled {
            return SourceNoticePresentation(title: "快捷指令未启用", actionTitle: "设置", isWarning: true)
        }
        if settings.isPaused {
            return SourceNoticePresentation(title: "已暂停", actionTitle: "恢复", isWarning: false)
        }
        return nil
    }

    public var settingRows: [SourceSettingRow] {
        var rows: [SourceSettingRow] = []
        if kind == .notification {
            rows.append(SourceSettingRow(
                id: .allowedApps,
                title: "允许的应用",
                value: settings.allowedApps.isEmpty ? "全部应用" : "\(settings.allowedApps.count) 个"
            ))
            rows.append(SourceSettingRow(
                id: .notificationContent,
                title: "通知内容",
                value: settings.notificationContent.title
            ))
        }
        rows.append(SourceSettingRow(
            id: .textRules,
            title: "文字规则",
            value: settings.excludedText.isEmpty ? "未设置" : "\(settings.excludedText.count) 条"
        ))
        rows.append(SourceSettingRow(id: .sourceDescription, title: "资料说明", value: ""))
        return rows
    }
}

public struct ShortcutSetupStep: Equatable, Sendable, Identifiable {
    public let number: Int
    public let title: String
    public let isMoteAction: Bool

    public var id: Int { number }

    public init(number: Int, title: String, isMoteAction: Bool = false) {
        self.number = number
        self.title = title
        self.isMoteAction = isMoteAction
    }
}

public struct ShortcutSetupPresentation: Equatable, Sendable {
    public let kind: ShortcutSourceKind
    public let phase: ShortcutSetupPhase
    public let latestItem: SourceReceivedItem?

    public init(kind: ShortcutSourceKind, phase: ShortcutSetupPhase, latestItem: SourceReceivedItem? = nil) {
        self.kind = kind
        self.phase = phase
        self.latestItem = latestItem
    }

    public var title: String { kind.title }
    public var showsOpenButton: Bool { phase != .enabled }
    public var showsDoneButton: Bool { phase == .enabled && latestItem != nil }

    public var steps: [ShortcutSetupStep] {
        switch kind {
        case .notification:
            [
                ShortcutSetupStep(number: 1, title: "收到通知时"),
                ShortcutSetupStep(number: 2, title: "选择 App"),
                ShortcutSetupStep(number: 3, title: "立即运行"),
                ShortcutSetupStep(number: 4, title: "保存通知", isMoteAction: true),
            ]
        case .screenshot:
            [
                ShortcutSetupStep(number: 1, title: "截屏时"),
                ShortcutSetupStep(number: 2, title: "立即运行"),
                ShortcutSetupStep(number: 3, title: "保存截图", isMoteAction: true),
            ]
        }
    }

    public var waitingText: String {
        kind == .notification ? "等待第一条通知" : "等待第一张截图"
    }

    public var receivedText: String? {
        guard let latestItem else { return nil }
        let meta = kind == .notification ? latestItem.meta.replacingOccurrences(of: " · ", with: " ") : latestItem.meta
        return "已收到 · \(meta)"
    }
}
