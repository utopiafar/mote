import MoteCentral
import MoteCore
import MoteDesign
import SwiftUI

/// 发现历史: the read-only list of insights Central already archived, plus
/// the read-only detail of one report. Nothing on this page generates a
/// report; rows only read what Central saved.
struct DiscoveryHistoryView: View {
    @State private var model: DiscoveryModel
    @State private var detail: InsightDetailModel?
    @State private var originalID: String?
    private let onBack: () -> Void
    private let onOpenConnection: (() -> Void)?
    private let onAsk: ((OriginalAskScope) -> Void)?

    init(model: DiscoveryModel? = nil, onBack: @escaping () -> Void,
         onOpenConnection: (() -> Void)? = nil,
         onAsk: ((OriginalAskScope) -> Void)? = nil) {
        _model = State(initialValue: model ?? .live())
        self.onBack = onBack
        self.onOpenConnection = onOpenConnection
        self.onAsk = onAsk
    }

    var body: some View {
        Group {
            if let originalID {
                OriginalRootView(
                    id: originalID,
                    onDeleted: {
                        self.originalID = nil
                        Task { await model.load() }
                    },
                    onAsk: { scope in onAsk?(scope) }
                )
            } else if let detail {
                InsightDetailView(
                    model: detail,
                    onBack: { self.detail = nil },
                    onOpenOriginal: { originalID = $0 }
                )
            } else {
                history
            }
        }
    }

    private var history: some View {
        ZStack {
            MoteDesignTokens.background.color
                .ignoresSafeArea()

            VStack(spacing: 0) {
                topBar
                Text("发现历史")
                    .font(MoteFont.title)
                    .tracking(-0.55)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 2)
                    .padding(.horizontal, 20)
                content
            }
            .padding(.top, 54)
            .padding(.bottom, 34)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .ignoresSafeArea(.container, edges: .vertical)
        .statusBarHidden()
        .task { await model.load() }
    }

    private var topBar: some View {
        HStack(spacing: 0) {
            MoteIconButton(icon: .back, label: "返回", action: onBack)
                .accessibilityIdentifier("discovery-back")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
        .frame(height: 44)
    }

    @ViewBuilder
    private var content: some View {
        if !model.connected {
            stateMessage("连接 Mote 后查看发现。", actionTitle: "连接", action: onOpenConnection)
        } else if model.denied {
            stateMessage("暂不可读取", actionTitle: "重试") {
                Task { await model.load() }
            }
        } else if model.failed {
            stateMessage("未能读取发现", actionTitle: "重试") {
                Task { await model.load() }
            }
        } else if model.loading && model.items.isEmpty {
            MoteLoading()
                .padding(.top, 16)
        } else if model.items.isEmpty {
            VStack(spacing: 6) {
                Text("第一份洞察会保存在这里，之后可以随时回看。")
                    .font(MoteFont.body)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 32)
            .padding(.top, 40)
        } else {
            list
        }
    }

    private func stateMessage(_ text: String, actionTitle: String,
                              action: (() -> Void)?) -> some View {
        VStack(spacing: 12) {
            Text(text)
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.muted.color)
                .multilineTextAlignment(.center)
            if let action {
                MoteCapsuleButton(actionTitle, action: action)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 32)
        .padding(.top, 40)
    }

    private var list: some View {
        ScrollView {
            VStack(spacing: 0) {
                MoteGroup {
                    ForEach(Array(model.items.enumerated()), id: \.offset) { index, report in
                        insightRow(report, divided: index > 0)
                    }
                }
                .padding(.horizontal, MoteMetrics.pageMargin)
                .padding(.top, 16)

                if model.canGoBack || model.canGoNext {
                    HStack(spacing: 16) {
                        if model.canGoBack {
                            MoteCapsuleButton("上一页", style: .plain) {
                                Task { await model.previous() }
                            }
                            .accessibilityIdentifier("discovery-previous")
                        }
                        if model.canGoNext {
                            MoteCapsuleButton("下一页", style: .plain) {
                                Task { await model.next() }
                            }
                            .accessibilityIdentifier("discovery-next")
                        }
                    }
                    .padding(.top, 14)
                }
            }
            .padding(.bottom, 12)
        }
        .scrollIndicators(.hidden)
    }

    private func insightRow(_ report: InsightReport, divided: Bool) -> some View {
        let title = InsightPresentation.title(report)
        let summary = InsightPresentation.preview(report)
        let meta = InsightPresentation.meta(report)
        let id = InsightPresentation.id(report) ?? ""
        return Button {
            guard !id.isEmpty else { return }
            detail = model.detailModel(for: id)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .lineLimit(1)
                Text(summary)
                    .font(MoteFont.secondary)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                    .lineLimit(2)
                Text(meta)
                    .font(.system(size: 12))
                    .foregroundStyle(MoteDesignTokens.muted.color)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .frame(minHeight: 60)
            .contentShape(Rectangle())
            .overlay(alignment: .top) {
                if divided {
                    Rectangle().fill(MoteDesignTokens.hair.color).frame(height: 1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title)，\(meta)")
        .accessibilityIdentifier("discovery-row-\(id)")
    }
}

/// One archived insight, read-only: title, archive metadata, the saved answer
/// and its original citations. There is no generate action on this page.
struct InsightDetailView: View {
    @Bindable var model: InsightDetailModel
    let onBack: () -> Void
    let onOpenOriginal: (String) -> Void

    var body: some View {
        ZStack {
            MoteDesignTokens.background.color
                .ignoresSafeArea()

            VStack(spacing: 0) {
                topBar
                content
            }
            .padding(.top, 54)
            .padding(.bottom, 34)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .ignoresSafeArea(.container, edges: .vertical)
        .statusBarHidden()
        .task { await model.load() }
    }

    private var topBar: some View {
        HStack(spacing: 0) {
            MoteIconButton(icon: .back, label: "返回", action: onBack)
                .accessibilityIdentifier("insight-detail-back")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
        .frame(height: 44)
    }

    @ViewBuilder
    private var content: some View {
        if let content = model.content {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(content.title)
                            .font(MoteFont.title)
                            .tracking(-0.55)
                            .foregroundStyle(MoteDesignTokens.ink.color)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(content.meta)
                            .font(MoteFont.secondary)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .frame(maxWidth: .infinity, minHeight: 19, alignment: .topLeading)
                        Text(content.answer)
                            .font(MoteFont.reading)
                            .lineSpacing(7)
                            .foregroundStyle(MoteDesignTokens.ink.color)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .padding(.top, 8)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("insight-answer")
                    }
                    .padding(.top, 2)
                    .padding(.horizontal, 20)

                    Text("原文依据")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(MoteDesignTokens.muted.color)
                        .padding(.leading, 31)
                        .padding(.top, 22)
                        .padding(.bottom, 8)

                    if content.citations.isEmpty {
                        Text("这份报告没有可引用的记录；内容需要进一步核实。")
                            .font(MoteFont.body)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .padding(.horizontal, 20)
                    } else {
                        MoteGroup {
                            ForEach(Array(content.citations.enumerated()), id: \.element.id) { index, citation in
                                citationRow(citation, index: index, divided: index > 0)
                            }
                        }
                        .padding(.horizontal, MoteMetrics.pageMargin)
                        .padding(.bottom, 12)
                    }
                }
            }
            .scrollIndicators(.hidden)
        } else if model.loading {
            MoteLoading()
                .padding(MoteMetrics.pageMargin)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else if model.unavailable {
            VStack(spacing: 14) {
                Text("这份洞察当前不可用，请从历史选择其他洞察。")
                    .font(MoteFont.body)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                    .multilineTextAlignment(.center)
                MoteCapsuleButton("发现历史", action: onBack)
                    .accessibilityIdentifier("insight-detail-history")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 32)
        } else {
            VStack(spacing: 14) {
                Text("未能读取这份发现")
                    .font(MoteFont.body)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                MoteCapsuleButton("重试") {
                    Task { await model.load() }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 32)
        }
    }

    private func citationRow(_ citation: InsightCitationRow, index: Int, divided: Bool) -> some View {
        Button {
            onOpenOriginal(citation.id)
        } label: {
            HStack(spacing: 12) {
                Text("\(index + 1)")
                    .font(MoteFont.secondary)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                    .frame(width: 28, alignment: .leading)
                VStack(alignment: .leading, spacing: 2) {
                    Text(citation.title)
                        .font(MoteFont.secondary)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                        .lineLimit(1)
                    Text(citation.subtitle)
                        .font(.system(size: 12))
                        .foregroundStyle(MoteDesignTokens.muted.color)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                MoteChevron()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
            .overlay(alignment: .top) {
                if divided {
                    Rectangle().fill(MoteDesignTokens.hair.color).frame(height: 1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("查看引用 \(index + 1)，\(citation.title)")
        .accessibilityIdentifier("insight-citation-\(citation.id)")
    }
}
