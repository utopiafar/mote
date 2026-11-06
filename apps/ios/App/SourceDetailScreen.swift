import MoteCore
import MoteDesign
import SwiftUI
import UIKit

struct SourceDetailScreen: View {
    @State private var model: SourceDetailModel
    @State private var showingSetup: Bool
    @State private var setting: SourceSettingID?
    @State private var confirmingRemoval = false
    @Environment(\.scenePhase) private var scenePhase
    private let onBack: () -> Void
    private let onOpenOriginal: (String) -> Void

    init(
        kind: ShortcutSourceKind,
        initiallyShowingSetup: Bool = false,
        onBack: @escaping () -> Void,
        onOpenOriginal: @escaping (String) -> Void
    ) {
        _model = State(initialValue: SourceDetailModel(kind: kind))
        _showingSetup = State(initialValue: initiallyShowingSetup)
        self.onBack = onBack
        self.onOpenOriginal = onOpenOriginal
    }

    var body: some View {
        Group {
            if showingSetup {
                ShortcutSetupView(
                    presentation: ShortcutSetupPresentation(
                        kind: model.kind,
                        phase: model.presentation.settings.setupPhase,
                        latestItem: model.presentation.items.first
                    ),
                    onBack: { showingSetup = false },
                    onOpenShortcuts: openShortcuts,
                    onDone: {
                        showingSetup = false
                        model.refresh()
                    }
                )
            } else {
                SourceDetailView(
                    presentation: model.presentation,
                    onBack: onBack,
                    onOpenShortcutSetup: { showingSetup = true },
                    onOpenSetting: { setting = $0 },
                    onPause: { model.setPaused(true) },
                    onResume: { model.setPaused(false) },
                    onRemove: { confirmingRemoval = true },
                    onOpenItem: onOpenOriginal
                )
            }
        }
        .onAppear(perform: model.refresh)
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.refresh() }
        }
        .sheet(item: $setting) { selected in
            SourceSettingsEditor(
                setting: selected,
                settings: model.presentation.settings,
                onSave: { model.save($0) }
            )
        }
        .confirmationDialog("移除这个来源？", isPresented: $confirmingRemoval, titleVisibility: .visible) {
            Button("移除来源", role: .destructive) { model.remove() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("将停止接收，并清除本机设置和收到列表。已发送的记录不会删除。")
        }
        .alert("来源设置", isPresented: errorPresented) {
            Button("好", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    private var errorPresented: Binding<Bool> {
        Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.refresh() } }
        )
    }

    private func openShortcuts() {
        model.beginWaiting()
        if let url = URL(string: "shortcuts://") {
            UIApplication.shared.open(url)
        }
    }
}

struct SourceSettingsEditor: View {
    let setting: SourceSettingID
    let onSave: (ShortcutSourceSettings) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var settings: ShortcutSourceSettings
    @State private var listText: String

    init(
        setting: SourceSettingID,
        settings: ShortcutSourceSettings,
        onSave: @escaping (ShortcutSourceSettings) -> Void
    ) {
        self.setting = setting
        self.onSave = onSave
        _settings = State(initialValue: settings)
        let listText: String = switch setting {
        case .allowedApps: settings.allowedApps.joined(separator: "\n")
        case .textRules: settings.excludedText.joined(separator: "\n")
        case .sourceDescription: settings.sourceDescription
        case .notificationContent: ""
        }
        _listText = State(initialValue: listText)
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                if setting == .notificationContent {
                    MoteGroup {
                        ForEach(Array(NotificationContentMode.allCases.enumerated()), id: \.element) { index, mode in
                            Button {
                                settings.notificationContent = mode
                            } label: {
                                HStack(spacing: 12) {
                                    Text(mode.title)
                                        .font(MoteFont.body)
                                        .foregroundStyle(MoteDesignTokens.ink.color)
                                    Spacer(minLength: 0)
                                    if settings.notificationContent == mode {
                                        MoteIcon(.check, size: 20)
                                            .foregroundStyle(MoteDesignTokens.accent.color)
                                    }
                                }
                                .padding(.horizontal, 14)
                                .frame(minHeight: 48)
                                .contentShape(Rectangle())
                                .overlay(alignment: .top) {
                                    if index > 0 {
                                        Rectangle().fill(MoteDesignTokens.hair.color).frame(height: 1)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(settings.notificationContent == mode ? .isSelected : [])
                        }
                    }
                } else {
                    Text(helpText)
                        .font(MoteFont.secondary)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                    TextEditor(text: $listText)
                        .font(MoteFont.body)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                        .scrollContentBackground(.hidden)
                        .padding(12)
                        .frame(minHeight: 180)
                        .background(MoteDesignTokens.surface.color, in: RoundedRectangle(cornerRadius: 12))
                        .overlay {
                            RoundedRectangle(cornerRadius: 12)
                                .strokeBorder(MoteDesignTokens.hair.color, lineWidth: 1)
                        }
                        .accessibilityLabel(Text(title))
                }
                Spacer(minLength: 0)
            }
            .padding(16)
            .background(MoteDesignTokens.background.color.ignoresSafeArea())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.frame(minWidth: 44, minHeight: 44)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        switch setting {
                        case .allowedApps: settings.allowedApps = lines
                        case .textRules: settings.excludedText = lines
                        case .sourceDescription: settings.sourceDescription = listText.trimmingCharacters(in: .whitespacesAndNewlines)
                        case .notificationContent: break
                        }
                        onSave(settings)
                        dismiss()
                    }
                    .frame(minWidth: 44, minHeight: 44)
                }
            }
        }
    }

    private var title: String {
        switch setting {
        case .allowedApps: "允许的应用"
        case .notificationContent: "通知内容"
        case .textRules: "文字规则"
        case .sourceDescription: "资料说明"
        }
    }

    private var helpText: String {
        switch setting {
        case .allowedApps: "每行一个应用名称或标识。留空表示允许全部应用。"
        case .textRules: "包含这些文字的内容不会保存。每行一条。"
        case .sourceDescription: "资料说明会作为这个来源的背景保存。"
        case .notificationContent: ""
        }
    }

    private var lines: [String] {
        var seen: Set<String> = []
        return listText.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}
