import Combine
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
    var saveAnswerRecord: SaveAnswerRecordAction = SaveAnswerRecord.save

    @State private var sentInitial = false
    @State private var saveTurn: ConversationTurn?
    @State private var keyboardHeight: CGFloat = 0
    @Environment(\.colorScheme) private var colorScheme

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
        .statusBarHidden()
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
            if let turn = model.detailTurn {
                detailsSheet(turn)
            } else if let turn = saveTurn, let result = turn.result {
                saveAnswerSheet(turn: turn, answer: result.answer)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { notification in
            guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
            keyboardHeight = max(0, UIScreen.main.bounds.maxY - frame.minY)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardHeight = 0
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
            // The canvas bubble is 44pt tall through its 1.45 line height;
            // SwiftUI's 15pt line is shorter, so keep the same minimum.
            .frame(minHeight: 44)
            .background(MoteDesignTokens.surface.color,
                        in: RoundedRectangle(cornerRadius: MoteDesignTokens.Dimens.radiusBubble, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: MoteDesignTokens.Dimens.radiusBubble, style: .continuous)
                    .strokeBorder(MoteDesignTokens.hair.color, lineWidth: 1)
            }
            .frame(maxWidth: 304, alignment: .trailing)
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
            answerText(display)
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

    /// Builds the answer as one text run so inline citation chips keep the
    /// canvas geometry: an 18pt tinted pill centred on the text's ink box.
    /// The chip image is drawn at its natural size and nudged down from the
    /// default baseline attachment so it does not clip above the first line.
    private func answerText(_ display: ConversationPresentation.Display) -> Text {
        var attributed = AttributedString(display.text)
        for emphasis in display.emphasis {
            guard let range = Self.range(in: attributed, text: display.text, start: emphasis.start, end: emphasis.end) else { continue }
            attributed[range].font = emphasis.bold ? Font.system(size: 16, weight: .semibold) : Font.system(size: 16).italic()
        }
        var output = Text("")
        var cursor = 0
        for span in display.citations where span.start >= cursor {
            if let slice = Self.slice(attributed, text: display.text, from: cursor, to: span.start) {
                output = output + Text(slice)
            }
            output = output + Text(Image(uiImage: CitationChip.image(number: span.number, colorScheme: colorScheme)))
                .baselineOffset(-4)
            // Keep closing punctuation bound to the chip so a CJK line never
            // starts with the punctuation alone.
            output = output + Text("\u{2060}")
            cursor = span.end
        }
        if let slice = Self.slice(attributed, text: display.text, from: cursor, to: display.text.count) {
            output = output + Text(slice)
        }
        return output
    }

    private static func slice(_ attributed: AttributedString, text: String,
                              from: Int, to: Int) -> AttributedString? {
        guard from >= 0, from < to, to <= text.count,
              let lower = text.index(text.startIndex, offsetBy: from, limitedBy: text.endIndex),
              let upper = text.index(text.startIndex, offsetBy: to, limitedBy: text.endIndex),
              let lowerBound = AttributedString.Index(lower, within: attributed),
              let upperBound = AttributedString.Index(upper, within: attributed),
              lowerBound < upperBound else { return nil }
        return AttributedString(attributed[lowerBound..<upperBound])
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
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(MoteDesignTokens.accent.color)
            .padding(.horizontal, 4)
            .frame(minWidth: 18, minHeight: 18)
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
                    // Canvas rows are 1.45 line-height: about 60pt tall even
                    // though the two text lines alone need only 35pt.
                    .frame(minHeight: 60)
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
        .clipShape(RoundedRectangle(cornerRadius: MoteMetrics.groupRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: MoteMetrics.groupRadius, style: .continuous)
                .strokeBorder(MoteDesignTokens.hair.color, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
    }

    private func answerActions(turn: ConversationTurn, answer: String) -> some View {
        HStack(spacing: 2) {
            Button {
                saveTurn = turn
            } label: {
                HStack(spacing: 8) {
                    MoteIcon(.memory, size: 16)
                    Text("保存为记录")
                        .font(MoteFont.action)
                }
                .foregroundStyle(MoteDesignTokens.accent.color)
                .padding(.horizontal, 8)
                // Whole-point width keeps the following 44pt icon targets on
                // whole points, so their measured touch targets stay 44pt.
                .frame(minWidth: 116, minHeight: MoteMetrics.touchTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("保存为记录"))
            answerAction(icon: .copy, label: "复制") {
                UIPasteboard.general.string = answer
            }
            answerAction(icon: .more, label: "更多") {
                model.showDetails(turn)
            }
        }
        .padding(.top, -6)
        .padding(.leading, -10)
    }

    private func answerAction(icon: MoteIconName, label: String,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            MoteIcon(icon, size: 20)
                .foregroundStyle(MoteDesignTokens.muted.color)
                .frame(width: MoteMetrics.touchTarget, height: MoteMetrics.touchTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }

    private var runningAnswer: some View {
        (Text(model.runningText)
            .font(MoteFont.reading)
            .foregroundStyle(model.runningTextIsStatusOnly
                             ? MoteDesignTokens.muted.color
                             : MoteDesignTokens.ink.color)
        + Text(Image(uiImage: AnswerCaret.image(colorScheme: colorScheme)))
            .baselineOffset(-2))
            .lineSpacing(7)
    }

    // MARK: - Save-as-record sheet

    private func saveAnswerSheet(turn: ConversationTurn, answer: String) -> some View {
        ZStack(alignment: .bottom) {
            ShareScrim()
                .contentShape(Rectangle())
                .onTapGesture { saveTurn = nil }
            if let conversationId = model.conversation?.id {
                SaveAnswerPanel(
                    quote: ShareConversationQuote(
                        question: turn.question,
                        answer: answer,
                        displayAnswer: ConversationPresentation.quotedAnswer(
                            answer, numbers: model.citationNumbers),
                        conversationId: conversationId,
                        turnId: turn.id
                    ),
                    save: saveAnswerRecord,
                    onClose: { saveTurn = nil }
                )
                .padding(.bottom, keyboardHeight)
            }
        }
        .ignoresSafeArea()
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
        .clipShape(Capsule())
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
                        .frame(width: MoteMetrics.touchTarget, height: MoteMetrics.touchTarget)
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
                        .frame(width: MoteMetrics.touchTarget, height: MoteMetrics.touchTarget)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("发送")
            }
        }
        .padding(.leading, 2)
        .padding(.trailing, 0)
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
