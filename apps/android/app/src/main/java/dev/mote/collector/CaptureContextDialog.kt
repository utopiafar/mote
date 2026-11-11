package dev.mote.collector

import android.app.AlertDialog
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import java.util.concurrent.Executors

/** Only explicitly saved owner descriptions enter the source-context outbox. */
internal class CaptureContextDialog(private val activity: MoteActivity) {
    private val settings = Settings(activity)
    private val config = settings.read()
    private val origin = settings.dataOrigin()
    private val deviceId = settings.deviceId
    private val store = activity.captureContexts()
    private val io = Executors.newSingleThreadExecutor()
    private val task = UiTask(activity, io, ownsExecutor = false)
    private val fields = linkedMapOf<CaptureContextChannel, EditText>()
    private val statuses = linkedMapOf<CaptureContextChannel, TextView>()
    private val conflicts = linkedMapOf<CaptureContextChannel, TextView>()
    private lateinit var dialog: AlertDialog
    private lateinit var status: TextView
    private var rendering = false
    private var ready = false
    private var commonStatus = ""

    fun show() {
        val body = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(activity.moteDp(20),0,activity.moteDp(20),activity.moteDp(16)) }
        fun text(value: String, role: NativeFontRole = NativeFontRole.SUPPORT) = TextView(activity).apply {
            text = MoteI18n.text(value); MoteUi.type(this, role); MoteUi.textColor(this, NativeColorRole.MUTED)
            setPadding(0, activity.moteDp(6),0,activity.moteDp(6))
        }.also(body::addView)
        for (channel in CaptureContextChannel.entries) {
            text(channel.label).apply { MoteUi.textColor(this, NativeColorRole.INK) }
            fields[channel] = EditText(activity).apply {
                contentDescription = MoteI18n.text(channel.label) + " · " + MoteI18n.text("资料说明")
                tag = "capture-context:${channel.wire}"; hint = MoteI18n.text("补充这一类资料的背景（选填）")
                MoteUi.textInput(this, android.text.InputType.TYPE_CLASS_TEXT, multiline = true); MoteUi.field(this)
                minLines = 3; MoteUi.type(this,NativeFontRole.SUPPORT); filters = arrayOf(android.text.InputFilter.LengthFilter(12000)); isEnabled = false
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                    override fun afterTextChanged(s: Editable?) {
                        if (!ready || rendering) return
                        val draft = s.toString()
                        io.execute { runCatching {
                            ConnectionGuard.sync { checkSelection(); store.edit(origin, deviceId, channel, draft) }
                                ?: error(MoteI18n.text("正在调整连接，请稍后重试"))
                        }.onFailure {
                            activity.runOnUiThread { if (dialog.isShowing && verifyUiSelection()) status.text = MoteI18n.text("无法保存本机草稿，请检查存储后重试。") }
                        } }
                    }
                })
            }.also { body.addView(it, LinearLayout.LayoutParams(-1,-2)) }
            text(MoteI18n.text("适用于此手机的{0}来源。", MoteI18n.text(channel.label)), NativeFontRole.META)
            statuses[channel] = text("", NativeFontRole.META)
            conflicts[channel] = text("解决资料说明冲突").apply {
                visibility = View.GONE; minHeight = activity.moteDp(44); isFocusable = true
                MoteUi.textColor(this, NativeColorRole.ACCENT); setOnClickListener { resolve(channel) }
            }
        }
        text("修改说明适用于已有和未来资料；不会自动重新转写或重算历史记忆。", NativeFontRole.META)
        status = text("正在读取资料说明…").also { MoteComponents.reading(it, it.text.toString()) }
        val heading = LinearLayout(activity).apply {
            gravity = android.view.Gravity.CENTER_VERTICAL; setPadding(activity.moteDp(20),activity.moteDp(10),activity.moteDp(8),activity.moteDp(10))
            addView(TextView(activity).apply { text = MoteI18n.text("采集来源说明"); MoteUi.type(this,NativeFontRole.ACTION,medium = true); MoteUi.textColor(this,NativeColorRole.INK) },LinearLayout.LayoutParams(0,-2,1f))
            addView(MoteComponents.iconButton(activity, MoteGlyph.CLOSE, MoteI18n.text("关闭")) { dialog.dismiss() },
                LinearLayout.LayoutParams(activity.moteDp(48), activity.moteDp(48)))
        }
        dialog = MoteDialogBuilder(activity).setCustomTitle(heading)
            .setView(ScrollView(activity).apply { addView(body) })
            .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("保存说明"), null).create()
        dialog.setOnShowListener { MoteUi.action(dialog.getButton(AlertDialog.BUTTON_POSITIVE),MoteUi.ButtonRole.PRIMARY); dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { save() }; load() }
        dialog.setOnDismissListener { task.close(); io.shutdown() }
        dialog.show()
    }
    private fun checkSelection() {
        val current = settings.read()
        check(settings.deviceId == deviceId && settings.dataOrigin() == origin && current.server == config.server && current.connectionToken() == config.connectionToken()) {
            MoteI18n.text("登录会话已变更，请重新打开中央页面。")
        }
    }
    private fun entries() = CaptureContextChannel.entries.map { store.entry(origin, deviceId, it) }
    private fun verifyUiSelection(): Boolean {
        if (runCatching { checkSelection() }.isSuccess) return true
        fields.values.forEach { it.isEnabled = false }
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
        status.text = MoteI18n.text("登录会话已变更，请重新打开中央页面。")
        return false
    }
    private fun load() {
        task.start("", {}, {
            ConnectionGuard.sync {
                checkSelection()
                if (origin.isNotBlank() && origin == config.server.trimEnd('/')) store.bindLocal(origin, deviceId)
            } ?: error(MoteI18n.text("正在调整连接，请稍后重试"))
            var problem: Throwable? = null
            if (config.hasSyncConnection() && origin == config.server.trimEnd('/') && SyncSchedule.waitingReason(activity, config) == null) {
                for (entry in entries()) runCatching { CaptureContextSync.read(activity, config, entry) }.onFailure { problem = it }
            }
            entries() to problem
        }) { result -> result.onSuccess { (items, problem) ->
            if (!verifyUiSelection()) return@onSuccess
            render(items); status.text = if (problem == null) commonStatus else MoteI18n.text("无法读取中央资料说明；本机草稿保留，请重试。")
        }.onFailure { if (verifyUiSelection()) status.text = it.message } }
    }
    private fun render(items: List<CaptureContextEntry>) {
        rendering = true
        items.forEach { item ->
            fields.getValue(item.channel).apply { setText(item.draft); isEnabled = true }
            statuses.getValue(item.channel).text = when {
                item.conflict != null -> MoteI18n.text("资料说明版本已变化；草稿已保留，请重新加载最新版本后再保存。")
                item.dirty -> MoteI18n.text("有未保存的修改")
                item.pending -> MoteI18n.text("资料说明保存在本机，等待中央确认。")
                item.accepted != null && item.accepted.version > 0 -> MoteI18n.text("资料说明已获中央确认，版本 {0}。", item.accepted.version)
                else -> ""
            }
            conflicts.getValue(item.channel).visibility = if (item.conflict == null) View.GONE else View.VISIBLE
        }
        val distinct = statuses.values.map { it.text.toString() }.distinct()
        commonStatus = distinct.singleOrNull().orEmpty()
        statuses.values.forEach { it.visibility = if (it.text.isEmpty() || commonStatus.isNotBlank()) View.GONE else View.VISIBLE }
        status.text = commonStatus
        rendering = false; ready = true; dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true
    }
    private fun save() {
        if (!ready || task.busy) return
        val drafts = fields.mapValues { it.value.text.toString() }
        fields.values.forEach { it.isEnabled = false }; dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
        task.start(MoteI18n.text("保存说明"), MoteComponents.progress(status, read = false), {
            ConnectionGuard.sync {
                checkSelection()
                for ((channel, draft) in drafts) {
                    val entry = store.edit(origin, deviceId, channel, draft)
                    if (entry.dirty) store.saveDraft(origin, deviceId, channel)
                }
            } ?: error(MoteI18n.text("正在调整连接，请稍后重试"))
            var problem: Throwable? = null
            if (config.hasSyncConnection() && origin == config.server.trimEnd('/')) runCatching {
                ConnectionGuard.sync {
                    checkSelection(); SyncSchedule.requireConditions(activity, config)
                    SyncHeartbeat.send(activity, settings, config, activity.queue())
                    CaptureContextSync.syncPending(activity, config)
                } ?: error(MoteI18n.text("正在调整连接，请稍后重试"))
            }.onFailure { problem = it }
            entries() to problem
        }) { outcome -> outcome.onSuccess { (items, problem) ->
            if (!verifyUiSelection()) return@onSuccess
            render(items)
            if (items.any { it.pending }) SyncSchedule.schedule(activity, config)
            status.text = when {
                problem != null -> MoteI18n.text("资料说明保存在本机，等待中央确认。") + "\n" + problem.message.orEmpty()
                items.any { it.pending } -> MoteI18n.text("资料说明保存在本机，等待中央确认。")
                else -> MoteI18n.text("已保存")
            }
        }.onFailure { error -> if (verifyUiSelection()) { fields.values.forEach { it.isEnabled = true }; dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true; status.text = error.message } } }
    }
    private fun resolve(channel: CaptureContextChannel) {
        if (task.busy) return
        task.start("", {}, { checkSelection(); store.entry(origin, deviceId, channel) }) { result -> result.onSuccess { item ->
            if (!verifyUiSelection()) return@onSuccess
            val remote = item.conflict ?: return@onSuccess
            MoteDialogBuilder(activity).setTitle(MoteI18n.text("解决资料说明冲突"))
                .setMessage(MoteI18n.text("中央说明（版本 {0}）：\n{1}\n\n本机说明：\n{2}", remote.version, remote.description, item.draft))
                .setNegativeButton(MoteI18n.text("取消"), null)
                .setNeutralButton(MoteI18n.text("使用中央说明")) { _, _ -> resolved(item, false) }
                .setPositiveButton(MoteI18n.text("以本机说明更新")) { _, _ -> resolved(item, true) }.show()
        }.onFailure { if (verifyUiSelection()) status.text = it.message } }
    }
    private fun resolved(item: CaptureContextEntry, keepLocal: Boolean) {
        task.start("", {}, {
            ConnectionGuard.sync { checkSelection(); store.resolve(item, keepLocal); entries() }
                ?: error(MoteI18n.text("正在调整连接，请稍后重试"))
        }) { result -> result.onSuccess { if (verifyUiSelection()) { render(it); if (keepLocal) save() } }.onFailure { if (verifyUiSelection()) status.text = it.message } }
    }
}
