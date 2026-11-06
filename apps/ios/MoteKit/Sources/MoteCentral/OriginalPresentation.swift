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
        highlightedPhrase: String? = nil
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
    }

    public init(record: OriginalRecord, conversations: [ConversationSummary]?,
                highlightedPhrase: String? = nil) throws {
        let normalizedID = record.id.lowercased()
        guard UUID(uuidString: normalizedID) != nil,
              let capturedAt = CentralTimestamp.parse(record.capturedAt),
              let receivedAt = CentralTimestamp.parse(record.receivedAt)
        else { throw CentralError.invalidResponse }

        let title = Self.title(for: record)
        self.init(
            id: normalizedID,
            title: title,
            text: record.ocrText,
            summary: record.summary,
            capturedAt: capturedAt,
            receivedAt: receivedAt,
            indexingStatus: record.indexingStatus,
            sourceDescription: "\(Self.sourceLabel(record.source)) · \(record.deviceName)",
            referenceCount: conversations?.filter { Self.references($0.scope, record: record) }.count,
            deletionKind: record.deletion?.available == true ? record.deletion?.kind : nil,
            highlightedPhrase: highlightedPhrase
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
        if let firstLine = record.ocrText.split(whereSeparator: \.isNewline).first {
            let value = firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { return String(value.prefix(80)) }
        }
        let appName = record.appName.trimmingCharacters(in: .whitespacesAndNewlines)
        return appName.isEmpty ? "记录" : appName
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
