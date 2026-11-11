import MoteCentral
import MoteCore
import MoteDesign
import SwiftUI

struct ScheduleScreen: View {
    @State private var model: ScheduleModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab = "日程"
    @State private var selection: CalendarAction?
    @State private var selectionContext = 0
    @State private var todoTitle = ""
    let onBack: () -> Void

    init(fixture: String? = nil, onBack: @escaping () -> Void) {
        _model = State(initialValue: ScheduleModel(fixture: fixture))
        self.onBack = onBack
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                MoteIconButton(icon: .back, label: "返回", action: onBack)
                Spacer()
                Button("刷新") { Task { await model.refresh() } }
                    .frame(minWidth: 44, minHeight: 44)
            }
            .padding(.horizontal, 6)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("日程与待办")
                        .font(MoteFont.title)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                    MoteSegmentedControl(options: ["日程", "待办"], selection: $tab)
                    if let message = model.message {
                        Text(message).font(MoteFont.secondary).foregroundStyle(MoteDesignTokens.warning.color)
                            .accessibilityIdentifier("schedule-message")
                    }
                    if tab == "日程" { calendarContent } else { todoContent }
                }
                .padding(.horizontal, MoteMetrics.pageMargin)
                .padding(.top, 12)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
        }
        .background(MoteDesignTokens.background.color.ignoresSafeArea())
        .task { await model.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refresh() } }
        }
        .onChange(of: model.contextVersion) { _, _ in selection = nil; todoTitle = "" }
        .sheet(item: $selection) { action in
            ScheduleActionDetail(action: action, model: model, context: selectionContext) { selection = nil }
        }
    }

    @ViewBuilder private var calendarContent: some View {
        if model.loading && model.actions.isEmpty {
            MoteLoading("正在读取日程建议…")
        } else if model.actions.isEmpty {
            Text("尚未发现日程。上传资料或继续采集后会自动分析。")
                .font(MoteFont.secondary).foregroundStyle(MoteDesignTokens.muted.color)
                .accessibilityIdentifier("schedule-empty")
                .frame(maxWidth: .infinity, minHeight: 120, alignment: .leading)
        } else {
            MoteGroup {
                ForEach(Array(model.actions.enumerated()), id: \.element.id) { index, action in
                    MoteRow(title: action.event.title, subtitle: "\(action.kindLabel) · \(action.statusLabel)", topDivider: index > 0) {
                        selectionContext = model.contextVersion; selection = action
                    }
                    .accessibilityIdentifier("schedule-action-\(action.id)")
                }
            }
        }
        if model.actionCursor != nil {
            MoteCapsuleButton("更早建议", fullWidth: true) { Task { await model.moreActions() } }
        }
        DisclosureGroup("更多") {
            VStack(alignment: .leading, spacing: 12) {
                Text("从资料中发现安排。范围授权内的日程交给指定设备，其余逐条确认；结果保留在行动历史。")
                    .font(MoteFont.secondary).foregroundStyle(MoteDesignTokens.muted.color)
                Text("需要 Mac / Android 客户端连接、报告可写日历并具备设备端日历权限；由原生客户端执行已确认建议。")
                    .font(MoteFont.secondary).foregroundStyle(MoteDesignTokens.muted.color)
                MoteCapsuleButton("连接本机日历", fullWidth: true) { Task { await model.requestCalendarAccess() } }
                    .accessibilityIdentifier("schedule-permission")
            }.padding(.top, 12)
        }
        .font(MoteFont.body)
        .foregroundStyle(MoteDesignTokens.ink.color)
    }

    private var todoContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                TextField("待办标题", text: $todoTitle)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("todo-title")
                MoteCapsuleButton("添加待办", style: .primary) {
                    let title = todoTitle, context = model.contextVersion
                    Task { if await model.addTodo(title, context: context) { todoTitle = "" } }
                }
            }
            Text("完成待办不会创建日历事件。")
                .font(MoteFont.secondary).foregroundStyle(MoteDesignTokens.muted.color)
            if model.todos.isEmpty {
                Text("没有待办").font(MoteFont.secondary).foregroundStyle(MoteDesignTokens.muted.color)
                    .accessibilityIdentifier("todo-empty")
            } else {
                MoteGroup {
                    ForEach(Array(model.todos.enumerated()), id: \.element.id) { index, todo in
                        let context = model.contextVersion
                        VStack(alignment: .leading, spacing: 8) {
                            Text(todo.title).font(MoteFont.body).foregroundStyle(MoteDesignTokens.ink.color)
                            Text(todo.status == "open" ? "未完成" : todo.status == "completed" ? "已完成" : "已取消")
                                .font(MoteFont.secondary).foregroundStyle(MoteDesignTokens.muted.color)
                            if let due = todo.dueAt { Text(due).font(MoteFont.secondary) }
                            HStack {
                                if todo.status == "open" {
                                    MoteCapsuleButton("标记完成") { Task { await model.setTodo(todo, status: "completed", context: context) } }
                                    MoteCapsuleButton("取消待办") { Task { await model.setTodo(todo, status: "cancelled", context: context) } }
                                } else {
                                    MoteCapsuleButton("重新打开") { Task { await model.setTodo(todo, status: "open", context: context) } }
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .overlay(alignment: .top) {
                            if index > 0 { Rectangle().fill(MoteDesignTokens.hair.color).frame(height: 1) }
                        }
                        .accessibilityIdentifier("todo-\(todo.id)")
                    }
                }
            }
            if model.todoCursor != nil {
                MoteCapsuleButton("加载更多", fullWidth: true) { Task { await model.moreTodos() } }
            }
        }
    }
}

private struct ScheduleActionDetail: View {
    let action: CalendarAction
    let model: ScheduleModel
    let context: Int
    let close: () -> Void
    @State private var start = Date()
    @State private var end = Date().addingTimeInterval(3600)
    @State private var zone = TimeZone.current.identifier
    @State private var showingEvidence = false
    @State private var confirming = false
    @State private var dismissing = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(action.event.title).font(MoteFont.title)
                    Text("\(action.kindLabel) · \(action.statusLabel)")
                    if !action.uncertainty.isEmpty { Text(action.uncertainty) }
                    if let related = action.related { Text("原安排：\(related.event.title)") }
                    Text("\(action.event.start ?? "时间待补充") → \(action.event.end ?? "时间待补充")")
                }
                if action.canSupplyInformation {
                    Section("确认日程") {
                        if action.event.start == nil { DatePicker("开始", selection: $start, displayedComponents: components) }
                        if action.event.end == nil { DatePicker("结束", selection: $end, displayedComponents: components) }
                        if action.event.timeZone == nil { TextField("时区", text: $zone).textInputAutocapitalization(.never) }
                        else { Text("时区：\(action.event.timeZone ?? "")") }
                        if action.event.allDay { Text("全天日程的结束日期不包含当天。") }
                        Button("保存") {
                            Task { if await model.supply(action, event: completedEvent, context: context) { close() } }
                        }.accessibilityIdentifier("schedule-save-time")
                    }
                }
                if let message = model.message { Text(message).foregroundStyle(MoteDesignTokens.warning.color) }
                Section {
                    Button("查看原文依据") { showingEvidence = true }
                    if action.status == .proposed && action.resolution == nil {
                        if action.canConfirmWithoutNativeWrite {
                            Button("确认变更") { confirming = true }
                        } else if !action.canSupplyInformation {
                            Button("核对并添加到日历") { Task { await model.requestCalendarAccess() } }
                        }
                        Button("忽略这条建议", role: .destructive) { dismissing = true }
                    }
                }
            }
            .environment(\.locale, Locale(identifier: "zh_CN"))
            .environment(\.timeZone, TimeZone(identifier: action.event.timeZone ?? zone) ?? .current)
            .navigationTitle("日程")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("关闭", action: close) } }
            .sheet(isPresented: $showingEvidence) {
                NavigationStack {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            ForEach(Array(action.evidence.enumerated()), id: \.offset) { _, evidence in
                                Text("\(evidence.source) · \(evidence.capturedAt)\n\(evidence.quote)")
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }.padding()
                    }.navigationTitle("原文依据")
                        .toolbar { Button("关闭") { showingEvidence = false } }
                }
            }
            .confirmationDialog("确认变更", isPresented: $confirming) {
                Button("确认变更") { Task { if await model.confirm(action, context: context) { close() } } }
            } message: {
                Text(action.kind == .complete ? "确认后仅在 Mote 中标记完成。" :
                     action.kind == .update ? "确认后仅更新原建议，仍需确认添加到日历。" :
                     "确认后取消尚未写入日历的原建议。")
            }
            .confirmationDialog("忽略这条建议", isPresented: $dismissing) {
                Button("忽略这条建议", role: .destructive) { Task { if await model.dismiss(action, context: context) { close() } } }
                    .accessibilityIdentifier("schedule-confirm-dismiss")
            }
        }
    }
    private var components: DatePickerComponents { action.event.allDay ? [.date] : [.date, .hourAndMinute] }
    private var completedEvent: CalendarEventDraft {
        var event = action.event
        func formatted(_ date: Date) -> String {
            if event.allDay {
                let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
                formatter.timeZone = TimeZone(identifier: action.event.timeZone ?? zone) ?? .current
                formatter.dateFormat = "yyyy-MM-dd"; return formatter.string(from: date)
            }
            return ISO8601DateFormatter().string(from: date)
        }
        event.start = event.start ?? formatted(start)
        event.end = event.end ?? formatted(end)
        event.timeZone = event.timeZone ?? zone
        return event
    }
}
