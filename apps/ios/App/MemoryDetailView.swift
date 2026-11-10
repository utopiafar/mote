import MoteCentral
import MoteCore
import MoteDesign
import SwiftUI

struct MemoryDetailRootView: View {
    @State private var model: MemoryDetailModel
    private let onBack: () -> Void
    private let onOpenCapture: (String) -> Void

    init(id: String, onBack: @escaping () -> Void, onOpenCapture: @escaping (String) -> Void,
         onChanged: @escaping () -> Void = {}) {
        let model = MemoryDetailModel.live(id: id)
        model.onChanged = onChanged
        model.onDeleted = onBack
        _model = State(initialValue: model)
        self.onBack = onBack
        self.onOpenCapture = onOpenCapture
    }

    var body: some View {
        Group {
            if let content = model.content {
                MemoryDetailView(model: model, content: content, onBack: onBack, onOpenCapture: onOpenCapture)
            } else if model.loading {
                MoteLoading()
                    .padding(MoteMetrics.pageMargin)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .background(MoteDesignTokens.background.color)
            } else {
                VStack(spacing: 14) {
                    Text(model.errorMessage ?? "记忆暂不可读取")
                        .font(MoteFont.body)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                    MoteCapsuleButton("重试") {
                        Task { await model.load() }
                    }
                    MoteCapsuleButton("返回", style: .plain, action: onBack)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(MoteDesignTokens.background.color)
            }
        }
        .statusBarHidden()
        .task { await model.load() }
    }
}

struct MemoryDetailView: View {
    @Bindable var model: MemoryDetailModel
    let content: MemoryDetailContent
    let onBack: () -> Void
    let onOpenCapture: (String) -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            MoteDesignTokens.background.color
                .ignoresSafeArea()

            VStack(spacing: 0) {
                topBar
                ScrollView {
                    detail
                }
                .scrollIndicators(.hidden)
            }
            .padding(.top, 54)
            .padding(.bottom, 34)

            if let panel = model.panel {
                panelLayer(panel)
            }
        }
        .ignoresSafeArea(.container, edges: .vertical)
        .statusBarHidden()
    }

    private var topBar: some View {
        HStack(spacing: 0) {
            MoteIconButton(icon: .back, label: "返回", action: onBack)
                .accessibilityIdentifier("memory-detail-back")
            Spacer(minLength: 0)
            ShareLink(item: content.shareText) {
                MoteIcon(.share)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .frame(width: MoteMetrics.touchTarget, height: MoteMetrics.touchTarget)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("分享")
            .accessibilityIdentifier("memory-detail-share")
            MoteIconButton(icon: .more, label: "更多") {
                model.panel = .more
            }
            .accessibilityIdentifier("memory-detail-more")
        }
        .padding(.horizontal, 6)
        .frame(height: 44)
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Text(content.title)
                    .font(MoteFont.title)
                    .tracking(-0.55)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(content.statement)
                    .font(MoteFont.reading)
                    .lineSpacing(7)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .frame(maxWidth: .infinity, minHeight: 26, alignment: .topLeading)
                    .padding(.top, 4)
                Text(content.validityLabel)
                    .font(MoteFont.secondary)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                    .frame(maxWidth: .infinity, minHeight: 19, alignment: .topLeading)
            }
            .padding(.top, 2)
            .padding(.horizontal, 20)

            Text("证据")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(MoteDesignTokens.muted.color)
                .padding(.leading, 31)
                .padding(.top, 22)
                .padding(.bottom, 8)

            MoteGroup {
                ForEach(Array(content.evidence.enumerated()), id: \.element.id) { index, row in
                    evidenceRow(row, divided: index > 0)
                }
            }
            .padding(.horizontal, MoteMetrics.pageMargin)
            .padding(.bottom, 12)
        }
    }

    private func evidenceRow(_ row: MemoryDetailEvidenceRow, divided: Bool) -> some View {
        Button {
            onOpenCapture(row.id)
        } label: {
            HStack(spacing: 12) {
                MoteIcon(row.kind == .file ? .file : .compose, size: 20)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(MoteDesignTokens.ink.color)
                        .lineLimit(1)
                    Text(row.subtitle)
                        .font(MoteFont.secondary)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                MoteChevron()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(minHeight: 60)
            .contentShape(Rectangle())
            .overlay(alignment: .top) {
                if divided {
                    Rectangle().fill(MoteDesignTokens.hair.color).frame(height: 1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(row.title)，\(row.subtitle)")
        .accessibilityIdentifier("memory-evidence-\(row.id)")
    }

    @ViewBuilder
    private func panelLayer(_ panel: MemoryDetailModel.Panel) -> some View {
        if panel == .correct {
            ZStack(alignment: .top) {
                scrim {
                    guard !model.saving else { return }
                    model.panel = nil
                }
                MemoryCorrectionSheet(
                    initial: model.correctionInitial,
                    saving: model.saving,
                    error: model.saveError,
                    previewStatementFocused: model.previewStatementFocused,
                    onCancel: {
                        guard !model.saving else { return }
                        model.panel = nil
                    },
                    onSave: { draft in
                        Task { await model.save(draft) }
                    }
                )
                .padding(.top, 62)
            }
            .ignoresSafeArea()
        } else {
            ZStack(alignment: .bottom) {
                scrim {
                    if !model.deleting { model.panel = nil }
                }
                switch panel {
                case .more: moreSheet
                case .history: historySheet
                case .info: infoSheet
                case .delete: deleteSheet
                case .correct: EmptyView()
                }
            }
            .ignoresSafeArea()
        }
    }

    private var moreSheet: some View {
        MoteBottomSheet {
            VStack(spacing: 12) {
                MoteGroup {
                    MoteRow(icon: .compose, title: MemoryDetailCopy.moreItems[0]) {
                        model.panel = .correct
                    }
                    .accessibilityIdentifier("memory-more-correct")
                    MoteRow(icon: .history, title: MemoryDetailCopy.moreItems[1], topDivider: true) {
                        model.panel = .history
                    }
                    .accessibilityIdentifier("memory-more-history")
                    MoteRow(icon: .clock, title: MemoryDetailCopy.moreItems[2], topDivider: true) {
                        model.panel = .info
                    }
                    .accessibilityIdentifier("memory-more-info")
                }
                MoteGroup {
                    Button {
                        model.panel = .delete
                    } label: {
                        HStack(spacing: 12) {
                            MoteIcon(.trash, size: 20)
                            Text(MemoryDetailCopy.moreItems[3])
                                .font(MoteFont.body)
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(MoteDesignTokens.danger.color)
                        .padding(.horizontal, 14)
                        .frame(minHeight: MoteMetrics.touchTarget)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("memory-more-delete")
                }
            }
            .padding(.horizontal, MoteMetrics.pageMargin)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
    }

    private var historySheet: some View {
        VStack(spacing: 0) {
            sheetGrab
            sheetHeader(MemoryDetailCopy.moreItems[1])
            MoteGroup {
                ForEach(Array(content.versions.enumerated()), id: \.element.id) { index, version in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(version.statement)
                            .font(.system(size: 16))
                            .foregroundStyle(version.isCurrent
                                             ? MoteDesignTokens.ink.color
                                             : MoteDesignTokens.muted.color)
                            .frame(maxWidth: .infinity, minHeight: 22, alignment: .topLeading)
                        Text(version.subtitle)
                            .font(MoteFont.secondary)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .frame(maxWidth: .infinity, minHeight: 19, alignment: .topLeading)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .frame(minHeight: MoteMetrics.touchTarget)
                    .overlay(alignment: .top) {
                        if index > 0 {
                            Rectangle().fill(MoteDesignTokens.hair.color).frame(height: 1)
                        }
                    }
                }
            }
            .padding(.horizontal, MoteMetrics.pageMargin)
            .padding(.top, 9)
            .padding(.bottom, 40)
        }
        .frame(maxWidth: .infinity)
        .background(MoteDesignTokens.surfaceRaised.color)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: MoteMetrics.sheetRadius,
                topTrailingRadius: MoteMetrics.sheetRadius
            )
        )
    }

    private var infoSheet: some View {
        VStack(spacing: 0) {
            sheetGrab
            sheetHeader(MemoryDetailCopy.moreItems[2])
            MoteGroup {
                ForEach(Array(content.info.enumerated()), id: \.element.id) { index, row in
                    HStack(spacing: 12) {
                        Text(row.label)
                            .font(MoteFont.body)
                            .foregroundStyle(MoteDesignTokens.ink.color)
                        Spacer(minLength: 0)
                        Text(row.value)
                            .font(MoteFont.body)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: MoteMetrics.touchTarget)
                    .overlay(alignment: .top) {
                        if index > 0 {
                            Rectangle().fill(MoteDesignTokens.hair.color).frame(height: 1)
                        }
                    }
                }
            }
            .padding(.horizontal, MoteMetrics.pageMargin)
            .padding(.top, 6)
            .padding(.bottom, 40)
        }
        .frame(maxWidth: .infinity)
        .background(MoteDesignTokens.surfaceRaised.color)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: MoteMetrics.sheetRadius,
                topTrailingRadius: MoteMetrics.sheetRadius
            )
        )
    }

    private var sheetGrab: some View {
        Capsule()
            .fill(MoteDesignTokens.border.color)
            .frame(width: 36, height: 5)
            .padding(.top, 6)
            .padding(.bottom, 2)
    }

    private func sheetHeader(_ title: String) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .font(MoteFont.section)
                .foregroundStyle(MoteDesignTokens.ink.color)
            Spacer(minLength: 0)
            MoteIconButton(icon: .close, label: "关闭", style: .muted) {
                model.panel = nil
            }
        }
        .padding(.leading, 20)
        .padding(.trailing, 6)
        .frame(height: 44)
    }

    private var deleteSheet: some View {
        VStack(spacing: 13) {
            VStack(alignment: .leading, spacing: 6) {
                Text(MemoryDetailCopy.deleteTitle)
                    .font(MoteFont.section)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                Text(MemoryDetailCopy.deleteMessage)
                    .font(.system(size: 14))
                    .lineSpacing(5)
                    .foregroundStyle(MoteDesignTokens.muted.color)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .padding(.bottom, 10)

            if let error = model.deletionError {
                Text(error)
                    .font(MoteFont.secondary)
                    .foregroundStyle(MoteDesignTokens.danger.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
            }

            Button {
                Task { await model.delete() }
            } label: {
                Text(model.deleting ? "正在删除…" : MemoryDetailCopy.deleteConfirm)
                    .font(MoteFont.action)
                    .foregroundStyle(MoteDesignTokens.danger.color)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: MoteMetrics.touchTarget)
                    .background(MoteDesignTokens.fill.color, in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(model.deleting)
            .accessibilityIdentifier("memory-delete-confirm")

            Button {
                guard !model.deleting else { return }
                model.panel = nil
            } label: {
                Text(MemoryDetailCopy.deleteCancel)
                    .font(MoteFont.action)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: MoteMetrics.touchTarget)
                    .background(MoteDesignTokens.fill.color, in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(model.deleting)
            .accessibilityIdentifier("memory-delete-cancel")
        }
        .padding(.horizontal, MoteMetrics.pageMargin)
        .padding(.top, 22)
        .padding(.bottom, 42)
        .frame(maxWidth: .infinity)
        .background(MoteDesignTokens.surfaceRaised.color)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: MoteMetrics.sheetRadius,
                topTrailingRadius: MoteMetrics.sheetRadius
            )
        )
    }

    private func scrim(action: @escaping () -> Void) -> some View {
        (colorScheme == .dark ? Color.black.opacity(0.55) : MoteDesignTokens.ink.color.opacity(0.36))
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture(perform: action)
            .accessibilityHidden(true)
    }
}

private struct MemoryCorrectionSheet: View {
    private enum Field: Hashable {
        case title
        case statement
        case uncertainty
    }

    private enum ValidityField: String, Identifiable {
        case validFrom
        case validUntil

        var id: String { rawValue }
        var title: String { self == .validFrom ? MemoryDetailCopy.correctionFields[3] : MemoryDetailCopy.correctionFields[4] }
    }

    let saving: Bool
    let error: String?
    let previewStatementFocused: Bool
    let onCancel: () -> Void
    let onSave: (MemoryDetailModel.CorrectionDraft) -> Void

    @State private var draft: MemoryDetailModel.CorrectionDraft
    @State private var editing: ValidityField?
    @FocusState private var focused: Field?

    init(
        initial: MemoryDetailModel.CorrectionDraft,
        saving: Bool,
        error: String?,
        previewStatementFocused: Bool,
        onCancel: @escaping () -> Void,
        onSave: @escaping (MemoryDetailModel.CorrectionDraft) -> Void
    ) {
        _draft = State(initialValue: initial)
        self.saving = saving
        self.error = error
        self.previewStatementFocused = previewStatementFocused
        self.onCancel = onCancel
        self.onSave = onSave
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        fieldLabel(MemoryDetailCopy.correctionFields[0])
                        TextField("", text: $draft.title)
                            .font(.system(size: 16))
                            .foregroundStyle(MoteDesignTokens.ink.color)
                            .textFieldStyle(.plain)
                            .focused($focused, equals: .title)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 44)
                            .background(MoteDesignTokens.surface.color, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(
                                        focused == .title ? MoteDesignTokens.accent.color : MoteDesignTokens.controlBorder.color,
                                        lineWidth: focused == .title ? 2 : 1
                                    )
                            }
                            .accessibilityLabel(MemoryDetailCopy.correctionFields[0])
                            .accessibilityIdentifier("memory-correction-title")
                    }
                    .padding(.bottom, 4)

                    area(
                        label: MemoryDetailCopy.correctionFields[1],
                        text: $draft.statement,
                        field: .statement,
                        minHeight: 112,
                        identifier: "memory-correction-statement"
                    )
                    area(
                        label: MemoryDetailCopy.correctionFields[2],
                        text: $draft.uncertainty,
                        field: .uncertainty,
                        minHeight: 72,
                        identifier: "memory-correction-uncertainty"
                    )

                    if let error {
                        Text(error)
                            .font(MoteFont.secondary)
                            .foregroundStyle(MoteDesignTokens.danger.color)
                    }
                }
                .padding(.horizontal, MoteMetrics.pageMargin)
                .padding(.top, 10)

                MoteGroup {
                    validityRow(.validFrom)
                    validityRow(.validUntil)
                }
                .padding(.horizontal, MoteMetrics.pageMargin)
                .padding(.top, 20)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(MoteDesignTokens.surfaceRaised.color)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: MoteMetrics.sheetRadius,
                topTrailingRadius: MoteMetrics.sheetRadius
            )
        )
        .sheet(item: $editing) { field in
            validityEditor(field)
        }
    }

    private var topBar: some View {
        ZStack {
            HStack(spacing: 6) {
                Button(MemoryDetailCopy.correctionCancel, action: onCancel)
                    .font(MoteFont.action)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                    .padding(.horizontal, 8)
                    .frame(minHeight: 44)
                    .disabled(saving)
                    .accessibilityIdentifier("memory-correction-cancel")
                Spacer(minLength: 0)
                Button {
                    focused = nil
                    onSave(draft)
                } label: {
                    Text(MemoryDetailCopy.correctionSave)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(MoteDesignTokens.primaryInk.color)
                        .padding(.horizontal, 12)
                        .frame(height: 34)
                        .background(MoteDesignTokens.primaryBackground.color, in: Capsule())
                        .frame(height: MoteMetrics.touchTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(saving || draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                          || draft.statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .opacity(saving || draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                         || draft.statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.5 : 1)
                .accessibilityIdentifier("memory-correction-save")
            }
            Text(MemoryDetailCopy.correctionTitle)
                .font(MoteFont.section)
                .foregroundStyle(MoteDesignTokens.ink.color)
        }
        .padding(.horizontal, 8)
        .frame(height: 44)
    }

    private func fieldLabel(_ label: String) -> some View {
        Text(label)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(MoteDesignTokens.muted.color)
            .padding(.leading, 2)
    }

    private func area(label: String, text: Binding<String>, field: Field, minHeight: CGFloat,
                      identifier: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            fieldLabel(label)
            TextEditor(text: text)
                .font(.system(size: 16))
                .foregroundStyle(MoteDesignTokens.ink.color)
                .scrollContentBackground(.hidden)
                .focused($focused, equals: field)
                .padding(8)
                .frame(minHeight: minHeight, alignment: .topLeading)
                .background(MoteDesignTokens.surface.color, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(
                            isFocused(field) ? MoteDesignTokens.accent.color : MoteDesignTokens.controlBorder.color,
                            lineWidth: isFocused(field) ? 2 : 1
                        )
                }
                .accessibilityLabel(label)
                .accessibilityIdentifier(identifier)
        }
    }

    private func isFocused(_ field: Field) -> Bool {
        focused == field || (previewStatementFocused && field == .statement)
    }

    private func validityRow(_ field: ValidityField) -> some View {
        Button {
            focused = nil
            editing = field
        } label: {
            HStack(spacing: 12) {
                Text(field.title)
                    .font(MoteFont.body)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                Spacer(minLength: 0)
                Text(field == .validFrom ? validFromText : validUntilText)
                    .font(MoteFont.body)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                MoteChevron()
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .overlay(alignment: .top) {
                if field == .validUntil {
                    Rectangle().fill(MoteDesignTokens.hair.color).frame(height: 1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(field == .validFrom ? "memory-correction-valid-from" : "memory-correction-valid-until")
    }

    private var validFromText: String {
        draft.validFrom.map { editTime($0) } ?? "现在"
    }

    private var validUntilText: String {
        draft.validUntil.map { editTime($0) } ?? "无"
    }

    private func validityEditor(_ field: ValidityField) -> some View {
        NavigationStack {
            VStack(spacing: 12) {
                DatePicker(
                    "",
                    selection: Binding(
                        get: {
                            (field == .validFrom ? draft.validFrom : draft.validUntil) ?? Date()
                        },
                        set: { value in
                            if field == .validFrom { draft.validFrom = value } else { draft.validUntil = value }
                        }
                    ),
                    displayedComponents: [.date, .hourAndMinute]
                )
                .datePickerStyle(.graphical)
                .labelsHidden()
                .tint(MoteDesignTokens.accent.color)
                .environment(\.locale, Locale(identifier: "zh_CN"))
                .padding(.horizontal, 16)

                HStack(spacing: 12) {
                    Button("清除") {
                        if field == .validFrom { draft.validFrom = nil } else { draft.validUntil = nil }
                        editing = nil
                    }
                    .font(MoteFont.action)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                    .frame(minHeight: 44)
                    Spacer(minLength: 0)
                    MoteCapsuleButton("完成", style: .primary) {
                        editing = nil
                    }
                }
                .padding(.horizontal, 16)
                Spacer(minLength: 0)
            }
            .padding(.top, 8)
            .background(MoteDesignTokens.background.color)
            .navigationTitle(field.title)
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
    }

    private func editTime(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M月d日 HH:mm"
        return formatter.string(from: date)
    }
}
