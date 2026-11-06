import MoteCore
import MoteDesign
import SwiftUI

struct SourceDetailView: View {
    let presentation: ShortcutSourcePresentation
    let onBack: () -> Void
    let onOpenShortcutSetup: () -> Void
    let onOpenSetting: (SourceSettingID) -> Void
    let onPause: () -> Void
    let onResume: () -> Void
    let onRemove: () -> Void
    let onOpenItem: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            SourceBackBar(action: onBack)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(presentation.title)
                        .font(MoteFont.title)
                        .tracking(-0.55)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 18)

                    if let notice = presentation.notice {
                        SourceNotice(notice: notice) {
                            notice.isWarning ? onOpenShortcutSetup() : onResume()
                        }
                        .padding(.horizontal, MoteMetrics.pageMargin)
                        .padding(.bottom, 8)
                    }

                    if presentation.showsItems {
                        SourceSectionTitle("收到", topPadding: presentation.notice == nil ? 2 : 12)
                        MoteGroup {
                            ForEach(Array(presentation.items.enumerated()), id: \.element.id) { index, item in
                                SourceReceivedRow(item: item, topDivider: index > 0) {
                                    onOpenItem(item.id)
                                }
                            }
                        }
                        .padding(.horizontal, MoteMetrics.pageMargin)
                    }

                    SourceSectionTitle("设置", topPadding: presentation.notice == nil ? 18 : 12)
                    MoteGroup {
                        SourceSettingRowView(
                            title: "快捷指令",
                            value: presentation.shortcutValue,
                            topDivider: false,
                            action: onOpenShortcutSetup
                        )
                        ForEach(presentation.settingRows) { row in
                            SourceSettingRowView(
                                title: row.title,
                                value: row.value,
                                topDivider: true,
                                action: { onOpenSetting(row.id) }
                            )
                        }
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)

                    MoteGroup {
                        if presentation.canPause {
                            SourceActionRow(title: "暂停", action: onPause)
                        }
                        SourceActionRow(
                            title: "移除来源",
                            titleColor: MoteDesignTokens.danger.color,
                            topDivider: presentation.canPause,
                            action: onRemove
                        )
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)
                    .padding(.top, 40)
                }
                .padding(.bottom, 34)
            }
            .scrollIndicators(.hidden)
        }
        .background(MoteDesignTokens.background.color.ignoresSafeArea())
    }
}

struct ShortcutSetupView: View {
    let presentation: ShortcutSetupPresentation
    let onBack: () -> Void
    let onOpenShortcuts: () -> Void
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            SourceBackBar(action: onBack)
            Text(presentation.title)
                .font(MoteFont.title)
                .tracking(-0.55)
                .foregroundStyle(MoteDesignTokens.ink.color)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.bottom, 18)

            MoteGroup {
                ForEach(presentation.steps) { step in
                    HStack(spacing: 12) {
                        Text("\(step.number)")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .frame(width: 22, height: 22)
                            .background(MoteDesignTokens.surfaceSunken.color, in: Circle())
                        Text(step.title)
                            .font(MoteFont.body)
                            .foregroundStyle(MoteDesignTokens.ink.color)
                        Spacer(minLength: 0)
                        if step.isMoteAction {
                            Text("m")
                                .font(.system(size: 18, weight: .semibold))
                                .tracking(-1)
                                .foregroundStyle(MoteDesignTokens.primaryInk.color)
                                .padding(.trailing, 1)
                                .padding(.bottom, 2)
                                .frame(width: 22, height: 22)
                                .background(MoteDesignTokens.primaryBackground.color)
                                .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                                .accessibilityHidden(true)
                        }
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 52)
                    .overlay(alignment: .top) {
                        if step.number > 1 {
                            Rectangle()
                                .fill(MoteDesignTokens.hair.color)
                                .frame(height: MoteDesignTokens.Dimens.borderWidth)
                        }
                    }
                }
            }
            .padding(.horizontal, MoteMetrics.pageMargin)

            if presentation.phase == .waiting {
                MoteGroup {
                    HStack(spacing: 12) {
                        Circle()
                            .fill(MoteDesignTokens.muted.color)
                            .frame(width: 8, height: 8)
                        Text(presentation.waitingText)
                            .font(MoteFont.body)
                            .foregroundStyle(MoteDesignTokens.ink.color)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .accessibilityElement(children: .combine)
                }
                .padding(.horizontal, MoteMetrics.pageMargin)
                .padding(.top, 24)
            } else if presentation.phase == .enabled, let item = presentation.latestItem {
                MoteGroup {
                    HStack(spacing: 12) {
                        MoteIcon(.check, size: 20)
                            .foregroundStyle(MoteDesignTokens.success.color)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.title)
                                .font(MoteFont.body.weight(.medium))
                                .foregroundStyle(MoteDesignTokens.ink.color)
                            Text(presentation.receivedText ?? "")
                                .font(MoteFont.secondary)
                                .foregroundStyle(MoteDesignTokens.muted.color)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .accessibilityElement(children: .combine)
                }
                .padding(.horizontal, MoteMetrics.pageMargin)
                .padding(.top, 24)
            }

            Spacer(minLength: 24)
            Group {
                if presentation.showsDoneButton {
                    MoteCapsuleButton("完成", style: .primary, fullWidth: true, action: onDone)
                } else if presentation.showsOpenButton {
                    ShortcutOpenButton(isSecondary: presentation.phase == .waiting, action: onOpenShortcuts)
                }
            }
            .padding(.horizontal, MoteMetrics.pageMargin)
            Color.clear.frame(height: 34)
        }
        .background(MoteDesignTokens.background.color.ignoresSafeArea())
    }
}

private struct ShortcutOpenButton: View {
    let isSecondary: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                MoteIcon(.external, size: 16)
                Text("打开快捷指令")
                    .font(MoteFont.action)
            }
            .foregroundStyle(isSecondary ? MoteDesignTokens.ink.color : MoteDesignTokens.primaryInk.color)
            .frame(maxWidth: .infinity)
            .frame(height: MoteMetrics.touchTarget)
            .background(isSecondary ? MoteDesignTokens.fill.color : MoteDesignTokens.primaryBackground.color, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

private struct SourceBackBar: View {
    let action: () -> Void

    var body: some View {
        HStack(spacing: 2) {
            MoteIconButton(icon: .back, label: "返回", action: action)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
        .frame(height: 44)
    }
}

private struct SourceSectionTitle: View {
    let title: String
    let topPadding: CGFloat

    init(_ title: String, topPadding: CGFloat) {
        self.title = title
        self.topPadding = topPadding
    }

    var body: some View {
        Text(title)
            .font(MoteFont.section)
            .foregroundStyle(MoteDesignTokens.muted.color)
            .padding(.horizontal, 30)
            .padding(.top, topPadding)
            .padding(.bottom, 8)
    }
}

private struct SourceNotice: View {
    let notice: SourceNoticePresentation
    let action: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Text(notice.title)
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.ink.color)
            Spacer(minLength: 0)
            Button(action: action) {
                Text(notice.actionTitle)
                    .font(MoteFont.smallAction)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .padding(.horizontal, 12)
                    .frame(height: 34)
                    .background(MoteDesignTokens.fill.color, in: Capsule())
                    .frame(height: MoteMetrics.touchTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, 16)
        .padding(.trailing, 5)
        .frame(minHeight: 48)
        .background(notice.isWarning ? MoteDesignTokens.warningTint.color : MoteDesignTokens.surface.color, in: Capsule())
        .overlay {
            if !notice.isWarning {
                Capsule().strokeBorder(MoteDesignTokens.hair.color, lineWidth: MoteDesignTokens.Dimens.borderWidth)
            }
        }
    }
}

private struct SourceReceivedRow: View {
    let item: SourceReceivedItem
    let topDivider: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title)
                    .font(MoteFont.body.weight(.medium))
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .lineLimit(1)
                Text(item.meta)
                    .font(MoteFont.secondary)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .frame(minHeight: 60)
            .contentShape(Rectangle())
            .overlay(alignment: .top) {
                if topDivider {
                    Rectangle().fill(MoteDesignTokens.hair.color).frame(height: MoteDesignTokens.Dimens.borderWidth)
                }
            }
        }
        .buttonStyle(.plain)
    }
}

private struct SourceSettingRowView: View {
    let title: String
    let value: String
    let topDivider: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title)
                    .font(MoteFont.body)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                Spacer(minLength: 0)
                if !value.isEmpty {
                    Text(value)
                        .font(MoteFont.body)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                        .lineLimit(1)
                }
                MoteChevron()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 2)
            .frame(minHeight: 46)
            .contentShape(Rectangle())
            .overlay(alignment: .top) {
                if topDivider {
                    Rectangle().fill(MoteDesignTokens.hair.color).frame(height: MoteDesignTokens.Dimens.borderWidth)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(value.isEmpty ? title : "\(title)，\(value)"))
    }
}

private struct SourceActionRow: View {
    let title: String
    var titleColor: Color = MoteDesignTokens.ink.color
    var topDivider: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(MoteFont.body)
                .foregroundStyle(titleColor)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
                .overlay(alignment: .top) {
                    if topDivider {
                        Rectangle().fill(MoteDesignTokens.hair.color).frame(height: MoteDesignTokens.Dimens.borderWidth)
                    }
                }
        }
        .buttonStyle(.plain)
    }
}
