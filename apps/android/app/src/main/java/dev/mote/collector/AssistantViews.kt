package dev.mote.collector

import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.ui.MoteComponents
import org.json.JSONObject

/** Mountable page components for the existing shell. The host owns route
 * registration, current access checks, state-file lifetime and navigation. */
internal abstract class AssistantPanel(
    protected val activity: MoteActivity,
    private val current: () -> Boolean,
    private val open: (AssistantOpen) -> Unit,
    private val scope: AssistantScope,
) : LinearLayout(activity), HomeSection {
    private val task = UiTask(activity)
    private var visit = 0L
    private var active = true
    private var closed = false
    private var afterWork: (() -> Unit)? = null
    init { orientation = VERTICAL }
    protected fun allowed() = !closed && active && current() && !activity.isDestroyed && !activity.isFinishing
    protected fun launch(destination: AssistantOpen) {
        if (!allowed()) { removeAllViews(); return }
        if (!task.busy) open(destination)
    }
    protected fun work(read: () -> Unit, draw: () -> Unit) {
        if (!allowed()) { removeAllViews(); return }
        // A resume may arrive while the previous accepted IO is finishing.
        // Keep one refresh so dropping that old view callback cannot blank the page.
        if (task.busy) { afterWork = { work(read, draw) }; return }
        val stamp = visit
        removeAllViews(); addView(MoteComponents.skeleton(activity, MoteI18n.text("正在读取…"), rows = 1))
        task.start(MoteI18n.text("正在读取…"), {}, { read() }) { result ->
            removeAllViews()
            if (stamp == visit && allowed()) result.onSuccess { draw() }.onFailure { label(it.message ?: MoteI18n.text("操作失败")) }
            val next = afterWork; afterWork = null
            if (allowed()) next?.invoke()
        }
    }
    protected fun label(value: String, parent: LinearLayout = this, role: NativeFontRole = NativeFontRole.SUPPORT) = TextView(activity).apply {
        text = value; MoteUi.type(this, role); MoteUi.textColor(this, NativeColorRole.INK)
        setPadding(activity.moteDp(14), activity.moteDp(6), activity.moteDp(14), activity.moteDp(6))
        parent.addView(this)
    }
    protected fun button(key: String, parent: LinearLayout = this, enabled: Boolean = true, action: () -> Unit) {
        parent.addView(MoteComponents.button(activity, MoteI18n.text(key)) { if (allowed() && !task.busy) action() }.apply { isEnabled = enabled })
    }
    protected fun proof(items: List<AssistantProof>, parent: LinearLayout) {
        for (item in items) {
            parent.addView(MoteComponents.row(activity, title = MoteI18n.text("依据"), subtitle = item.quote,
                onClick = { launch(AssistantOpen.Evidence(item.ref, scope)) }))
        }
    }
    protected fun editor(value: String, parent: LinearLayout): EditText = EditText(activity).apply {
        setText(value); contentDescription = MoteI18n.text("工作目标"); inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
        filters = arrayOf(android.text.InputFilter.LengthFilter(8000)); parent.addView(this)
    }
    protected fun enter() { active = true }
    override fun pause() { active = false; visit++; afterWork = null; removeAllViews() }
    override fun close() { closed = true; pause(); task.close() }
}

internal class AssistantFeedView(
    activity: MoteActivity,
    private val model: AssistantFeedViewModel,
    current: () -> Boolean,
    open: (AssistantOpen) -> Unit,
) : AssistantPanel(activity, current, open, model.api.scope) {
    override fun refresh() { enter(); work({ model.refresh() }, ::draw) }
    private fun draw() {
        model.error?.let { label(it) }
        if (model.cards.isEmpty() && model.error == null) label(MoteI18n.text("暂无助理动态。"))
        button("刷新") { refresh() }
        for (card in model.cards) {
            val group = MoteComponents.group(activity).also { addView(it, LayoutParams(-1, -2).apply { bottomMargin = activity.moteDp(12) }) }
            label(card.title, group, NativeFontRole.SECTION)
            label(card.updatedAt + " · " + MoteI18n.text(if (card.readAt == null) "未读" else "已读"), group, NativeFontRole.META)
            label(card.body, group)
            if (card.stale || card.state == "stale") label(MoteI18n.text("这是历史版本，当前资料已更新。"), group)
            if (card.state == "resolved") label(MoteI18n.text("已解决"), group)
            card.feedback.lastOrNull()?.let { action ->
                label(MoteI18n.text(when (action) { "later" -> "稍后再看"; "ignore" -> "已忽略"; else -> "反馈已保存" }), group)
            }
            proof(card.evidence, group)
            card.matterId?.let { id -> button("事项与规则", group) { launch(AssistantOpen.Matter(id, model.api.scope)) } }
            val task = model.tasks[card.id]
            if (task != null) {
                label(AssistantPresentation.task(task), group)
                task.answer?.let { label(it, group) }
                button("任务状态", group) { launch(AssistantOpen.Task(task.id, task.workId, model.api.scope)) }
                if (task.state == "needs_input" && task.workId != null) button("需要补充", group) {
                    var questions = emptyList<AssistantQuestionLink>()
                    work({ questions = model.questions(task) }) {
                        draw()
                        for (question in questions) {
                            val key = when (question.state) { "open", "deferred" -> "需要补充"; "obsolete" -> "已失效"; else -> "已关闭" }
                            button(key) { launch(AssistantOpen.Question(question.id, question.workId, model.api.scope)) }
                            label(question.title)
                        }
                    }
                }
            } else card.acceptedTaskId?.let { id -> button("任务状态", group) { launch(AssistantOpen.Task(id, null, model.api.scope)) } }
            if (card.startable && task == null) {
                label(model.api.scope.description(), group)
                val goal = editor(card.title, group)
                button("开始", group, model.canStart && (model.pendingCardId == null || model.pendingCardId == card.id)) {
                    val text = goal.text.toString()
                    work({ model.start(card.id, card.revision, text) }) { draw() }
                }
                if (!model.canStart) label(MoteI18n.text("任务服务尚未接通，暂时不能开始。"), group)
            }
            if (!card.stale && card.state != "stale") {
                if (card.readAt == null) button("标为已读", group) { feedback(card, "read") }
                button("稍后再看", group) { feedback(card, "later") }
                button("忽略", group) { feedback(card, "ignore") }
            }
            button("历史版本", group) { history(card.id) }
        }
        if (model.nextCursor != null) button("加载更多") { work({ model.refresh(more = true) }, ::draw) }
    }
    private fun feedback(card: AssistantCard, action: String) = work({ model.feedback(card.id, card.revision, action) }, ::draw)
    private fun history(id: String, cursor: String? = null) {
        var page: JSONObject? = null
        work({ page = model.history(id, cursor) }) {
            button("返回") { refresh() }
            for (row in AssistantJson.rows(requireNotNull(page), "items") { it }) {
                label(row.getString("title"), role = NativeFontRole.SECTION)
                label(row.getString("createdAt") + " · " + row.getString("version"))
                label(row.getString("body"))
                if (row.optBoolean("evidenceStale")) label(MoteI18n.text("这是历史版本，当前资料已更新。"))
                proof(AssistantJson.rows(row, "evidence", AssistantProof::read), this)
            }
            AssistantJson.cursor(requireNotNull(page))?.let { next -> button("下一页") { history(id, next) } }
        }
    }
}

internal class AssistantMatterView(
    activity: MoteActivity,
    private val model: AssistantMatterViewModel,
    current: () -> Boolean,
    open: (AssistantOpen) -> Unit,
) : AssistantPanel(activity, current, open, model.api.scope) {
    private var draft: String? = null
    override fun refresh() { enter(); work({ model.refresh() }, ::draw) }
    private fun draw() {
        model.error?.let { label(it) }
        button("刷新") { refresh() }
        val detail = model.detail ?: return
        label(detail.goal, role = NativeFontRole.SECTION)
        label(MoteI18n.text(when (detail.state) { "paused" -> "已暂停"; "archived" -> "已归档"; else -> "进行中" }))
        label(detail.scope.description())
        if (detail.partial) label(MoteI18n.text("部分关联内容当前不可读取。"))
        for ((id, title) in detail.evidence) addView(MoteComponents.row(activity, title = title, onClick = { launch(AssistantOpen.Evidence(CentralEvidenceReference.capture(id), model.api.scope)) }))
        for ((id, state) in detail.tasks) addView(MoteComponents.row(activity, title = MoteI18n.text("任务状态"), subtitle = AssistantPresentation.operation(state), onClick = { launch(AssistantOpen.Task(id, null, model.api.scope)) }))
        if (model.canEdit) {
            val goal = editor(draft ?: detail.goal, this)
            button("保存修改") {
                draft = goal.text.toString()
                work({ model.edit(detail.revision, requireNotNull(draft)) }) { if (model.error == null) draft = null; draw() }
            }
            button(if (detail.state == "paused") "恢复" else "暂停") {
                work({ model.transition(detail.revision, if (detail.state == "paused") "resume" else "pause") }, ::draw)
            }
            button("归档事项") { work({ model.transition(detail.revision, "archive") }, ::draw) }
        }
        for (commitment in model.commitments) {
            val group = MoteComponents.group(activity).also(::addView)
            label(commitment.title, group, NativeFontRole.SECTION)
            label(MoteI18n.text(when (commitment.status) { "pending_confirmation" -> "待确认"; "completed" -> "已完成"; "cancelled" -> "已取消"; else -> "已确认" }), group)
            label(if (commitment.dueState == "unknown" || commitment.deadline == null) MoteI18n.text("期限未明确") else requireNotNull(commitment.deadline), group)
            commitment.deadlineAt?.let { label(it, group) }
            for (event in commitment.timeline) {
                if (event.origin == "owner") label(MoteI18n.text("用户纠正"), group)
                label(MoteI18n.text("时间") + " · " + (event.occurredAt ?: MoteI18n.text("未知")), group, NativeFontRole.META)
                label(event.summary, group); proof(event.evidence, group)
            }
        }
        for (rule in model.routines) {
            val group = MoteComponents.group(activity).also(::addView)
            label(rule.goal, group, NativeFontRole.SECTION)
            label(MoteI18n.text(if (rule.enabled) "已开启" else "已暂停"), group)
            val schedule = rule.schedule(); val trigger = schedule.getJSONObject("trigger")
            label(AssistantPresentation.schedule(schedule), group)
            label(rule.scope.description(), group)
            label(MoteI18n.text("下一次：{0}", rule.nextDue ?: MoteI18n.text("未知")), group)
            // Matter and rule controls are independent; the server decides
            // whether a resumed rule may admit work for a paused matter.
            button(if (rule.enabled) "暂停" else "恢复", group) { work({ model.updateRoutine(rule.id, rule.revision, !rule.enabled) }, ::draw) }
            val zone = editor(schedule.getString("timeZone"), group).apply { contentDescription = MoteI18n.text("时区") }
            val time = editor(if (trigger.getString("kind") == "before-event") trigger.getInt("leadMinutes").toString() else trigger.getString("localTime"), group).apply { contentDescription = MoteI18n.text("时间") }
            button("保存修改", group) {
                val edited = JSONObject(trigger.toString())
                val text = time.text.toString(); val timeZone = zone.text.toString()
                work({
                    if (edited.getString("kind") == "before-event") edited.put("leadMinutes", text.toInt()) else edited.put("localTime", text)
                    model.updateRoutine(rule.id, rule.revision, rule.enabled, timeZone = timeZone, trigger = edited)
                }, ::draw)
            }
        }
    }
}

internal object AssistantPresentation {
    fun task(task: AssistantTask): String = when (task.error) {
        "no_usable_evidence" -> MoteI18n.text("当前范围没有可用正文，任务尚未执行。")
        "model_context_budget_unavailable" -> MoteI18n.text("模型上下文预算尚未就绪，任务未执行。")
        else -> work(task.state)
    }
    fun operation(value: String) = work(when (value) { "succeeded" -> "completed"; "blocked" -> "needs_input"; "skipped" -> "excluded"; else -> value })
    private fun work(value: String) = MoteI18n.text(when (value) {
        "waiting" -> "等待开始"; "running" -> "正在进行"; "needs_input" -> "需要处理"; "completed" -> "已完成"
        "failed" -> "未能完成"; "cancelled" -> "已停止"; "stale" -> "资料变化，需要重新检查"; "excluded" -> "按设置跳过"
        else -> "未知"
    })
    fun schedule(schedule: JSONObject): String {
        val trigger = schedule.getJSONObject("trigger")
        return when (trigger.getString("kind")) {
            "daily" -> MoteI18n.text("每天 {0}", trigger.getString("localTime"))
            "weekly" -> MoteI18n.text("每周 {0} · {1}", java.time.DayOfWeek.of(trigger.getInt("weekday")).getDisplayName(java.time.format.TextStyle.FULL, MoteI18n.locale()), trigger.getString("localTime"))
            else -> MoteI18n.text("日程前 {0} 分钟", trigger.getInt("leadMinutes"))
        } + " · " + schedule.getString("timeZone")
    }
}
