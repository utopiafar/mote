import Foundation
import MoteCentral
import MoteCore
import MoteStorage
import Observation

@MainActor
@Observable
final class SourceDetailModel {
    let kind: ShortcutSourceKind
    private(set) var presentation: ShortcutSourcePresentation
    private(set) var errorMessage: String?

    private let store: ShortcutSourceStore?

    init(kind: ShortcutSourceKind, store: ShortcutSourceStore? = try? MoteStorage.shortcutSourceStore()) {
        self.kind = kind
        self.store = store
        let snapshot = (try? store?.snapshot(for: kind)) ?? nil
        presentation = Self.presentation(kind: kind, snapshot: snapshot ?? ShortcutSourceSnapshot())
    }

    func refresh() {
        guard let store else { return }
        do {
            presentation = Self.presentation(kind: kind, snapshot: try store.snapshot(for: kind))
            errorMessage = nil
        } catch {
            errorMessage = "来源状态未能读取"
        }
    }

    func beginWaiting() {
        do {
            try store?.beginWaiting(for: kind)
            refresh()
        } catch {
            errorMessage = "快捷指令状态未能保存"
        }
    }

    func setPaused(_ paused: Bool) {
        update { $0.isPaused = paused }
    }

    func save(_ settings: ShortcutSourceSettings) {
        update { $0 = settings }
    }

    func remove() {
        do {
            try store?.remove(kind)
            presentation = Self.presentation(kind: kind, snapshot: ShortcutSourceSnapshot())
            errorMessage = nil
        } catch {
            errorMessage = "来源未能移除"
        }
    }

    private func update(_ change: (inout ShortcutSourceSettings) -> Void) {
        var settings = presentation.settings
        change(&settings)
        do {
            try store?.saveSettings(settings, for: kind)
            presentation = ShortcutSourcePresentation(
                kind: kind,
                settings: settings,
                items: presentation.items
            )
            errorMessage = nil
        } catch {
            errorMessage = "来源设置未能保存"
        }
    }

    private static func presentation(
        kind: ShortcutSourceKind,
        snapshot: ShortcutSourceSnapshot
    ) -> ShortcutSourcePresentation {
        let items = snapshot.received.map { receipt in
            let time = SourceReceiptTime.format(receipt.capturedAt)
            let meta = [receipt.appName, time].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            return SourceReceivedItem(id: receipt.id, title: receipt.title, meta: meta)
        }
        return ShortcutSourcePresentation(kind: kind, settings: snapshot.settings, items: items)
    }
}

enum SourceReceiptTime {
    static func format(_ timestamp: String) -> String {
        guard let date = CentralTimestamp.parse(timestamp) else { return "" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }
}
