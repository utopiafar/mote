import MoteCore
import MoteDesign
import SwiftUI

/// 资料与记忆. Both lists read the owner's existing Central pages; the filter
/// sheet and search field only narrow those reads.
struct LibraryMemoriesView: View {
    private enum FocusedField: Hashable {
        case library
        case memory
    }

    @State private var model: LibraryMemoriesModel
    @State private var pendingDate = Date()
    @State private var showingUnavailable = false
    @State private var selectedMemoryID: String?
    @State private var selectedOriginalID: String?
    @FocusState private var focusedField: FocusedField?
    @Environment(\.colorScheme) private var colorScheme

    private let onBack: () -> Void
    private let onOpenCapture: ((String) -> Void)?
    private let onConnect: (() -> Void)?
    private let previewFocused: Bool

    init(
        model: LibraryMemoriesModel? = nil,
        onBack: @escaping () -> Void,
        onOpenCapture: ((String) -> Void)? = nil,
        onConnect: (() -> Void)? = nil,
        previewFocused: Bool = false
    ) {
        _model = State(initialValue: model ?? .live())
        self.onBack = onBack
        self.onOpenCapture = onOpenCapture
        self.onConnect = onConnect
        self.previewFocused = previewFocused
    }

    var body: some View {
        Group {
            if let selectedOriginalID {
                OriginalRootView(
                    id: selectedOriginalID,
                    onDeleted: {
                        self.selectedOriginalID = nil
                        Task { await model.reloadCurrent() }
                    },
                    onAsk: { _ in showingUnavailable = true }
                )
            } else if let selectedMemoryID {
                if model.previewMode {
                    MemoryDetailPreview()
                } else {
                    MemoryDetailRootView(
                        id: selectedMemoryID,
                        onBack: {
                            self.selectedMemoryID = nil
                            Task { await model.reloadCurrent() }
                        },
                        onOpenCapture: { id in selectedOriginalID = id },
                        onChanged: {
                            Task { await model.reloadCurrent() }
                        }
                    )
                }
            } else {
                libraryScreen
            }
        }
        .onChange(of: model.libraryQuery) { _, _ in
            Task { await model.loadLibraryAfterQueryChange() }
        }
        .onChange(of: model.memoryQuery) { _, _ in
            Task { await model.loadMemoriesAfterQueryChange() }
        }
        .alert("此功能将在后续版本提供", isPresented: $showingUnavailable) {
            Button("好", role: .cancel) {}
        }
    }

    private var libraryScreen: some View {
        ZStack {
            MoteDesignTokens.background.color
                .ignoresSafeArea()

            VStack(spacing: 0) {
                topBar
                title
                controls
                content
            }
            .padding(.top, 54)
            .padding(.bottom, 34)

            if model.filterPresented {
                filterLayer
            }
            if model.datePickerPresented {
                dateLayer
            }
        }
        .ignoresSafeArea(.container, edges: .vertical)
        .statusBarHidden()
        .task {
            await model.reloadCurrent()
        }
    }

    private var topBar: some View {
        HStack(spacing: 0) {
            MoteIconButton(icon: .back, label: "返回", action: onBack)
            Spacer(minLength: 0)
            MoteIconButton(icon: .sliders, label: "筛选") {
                focusedField = nil
                withAnimation(.easeOut(duration: 0.2)) { model.filterPresented = true }
            }
            .accessibilityIdentifier("library-filter")
        }
        .padding(.horizontal, 6)
        .frame(height: 44)
    }

    private var title: some View {
        Text("资料与记忆")
            .font(MoteFont.title)
            .tracking(-0.55)
            .foregroundStyle(MoteDesignTokens.ink.color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 2)
            .padding(.horizontal, 20)
    }

    private var controls: some View {
        VStack(spacing: 5) {
            MoteSegmentedControl(options: [LibraryMemoriesModel.Tab.library.title, LibraryMemoriesModel.Tab.memories.title],
                                 selection: tabSelection)
                // The component keeps a 44pt target around a 34pt pill. The
                // canvas puts the pill 5pt higher; pull the drawing up without
                // shrinking the target and let the 5pt band form the gap.
                .padding(.top, -4)
                .accessibilityIdentifier("library-primary-views")
            searchField
        }
        .padding(.horizontal, MoteMetrics.pageMargin)
        .padding(.top, 14)
    }

    private var tabSelection: Binding<String> {
        Binding(
            get: { model.tab.title },
            set: { value in
                let next: LibraryMemoriesModel.Tab = value == "记忆" ? .memories : .library
                guard next != model.tab else { return }
                model.tab = next
                focusedField = nil
                model.filterPresented = false
                model.datePickerPresented = false
                Task { await model.reloadCurrent() }
            }
        )
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            MoteIcon(.search, size: 20)
                .foregroundStyle(MoteDesignTokens.muted.color)
            TextField("", text: searchBinding,
                      prompt: Text(model.tab == .library ? "搜索资料" : "搜索记忆")
                        .foregroundStyle(MoteDesignTokens.muted.color))
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.ink.color)
                .textFieldStyle(.plain)
                .focused($focusedField, equals: model.tab == .library ? .library : .memory)
                .submitLabel(.search)
                .accessibilityLabel(model.tab == .library ? "搜索资料" : "搜索记忆")
                .accessibilityIdentifier(model.tab == .library ? "library-search" : "memory-search")
                .overlay(alignment: .leading) {
                    if previewFocused && focusedField == nil && !currentQuery.isEmpty {
                        HStack(spacing: 1) {
                            Text(currentQuery).font(MoteFont.body).hidden()
                            Capsule().fill(MoteDesignTokens.accent.color).frame(width: 2, height: 18)
                        }
                        .allowsHitTesting(false)
                    }
                }
            if !currentQuery.isEmpty {
                Button {
                    if model.tab == .library {
                        model.libraryQuery = ""
                    } else {
                        model.memoryQuery = ""
                    }
                } label: {
                    MoteIcon(.close, size: 16)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清除")
                .accessibilityIdentifier("library-search-clear")
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 2)
        .frame(minHeight: 44)
        .background(MoteDesignTokens.surface.color, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(
                    focusedField != nil || previewFocused
                        ? MoteDesignTokens.accent.color
                        : MoteDesignTokens.controlBorder.color,
                    lineWidth: focusedField != nil || previewFocused ? 2 : 1
                )
        }
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .onTapGesture {
            focusedField = model.tab == .library ? .library : .memory
        }
    }

    private var searchBinding: Binding<String> {
        Binding(
            get: { currentQuery },
            set: { value in
                let trimmed = String(value.prefix(500))
                if model.tab == .library {
                    model.libraryQuery = trimmed
                } else {
                    model.memoryQuery = trimmed
                }
            }
        )
    }

    private var currentQuery: String {
        model.tab == .library ? model.libraryQuery : model.memoryQuery
    }

    @ViewBuilder
    private var content: some View {
        if !model.connected {
            stateMessage("连接 Mote 后查看资料与记忆。", action: onConnect)
        } else if model.tab == .library, let error = model.libraryError {
            errorState(error) { await model.reloadCurrent() }
        } else if model.tab == .memories, let error = model.memoryError {
            errorState(error) { await model.reloadCurrent() }
        } else if isLoading, currentRowsEmpty {
            ProgressView("正在读取…")
                .font(MoteFont.secondary)
                .foregroundStyle(MoteDesignTokens.muted.color)
                .frame(maxWidth: .infinity)
                .padding(.top, 40)
        } else if currentRowsEmpty {
            emptyState
        } else if model.tab == .library {
            libraryList
        } else {
            memoryList
        }
    }

    private var isLoading: Bool {
        model.tab == .library ? model.libraryLoading : model.memoryLoading
    }

    private var currentRowsEmpty: Bool {
        model.tab == .library ? model.libraryRows.isEmpty : model.memoryRows.isEmpty
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            if model.tab == .library {
                Text("当前范围内暂无资料。")
                    .font(MoteFont.body)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                Text("保存记录或导入资料后，可以在这里查看。")
                    .font(MoteFont.secondary)
                    .foregroundStyle(MoteDesignTokens.muted.color)
            } else {
                Text("当前筛选下没有匹配的记忆。可切换内容分类或调整筛选条件。")
                    .font(MoteFont.body)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 32)
        .padding(.top, 40)
    }

    private func stateMessage(_ text: String, action: (() -> Void)?) -> some View {
        VStack(spacing: 12) {
            Text(text)
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.muted.color)
                .multilineTextAlignment(.center)
            if let action {
                MoteCapsuleButton("连接", action: action)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 32)
        .padding(.top, 40)
    }

    private func errorState(_ message: String, retry: @escaping () async -> Void) -> some View {
        VStack(spacing: 12) {
            Text(message)
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.muted.color)
            MoteCapsuleButton("重试") {
                Task { await retry() }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
    }

    private var libraryList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(LibraryBrowsePresentation.groups(model.libraryRows)) { group in
                    Text(group.label)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(MoteDesignTokens.muted.color)
                        .padding(.leading, 31)
                        .padding(.top, 25)
                        .padding(.bottom, 8)
                    MoteGroup {
                        ForEach(Array(group.rows.enumerated()), id: \.element.id) { index, row in
                            libraryRow(row, divided: index > 0)
                        }
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)
                }
            }
            .padding(.bottom, 12)
        }
        .scrollIndicators(.hidden)
    }

    private var memoryList: some View {
        ScrollView {
            MoteGroup {
                ForEach(Array(model.memoryRows.enumerated()), id: \.element.id) { index, row in
                    memoryRow(row, divided: index > 0)
                }
            }
            .padding(.horizontal, MoteMetrics.pageMargin)
            .padding(.top, 16)
            .padding(.bottom, 12)
        }
        .scrollIndicators(.hidden)
    }

    private func libraryRow(_ row: LibraryBrowseRow, divided: Bool) -> some View {
        Button {
            open(row)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(row.title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .lineLimit(1)
                Text(row.meta)
                    .font(.system(size: 13))
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
        .accessibilityLabel("\(row.title)，\(row.meta)")
        .accessibilityIdentifier("library-row-\(row.id)")
        .task { await model.loadMoreLibraryIfNeeded(after: row.id) }
    }

    private func memoryRow(_ row: MemoryBrowseRow, divided: Bool) -> some View {
        Button {
            selectedMemoryID = row.id
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                highlighted(row.title, query: model.memoryQuery)
                    .font(.system(size: 15, weight: .medium))
                    .lineLimit(1)
                highlighted(row.statement, query: model.memoryQuery)
                    .font(.system(size: 13))
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
        .accessibilityLabel("\(row.title)，\(row.statement)")
        .accessibilityIdentifier("memory-row-\(row.id)")
        .task { await model.loadMoreMemoriesIfNeeded(after: row.id) }
    }

    private func highlighted(_ text: String, query: String) -> Text {
        let ranges = MemorySearchHighlight.ranges(in: text, query: query)
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

    private func open(_ row: LibraryBrowseRow) {
        if let captureID = row.captureID, let onOpenCapture {
            onOpenCapture(captureID)
        } else {
            showingUnavailable = true
        }
    }

    private var filterLayer: some View {
        ZStack(alignment: .bottom) {
            scrim.onTapGesture { dismissFilter() }
            MoteBottomSheet {
                HStack(spacing: 8) {
                    Text("筛选")
                        .font(MoteFont.section)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                    Spacer(minLength: 0)
                    MoteIconButton(icon: .close, label: "关闭", style: .muted) {
                        dismissFilter()
                    }
                }
                .padding(.leading, 20)
                .padding(.trailing, 4)
                .frame(height: 44)

                if model.tab == .library {
                    libraryFilters
                } else {
                    memoryFilters
                }

                Color.clear.frame(height: 40)
            }
        }
    }

    private var libraryFilters: some View {
        VStack(spacing: 12) {
            MoteGroup {
                ForEach(Array(LibraryBrowseCategory.allCases.enumerated()), id: \.element.id) { index, category in
                    filterRow(
                        title: category.title,
                        selected: model.libraryCategory == category,
                        identifier: "library-filter-\(category.rawValue)",
                        divided: index > 0
                    ) {
                        Task { await model.selectLibraryCategory(category) }
                        dismissFilter()
                    }
                }
            }
            .padding(.horizontal, MoteMetrics.pageMargin)
            .padding(.top, 6)

            MoteGroup {
                Button {
                    pendingDate = model.reviewDay ?? Date()
                    dismissFilter()
                    withAnimation(.easeOut(duration: 0.2)) { model.datePickerPresented = true }
                } label: {
                    HStack(spacing: 12) {
                        MoteIcon(.calendar, size: 20)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                        Text("按时间回看")
                            .font(MoteFont.body)
                            .foregroundStyle(MoteDesignTokens.ink.color)
                        Spacer(minLength: 0)
                        if let reviewDay = model.reviewDay {
                            Text(reviewDayLabel(reviewDay))
                                .font(MoteFont.secondary)
                                .foregroundStyle(MoteDesignTokens.muted.color)
                        }
                        MoteChevron()
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("library-filter-date")
            }
            .padding(.horizontal, MoteMetrics.pageMargin)
        }
    }

    private var memoryFilters: some View {
        VStack(spacing: 12) {
            MoteGroup {
                ForEach(Array(MemoryBrowseCategory.allCases.enumerated()), id: \.element.id) { index, category in
                    filterRow(
                        title: category.title,
                        selected: model.memoryCategory == category,
                        identifier: "memory-filter-\(category.rawValue)",
                        divided: index > 0
                    ) {
                        Task { await model.selectMemoryCategory(category) }
                        dismissFilter()
                    }
                }
            }
            .padding(.horizontal, MoteMetrics.pageMargin)
            .padding(.top, 6)

            MoteGroup {
                Button {
                    toggleHistory()
                } label: {
                    HStack(spacing: 12) {
                        Text("包含被替代与过期历史")
                            .font(MoteFont.body)
                            .foregroundStyle(MoteDesignTokens.ink.color)
                        Spacer(minLength: 0)
                        MoteSwitchIndicator(isOn: model.includeHistory)
                            .accessibilityHidden(true)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("包含被替代与过期历史")
                .accessibilityValue(model.includeHistory ? "开" : "关")
                .accessibilityIdentifier("memory-filter-history")
            }
            .padding(.horizontal, MoteMetrics.pageMargin)
        }
    }

    private func toggleHistory() {
        let next = !model.includeHistory
        model.includeHistory = next
        Task { await model.setIncludeHistory(next) }
    }

    private func filterRow(
        title: String,
        selected: Bool,
        identifier: String,
        divided: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text(title)
                    .font(MoteFont.body)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                Spacer(minLength: 0)
                if selected {
                    MoteIcon(.check, size: 20)
                        .foregroundStyle(MoteDesignTokens.accent.color)
                }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .overlay(alignment: .top) {
                if divided {
                    Rectangle().fill(MoteDesignTokens.hair.color).frame(height: 1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var dateLayer: some View {
        ZStack(alignment: .bottom) {
            scrim.onTapGesture {
                withAnimation(.easeOut(duration: 0.2)) { model.datePickerPresented = false }
            }
            MoteBottomSheet {
                HStack(spacing: 8) {
                    Text("按时间回看")
                        .font(MoteFont.section)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                    Spacer(minLength: 0)
                    MoteIconButton(icon: .close, label: "关闭", style: .muted) {
                        withAnimation(.easeOut(duration: 0.2)) { model.datePickerPresented = false }
                    }
                }
                .padding(.leading, 20)
                .padding(.trailing, 4)
                .frame(height: 44)

                DatePicker("", selection: $pendingDate, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .labelsHidden()
                    .tint(MoteDesignTokens.accent.color)
                    .environment(\.locale, Locale(identifier: "zh_CN"))
                    .padding(.horizontal, 16)

                HStack(spacing: 12) {
                    Button("全部日期") {
                        applyReviewDay(nil)
                    }
                    .font(MoteFont.action)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .frame(minHeight: 44)
                    Spacer(minLength: 0)
                    MoteCapsuleButton("完成", style: .primary) {
                        applyReviewDay(pendingDate)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 40)
            }
        }
    }

    private func applyReviewDay(_ day: Date?) {
        withAnimation(.easeOut(duration: 0.2)) { model.datePickerPresented = false }
        Task { await model.setReviewDay(day) }
    }

    private func reviewDayLabel(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M月d日"
        return formatter.string(from: date)
    }

    private func dismissFilter() {
        withAnimation(.easeOut(duration: 0.2)) { model.filterPresented = false }
    }

    private var scrim: some View {
        (colorScheme == .dark ? Color.black.opacity(0.55) : MoteDesignTokens.ink.color.opacity(0.36))
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .accessibilityHidden(true)
    }
}

/// The canvas switch: a warm border track with a white thumb. The surrounding
/// row owns the 44pt target and the accessibility value.
private struct MoteSwitchIndicator: View {
    let isOn: Bool

    var body: some View {
        ZStack(alignment: .leading) {
            Capsule()
                .fill(isOn ? MoteDesignTokens.accent.color : MoteDesignTokens.border.color)
            Circle()
                .fill(.white)
                .frame(width: 27, height: 27)
                .overlay {
                    Circle().strokeBorder(.black.opacity(0.08), lineWidth: 1)
                }
                .shadow(color: .black.opacity(0.12), radius: 1.5, y: 2)
                .padding(2)
                .offset(x: isOn ? 20 : 0)
        }
        .frame(width: 51, height: 31)
        .animation(.easeOut(duration: 0.15), value: isOn)
    }
}
