import MoteCore
import MoteDesign
import SwiftUI

enum HomeAction: Equatable {
    case profile
    case search
    case notice(HomeNotice.Operation)
    case highlight(HomeHighlight.Kind, String)
    case original(String)
    case ask
    case record
    case camera
    case microphone
}

/// The feature owning a destination handles the corresponding action.
struct HomeView: View {
    let presentation: HomePresentation
    let onAction: (HomeAction) -> Void

    var body: some View {
        VStack(spacing: 0) {
            topBar

            if let notice = presentation.notice {
                MoteNotice(
                    tone: notice.level == .needsAction ? .warning : .neutral,
                    icon: noticeIcon(notice),
                    title: notice.title,
                    actionTitle: notice.actionTitle
                ) {
                    onAction(.notice(notice.operation))
                }
                .padding(.horizontal, MoteMetrics.pageMargin)
                .padding(.top, 6)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if !presentation.highlights.isEmpty {
                        MoteGroup {
                            ForEach(Array(presentation.highlights.enumerated()), id: \.element.id) { index, highlight in
                                HomeContentRow(title: highlight.title, detail: highlight.detail, divided: index > 0) {
                                    onAction(.highlight(highlight.kind, highlight.id))
                                }
                            }
                        }
                        .padding(.horizontal, MoteMetrics.pageMargin)
                        .padding(.top, 22)
                    }

                    ForEach(presentation.days) { day in
                        Text(dayHeading(day.date))
                            .font(MoteFont.smallAction.weight(.semibold))
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .padding(.leading, 31)
                            .padding(.top, 22)
                            .padding(.bottom, 8)

                        MoteGroup {
                            ForEach(Array(day.originals.enumerated()), id: \.element.id) { index, original in
                                HomeContentRow(
                                    title: original.title,
                                    detail: original.detail,
                                    thumbnail: original.thumbnail,
                                    divided: index > 0
                                ) {
                                    onAction(.original(original.id))
                                }
                            }
                        }
                        .padding(.horizontal, MoteMetrics.pageMargin)
                    }
                }
                .padding(.bottom, 16)
            }
            .scrollIndicators(.hidden)
        }
        .background(MoteDesignTokens.background.color)
        .safeAreaInset(edge: .bottom, spacing: 0) { dock }
    }

    private var topBar: some View {
        HStack(spacing: 0) {
            Button { onAction(.profile) } label: {
                MoteMark()
                    .frame(width: MoteMetrics.touchTarget, height: MoteMetrics.touchTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("我的 Mote")
            Spacer()
            MoteIconButton(icon: .search, label: "搜索") { onAction(.search) }
        }
        .padding(.horizontal, 8)
        .frame(height: MoteMetrics.touchTarget)
    }

    private var dock: some View {
        VStack(spacing: 10) {
            MoteCapsuleButton("问一问", icon: .ask, fullWidth: true) { onAction(.ask) }
            HStack(spacing: 8) {
                MoteCapsuleButton(presentation.hasDraft ? "继续草稿" : "记录", icon: .compose, style: .primary, fullWidth: true) {
                    onAction(.record)
                }
                MoteIconButton(icon: .camera, label: "拍照", style: .filled) { onAction(.camera) }
                MoteIconButton(icon: .mic, label: "录音", style: .filled) { onAction(.microphone) }
            }
        }
        .padding(.horizontal, MoteMetrics.pageMargin)
        .padding(.top, 12)
        .padding(.bottom, 2)
        .background(MoteDesignTokens.surface.color)
        .overlay(alignment: .top) {
            Rectangle().fill(MoteDesignTokens.hair.color).frame(height: MoteDesignTokens.Dimens.borderWidth)
        }
    }

    private func noticeIcon(_ notice: HomeNotice) -> MoteIconName {
        if notice.operation == .connect { return .link }
        return notice.level == .needsAction ? .alert : .pause
    }

    private func dayHeading(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateStyle = .medium
        formatter.doesRelativeDateFormatting = true
        return formatter.string(from: date)
    }
}

private struct HomeContentRow: View {
    let title: String
    let detail: String
    var thumbnail: Data? = nil
    let divided: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(MoteFont.action)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                        .lineLimit(1)
                    Text(detail)
                        .font(MoteFont.secondary)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let thumbnail, let image = UIImage(data: thumbnail) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 44, height: 44)
                        .clipShape(RoundedRectangle(cornerRadius: MoteDesignTokens.Dimens.radiusThumbMobile))
                        .overlay {
                            RoundedRectangle(cornerRadius: MoteDesignTokens.Dimens.radiusThumbMobile)
                                .strokeBorder(MoteDesignTokens.hair.color, lineWidth: MoteDesignTokens.Dimens.borderWidth)
                        }
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(minHeight: 62)
            .contentShape(Rectangle())
            .overlay(alignment: .top) {
                if divided {
                    Rectangle().fill(MoteDesignTokens.hair.color).frame(height: MoteDesignTokens.Dimens.borderWidth)
                }
            }
        }
        .buttonStyle(.plain)
    }
}
