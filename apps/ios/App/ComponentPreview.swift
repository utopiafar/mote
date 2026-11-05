import SwiftUI
import MoteDesign

struct ComponentPreview: View {
    @State private var query = ""
    @State private var question = ""
    @State private var segment = "资料"
    @State private var notifications = true

    private let swatches: [(String, MoteColorToken)] = [
        ("背景", MoteDesignTokens.background),
        ("表面", MoteDesignTokens.surface),
        ("墨色", MoteDesignTokens.ink),
        ("强调", MoteDesignTokens.accent),
        ("完成", MoteDesignTokens.success),
        ("提醒", MoteDesignTokens.warning),
        ("危险", MoteDesignTokens.danger)
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                swatchRow
                section("输入框")
                MoteCapsuleField("搜索资料", text: $query, icon: .search)
                MoteCapsuleField("问一问", text: $question, icon: .photo) {
                    MoteIconButton(icon: .send, label: "发送", style: .solid) {}
                }
                section("按钮")
                buttonRow
                section("分组")
                group
                section("分段")
                MoteSegmentedControl(options: ["资料", "记忆"], selection: $segment)
                section("提示条")
                MoteNotice(icon: .pause, title: "屏幕采集已暂停", actionTitle: "恢复") {}
                MoteNotice(tone: .warning, icon: .alert, title: "等待采集权限", actionTitle: "处理") {}
                MoteToast(title: "已清空", actionTitle: "撤销") {}
                badgeRow
                section("底部面板")
                sheet
                section("图标")
                iconGrid
                Text("Mote")
                    .font(.system(size: 1))
                    .foregroundStyle(.clear)
                    .accessibilityIdentifier("mote-preview-bottom")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .background(MoteDesignTokens.background.color)
        .accessibilityIdentifier("mote-component-preview")
    }

    private var header: some View {
        HStack(spacing: 10) {
            MoteMark()
            Text("组件预览")
                .font(MoteFont.title)
                .tracking(-0.55)
                .foregroundStyle(MoteDesignTokens.ink.color)
            Spacer()
        }
        .accessibilityIdentifier("mote-preview-header")
    }

    private var swatchRow: some View {
        HStack(spacing: 8) {
            ForEach(Array(swatches.enumerated()), id: \.offset) { _, swatch in
                let (name, token) = swatch
                VStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(token.color)
                        .frame(height: 28)
                        .overlay {
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .strokeBorder(MoteDesignTokens.border.color, lineWidth: 1)
                        }
                    Text(name)
                        .font(.system(size: 10))
                        .foregroundStyle(MoteDesignTokens.muted.color)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    private var buttonRow: some View {
        HStack(spacing: 8) {
            MoteCapsuleButton("保存", style: .primary, fullWidth: true) {}
            MoteCapsuleButton("取消") {}
            MoteIconButton(icon: .camera, label: "拍照", style: .filled) {}
            MoteIconButton(icon: .mic, label: "录音", style: .muted) {}
        }
    }

    private var group: some View {
        MoteGroup {
            MoteRow(icon: .bell, title: "通知") {
                HStack(spacing: 8) {
                    Text("21:38")
                        .font(MoteFont.secondary)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                    MoteChevron()
                }
            }
            MoteRow(icon: .photo, title: "媒体", topDivider: true) {
                HStack(spacing: 8) {
                    Text("等待采集权限")
                        .font(MoteFont.secondary)
                        .foregroundStyle(MoteDesignTokens.warning.color)
                    MoteChevron()
                }
            }
            MoteRow(icon: .screen, title: "屏幕采集", topDivider: true) {
                Toggle("", isOn: $notifications)
                    .labelsHidden()
                    .tint(MoteDesignTokens.accent.color)
                    .accessibilityLabel(Text("屏幕采集"))
            }
        }
    }

    private var badgeRow: some View {
        HStack(spacing: 8) {
            MoteBadge("正在采集", tone: .success)
            MoteBadge("已暂停")
            MoteBadge("需要处理", tone: .warning)
            MoteBadge("失联", tone: .danger)
        }
    }

    private var sheet: some View {
        MoteBottomSheet {
            VStack(alignment: .leading, spacing: 0) {
                Text("添加来源")
                    .font(MoteFont.section)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .padding(.horizontal, 18)
                    .padding(.bottom, 6)
                MoteGroup {
                    MoteRow(icon: .photo, title: "照片") {}
                    MoteRow(icon: .file, title: "文件", topDivider: true) {}
                }
                .padding(.horizontal, 18)
                HStack {
                    MoteCapsuleButton("取消") {}
                    Spacer()
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 8)
            }
        }
    }

    private var iconGrid: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 7), spacing: 10) {
            ForEach(MoteIconName.allCases, id: \.self) { name in
                VStack(spacing: 5) {
                    MoteIcon(name, size: 24)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                    Text(name.rawValue)
                        .font(.system(size: 9))
                        .foregroundStyle(MoteDesignTokens.muted.color)
                        .lineLimit(1)
                }
            }
        }
    }

    private func section(_ title: String) -> some View {
        Text(title)
            .font(MoteFont.smallAction)
            .foregroundStyle(MoteDesignTokens.muted.color)
            .padding(.top, 2)
    }
}
