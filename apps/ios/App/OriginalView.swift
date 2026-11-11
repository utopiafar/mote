import MoteCentral
import MoteDesign
import SwiftUI
import UIKit

enum OriginalPanel: String, Identifiable {
    case more
    case detail
    case description

    var id: String { rawValue }
}

struct OriginalRootView: View {
    @State private var model: OriginalModel
    let onDeleted: () -> Void
    let onAsk: (OriginalAskScope) -> Void

    init(id: String, highlightedPhrase: String? = nil,
         onDeleted: @escaping () -> Void, onAsk: @escaping (OriginalAskScope) -> Void) {
        _model = State(initialValue: OriginalModel(id: id, highlightedPhrase: highlightedPhrase))
        self.onDeleted = onDeleted
        self.onAsk = onAsk
    }

    var body: some View {
        Group {
            if let presentation = model.presentation {
                OriginalView(
                    presentation: presentation,
                    hero: model.hero,
                    onBack: onDeleted,
                    onAsk: { onAsk($0) },
                    onDelete: { await model.delete() },
                    onDeleted: onDeleted
                )
            } else if model.isLoading {
                MoteLoading("正在读取原文…")
                    .padding(.horizontal, 20)
                    .padding(.top, MoteMetrics.touchTarget + 8)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            } else {
                VStack(spacing: 16) {
                    Text(model.errorMessage ?? "原文不可用")
                        .font(MoteFont.body)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                    if model.errorMessage != "原文不可用" {
                        MoteCapsuleButton("重试") {
                            Task { await model.load() }
                        }
                    }
                    MoteCapsuleButton("返回", style: .plain, action: onDeleted)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MoteDesignTokens.background.color)
        .task { await model.load() }
    }
}

struct OriginalView: View {
    let presentation: OriginalPresentation
    var hero: OriginalHero? = nil
    var initialPanel: OriginalPanel? = nil
    var initialDeletionError: String? = nil
    let onBack: () -> Void
    let onAsk: (OriginalAskScope) -> Void
    let onDelete: () async -> String?
    let onDeleted: () -> Void

    @State private var panel: OriginalPanel?
    @State private var confirmingDeletion = false
    @State private var deleting = false
    @State private var deletionError: String?

    init(
        presentation: OriginalPresentation,
        hero: OriginalHero? = nil,
        initialPanel: OriginalPanel? = nil,
        initialDeletionError: String? = nil,
        onBack: @escaping () -> Void,
        onAsk: @escaping (OriginalAskScope) -> Void,
        onDelete: @escaping () async -> String?,
        onDeleted: @escaping () -> Void
    ) {
        self.presentation = presentation
        self.hero = hero
        self.initialPanel = initialPanel
        self.initialDeletionError = initialDeletionError
        self.onBack = onBack
        self.onAsk = onAsk
        self.onDelete = onDelete
        self.onDeleted = onDeleted
        _panel = State(initialValue: initialPanel)
        _deletionError = State(initialValue: initialDeletionError)
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(metadata)
                            .font(MoteFont.secondary)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                        if let headline {
                            Text(headline)
                                .font(MoteFont.title)
                                .foregroundStyle(MoteDesignTokens.ink.color)
                                .frame(maxWidth: 340, alignment: .leading)
                                .accessibilityAddTraits(.isHeader)
                        }
                    }
                    .padding(.horizontal, 20)
                    // A screenshot leads and its recognized words follow; a photo follows the words it came with.
                    if isScreen {
                        if let hero { heroView(hero) }
                        Text("识别文字")
                            .font(MoteFont.secondary)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .padding(.horizontal, 20)
                            .accessibilityAddTraits(.isHeader)
                    }
                    if isScreen && presentation.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text("暂无识别文字。")
                            .font(MoteFont.body)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .padding(.horizontal, 20)
                    } else {
                        Text(bodyText)
                            .font(MoteFont.reading)
                            .foregroundStyle(MoteDesignTokens.ink.color)
                            .lineSpacing(10)
                            .frame(maxWidth: 340, alignment: .leading)
                            .padding(.horizontal, 20)
                            .textSelection(.enabled)
                    }
                    if !isScreen, let hero { heroView(hero) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 8)
            }
            .scrollIndicators(.hidden)
            if let deletionError {
                Text(deletionError)
                    .font(MoteFont.secondary)
                    .foregroundStyle(MoteDesignTokens.danger.color)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 8)
            }
        }
        .background(MoteDesignTokens.background.color)
        .safeAreaInset(edge: .bottom, spacing: 0) { askDock }
        .overlay {
            if let panel {
                ZStack(alignment: .bottom) {
                    Color.black.opacity(0.25)
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { self.panel = nil }
                    sheetContent(panel)
                }
                .ignoresSafeArea()
            }
        }
    }

    private var topBar: some View {
        HStack(spacing: 0) {
            MoteIconButton(icon: .back, label: "返回", action: onBack)
            Spacer()
            ShareLink(item: presentation.text) {
                MoteIcon(.share)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .frame(width: MoteMetrics.touchTarget, height: MoteMetrics.touchTarget)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("分享")
            MoteIconButton(icon: .more, label: "更多") {
                deletionError = nil
                panel = .more
            }
        }
        .padding(.horizontal, 8)
        .frame(height: MoteMetrics.touchTarget)
    }

    private var askDock: some View {
        Button {
            onAsk(presentation.askScope)
        } label: {
            HStack {
                Text("围绕这份资料提问")
                    .font(MoteFont.action)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                Spacer()
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity)
            .frame(minHeight: MoteMetrics.touchTarget)
            .background(MoteDesignTokens.background.color, in: Capsule())
            .overlay {
                Capsule().strokeBorder(MoteDesignTokens.controlBorder.color, lineWidth: 1)
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, MoteMetrics.pageMargin)
        .padding(.top, 12)
        .padding(.bottom, 2)
        .background(MoteDesignTokens.background.color)
        .overlay(alignment: .top) {
            Rectangle().fill(MoteDesignTokens.hair.color).frame(height: 1)
        }
    }

    @ViewBuilder
    private func sheetContent(_ panel: OriginalPanel) -> some View {
        switch panel {
        case .more: moreSheet
        case .detail: detailSheet
        case .description: descriptionSheet
        }
    }

    private var moreSheet: some View {
        MoteBottomSheet {
            VStack(spacing: 12) {
                MoteGroup {
                    MoteRow(icon: .clock, title: "详情") {
                        self.panel = .detail
                    }
                    MoteRow(icon: .compose, title: "资料说明", topDivider: true) {
                        self.panel = .description
                    }
                    MoteRow(icon: .copy, title: "复制", topDivider: true, action: {
                        UIPasteboard.general.string = presentation.text
                        self.panel = nil
                    }) {
                        EmptyView()
                    }
                }
                if presentation.deletionKind != nil {
                    Button {
                        confirmingDeletion = true
                    } label: {
                        HStack(spacing: 12) {
                            MoteIcon(.trash, size: 20)
                            Text("删除")
                                .font(MoteFont.body)
                            Spacer()
                        }
                        .foregroundStyle(MoteDesignTokens.danger.color)
                        .padding(.horizontal, 14)
                        .frame(minHeight: MoteMetrics.touchTarget)
                        .background(MoteDesignTokens.surface.color, in: RoundedRectangle(cornerRadius: MoteMetrics.groupRadius))
                        .overlay {
                            RoundedRectangle(cornerRadius: MoteMetrics.groupRadius)
                                .strokeBorder(MoteDesignTokens.hair.color, lineWidth: 1)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, MoteMetrics.pageMargin)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .alert(deletionTitle, isPresented: $confirmingDeletion) {
            Button("取消", role: .cancel) {}
            Button("确认", role: .destructive) {
                guard !deleting else { return }
                deleting = true
                Task {
                    let error = await onDelete()
                    deleting = false
                    if let error {
                        deletionError = error
                        panel = nil
                    } else {
                        panel = nil
                        onDeleted()
                    }
                }
            }
        } message: {
            Text(deletionMessage)
        }
    }

    private var detailSheet: some View {
        MoteBottomSheet {
            VStack(spacing: 0) {
                HStack {
                    Text("详情")
                        .font(MoteFont.section)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                    Spacer()
                    MoteIconButton(icon: .close, label: "关闭", style: .muted) { panel = nil }
                }
                .padding(.leading, 20)
                .padding(.trailing, 6)
                MoteGroup {
                    ForEach(Array(presentation.timeline.enumerated()), id: \.offset) { index, step in
                        HStack(spacing: 12) {
                            Circle()
                                .fill(step.completed ? MoteDesignTokens.success.color : MoteDesignTokens.muted.color)
                                .frame(width: 8, height: 8)
                            Text(step.title)
                                .font(MoteFont.body)
                                .foregroundStyle(MoteDesignTokens.ink.color)
                            Spacer()
                            Text(step.date.map(timeString) ?? "—")
                                .font(MoteFont.secondary)
                                .foregroundStyle(MoteDesignTokens.muted.color)
                        }
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .overlay(alignment: .top) {
                            if index > 0 {
                                Rectangle().fill(MoteDesignTokens.hair.color).frame(height: 1)
                            }
                        }
                    }
                }
                .padding(.horizontal, MoteMetrics.pageMargin)
                .padding(.top, 6)
                MoteGroup {
                    MoteRow(title: "来源") {
                        Text(presentation.sourceDescription)
                            .font(MoteFont.body)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                    }
                    MoteRow(title: "引用它的对话", topDivider: true) {
                        HStack(spacing: 8) {
                            Text(presentation.referenceCount.map(String.init) ?? "—")
                                .font(MoteFont.body)
                                .foregroundStyle(MoteDesignTokens.muted.color)
                            MoteChevron()
                        }
                    }
                }
                .padding(.horizontal, MoteMetrics.pageMargin)
                .padding(.top, 12)
                .padding(.bottom, 40)
            }
        }
    }

    private var descriptionSheet: some View {
        MoteBottomSheet {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("资料说明")
                        .font(MoteFont.section)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                    Spacer()
                    MoteIconButton(icon: .close, label: "关闭", style: .muted) { panel = nil }
                }
                Text(presentation.summary?.isEmpty == false ? presentation.summary! : "没有资料说明")
                    .font(MoteFont.body)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
        }
    }

    private var isScreen: Bool { presentation.source == .screen }

    @ViewBuilder
    private func heroView(_ hero: OriginalHero) -> some View {
        Group {
            switch hero {
            case .loading:
                MoteLoadingTile("正在读取图片…")
            case .image(let image):
                HeroFrame(aspectRatio: image.size.width / max(image.size.height, 1), maxHeight: 360) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                }
                .background(MoteDesignTokens.surfaceSunken.color)
                .clipShape(RoundedRectangle(cornerRadius: MoteMetrics.groupRadius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: MoteMetrics.groupRadius, style: .continuous)
                        .strokeBorder(MoteDesignTokens.hair.color, lineWidth: 1)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(isScreen ? "截图" : "照片")
                .accessibilityAddTraits(.isImage)
            case .unavailable:
                Text("图片暂不可用。")
                    .font(MoteFont.body)
                    .foregroundStyle(MoteDesignTokens.muted.color)
            }
        }
        .padding(.horizontal, 20)
    }

    /// The title earns its own line only when it says more than the opening words below it.
    private var headline: String? {
        let title = presentation.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let opening = presentation.text.split(whereSeparator: \.isNewline).first
            .map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80)) } ?? ""
        return title.isEmpty || title == "记录" || title == opening ? nil : title
    }

    private var bodyText: AttributedString {
        var text = AttributedString(presentation.text)
        if let phrase = presentation.highlightedPhrase, let range = text.range(of: phrase) {
            text[range].backgroundColor = MoteDesignTokens.tint.color
        }
        return text
    }

    private var metadata: String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        formatter.doesRelativeDateFormatting = true
        let date = formatter.string(from: presentation.capturedAt)
        return "\(date) · \(presentation.sourceDescription.components(separatedBy: " · ").first ?? "记录")"
    }

    private func timeString(_ date: Date) -> String {
        date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(Locale(identifier: "zh_CN")))
    }

    private var deletionTitle: String {
        presentation.deletionKind == .file ? "删除中央文件" : "删除中央记录"
    }

    private var deletionMessage: String {
        if presentation.deletionKind == .file {
            return "删除中央保存的这份文件。不会删除设备上的原件，也不会改变来源同步策略。删除后无法恢复。"
        }
        return "删除中央保存的这条记录。不会删除本机副本或来源原件，也不会改变来源同步策略。删除后无法恢复。"
    }
}

/// Full width and as tall as the image's shape asks, up to `maxHeight`; a taller image is centered within that.
private struct HeroFrame: Layout {
    let aspectRatio: CGFloat
    let maxHeight: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let ratio = max(aspectRatio, 0.01)
        let width = proposal.width ?? maxHeight * ratio
        return CGSize(width: width, height: min(maxHeight, width / ratio))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for subview in subviews {
            subview.place(at: CGPoint(x: bounds.midX, y: bounds.midY), anchor: .center, proposal: ProposedViewSize(bounds.size))
        }
    }
}
