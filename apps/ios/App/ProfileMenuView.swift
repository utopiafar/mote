import MoteCentral
import MoteCore
import MoteDesign
import MoteStorage
import SwiftUI
import UIKit

/// 我的 Mote: the settings hub home reaches from the top-left mark. Rows whose
/// screens belong to later units answer with the shared placeholder notice.
struct ProfileMenuView: View {
    enum Screen: Equatable {
        case menu
        case capture
        case settings
        case library
        case schedule
        case original(String)
        case discovery
    }

    private let onOpenConnection: (() -> Void)?
    private let onAsk: ((OriginalAskScope) -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var screen: Screen
    @State private var model: ProfileMenuModel
    @State private var settingsModel: SettingsModel
    @State private var showingUnavailable = false

    init(
        model: ProfileMenuModel = ProfileMenuModel(),
        settingsModel: SettingsModel = SettingsModel(),
        screen: Screen = .menu,
        onOpenConnection: (() -> Void)? = nil,
        onAsk: ((OriginalAskScope) -> Void)? = nil
    ) {
        _model = State(initialValue: model)
        _settingsModel = State(initialValue: settingsModel)
        _screen = State(initialValue: screen)
        self.onOpenConnection = onOpenConnection
        self.onAsk = onAsk
    }

    var body: some View {
        ZStack {
            MoteDesignTokens.background.color
                .ignoresSafeArea()

            switch screen {
            case .menu:
                menu
            case .capture:
                CaptureSyncScreen(onBack: { dismiss() }, onOpenConnection: onOpenConnection)
            case .settings:
                SettingsScreen(model: settingsModel, onBack: { screen = .menu }, onOpenConnection: onOpenConnection)
            case .schedule:
                ScheduleScreen(onBack: { screen = .menu })
            case .library:
                LibraryMemoriesView(
                    onBack: { screen = .menu },
                    onOpenCapture: { id in screen = .original(id) },
                    onConnect: onOpenConnection
                )
            case .original(let id):
                OriginalRootView(
                    id: id,
                    onDeleted: { screen = .library },
                    onAsk: { _ in showingUnavailable = true }
                )
            case .discovery:
                DiscoveryHistoryView(onBack: { screen = .menu }, onOpenConnection: onOpenConnection, onAsk: onAsk)
            }
        }
        .alert("此功能将在后续版本提供", isPresented: $showingUnavailable) {
            Button("好", role: .cancel) {}
        }
    }

    private var menu: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                MoteIconButton(icon: .back, label: "返回") { dismiss() }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 6)
            .frame(height: 44)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("我的 Mote")
                        .font(MoteFont.title)
                        .tracking(-0.55)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 18)

                    MoteGroup {
                        MoteRow(icon: .library, title: "资料与记忆") { screen = .library }
                            .accessibilityIdentifier("menu-library")
                        MoteRow(icon: .pulse, title: "发现历史", topDivider: true) { screen = .discovery }
                        MoteRow(icon: .calendar, title: "日程与待办", topDivider: true) { screen = .schedule }
                            .accessibilityIdentifier("menu-schedule")
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)

                    MoteGroup {
                        MoteRow(icon: .refresh, title: "采集与同步", action: { screen = .capture }) {
                            HStack(spacing: 12) {
                                if let status = model.captureStatus {
                                    Text(status.title)
                                        .font(MoteFont.body)
                                        .foregroundStyle(status.tone == .warning
                                                         ? MoteDesignTokens.warning.color
                                                         : MoteDesignTokens.muted.color)
                                        .lineLimit(1)
                                }
                                MoteChevron()
                            }
                        }
                        .accessibilityIdentifier("menu-capture-sync")
                        MoteRow(icon: .gear, title: "设置", topDivider: true) { screen = .settings }
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)
                    .padding(.top, 24)

                    MoteGroup {
                        MoteRow(icon: .globe, title: "中央工作台", action: openCentral) {
                            MoteIcon(.external, size: 16)
                                .foregroundStyle(MoteDesignTokens.muted.color)
                        }
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)
                    .padding(.top, 24)
                }
                .padding(.bottom, 34)
            }
            .scrollIndicators(.hidden)
        }
        .onAppear { model.refresh() }
    }

    private func unavailable() {
        showingUnavailable = true
    }

    private func openCentral() {
        guard let connection = (try? MoteStorage.connectionStore().read()) ?? nil,
              let url = URL(string: connection.serverUrl),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else {
            unavailable()
            return
        }
        UIApplication.shared.open(url)
    }
}
