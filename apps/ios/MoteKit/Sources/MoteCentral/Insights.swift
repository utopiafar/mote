import Foundation
import MoteCore

/// The saved insight artifact metadata Central attaches to a stored report.
/// Only the fields the read-only screens display are decoded.
public struct InsightArtifact: Codable, Equatable, Sendable {
    public let id: String?
    public let title: String?
    public let createdAt: String?

    public init(id: String? = nil, title: String? = nil, createdAt: String? = nil) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
    }
}

/// One archived insight as returned by `GET /api/insights` and
/// `GET /api/insights/:runId`. Central adds `id`/`createdAt` to every stored
/// result; the remaining fields are the saved query result itself.
public struct InsightReport: Codable, Equatable, Sendable {
    public let id: String?
    public let runId: String?
    public let answer: String?
    public let citations: [Answer.Citation]
    public let artifact: InsightArtifact?
    public let createdAt: String?

    public init(id: String? = nil, runId: String? = nil, answer: String? = nil,
                citations: [Answer.Citation] = [], artifact: InsightArtifact? = nil,
                createdAt: String? = nil) {
        self.id = id
        self.runId = runId
        self.answer = answer
        self.citations = citations
        self.artifact = artifact
        self.createdAt = createdAt
    }
}

/// Read-only presentation of archived insights. Mirrors Android
/// `InsightPresentation`: a discovery is an existing saved report, never a
/// local inference, and the client never generates one.
public enum InsightPresentation {
    /// Saved result IDs are opaque Central strings: non-blank, bounded and
    /// free of path separators and control characters.
    public static func validID(_ value: String) -> Bool {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.count <= 128,
              !value.contains("/"), !value.contains("\\")
        else { return false }
        return value.unicodeScalars.allSatisfy {
            !CharacterSet.controlCharacters.contains($0)
        }
    }

    /// The result identity used by both the history rows and the detail route.
    public static func id(_ report: InsightReport) -> String? {
        guard let runId = report.runId, validID(runId) else { return nil }
        return runId
    }

    /// The home block features the first saved report that carries a usable
    /// identity, a non-blank answer and at least one citation.
    public static func featured(_ items: [InsightReport]) -> InsightReport? {
        items.first { report in
            id(report) != nil
                && !(report.answer ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !report.citations.isEmpty
        }
    }

    /// One-line summary for home and history rows: citation markers removed,
    /// whitespace collapsed, then bounded.
    public static func preview(_ report: InsightReport, limit: Int = 125) -> String {
        var text = report.answer ?? ""
        for citation in report.citations where !citation.id.isEmpty {
            text = text.replacingOccurrences(of: "[\(citation.id)]", with: "")
        }
        let collapsed = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard collapsed.count > limit else { return collapsed }
        return String(collapsed.prefix(limit)) + "…"
    }

    public static func title(_ report: InsightReport) -> String {
        guard let title = report.artifact?.title?
            .trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty
        else { return "个人回顾" }
        return title
    }

    /// Detail answer with inline `[id]` markers rewritten to numbered source
    /// references in citation order.
    public static func answer(_ report: InsightReport) -> String {
        var text = report.answer ?? ""
        for (index, citation) in report.citations.enumerated() where !citation.id.isEmpty {
            text = text.replacingOccurrences(of: "[\(citation.id)]", with: "（来源 \(index + 1)）")
        }
        return text
    }

    /// The archive timestamp wins; the artifact creation time is the fallback,
    /// matching the Android row and detail metadata.
    public static func timestamp(_ report: InsightReport) -> String {
        if let createdAt = report.createdAt, !createdAt.isEmpty { return createdAt }
        return report.artifact?.createdAt ?? ""
    }

    /// Home shows at most the featured report as one discovery highlight.
    /// Any read failure arrives as `nil` and clears the block, so a revoked
    /// read or an unavailable capability never leaves stale rows behind.
    public static func homeHighlights(_ page: CentralPage<InsightReport>?) -> [HomeHighlight] {
        guard let report = page.flatMap({ featured($0.items) }),
              let highlight = homeHighlight(report)
        else { return [] }
        return [highlight]
    }

    public static func homeHighlight(_ report: InsightReport,
                                     calendar: Calendar = .current) -> HomeHighlight? {
        guard let id = id(report) else { return nil }
        return HomeHighlight(
            id: id,
            kind: .discovery,
            title: title(report),
            detail: "发现 · " + dayLabel(timestamp(report), calendar: calendar)
        )
    }

    /// Read failures that mean the owner credential lost read permission.
    public static func isDenied(_ error: Error) -> Bool {
        guard case CentralError.http(let status, _) = error else { return false }
        return status == 401 || status == 403
    }

    /// Detail reads treat revoked, missing and expired reports the same way:
    /// the saved result is gone or unreadable, so the history list is offered
    /// instead of a retry that cannot succeed.
    public static func isUnavailable(_ error: Error) -> Bool {
        guard case CentralError.http(let status, _) = error else { return false }
        return status == 401 || status == 403 || status == 404 || status == 410
    }

    /// Deduplicated citation rows in saved order, matching the Android detail.
    public static func citationRows(_ report: InsightReport,
                                    calendar: Calendar = .current) -> [InsightCitationRow] {
        var seen = Set<String>()
        return report.citations.compactMap { citation in
            guard !citation.id.isEmpty, seen.insert(citation.id).inserted else { return nil }
            let title = [citation.title, citation.appName]
                .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .first { !$0.isEmpty } ?? "原始记录"
            let stamp = citation.contentAt?.isEmpty == false ? citation.contentAt! : citation.capturedAt
            return InsightCitationRow(
                id: citation.id,
                title: title,
                subtitle: dateTimeLabel(stamp, calendar: calendar)
            )
        }
    }

    /// The shared "发现 · date · N 份依据" metadata line.
    public static func meta(_ report: InsightReport, calendar: Calendar = .current) -> String {
        [
            "发现",
            dayLabel(timestamp(report), calendar: calendar),
            "\(citationRows(report, calendar: calendar).count) 份依据",
        ].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    public static func dayLabel(_ raw: String, calendar: Calendar = .current) -> String {
        guard let date = CentralTimestamp.parse(raw) else { return raw }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }

    public static func dateTimeLabel(_ raw: String, calendar: Calendar = .current) -> String {
        guard let date = CentralTimestamp.parse(raw) else { return raw }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}

public struct InsightCitationRow: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let subtitle: String

    public init(id: String, title: String, subtitle: String) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
    }
}

/// Everything the read-only detail screen displays, mapped once from the
/// archived report so the view stays declarative.
public struct InsightDetailContent: Equatable, Sendable {
    public let id: String
    public let title: String
    public let meta: String
    public let answer: String
    public let citations: [InsightCitationRow]

    public init(id: String, title: String, meta: String, answer: String,
                citations: [InsightCitationRow]) {
        self.id = id
        self.title = title
        self.meta = meta
        self.answer = answer
        self.citations = citations
    }

    public static func present(
        _ report: InsightReport,
        calendar: Calendar = .current
    ) -> InsightDetailContent? {
        guard let id = InsightPresentation.id(report) else { return nil }
        return InsightDetailContent(
            id: id,
            title: InsightPresentation.title(report),
            meta: InsightPresentation.meta(report, calendar: calendar),
            answer: InsightPresentation.answer(report),
            citations: InsightPresentation.citationRows(report, calendar: calendar)
        )
    }
}
