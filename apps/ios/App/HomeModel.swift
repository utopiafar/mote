import Foundation
import MoteCentral
import MoteCore
import MoteStorage
import Observation

/// Loads the saved connection, the single draft and durable local records.
/// Central rows remain scoped to the connection that supplied them.
/// Calendar needs are an independent read and do not replace local saved rows.
@MainActor
@Observable
final class HomeModel {
    private(set) var presentation: HomePresentation

    private let calendar: Calendar
    private let session: URLSession
    private let fileManager: FileManager
    private var centralOriginals: [HomeOriginal] = []
    private var centralOrigin: String?
    private var highlights: [HomeHighlight] = []
    private var refreshGeneration = 0

    init(calendar: Calendar = .current, session: URLSession = .shared, fileManager: FileManager = .default) {
        self.calendar = calendar
        self.session = session
        self.fileManager = fileManager
        let local = Self.readLocalState(fileManager: fileManager)
        let origin = local.connection?.serverUrl ?? ""
        centralOrigin = local.connection?.serverUrl
        presentation = Self.makePresentation(
            local: local, central: [], origin: origin, highlights: [], calendar: calendar
        )
    }

    func refresh() async {
        refreshGeneration += 1
        let generation = refreshGeneration
        let local = Self.readLocalState(fileManager: fileManager)
        let origin = local.connection?.serverUrl
        if centralOrigin != origin {
            centralOrigin = origin
            centralOriginals = []
            highlights = []
        }
        render(local)

        guard let connection = local.connection,
              let client = try? CentralClient(serverUrl: connection.serverUrl, token: connection.token, session: session)
        else { return }

        do {
            let page = try await client.originals(limit: 30)
            guard generation == refreshGeneration else { return }
            centralOriginals = page.items.map { Self.original(from: $0) }
            render(local)
        } catch CentralError.http(let status, _) where status == 401 || status == 403 {
            guard generation == refreshGeneration else { return }
            centralOriginals = []
            highlights = []
            render(local)
            return
        } catch {
            guard generation == refreshGeneration else { return }
            render(local)
        }

        do {
            let needs = try await client.calendarNeeds()
            guard generation == refreshGeneration else { return }
            highlights = needs
            render(local)
        } catch CentralError.http(let status, _) where status == 401 || status == 403 {
            guard generation == refreshGeneration else { return }
            highlights = []
            render(local)
        } catch {
            guard generation == refreshGeneration else { return }
            render(local)
        }
    }

    private struct LocalState {
        let connection: StoredConnection?
        let hasDraft: Bool
        let pendingCount: Int
        let originals: [HomeOriginal]
    }

    private static func readLocalState(fileManager: FileManager) -> LocalState {
        let connection = (try? MoteStorage.connectionStore(fileManager: fileManager).read()) ?? nil
        let hasDraft = (try? MoteStorage.editorDraftStore(fileManager: fileManager).load())
            .map { !$0.isEmpty } ?? false
        let items = (try? MoteStorage.sendQueue(fileManager: fileManager).pending()) ?? []
        return LocalState(
            connection: connection,
            hasDraft: hasDraft,
            pendingCount: items.count,
            originals: localOriginals(items)
        )
    }

    private func render(_ local: LocalState) {
        presentation = Self.makePresentation(
            local: local,
            central: centralOriginals,
            origin: centralOrigin ?? "",
            highlights: highlights,
            calendar: calendar
        )
    }

    private static func makePresentation(
        local: LocalState,
        central: [HomeOriginal],
        origin: String,
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
            originals: HomeFeed.merge(local: local.originals, central: central, origin: origin),
            calendar: calendar
        )
    }

    private static func localOriginals(_ items: [SendQueueItem]) -> [HomeOriginal] {
        items.compactMap { item -> HomeOriginal? in
            guard let capture = try? JSONDecoder().decode(CaptureUpload.self, from: item.payload),
                  let capturedAt = CentralTimestamp.parse(capture.capturedAt)
            else { return nil }
            let kind = kindLabel(for: capture)
            return HomeOriginal(
                id: capture.id,
                deviceId: capture.deviceId,
                capturedAt: capturedAt,
                title: title(for: capture),
                detail: HomeFeed.detail(capturedAt: capturedAt, kind: kind, saved: true),
                thumbnail: capture.imageBase64.flatMap { Data(base64Encoded: $0) },
                saved: true,
                archiveOrigin: item.archiveOrigin
            )
        }
        .sorted {
            if $0.capturedAt == $1.capturedAt { return $0.id > $1.id }
            return $0.capturedAt > $1.capturedAt
        }
        .prefix(30)
        .map { $0 }
    }

    private static func original(from preview: CapturePreview) -> HomeOriginal {
        let capturedAt = CentralTimestamp.parse(preview.capturedAt) ?? Date()
        return HomeOriginal(
            id: preview.id,
            deviceId: preview.deviceId,
            capturedAt: capturedAt,
            title: title(for: preview),
            detail: HomeFeed.detail(capturedAt: capturedAt, kind: kindLabel(for: preview), saved: false),
            thumbnail: nil
        )
    }

    private static func title(for preview: CapturePreview) -> String {
        firstLine([preview.textPreview, preview.windowTitle, preview.appName]) ?? sourceLabel(preview.source)
    }

    private static func title(for capture: CaptureUpload) -> String {
        firstLine([
            capture.ocrText,
            capture.metadata?.noteOrigin?.text,
            capture.windowTitle,
            capture.appName,
        ]) ?? sourceLabel(capture.source)
    }

    private static func firstLine(_ candidates: [String?]) -> String? {
        for candidate in candidates {
            guard let line = candidate?.split(whereSeparator: \.isNewline).first else { continue }
            let trimmed = String(line).trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { return String(trimmed.prefix(80)) }
        }
        return nil
    }

    private static func kindLabel(for preview: CapturePreview) -> String {
        if preview.source == .media, preview.durationMs > 0 {
            let seconds = preview.durationMs / 1000
            return String(format: "录音 %d:%02d", seconds / 60, seconds % 60)
        }
        return sourceLabel(preview.source)
    }

    private static func kindLabel(for capture: CaptureUpload) -> String {
        if capture.source == .media, capture.durationMs > 0 {
            let seconds = capture.durationMs / 1000
            return String(format: "录音 %d:%02d", seconds / 60, seconds % 60)
        }
        return sourceLabel(capture.source)
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
