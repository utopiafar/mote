import Foundation
import MoteCentral
import MoteCore
import MoteStorage
import Observation

/// Loads the facts the home screen can read today: the saved connection, the
/// single draft and the durable send queue. Records come from Central only
/// when a connection exists; there is no sample data on this path.
@MainActor
@Observable
final class HomeModel {
    private(set) var presentation: HomePresentation

    private let calendar: Calendar
    private let session: URLSession
    private let fileManager: FileManager
    private var originals: [HomeOriginal] = []
    private var highlights: [HomeHighlight] = []
    private var loadedConnection: StoredConnection?
    private var refreshGeneration = 0

    init(calendar: Calendar = .current, session: URLSession = .shared, fileManager: FileManager = .default) {
        self.calendar = calendar
        self.session = session
        self.fileManager = fileManager
        let local = Self.readLocalState(fileManager: fileManager)
        presentation = Self.makePresentation(local: local, originals: [], calendar: calendar)
    }

    func refresh() async {
        refreshGeneration += 1
        let generation = refreshGeneration
        let local = Self.readLocalState(fileManager: fileManager)
        if local.connection != loadedConnection {
            loadedConnection = local.connection
            originals = []
            highlights = []
        }
        presentation = Self.makePresentation(local: local, originals: originals, highlights: highlights, calendar: calendar)

        guard let connection = local.connection,
              let client = try? CentralClient(serverUrl: connection.serverUrl, token: connection.token, session: session)
        else {
            originals = []
            highlights = []
            presentation = Self.makePresentation(local: local, originals: [], highlights: [], calendar: calendar)
            return
        }

        if let page = try? await client.originals(limit: 30), generation == refreshGeneration,
           Self.readLocalState(fileManager: fileManager).connection == connection {
            originals = page.items.map { Self.original(from: $0) }
            presentation = Self.makePresentation(local: local, originals: originals, highlights: highlights, calendar: calendar)
        }
        do {
            let needs = try await client.calendarNeeds()
            guard generation == refreshGeneration, Self.readLocalState(fileManager: fileManager).connection == connection else { return }
            highlights = needs
        } catch CentralError.http(let status, _) where status == 401 || status == 403 {
            guard generation == refreshGeneration else { return }
            highlights = []
        } catch { }
        guard generation == refreshGeneration, Self.readLocalState(fileManager: fileManager).connection == connection else { return }
        presentation = Self.makePresentation(local: local, originals: originals, highlights: highlights, calendar: calendar)
    }

    private struct LocalState {
        let connection: StoredConnection?
        let hasDraft: Bool
        let pendingCount: Int
    }

    private static func readLocalState(fileManager: FileManager) -> LocalState {
        let connection = (try? MoteStorage.connectionStore(fileManager: fileManager).read()) ?? nil
        let hasDraft = (try? MoteStorage.editorDraftStore(fileManager: fileManager).load())
            .map { !$0.isEmpty } ?? false
        let pendingCount = (try? MoteStorage.sendQueue(fileManager: fileManager).pending().count) ?? 0
        return LocalState(connection: connection, hasDraft: hasDraft, pendingCount: pendingCount)
    }

    private static func makePresentation(
        local: LocalState,
        originals: [HomeOriginal],
        highlights: [HomeHighlight] = [],
        calendar: Calendar
    ) -> HomePresentation {
        let connected = local.connection != nil
        // Capture start belongs to IOS09/IOS10. Until that pipeline exists the
        // shared mapping is told the truth: capture is not enabled or live.
        let facts = CaptureStatusFacts(
            connection: connected ? .connected : .unconfigured,
            captureEnabled: false,
            captureLive: false,
            syncState: connected ? (local.pendingCount > 0 ? .waiting : .idle) : .unconfigured,
            pending: local.pendingCount
        )
        return HomePresentation(
            facts: facts,
            hasDraft: local.hasDraft,
            highlights: highlights,
            originals: originals,
            calendar: calendar
        )
    }

    private static func original(from preview: CapturePreview) -> HomeOriginal {
        let capturedAt = CentralTimestamp.parse(preview.capturedAt) ?? Date()
        return HomeOriginal(
            id: preview.id,
            capturedAt: capturedAt,
            title: title(for: preview),
            detail: detail(for: preview, capturedAt: capturedAt),
            thumbnail: nil
        )
    }

    private static func title(for preview: CapturePreview) -> String {
        for candidate in [preview.textPreview, preview.windowTitle, preview.appName] {
            guard let line = candidate.split(whereSeparator: \.isNewline).first else { continue }
            let trimmed = String(line).trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { return String(trimmed.prefix(80)) }
        }
        return sourceLabel(preview.source)
    }

    private static func detail(for preview: CapturePreview, capturedAt: Date) -> String {
        let time = capturedAt.formatted(
            Date.FormatStyle(date: .omitted, time: .shortened)
                .locale(Locale(identifier: "zh_CN"))
        )
        return "\(time) · \(kindLabel(for: preview))"
    }

    private static func kindLabel(for preview: CapturePreview) -> String {
        if preview.source == .media, preview.durationMs > 0 {
            let seconds = preview.durationMs / 1000
            return String(format: "录音 %d:%02d", seconds / 60, seconds % 60)
        }
        return sourceLabel(preview.source)
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
