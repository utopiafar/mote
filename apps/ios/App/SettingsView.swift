import MoteCore
import MoteDesign
import SwiftUI

/// 设置 and 连接与设备. The connection card opens the device page; the other
/// settings rows are owned by later units and answer with the shared
/// placeholder notice.
struct SettingsScreen: View {
    enum Page: Equatable {
        case settings
        case connection
        case diagnostics
    }

    private let onBack: () -> Void
    private let onOpenConnection: (() -> Void)?
    @State private var model: SettingsModel
    @State private var page: Page
    @State private var confirmingDisconnect = false
    @State private var notice: String?

    init(
        model: SettingsModel = SettingsModel(),
        page: Page = .settings,
        onBack: @escaping () -> Void,
        onOpenConnection: (() -> Void)? = nil
    ) {
        _model = State(initialValue: model)
        _page = State(initialValue: page)
        self.onBack = onBack
        self.onOpenConnection = onOpenConnection
    }

    var body: some View {
        ZStack {
            MoteDesignTokens.background.color.ignoresSafeArea()

            switch page {
            case .settings:
                SettingsList(
                    presentation: model.presentation,
                    version: Self.version,
                    onBack: onBack,
                    onOpenConnection: { page = .connection },
                    onOpenDiagnostics: { page = .diagnostics }
                )
            case .connection:
                ConnectionDeviceView(
                    presentation: model.presentation,
                    connected: model.connection != nil,
                    onBack: { page = .settings },
                    onConnect: { onOpenConnection?() },
                    onDisconnect: { confirmingDisconnect = true }
                )
            case .diagnostics:
                DiagnosticsSettingsView(onBack: { page = .settings })
            }

            if let notice {
                MoteToast(title: notice)
                    .padding(.horizontal, MoteMetrics.pageMargin)
                    .padding(.bottom, 24)
                    .frame(maxHeight: .infinity, alignment: .bottom)
            }
        }
        .onAppear { model.refresh() }
        .task(id: notice) {
            guard notice != nil else { return }
            try? await Task.sleep(for: .seconds(2))
            withAnimation { notice = nil }
        }
        .alert("断开连接", isPresented: $confirmingDisconnect) {
            Button("取消", role: .cancel) {}
            Button("断开连接", role: .destructive) { disconnect() }
        } message: {
            Text("断开连接后停止发送，已有记录保留在本机。")
        }
    }

    private func disconnect() {
        model.disconnect()
        page = .settings
        withAnimation { notice = "已断开连接，已有记录保留在本机" }
    }

    private static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"
    }
}

private struct SettingsList: View {
    let presentation: ConnectionDevicePresentation
    let version: String
    let onBack: () -> Void
    let onOpenConnection: () -> Void
    let onOpenDiagnostics: () -> Void
    @State private var showingUnavailable = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                MoteIconButton(icon: .back, label: "返回", action: onBack)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 6)
            .frame(height: 44)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("设置")
                        .font(MoteFont.title)
                        .tracking(-0.55)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 18)

                    MoteGroup {
                        Button(action: onOpenConnection) { connectionCard }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("settings-connection-card")
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)

                    MoteGroup {
                        MoteRow(title: "外观与语言") { unavailable() }
                            .accessibilityIdentifier("settings-appearance")
                        MoteRow(title: "备份与恢复", topDivider: true) { unavailable() }
                            .accessibilityIdentifier("settings-backup")
                        MoteRow(title: "诊断与支持", topDivider: true, action: onOpenDiagnostics)
                            .accessibilityIdentifier("settings-diagnostics")
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)
                    .padding(.top, 24)

                    MoteGroup {
                        MoteRow(title: "关于与更新", action: { unavailable() }) {
                            HStack(spacing: 12) {
                                Text(version)
                                    .font(MoteFont.body)
                                    .foregroundStyle(MoteDesignTokens.muted.color)
                                MoteChevron()
                            }
                        }
                        .accessibilityIdentifier("settings-about")
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)
                    .padding(.top, 24)
                }
                .padding(.bottom, 34)
            }
            .scrollIndicators(.hidden)
        }
        .alert("此功能将在后续版本提供", isPresented: $showingUnavailable) {
            Button("好", role: .cancel) {}
        }
    }

    private var connectionCard: some View {
        HStack(spacing: 12) {
            MoteMark()
            VStack(alignment: .leading, spacing: 1) {
                Text(presentation.central)
                    .font(MoteFont.body.weight(.medium))
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .lineLimit(1)
                Text(presentation.deviceName)
                    .font(MoteFont.secondary)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            MoteChevron()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(minHeight: 64)
        .contentShape(Rectangle())
    }

    private func unavailable() {
        showingUnavailable = true
    }
}

private struct ConnectionDeviceView: View {
    let presentation: ConnectionDevicePresentation
    let connected: Bool
    let onBack: () -> Void
    let onConnect: () -> Void
    let onDisconnect: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                MoteIconButton(icon: .back, label: "返回", action: onBack)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 6)
            .frame(height: 44)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("连接与设备")
                        .font(MoteFont.title)
                        .tracking(-0.55)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 18)

                    MoteGroup {
                        valueRow("中央", presentation.central)
                        valueRow("权限", presentation.permission, topDivider: true)
                        valueRow("连接时间", presentation.connectionTime, topDivider: true)
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)

                    VStack(alignment: .leading, spacing: 6) {
                        Text("设备名称")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .frame(height: 19, alignment: .leading)
                            .padding(.leading, 2)
                        Text(presentation.deviceName)
                            .font(MoteFont.body)
                            .foregroundStyle(MoteDesignTokens.ink.color)
                            .lineLimit(1)
                            .padding(.horizontal, 12)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .background(MoteDesignTokens.surface.color, in: RoundedRectangle(cornerRadius: 12))
                            .overlay {
                                RoundedRectangle(cornerRadius: 12)
                                    .strokeBorder(MoteDesignTokens.controlBorder.color, lineWidth: 1)
                            }
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)
                    .padding(.top, 22)

                    MoteGroup {
                        if connected {
                            Button(action: onDisconnect) {
                                Text("断开连接")
                                    .font(MoteFont.body)
                                    .foregroundStyle(MoteDesignTokens.danger.color)
                                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                    .padding(.horizontal, 14)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("settings-disconnect")
                        } else {
                            MoteRow(title: "连接你的 Mote", action: onConnect)
                        }
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)
                    .padding(.top, 24)
                }
                .padding(.bottom, 34)
            }
            .scrollIndicators(.hidden)
        }
    }

    private func valueRow(_ title: String, _ value: String, topDivider: Bool = false) -> some View {
        HStack(spacing: 12) {
            Text(title)
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.ink.color)
            Spacer(minLength: 12)
            Text(value)
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.muted.color)
                .lineLimit(1)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
        .overlay(alignment: .top) {
            if topDivider {
                Rectangle()
                    .fill(MoteDesignTokens.hair.color)
                    .frame(height: MoteDesignTokens.Dimens.borderWidth)
            }
        }
    }
}
