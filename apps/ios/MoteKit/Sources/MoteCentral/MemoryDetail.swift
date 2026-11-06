import Foundation
import MoteCore

/// The Memory detail "更多" copy. Wording matches the canvas and the central
/// web dialog; the owner correction uses 保存 as drawn on iOS.
public enum MemoryDetailCopy {
    public static let moreItems = ["纠正这条记忆", "历史与有效时间", "生成信息", "删除记忆"]
    public static let correctionTitle = "纠正这条记忆"
    public static let correctionFields = ["标题", "纠正后的内容", "判断的边界", "生效时间", "失效时间"]
    public static let correctionSave = "保存"
    public static let correctionCancel = "取消"
    public static let deleteTitle = "删除这条记忆？"
    public static let deleteMessage = "原始资料保留。同一批旧证据不会重新生成这个结论；有新证据时可以重新判断。"
    public static let deleteConfirm = "确认删除"
    public static let deleteCancel = "取消"

    public static func deletionNotice(_ receipt: MemoryDeleteReceipt) -> String {
        if receipt.externalErase == "pending" { return "记忆已禁止使用；外部清除仍待确认。" }
        if receipt.externalErase == "acknowledged" && receipt.physicalEraseVerified != true {
            return "记忆已禁止使用；外部已确认移除当前记录，物理擦除尚未核验。"
        }
        return "记忆已禁止使用。"
    }
}

public struct MemoryDetailEvidenceRow: Identifiable, Equatable, Sendable {
    public enum Kind: String, Equatable, Sendable {
        case file
        case note
        case other
    }

    public let id: String
    public let title: String
    public let subtitle: String
    public let kind: Kind

    public init(id: String, title: String, subtitle: String, kind: Kind = .other) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.kind = kind
    }
}

public struct MemoryDetailVersionRow: Identifiable, Equatable, Sendable {
    public let id: String
    public let statement: String
    public let subtitle: String
    public let isCurrent: Bool

    public init(id: String, statement: String, subtitle: String, isCurrent: Bool) {
        self.id = id
        self.statement = statement
        self.subtitle = subtitle
        self.isCurrent = isCurrent
    }
}

public struct MemoryDetailInfoRow: Identifiable, Equatable, Sendable {
    public let label: String
    public let value: String

    public var id: String { label }

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

/// Everything the detail screen displays. Live loads map Central records into
/// this value; the generated preview states use the same shape.
public struct MemoryDetailContent: Equatable, Sendable {
    public let id: String
    public let version: Int
    public let title: String
    public let statement: String
    public let uncertainty: String
    public let validityLabel: String
    public let isCorrection: Bool
    public let evidence: [MemoryDetailEvidenceRow]
    public let versions: [MemoryDetailVersionRow]
    public let info: [MemoryDetailInfoRow]
    public let validFrom: Date?
    public let validUntil: Date?

    public init(
        id: String,
        version: Int,
        title: String,
        statement: String,
        uncertainty: String,
        validityLabel: String,
        isCorrection: Bool = false,
        evidence: [MemoryDetailEvidenceRow],
        versions: [MemoryDetailVersionRow],
        info: [MemoryDetailInfoRow],
        validFrom: Date? = nil,
        validUntil: Date? = nil
    ) {
        self.id = id
        self.version = version
        self.title = title
        self.statement = statement
        self.uncertainty = uncertainty
        self.validityLabel = validityLabel
        self.isCorrection = isCorrection
        self.evidence = evidence
        self.versions = versions
        self.info = info
        self.validFrom = validFrom
        self.validUntil = validUntil
    }

    public var shareText: String {
        title + "\n\n" + statement
    }

    public static func present(
        record: MemoryRecord,
        history: [MemoryRecord] = [],
        evidence: [OriginalRecord] = [],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> MemoryDetailContent {
        let versionRecords = [record] + history.filter { $0.id != record.id }
        let versionRows = versionRecords.enumerated().map { index, version in
            let isCurrent = version.supersededBy == nil
            let subtitle: String
            if isCurrent {
                subtitle = "当前版本 · " + validityLabel(
                    validFrom: version.validFrom,
                    validUntil: version.validUntil,
                    now: now,
                    calendar: calendar
                )
            } else {
                let startDate = CentralTimestamp.parse(version.validFrom ?? "")
                let endDate = CentralTimestamp.parse(version.supersededAt ?? "")
                    ?? versionRecords.compactMap { CentralTimestamp.parse($0.validFrom ?? "") }
                        .filter { candidate in startDate.map { candidate > $0 } ?? false }
                        .min()
                    ?? CentralTimestamp.parse(version.validUntil ?? "")
                let range = historyRange(start: startDate, end: endDate, now: now, calendar: calendar)
                subtitle = "历史版本" + (range.map { " · " + $0 } ?? "")
            }
            return MemoryDetailVersionRow(
                id: version.id,
                statement: version.statement,
                subtitle: subtitle,
                isCurrent: isCurrent
            )
        }
        let evidenceRows = evidence.isEmpty
            ? record.evidence.map { evidenceRow($0, now: now, calendar: calendar) }
            : evidence.map { evidenceRow($0, now: now, calendar: calendar) }
        let type = record.admission.layer == "memory" ? "精选记忆" : "事件与资料"
        let source = record.correction == nil ? "模型生成" : "用户纠正"
        return MemoryDetailContent(
            id: record.id,
            version: record.version,
            title: record.title,
            statement: record.statement,
            uncertainty: record.uncertainty,
            validityLabel: validityLabel(
                validFrom: record.validFrom,
                validUntil: record.validUntil,
                now: now,
                calendar: calendar
            ),
            isCorrection: record.correction != nil,
            evidence: evidenceRows,
            versions: versionRows,
            info: [
                MemoryDetailInfoRow(label: "类型", value: type),
                MemoryDetailInfoRow(label: "来源", value: source),
                MemoryDetailInfoRow(
                    label: "生成时间",
                    value: relativeDateTime(CentralTimestamp.parse(record.createdAt), now: now, calendar: calendar)
                ),
            ],
            validFrom: CentralTimestamp.parse(record.validFrom ?? ""),
            validUntil: CentralTimestamp.parse(record.validUntil ?? "")
        )
    }

    public static func validityLabel(
        validFrom: String?,
        validUntil: String?,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> String {
        let start = CentralTimestamp.parse(validFrom ?? "")
        let end = CentralTimestamp.parse(validUntil ?? "")
        if let start {
            let startLabel = calendar.isDate(start, inSameDayAs: now)
                ? "今天起"
                : dayLabel(start, now: now, calendar: calendar) + "起"
            if let end {
                return startLabel + " · " + dayLabel(end, now: now, calendar: calendar) + "止"
            }
            return startLabel
        }
        if let end {
            return "至 " + dayLabel(end, now: now, calendar: calendar)
        }
        return "现在起"
    }

    public static func relativeDateTime(
        _ date: Date?,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> String {
        guard let date else { return "" }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "HH:mm"
        return dayLabel(date, now: now, calendar: calendar) + " " + formatter.string(from: date)
    }

    private static func historyRange(start: Date?, end: Date?, now: Date, calendar: Calendar) -> String? {
        let startLabel = start.map { dayLabel($0, now: now, calendar: calendar) }
        let endLabel = end.map { dayLabel($0, now: now, calendar: calendar) }
        switch (startLabel, endLabel) {
        case let (start?, end?): return start + " – " + end
        case let (start?, nil): return start + " – 现在"
        case let (nil, end?): return "至 " + end
        default: return nil
        }
    }

    private static func dayLabel(_ date: Date, now: Date, calendar: Calendar) -> String {
        ConversationHistory.dateLabel(date, now: now, calendar: calendar)
    }

    private static func evidenceRow(
        _ record: OriginalRecord,
        now: Date,
        calendar: Calendar
    ) -> MemoryDetailEvidenceRow {
        let source = record.source.rawValue
        let title = LibraryBrowsePresentation.title(
            source: source,
            textPreview: record.ocrText,
            windowTitle: record.windowTitle,
            appName: record.appName
        )
        let sourceLabel = LibraryBrowsePresentation.sourceLabel(
            source: source,
            kind: "",
            isMaterial: record.memoryMaterialRef != nil,
            appName: record.appName,
            durationMs: record.durationMs
        )
        let time = relativeDateTime(CentralTimestamp.parse(record.capturedAt), now: now, calendar: calendar)
        return MemoryDetailEvidenceRow(
            id: record.id,
            title: title.isEmpty ? "查看原始记录" : title,
            subtitle: [sourceLabel, time].filter { !$0.isEmpty }.joined(separator: " · "),
            kind: source == "file" || record.memoryMaterialRef != nil ? .file : source == "note" ? .note : .other
        )
    }

    private static func evidenceRow(
        _ evidence: MemoryEvidence,
        now: Date,
        calendar: Calendar
    ) -> MemoryDetailEvidenceRow {
        let pathTitle = evidence.path.map { path in
            path.split(separator: "/").last.map(String.init) ?? path
        }?.trimmingCharacters(in: .whitespacesAndNewlines)
        let quoteTitle = evidence.quote?
            .split(whereSeparator: \.isNewline).first
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let title = [pathTitle, quoteTitle].compactMap { $0 }.first { !$0.isEmpty } ?? "查看原始记录"
        let time = relativeDateTime(CentralTimestamp.parse(evidence.capturedAt), now: now, calendar: calendar)
        return MemoryDetailEvidenceRow(
            id: evidence.id,
            title: title,
            subtitle: time,
            kind: evidence.path == nil ? .note : .file
        )
    }
}
