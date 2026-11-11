import MoteCore
import MoteDesign
import SwiftUI

/// 搜索资料: the home search action's destination. It reads the owner's
/// central originals through the same literal search Android uses, and opens
/// each hit in the existing original reader.
struct SearchRecordsView: View {
    @State private var model: SearchRecordsModel

    private let onClose: () -> Void
    private let onOpenOriginal: (String) -> Void
    private let onConnect: (() -> Void)?

    init(
        model: SearchRecordsModel? = nil,
        onClose: @escaping () -> Void,
        onOpenOriginal: @escaping (String) -> Void,
        onConnect: (() -> Void)? = nil
    ) {
        _model = State(initialValue: model ?? .live())
        self.onClose = onClose
        self.onOpenOriginal = onOpenOriginal
        self.onConnect = onConnect
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            title
            searchField
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(MoteDesignTokens.background.color.ignoresSafeArea())
        .task { await model.prepare() }
        .onChange(of: model.query) { _, _ in
            Task { await model.searchAfterQueryChange() }
        }
    }

    private var topBar: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            MoteIconButton(icon: .close, label: "关闭", action: onClose)
        }
        .padding(.horizontal, 6)
        .frame(height: 44)
    }

    private var title: some View {
        Text("搜索资料")
            .font(MoteFont.title)
            .tracking(-0.55)
            .foregroundStyle(MoteDesignTokens.ink.color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
    }

    private var searchField: some View {
        MoteCapsuleField("搜索资料", text: queryBinding, icon: .search) {
            if !model.query.isEmpty {
                Button {
                    model.query = ""
                } label: {
                    MoteIcon(.close, size: 16)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                        .frame(width: MoteMetrics.touchTarget, height: MoteMetrics.touchTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清除")
                .accessibilityIdentifier("search-records-clear")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("search-records-field")
        .padding(.horizontal, MoteMetrics.pageMargin)
        .padding(.top, 18)
        .padding(.bottom, 10)
    }

    private var queryBinding: Binding<String> {
        Binding(
            get: { model.query },
            set: { model.query = String($0.prefix(500)) }
        )
    }

    @ViewBuilder
    private var content: some View {
        if !model.connected {
            stateMessage("连接 Mote 后搜索中央原文。", actionTitle: onConnect == nil ? nil : "连接", action: onConnect)
        } else if let error = model.errorMessage {
            errorState(error)
        } else if model.loading && model.rows.isEmpty {
            MoteLoading("正在搜索…")
                .padding(.top, 16)
        } else if model.trimmedQuery.isEmpty {
            prompt("输入关键词搜索中央原文。", detail: "可搜索记录、截图、通知与文件。")
        } else if model.showsEmptyResult {
            prompt("没有找到匹配的原文。", detail: "可换一个关键词。")
        } else if model.rows.isEmpty {
            prompt("输入关键词搜索中央原文。", detail: "可搜索记录、截图、通知与文件。")
        } else {
            results
        }
    }

    private var results: some View {
        ScrollView {
            MoteGroup {
                ForEach(Array(model.rows.enumerated()), id: \.element.id) { index, row in
                    resultRow(row, divided: index > 0)
                }
            }
            .padding(.horizontal, MoteMetrics.pageMargin)
            .padding(.top, 6)
            .padding(.bottom, 12)
        }
        .scrollIndicators(.hidden)
    }

    private func resultRow(_ row: SearchRecordsModel.Row, divided: Bool) -> some View {
        Button {
            onOpenOriginal(row.id)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                highlighted(row.title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .lineLimit(2)
                if !row.snippet.isEmpty {
                    highlighted(row.snippet)
                        .font(.system(size: 13))
                        .foregroundStyle(MoteDesignTokens.muted.color)
                        .lineLimit(2)
                }
                if !row.meta.isEmpty {
                    Text(row.meta)
                        .font(.system(size: 12))
                        .foregroundStyle(MoteDesignTokens.muted.color)
                        .lineLimit(1)
                }
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
        .accessibilityLabel(row.snippet.isEmpty ? row.title : "\(row.title)，\(row.snippet)")
        .accessibilityIdentifier("search-row-\(row.id)")
        .task { await model.loadMoreIfNeeded(after: row.id) }
    }

    private func highlighted(_ text: String) -> Text {
        let ranges = MemorySearchHighlight.ranges(in: text, query: model.trimmedQuery)
        guard !ranges.isEmpty else { return Text(text) }
        var result = AttributedString()
        var index = text.startIndex
        for range in ranges {
            result.append(AttributedString(String(text[index..<range.lowerBound])))
            var highlighted = AttributedString(String(text[range]))
            highlighted.foregroundColor = MoteDesignTokens.accent.color
            highlighted.backgroundColor = MoteDesignTokens.tint.color
            result.append(highlighted)
            index = range.upperBound
        }
        result.append(AttributedString(String(text[index...])))
        return Text(result)
    }

    private func prompt(_ text: String, detail: String) -> some View {
        VStack(spacing: 6) {
            Text(text)
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.muted.color)
                .multilineTextAlignment(.center)
            Text(detail)
                .font(MoteFont.secondary)
                .foregroundStyle(MoteDesignTokens.muted.color)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 32)
        .padding(.top, 40)
    }

    private func stateMessage(_ text: String, actionTitle: String?, action: (() -> Void)?) -> some View {
        VStack(spacing: 12) {
            Text(text)
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.muted.color)
                .multilineTextAlignment(.center)
            if let actionTitle, let action {
                MoteCapsuleButton(actionTitle, action: action)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 32)
        .padding(.top, 40)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Text(message)
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.muted.color)
            MoteCapsuleButton("重试") {
                Task { await model.searchNow() }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
    }
}
