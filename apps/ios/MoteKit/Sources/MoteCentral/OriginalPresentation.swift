import Foundation

public enum OriginalDeletionError: Error, Equatable {
    case unavailable
    case unconfirmed
}

public enum OriginalDeletion {
    public static func requireCompleted(_ receipt: DeletionReceipt) throws {
        guard receipt.deleted > 0 else { throw OriginalDeletionError.unconfirmed }
    }
}

public struct OriginalAskScope: Equatable, Hashable, Sendable {
    public let id: String
    public let title: String

    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }

    public var conversationScope: ConversationScope {
        ConversationScope(anchorEvidenceIds: [id])
    }
}

public struct OriginalReceiptStep: Equatable, Sendable {
    public let title: String
    public let date: Date?
    public let completed: Bool
}

public struct OriginalPresentation: Equatable, Sendable {
    public let id: String
    public let title: String
    public let text: String
    public let summary: String?
    public let capturedAt: Date
    public let receivedAt: Date
    public let organizedAt: Date?
    public let indexingStatus: String
    public let sourceDescription: String
    public let referenceCount: Int?
    public let deletionKind: OriginalDeletionKind?
    public let highlightedPhrase: String?
    public let askScope: OriginalAskScope
    public let source: CaptureSource?
    /// Central keeps an image for this record; the reader shows it as the hero.
    public let hasImage: Bool

    public init(
        id: String,
        title: String,
        text: String,
        summary: String? = nil,
        capturedAt: Date,
        receivedAt: Date,
        organizedAt: Date? = nil,
        indexingStatus: String,
        sourceDescription: String,
        referenceCount: Int? = nil,
        deletionKind: OriginalDeletionKind? = nil,
        highlightedPhrase: String? = nil,
        source: CaptureSource? = nil,
        hasImage: Bool = false
    ) {
        self.id = id
        self.title = title
        self.text = text
        self.summary = summary
        self.capturedAt = capturedAt
        self.receivedAt = receivedAt
        self.organizedAt = organizedAt
        self.indexingStatus = indexingStatus
        self.sourceDescription = sourceDescription
        self.referenceCount = referenceCount
        self.deletionKind = deletionKind
        self.highlightedPhrase = highlightedPhrase
        self.askScope = OriginalAskScope(id: id, title: title)
        self.source = source
        self.hasImage = hasImage
    }

    public init(record: OriginalRecord, conversations: [ConversationSummary]?,
                highlightedPhrase: String? = nil, fileText: String? = nil, fileImage: Bool = false) throws {
        let normalizedID = record.id.lowercased()
        guard UUID(uuidString: normalizedID) != nil,
              let capturedAt = CentralTimestamp.parse(record.capturedAt),
              let receivedAt = CentralTimestamp.parse(record.receivedAt)
        else { throw CentralError.invalidResponse }

        let title = Self.title(for: record)
        self.init(
            id: normalizedID,
            title: title,
            text: fileText ?? Self.readableText(record),
            summary: record.summary,
            capturedAt: capturedAt,
            receivedAt: receivedAt,
            indexingStatus: record.indexingStatus,
            sourceDescription: "\(Self.sourceLabel(record.source)) · \(record.deviceName)",
            referenceCount: conversations?.filter { Self.references($0.scope, record: record) }.count,
            deletionKind: record.deletion?.available == true ? record.deletion?.kind : nil,
            highlightedPhrase: highlightedPhrase,
            source: record.source,
            hasImage: fileImage || record.blobHash?.isEmpty == false
        )
    }

    public var timeline: [OriginalReceiptStep] {
        [
            OriginalReceiptStep(title: "本机已保存", date: capturedAt, completed: true),
            OriginalReceiptStep(title: "中央已接收", date: receivedAt, completed: true),
            OriginalReceiptStep(title: organized ? "已整理，可搜索" : indexingStatus == "failed" ? "整理未完成" : "正在整理",
                                date: organizedAt, completed: organized),
        ]
    }

    public var organized: Bool {
        indexingStatus == "indexed" || indexingStatus == "text_ready"
    }

    private static func title(for record: OriginalRecord) -> String {
        let windowTitle = record.windowTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if !windowTitle.isEmpty { return windowTitle }
        if record.source == .notification {
            return record.metadata?.notification?.title ?? sourceLabel(record.source)
        }
        if record.source == .deviceEvent { return sourceLabel(record.source) }
        if let firstLine = record.ocrText.split(whereSeparator: \.isNewline).first {
            let value = firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { return String(value.prefix(80)) }
        }
        let appName = record.appName.trimmingCharacters(in: .whitespacesAndNewlines)
        return appName.isEmpty ? "记录" : appName
    }

    private static func readableText(_ record: OriginalRecord) -> String {
        switch record.source {
        case .notification:
            guard let notification = record.metadata?.notification else { return record.ocrText }
            let action = switch notification.action {
            case .posted: "收到通知"
            case .updated: "通知更新"
            case .removed: "通知移除"
            }
            let lines = [action, notification.title, notification.text, notification.bigText, notification.subText]
                .compactMap { $0 } + (notification.textLines ?? [])
            var seen = Set<String>()
            return lines.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: "\n")
        case .deviceEvent:
            guard let event = record.metadata?.deviceEvent else { return record.ocrText }
            let action = switch event.action {
            case "screen_on": "亮屏"
            case "screen_off": "熄屏"
            case "user_present": "用户解锁 / 在场"
            default: "锁定状态观察"
            }
            return [action, event.keyguardLocked ? "系统报告已锁定" : "系统报告未锁定",
                    event.screenInteractive ? "屏幕可交互" : "屏幕不可交互"].joined(separator: " · ")
        case .activity:
            guard record.durationMs > 0 else { return record.ocrText }
            let seconds = Double(record.durationMs) / 1_000
            return "前台应用采样时长：\(seconds.formatted()) 秒"
        case .media:
            let lines = record.metadata?.media?.sessions.compactMap { session -> String? in
                let state = switch session.playbackState {
                case "playing": "正在播放"
                case "paused": "已暂停"
                case "stopped": "已停止"
                default: nil as String?
                }
                let label = session.title ?? session.appName
                let line = [label, session.artist, state].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                return line.isEmpty ? nil : line
            } ?? []
            return lines.isEmpty ? "媒体状态未上报" : lines.joined(separator: "\n")
        default:
            if record.ocrText.isEmpty && record.provenance?.layer == "reference" {
                return "此来源仅保留引用与元数据，未导入正文。"
            }
            return record.ocrText
        }
    }

    private static func references(_ scope: ConversationScope, record: OriginalRecord) -> Bool {
        if scope.evidenceIds?.contains(record.id) == true || scope.anchorEvidenceIds?.contains(record.id) == true {
            return true
        }
        return record.memoryMaterialRef != nil && scope.anchorMaterialRef == record.memoryMaterialRef
    }

    private static func sourceLabel(_ source: CaptureSource) -> String {
        switch source {
        case .note: "记录"
        case .screen: "截图"
        case .uiPage: "网页"
        case .activity: "活动"
        case .media: "媒体"
        case .notification: "通知"
        case .deviceEvent: "设备事件"
        case .file: "文件"
        case .calendar, .event: "日程"
        case .message: "消息"
        case .metric: "指标"
        case .memory: "记忆"
        }
    }
}
