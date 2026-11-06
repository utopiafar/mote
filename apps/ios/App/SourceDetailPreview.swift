import MoteCore
import SwiftUI

struct SourceDetailPreview: View {
    @State private var presentation: ShortcutSourcePresentation
    @State private var showingSetup = false
    @State private var setupPhase: ShortcutSetupPhase
    @State private var editingSetting: SourceSettingID?

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let kind: ShortcutSourceKind = Self.argument("-MoteSourceKind", in: arguments) == "screenshot" ? .screenshot : .notification
        let state = Self.argument("-MoteSourceState", in: arguments) ?? "receiving"
        let phase: ShortcutSetupPhase = state == "empty" ? .notEnabled : .enabled
        let settings = ShortcutSourceSettings(
            setupPhase: phase,
            isPaused: state == "paused",
            allowedApps: ["顺丰速运", "微信", "日历", "物业"],
            excludedText: ["验证码", "内部"]
        )
        _presentation = State(initialValue: ShortcutSourcePresentation(
            kind: kind,
            settings: settings,
            items: phase == .notEnabled ? [] : Self.items(for: kind)
        ))
        _setupPhase = State(initialValue: phase)
    }

    var body: some View {
        Group {
            if showingSetup {
                ShortcutSetupView(
                    presentation: ShortcutSetupPresentation(
                        kind: presentation.kind,
                        phase: setupPhase,
                        latestItem: presentation.items.first
                    ),
                    onBack: { showingSetup = false },
                    onOpenShortcuts: { setupPhase = .waiting },
                    onDone: { showingSetup = false }
                )
            } else {
                SourceDetailView(
                    presentation: presentation,
                    onBack: {},
                    onOpenShortcutSetup: { showingSetup = true },
                    onOpenSetting: { editingSetting = $0 },
                    onPause: { update { $0.isPaused = true } },
                    onResume: { update { $0.isPaused = false } },
                    onRemove: {
                        presentation = ShortcutSourcePresentation(
                            kind: presentation.kind,
                            settings: ShortcutSourceSettings(),
                            items: []
                        )
                    },
                    onOpenItem: { _ in }
                )
            }
        }
        .statusBarHidden()
        .sheet(item: $editingSetting) { setting in
            SourceSettingsEditor(
                setting: setting,
                settings: presentation.settings,
                onSave: { settings in update { $0 = settings } }
            )
        }
    }

    private func update(_ change: (inout ShortcutSourceSettings) -> Void) {
        var settings = presentation.settings
        change(&settings)
        presentation = ShortcutSourcePresentation(kind: presentation.kind, settings: settings, items: presentation.items)
    }

    static func items(for kind: ShortcutSourceKind) -> [SourceReceivedItem] {
        switch kind {
        case .notification:
            [
                SourceReceivedItem(id: "parcel", title: "包裹已放入驿站", meta: "顺丰速运 · 21:38"),
                SourceReceivedItem(id: "class", title: "周三的课改到下午四点", meta: "微信 · 16:52"),
                SourceReceivedItem(id: "dentist", title: "周五 10:00 牙医复诊", meta: "日历 · 12:00"),
                SourceReceivedItem(id: "utilities", title: "本月水电费账单已出", meta: "物业 · 09:15"),
            ]
        case .screenshot:
            [
                SourceReceivedItem(id: "roadmap", title: "白板：第三季度路线图", meta: "18:02"),
                SourceReceivedItem(id: "flight", title: "航班值机成功 · 6 排 A 座", meta: "昨天 20:11"),
                SourceReceivedItem(id: "recipe", title: "低温慢烤牛肋排的时间表", meta: "周一 11:05"),
            ]
        }
    }

    static func argument(_ name: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }
}

struct ShortcutSetupPreview: View {
    @State private var phase: ShortcutSetupPhase
    private let kind: ShortcutSourceKind

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        kind = SourceDetailPreview.argument("-MoteSourceKind", in: arguments) == "screenshot" ? .screenshot : .notification
        let phase: ShortcutSetupPhase = switch SourceDetailPreview.argument("-MoteShortcutState", in: arguments) {
        case "waiting": .waiting
        case "received": .enabled
        default: .notEnabled
        }
        _phase = State(initialValue: phase)
    }

    var body: some View {
        ShortcutSetupView(
            presentation: ShortcutSetupPresentation(
                kind: kind,
                phase: phase,
                latestItem: SourceDetailPreview.items(for: kind).first
            ),
            onBack: {},
            onOpenShortcuts: { phase = .waiting },
            onDone: {}
        )
        .statusBarHidden()
    }
}
