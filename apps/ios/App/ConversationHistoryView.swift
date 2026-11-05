import MoteCore
import MoteDesign
import SwiftUI

struct ConversationHistoryView: View {
    @State var model: ConversationHistoryModel
    let now: Date
    let calendar: Calendar
    let onBack: () -> Void
    let onOpen: (String) -> Void
    let onSend: (String) -> Void
    let onAddImage: () -> Void
    var initialQuestion = ""
    var previewFocused = false
    @State private var question = ""
    @State private var pendingDelete: HistoryConversation?
    @State private var failureDetails: String?
    @State private var revealedID: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MoteIconButton(icon: .back, label: "返回", action: onBack)
                .padding(.leading, 6)
            Text("对话")
                .font(MoteFont.title)
                .tracking(-0.55)
                .foregroundStyle(MoteDesignTokens.ink.color)
                .frame(height: 27.5, alignment: .center)
                .padding(.leading, 20)
                .padding(.top, 2)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(ConversationHistory.groups(model.conversations, now: now, calendar: calendar)) { group in
                        Text(group.kind.title)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .frame(height: 19, alignment: .center)
                            .padding(.leading, 31)
                            .padding(.top, 22)
                            .padding(.bottom, 8)
                        MoteGroup {
                            ForEach(Array(group.conversations.enumerated()), id: \.element.id) { index, conversation in
                                row(conversation, divided: index > 0)
                                    .task { await model.loadMoreIfNeeded(after: conversation.id) }
                            }
                        }
                        .padding(.horizontal, MoteMetrics.pageMargin)
                    }
                    if model.loadFailed {
                        Button("对话暂不可读取，重新加载") { Task { await model.refresh() } }
                            .font(MoteFont.secondary)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .padding(.horizontal, 31)
                            .padding(.top, 22)
                    }
                }
                .padding(.bottom, 12)
            }
            .scrollIndicators(.hidden)
            composer
        }
        .padding(.top, 54)
        .padding(.bottom, 26)
        .background(MoteDesignTokens.background.color)
        .ignoresSafeArea(.container, edges: .vertical)
        .statusBarHidden()
        .task { await model.refresh() }
        .onAppear { question = initialQuestion }
        .alert("删除整段对话？", isPresented: Binding(
            get: { pendingDelete != nil },
            set: { if !$0 { pendingDelete = nil } }
        ), presenting: pendingDelete) { conversation in
            Button("删除对话", role: .destructive) {
                pendingDelete = nil
                revealedID = nil
                Task { await model.delete(conversation) }
            }
            Button("取消", role: .cancel) { pendingDelete = nil }
        } message: { _ in
            Text("会删除这段对话的所有问答。已单独保存的记录保留。")
        }
        .alert("查看详情", isPresented: Binding(
            get: { failureDetails != nil },
            set: { if !$0 { failureDetails = nil } }
        )) {
            Button("关闭", role: .cancel) { failureDetails = nil }
        } message: {
            Text(failureDetails ?? "")
        }
    }

    private func row(_ conversation: HistoryConversation, divided: Bool) -> some View {
        ZStack(alignment: .trailing) {
            if revealedID == conversation.id {
                Button("删除这段对话", role: .destructive) { pendingDelete = conversation }
                    .font(MoteFont.secondary.weight(.medium))
                    .foregroundStyle(.white)
                    .frame(width: 92, height: 44)
                    .background(MoteDesignTokens.danger.color)
            }
            Button { onOpen(conversation.id) } label: {
                HStack(spacing: 12) {
                    Text(conversation.title)
                        .font(MoteFont.body)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(ConversationHistory.dateLabel(conversation.updatedAt, now: now, calendar: calendar))
                        .font(MoteFont.secondary)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                }
                .padding(.horizontal, 14)
                .frame(height: 44)
                .background(MoteDesignTokens.surface.color)
                .contentShape(Rectangle())
                .overlay(alignment: .top) {
                    if divided { Rectangle().fill(MoteDesignTokens.hair.color).frame(height: 1) }
                }
            }
            .buttonStyle(.plain)
            .offset(x: revealedID == conversation.id ? -92 : 0)
            .accessibilityIdentifier("conversation-\(conversation.id)")
            .contextMenu {
                Button("删除这段对话", role: .destructive) { pendingDelete = conversation }
                if let details = model.failures[conversation.id] {
                    Button("查看详情") { failureDetails = details }
                }
            }
            .simultaneousGesture(DragGesture(minimumDistance: 20).onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                if value.translation.width < -30 { revealedID = conversation.id }
                if value.translation.width > 30 { revealedID = nil }
            })
        }
        .disabled(model.deleting.contains(conversation.id))
    }

    private var composer: some View {
        HStack(spacing: 8) {
            Button(action: onAddImage) {
                MoteIcon(.photo, size: 20)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("添加图片")
            TextField("", text: $question, prompt: Text("问一问").foregroundStyle(MoteDesignTokens.muted.color))
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.ink.color)
                .overlay(alignment: .leading) {
                    if previewFocused && !focused {
                        HStack(spacing: 1) {
                            Text(question).font(MoteFont.body).hidden()
                            Capsule().fill(MoteDesignTokens.accent.color).frame(width: 2, height: 18)
                        }
                        .allowsHitTesting(false)
                    }
                }
                .focused($focused)
                .submitLabel(.send)
                .accessibilityLabel("问一问")
                .onSubmit(send)
            if !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(action: send) {
                    MoteIcon(.up, size: 20)
                        .foregroundStyle(MoteDesignTokens.primaryInk.color)
                        .frame(width: 36, height: 36)
                        .background(MoteDesignTokens.primaryBackground.color, in: Circle())
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("发送")
                .accessibilityIdentifier("history-send")
            }
        }
        .padding(.leading, 2)
        .padding(.trailing, 2)
        .frame(height: 44)
        .background(MoteDesignTokens.surface.color, in: Capsule())
        .overlay {
            Capsule().strokeBorder(focused || previewFocused ? MoteDesignTokens.accent.color : MoteDesignTokens.controlBorder.color,
                                   lineWidth: focused || previewFocused ? 2 : 1)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    private func send() {
        let value = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        onSend(value)
    }
}
