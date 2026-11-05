import MoteCentral
import MoteDesign
import SwiftUI
import UIKit

/// The conversation thread page (iOS-Ask): back returns to the conversation
/// list, answers carry numbered citation chips and cards, and the composer
/// collapses to a stop control while a run is unresolved.
struct ConversationView: View {
    var model: ConversationModel
    let now: Date
    let calendar: Calendar
    /// A question carried over from the history composer, sent once on open.
    var initialQuestion: String? = nil
    let onBack: () -> Void
    let onAddImage: () -> Void

    @State private var sentInitial = false

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if model.loading {
                        ProgressView("正在读取对话…")
                            .font(MoteFont.secondary)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 24)
                    }
                    ForEach(model.turns, id: \.id) { turn in
                        questionBubble(turn.question)
                        turnBody(turn, cards: newCitationsByTurn[turn.id] ?? [])
                    }
                    if model.busy, let question = model.inFlightQuestion {
                        questionBubble(question)
                        runningAnswer
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.top, 10)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .background(MoteDesignTokens.background.color)
        .safeAreaInset(edge: .bottom, spacing: 0) { dock }
        .task {
            await model.open()
            if !sentInitial, let initialQuestion, !initialQuestion.isEmpty {
                sentInitial = true
                model.question = initialQuestion
                await model.send()
            }
        }
        .alert("引用不可用", isPresented: unavailableBinding) {
            Button("返回原对话") { model.dismissCitationNotice() }
        } message: {
            Text("引用原文已删除，历史问答仍保留。")
        }
        .alert("回答未完成", isPresented: failureBinding) {
            Button("好") { model.dismissFailure() }
        } message: {
            Text(model.turnFailure ?? "")
        }
        .overlay(alignment: .bottom) {
            if let turn = model.detailTurn { detailsSheet(turn) }
        }
    }

    private var unavailableBinding: Binding<Bool> {
        Binding(get: { model.citationUnavailable }, set: { if !$0 { model.dismissCitationNotice() } })
    }

    private var failureBinding: Binding<Bool> {
        Binding(get: { model.turnFailure != nil }, set: { if !$0 { model.dismissFailure() } })
    }

    // MARK: - Top bar

    private var topBar: some View {
        HStack(spacing: 0) {
            MoteIconButton(icon: .back, label: "返回", action: onBack)
                .accessibilityIdentifier("conversation-back")
            Spacer()
        }
        .padding(.horizontal, 6)
        .frame(height: MoteMetrics.touchTarget)
    }

    // MARK: - Thread

    private func questionBubble(_ question: String) -> some View {
        Text(question)
            .font(MoteFont.body)
            .foregroundStyle(MoteDesignTokens.ink.color)
            .padding(.horizontal, 15)
            .padding(.vertical, 10)
            .background(MoteDesignTokens.surface.color,
                        in: RoundedRectangle(cornerRadius: MoteDesignTokens.Dimens.radiusBubble, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: MoteDesignTokens.Dimens.radiusBubble, style: .continuous)
                    .strokeBorder(MoteDesignTokens.hair.color, lineWidth: 1)
            }
            .frame(maxWidth: 280, alignment: .trailing)
            .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var newCitationsByTurn: [String: [Answer.Citation]] {
        var shown = Set<String>()
        var map: [String: [Answer.Citation]] = [:]
        for turn in model.turns {
            map[turn.id] = ConversationPresentation.newCitations(turn: turn, shown: &shown)
        }
        return map
    }

    @ViewBuilder
    private func turnBody(_ turn: ConversationTurn, cards: [Answer.Citation]) -> some View {
        if let notice = ConversationPresentation.turnNotice(turn) {
            Text(notice)
                .font(MoteFont.secondary)
                .foregroundStyle(MoteDesignTokens.muted.color)
        }
        if let result = turn.result {
            let display = ConversationPresentation.formatAnswer(result.answer, numbers: model.citationNumbers)
            Text(answerAttributed(display))
                .font(MoteFont.reading)
                .foregroundStyle(MoteDesignTokens.ink.color)
                .lineSpacing(7)
                .textSelection(.enabled)
            if !cards.isEmpty {
                citationCards(turn: turn, citations: cards, numbers: model.citationNumbers)
            }
            answerActions(turn: turn, answer: result.answer)
        }
        if turn.error != nil {
            Text("回答未完成")
                .font(MoteFont.secondary)
                .foregroundStyle(MoteDesignTokens.muted.color)
            Button {
                model.showFailure(turn)
            } label: {
                Text("查看详情")
                    .font(MoteFont.smallAction)
                    .foregroundStyle(MoteDesignTokens.accent.color)
                    .frame(minHeight: MoteMetrics.touchTarget)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("ask-turn-error-details:\(turn.id)")
        }
    }

    private func answerAttributed(_ display: ConversationPresentation.Display) -> AttributedString {
        var attributed = AttributedString(display.text)
        for emphasis in display.emphasis {
            guard let range = Self.range(in: attributed, text: display.text, start: emphasis.start, end: emphasis.end) else { continue }
            attributed[range].font = emphasis.bold ? Font.system(size: 16, weight: .semibold) : Font.system(size: 16).italic()
        }
        for span in display.citations {
            guard let range = Self.range(in: attributed, text: display.text, start: span.start, end: span.end) else { continue }
            attributed[range].foregroundColor = MoteDesignTokens.accent.color
            attributed[range].backgroundColor = MoteDesignTokens.tint.color
            attributed[range].font = .system(size: 11, weight: .medium)
        }
        return attributed
    }

    private static func range(in attributed: AttributedString, text: String,
                              start: Int, end: Int) -> Range<AttributedString.Index>? {
        guard start >= 0, end <= text.count, start < end,
              let lower = text.index(text.startIndex, offsetBy: start, limitedBy: text.endIndex),
              let upper = text.index(text.startIndex, offsetBy: end, limitedBy: text.endIndex),
              let lowerBound = AttributedString.Index(lower, within: attributed),
              let upperBound = AttributedString.Index(upper, within: attributed) else { return nil }
        return lowerBound..<upperBound
    }

    private func citationChip(_ number: Int) -> some View {
        Text("\(number)")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(MoteDesignTokens.accent.color)
            .frame(minWidth: 18, minHeight: 18)
            .padding(.horizontal, 4)
            .background(MoteDesignTokens.tint.color, in: Capsule())
    }

    private func citationCards(turn: ConversationTurn, citations: [Answer.Citation],
                               numbers: [String: Int]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(citations.enumerated()), id: \.element.id) { index, citation in
                Button {
                    Task { await model.openCitation(turn: turn, citation: citation) }
                } label: {
                    HStack(spacing: 10) {
                        citationChip(numbers[citation.id] ?? index + 1)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(ConversationPresentation.citationName(citation))
                                .font(MoteFont.body.weight(.medium))
                                .foregroundStyle(MoteDesignTokens.ink.color)
                                .lineLimit(1)
                            Text(ConversationPresentation.citationSubtitle(citation, now: now, calendar: calendar))
                                .font(MoteFont.secondary)
                                .foregroundStyle(MoteDesignTokens.muted.color)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .frame(minHeight: MoteMetrics.touchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .overlay(alignment: .top) {
                    if index > 0 {
                        Rectangle().fill(MoteDesignTokens.hair.color).frame(height: 1)
                    }
                }
            }
        }
        .background(MoteDesignTokens.surface.color)
        .clipShape(RoundedRectangle(cornerRadius: MoteDesignTokens.Dimens.radiusControlMobile, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: MoteDesignTokens.Dimens.radiusControlMobile, style: .continuous)
                .strokeBorder(MoteDesignTokens.hair.color, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
    }

    private func answerActions(turn: ConversationTurn, answer: String) -> some View {
        HStack(spacing: 2) {
            // The 保存为记录 action arrives with the record panel (IOS15);
            // until then only copy and more are placed.
            MoteIconButton(icon: .copy, label: "复制") {
                UIPasteboard.general.string = answer
            }
            .disabled(model.busy)
            MoteIconButton(icon: .more, label: "更多") {
                model.showDetails(turn)
            }
            .disabled(model.busy)
        }
        .padding(.top, -6)
        .padding(.leading, -10)
    }

    private var runningAnswer: some View {
        (Text(model.runningText)
            .font(MoteFont.reading)
            .foregroundStyle(model.runningTextIsStatusOnly
                             ? MoteDesignTokens.muted.color
                             : MoteDesignTokens.ink.color)
        + Text(" ▌")
            .font(MoteFont.reading)
            .foregroundStyle(MoteDesignTokens.ink.color.opacity(0.6)))
            .lineSpacing(7)
    }

    // MARK: - Details sheet

    private func detailsSheet(_ turn: ConversationTurn) -> some View {
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.25)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { model.dismissDetails() }
            MoteBottomSheet {
                VStack(spacing: 12) {
                    HStack {
                        Text("本轮详情")
                            .font(MoteFont.section)
                            .foregroundStyle(MoteDesignTokens.ink.color)
                        Spacer()
                        MoteIconButton(icon: .close, label: "关闭", style: .muted) { model.dismissDetails() }
                    }
                    .padding(.leading, 20)
                    .padding(.trailing, 6)
                    if let result = turn.result {
                        MoteGroup {
                            ForEach(Array(ConversationPresentation.turnDetails(answer: result).enumerated()),
                                    id: \.offset) { index, fact in
                                MoteRow(title: fact.0, topDivider: index > 0) {
                                    Text(fact.1)
                                        .font(MoteFont.body)
                                        .foregroundStyle(MoteDesignTokens.muted.color)
                                        .lineLimit(1)
                                }
                            }
                        }
                        .padding(.horizontal, MoteMetrics.pageMargin)
                        let citations = result.citations
                        if !citations.isEmpty {
                            MoteGroup {
                                ForEach(Array(citations.enumerated()), id: \.element.id) { index, citation in
                                    MoteRow(title: ConversationPresentation.citationName(citation),
                                            subtitle: ConversationPresentation.citationSubtitle(citation, now: now, calendar: calendar),
                                            topDivider: index > 0,
                                            action: {
                                                model.dismissDetails()
                                                Task { await model.openCitation(turn: turn, citation: citation) }
                                            })
                                }
                            }
                            .padding(.horizontal, MoteMetrics.pageMargin)
                        } else {
                            Text("没有档案引用")
                                .font(MoteFont.secondary)
                                .foregroundStyle(MoteDesignTokens.muted.color)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 20)
                        }
                    }
                }
                .padding(.top, 8)
                .padding(.bottom, 40)
            }
        }
        .ignoresSafeArea()
    }

    // MARK: - Dock

    private var dock: some View {
        VStack(spacing: 10) {
            if model.offline {
                offlineNotice
            }
            if let label = model.scopeLabel {
                scopeChip(label)
            }
            composer
        }
        .padding(.top, 8)
        .padding(.horizontal, MoteMetrics.pageMargin)
        .padding(.bottom, 8)
        .background(MoteDesignTokens.background.color)
    }

    private var offlineNotice: some View {
        HStack(spacing: 10) {
            MoteIcon(.alert, size: 20)
                .foregroundStyle(MoteDesignTokens.warning.color)
            Text("没有连上中央")
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.ink.color)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                Task { await model.retry() }
            } label: {
                Text("重试")
                    .font(MoteFont.smallAction)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .padding(.horizontal, 12)
                    .frame(height: 34)
                    .background(MoteDesignTokens.fill.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .frame(minHeight: MoteMetrics.touchTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, 16)
        .padding(.trailing, 5)
        .frame(minHeight: MoteMetrics.touchTarget)
        .background(MoteDesignTokens.warningTint.color)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private func scopeChip(_ label: String) -> some View {
        HStack(spacing: 6) {
            MoteIcon(.file, size: 16)
            Text(label)
                .font(MoteFont.secondary)
                .lineLimit(1)
            Button {
                model.clearScope()
            } label: {
                MoteIcon(.close, size: 16)
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("清除范围")
        }
        .foregroundStyle(MoteDesignTokens.accent.color)
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .frame(height: 30)
        .background(MoteDesignTokens.tint.color, in: Capsule())
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var composer: some View {
        HStack(spacing: 8) {
            MoteIconButton(icon: .photo, label: "添加图片", style: .muted) {
                if !model.busy { onAddImage() }
            }
            TextField("",
                      text: composerBinding,
                      prompt: Text(composerPlaceholder).foregroundStyle(MoteDesignTokens.muted.color))
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.ink.color)
                .textFieldStyle(.plain)
                .submitLabel(.send)
                .disabled(model.busy)
                .accessibilityLabel("你的问题")
            if model.busy {
                Button {
                    Task { await model.stop() }
                } label: {
                    MoteIcon(.stop, size: 16)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                        .frame(width: 36, height: 36)
                        .background(MoteDesignTokens.fill.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("停止")
            } else if model.session.hasDraft {
                Button {
                    Task { await model.send() }
                } label: {
                    MoteIcon(.up, size: 20)
                        .foregroundStyle(MoteDesignTokens.primaryInk.color)
                        .frame(width: 40, height: 40)
                        .background(MoteDesignTokens.primaryBackground.color, in: Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("发送")
            }
        }
        .padding(.leading, 2)
        .padding(.trailing, 4)
        .frame(minHeight: MoteMetrics.touchTarget)
        .background(MoteDesignTokens.surface.color, in: Capsule())
        .overlay {
            Capsule().strokeBorder(MoteDesignTokens.controlBorder.color, lineWidth: 1)
        }
        .contentShape(Capsule())
    }

    private var composerBinding: Binding<String> {
        Binding(get: { model.question }, set: { model.question = $0 })
    }

    private var composerPlaceholder: String {
        model.session.conversationId == nil ? "问一问" : "继续问"
    }
}
