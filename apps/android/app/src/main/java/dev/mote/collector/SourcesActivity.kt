package dev.mote.collector

import android.Manifest
import android.app.AlertDialog
import android.app.Dialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.*
import dev.mote.collector.plugins.SourceProviderPlugin
import dev.mote.collector.plugins.SourceSnapshot
import dev.mote.collector.meeting.MeetingRecordingActivity
import dev.mote.collector.meeting.meetingRecordings
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import dev.mote.collector.ui.MoteIconButtonStyle
import java.util.concurrent.Executors

/** Native opt-in connection UI. No calendar query occurs before the user requests a connection. */
class SourcesActivity : MoteActivity() {
    private lateinit var list: LinearLayout
    private var detailSourceId: String? = null
    private var sourceKind: String? = null
    private var renderedSignature: String? = null
    private var localOffset = 0
    private val localPageSize = 20
    private val worker = Executors.newSingleThreadExecutor()
    private val task by lazy { UiTask(this, worker, ownsExecutor = false) }
    private val owner by lazy { SourceProviderPlugin.owner(this) }
    private lateinit var operationStatusView: TextView
    /** Blank status lines must not reserve the gap above the overview title. */
    private var operationStatus: String
        get() = operationStatusView.text.toString()
        set(value) {
            operationStatusView.text = value
            operationStatusView.visibility = if (value.isBlank()) View.GONE else View.VISIBLE
        }
    private var rendering = false
    private var editingSource: LocalSource? = null
    private val draftControls = linkedMapOf<String, android.view.View>()
    private data class Draft(val source: LocalSource, val values: Map<String, String>, val newSource: Boolean)
    private var editingNewSource = false
    private var restoringDraft: Draft? = null
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable { override fun run() { render(); handler.postDelayed(this, 2500) } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        restoringDraft = lastNonConfigurationInstance as? Draft
        detailSourceId = intent.getStringExtra("detailSourceId")
        sourceKind = intent.getStringExtra("kind")?.takeIf { it in setOf("local-files", "local-calendar") }
        localOffset = savedInstanceState?.getInt("localOffset") ?: 0
        val overviewPage = detailSourceId == null && sourceKind == null
        val content = moteDetailPage(title = MoteI18n.text(when {
            detailSourceId != null -> "来源详情"
            sourceKind == "local-files" -> "同步文件夹"
            sourceKind == "local-calendar" -> "本机日历"
            else -> ""
        }))
        content.setPadding(moteDp(16), moteDp(if (overviewPage) 0 else MoteTheme.spaceItem), moteDp(16), moteDp(MoteTheme.spaceGroup))
        operationStatusView = SecondaryUi.text(content, "", muted = true).apply { visibility = View.GONE; accessibilityLiveRegion = android.view.View.ACCESSIBILITY_LIVE_REGION_POLITE }
        list = SecondaryUi.column(content)
        MoteUi.styleTree(content)
        if (restoringDraft != null) edit(restoringDraft!!.source, restoringDraft!!.newSource)
        else if (savedInstanceState == null) {
            intent.getStringExtra("addAction")?.takeIf { it in setOf("FILE", "FOLDER") }?.let { action ->
                startActivity(Intent(this, FileTaskActivity::class.java).putExtra("addAction", action)); finish()
            }
            if (intent.getBooleanExtra("addCalendar", false)) connectCalendar()
            intent.getStringExtra("sourceId")?.let { id ->
                task.start(MoteI18n.text("正在读取来源…"), { operationStatus = it }, { owner.source(id) }) { result -> result.getOrNull()?.let { edit(it) } }
            }
        }
    }
    @Deprecated("Native in-memory configuration retention") override fun onRetainNonConfigurationInstance(): Any? = editingSource?.let { source ->
        Draft(source, draftControls.mapValues { (_, view) -> when (view) { is CheckBox -> view.isChecked.toString(); is Spinner -> view.selectedItemPosition.toString(); is EditText -> view.text.toString(); else -> "" } }, editingNewSource)
    }
    override fun onSaveInstanceState(state: Bundle) { state.putInt("localOffset", localOffset); super.onSaveInstanceState(state) }
    override fun onResume() { super.onResume(); handler.post(refresh) }
    override fun onPause() { handler.removeCallbacks(refresh); super.onPause() }
    override fun onDestroy() {
        worker.shutdown(); super.onDestroy()
    }
    private fun render() {
        if (isDestroyed || !::list.isInitialized || rendering || worker.isShutdown) return
        rendering = true
        worker.execute {
            val overview = if (detailSourceId == null && sourceKind == null) runCatching {
                owner.reconcileAuthorization()
                loadOverview()
            } else null
            val rows = if (overview == null) runCatching {
                owner.reconcileAuthorization()
                owner.snapshots(detailSourceId, localOffset, localPageSize).filter { sourceKind == null || it.source.kind == sourceKind }.map { snapshot ->
                    val source = snapshot.source
                    val state = snapshot.state
                    val pending = snapshot.pending
                    val fileProgress = snapshot.progress
                    val transferring = fileProgress != null && fileProgress.count(FileSyncPhase.UPLOADING) + fileProgress.count(FileSyncPhase.PREPARING) > 0
                    val status = if (transferring) MoteI18n.text("正在同步来源记录") else when (state.optString("status")) {
                        "permission" -> MoteI18n.text("权限丢失，请重新授权"); "paused" -> MoteI18n.text("中央已暂停；请在中央恢复后重试"); "provider" -> MoteI18n.text("提供者不可用或缓存已满；保留旧快照，稍后重试")
                        "context-conflict" -> MoteI18n.text("资料说明与中央版本冲突；请打开设置处理，文件保留待发。"); "context-http" -> MoteI18n.text("资料说明尚未获中央确认；请检查连接或升级中央，文件保留待发。");
                        "consent" -> MoteI18n.text("请编辑来源并确认完整文件上传到中央处理，处理后不保留中央原件。"); "offline" -> MoteI18n.text("等待网络/节点恢复"); "http", "ack" -> MoteI18n.text("节点未确认，原版本保留待发"); "synced" -> if (source.kind == "local-files" && source.retention != "archive") MoteI18n.text("文件已接收；中央处理与可搜索状态请在资料库查看") else MoteI18n.text("已同步"); "partial" -> MoteI18n.text("扫描不完整"); "scanned" -> MoteI18n.text("已扫描，等待发送"); else -> MoteI18n.text("等待首次扫描")
                    }
                    val syncState = when { !source.enabled -> "paused"; !Settings(this).read().hasSyncConnection() -> "unconfigured"; state.optString("status") in setOf("permission", "consent", "context-conflict") -> "blocked"; state.optString("status") == "paused" -> "paused"; transferring -> "uploading"; state.optString("status") in setOf("offline", "http", "ack", "provider", "context-http") -> "error"; pending > 0 || source.contextDirty -> "waiting"; else -> "idle" }
                    val facts = NativeStatus.project(org.json.JSONObject().put("pending", pending).put("lastAcknowledgedAt", state.opt("lastAcknowledgedAt") ?: org.json.JSONObject.NULL).put("syncState", syncState)
                        .put("errorCode", if (state.optString("status") == "permission") "permission_required" else if (state.optString("status") == "provider") "source_unavailable" else org.json.JSONObject.NULL)
                        .put("scanComplete", state.opt("scanComplete") ?: org.json.JSONObject.NULL).put("skipped", state.opt("skipped") ?: org.json.JSONObject.NULL))
                    val summary = if (source.tree && source.binaryFiles()) listOf(
                        LocalContentPresentation.folderStatus(applicationContext, source),
                        MoteI18n.text("文件") + " · " + when (source.retention) { "reference" -> MoteI18n.text("仅文件目录"); "archive" -> MoteI18n.text("原件归档"); else -> MoteI18n.text("中央提取正文，不保留原件") },
                        MoteI18n.text("最近扫描：{0}", state.optString("lastScan").ifBlank { MoteI18n.text("尚无") })
                    ).joinToString("\n") else MoteI18n.text("\n{0}\n{1} · {2} · {3}\n待发 {4} 个版本 · 最近扫描 {5}\n{6}", source.name, if (source.kind == "local-calendar") MoteI18n.text("日历") else MoteI18n.text("文件"), when (source.retention) { "reference" -> MoteI18n.text("仅文件目录"); "archive" -> MoteI18n.text("原件归档"); else -> if (source.kind == "local-files") MoteI18n.text("中央提取正文，不保留原件") else MoteI18n.text("内容快照") }, if (source.enabled) status else MoteI18n.text("本机已停用"), pending, state.optString("lastScan", MoteI18n.text("尚无")), if (state.has("scanComplete") && !state.optBoolean("scanComplete")) MoteI18n.text("本次扫描未完整：跳过 {0} 项；没有推断这些项已删除。", state.optInt("skipped")) else "") + "\n" + NativeStatus.summary(facts)
                    val presentationStatus = when {
                        !source.enabled -> MoteI18n.text("已暂停")
                        state.optString("status") in setOf("permission", "paused", "provider", "context-conflict", "context-http", "consent", "offline", "http", "ack", "partial") -> status
                        !Settings(this).read().hasSyncConnection() -> MoteI18n.text("仅保存在本机 · 连接节点后可同步")
                        else -> status
                    }
                    SourceRow(source, summary, presentationStatus, snapshot.local, snapshot.localTotal, snapshot.contextConflict)
                }
            } else null
            runOnUiThread {
                rendering = false
                if (isDestroyed || isFinishing) return@runOnUiThread
                if (overview != null) {
                    val value = overview.getOrNull()
                    val signature = value?.signature ?: "error"
                    if (signature == renderedSignature) return@runOnUiThread
                    renderedSignature = signature
                    list.removeAllViews()
                    if (value == null) SecondaryUi.text(list, MoteI18n.text("来源配置不可读；请保留应用数据，检查存储状态。"))
                    else showOverview(value)
                } else {
                    val signature = rows!!.getOrNull()?.joinToString { row -> row.source.json().toString() + row.summary + row.presentationStatus + row.local.joinToString() + row.localTotal + row.contextConflict }
                    if (signature != null && signature == renderedSignature) return@runOnUiThread
                    renderedSignature = signature
                    list.removeAllViews()
                    if (rows.isFailure) SecondaryUi.text(list, MoteI18n.text("来源配置不可读；请保留应用数据，检查存储状态。"))
                    else {
                        if (rows.getOrThrow().isEmpty()) SecondaryUi.text(list, MoteI18n.text(if (detailSourceId == null) "尚未连接来源。权限只在点击连接时申请。" else "所选文件不可用"), muted = true)
                        for (row in rows.getOrThrow()) {
                            val source = row.source
                            if (detailSourceId != null) showSourceDetail(row)
                            else SecondaryUi.row(list, source.name, row.summary.removePrefix("\n${source.name}\n").lineSequence().filter { it.isNotBlank() }.take(2).joinToString("\n")) {
                                startActivity(Intent(this, SourcesActivity::class.java).putExtra("detailSourceId", source.id))
                            }.tag = "source:${source.id}"
                        }
                    }
                }
                MoteUi.styleTree(list)
            }
        }
    }

    private data class Overview(
        val rows: List<CaptureSyncPresentation.SourceRow>, val send: CaptureSyncPresentation.SendView,
        val sendMethod: String, val sendPaused: Boolean, val storageText: String,
    ) { val signature get() = rows.toString() + send.toString() + sendMethod + sendPaused + storageText }

    private fun loadOverview(): Overview {
        val settings = Settings(this)
        val config = settings.read()
        val local = LocalStatusProducer.get(this).state.value
        val latest = runCatching { queue().latestCapturedAt() }.getOrDefault(emptyMap())
        fun lastAt(vararg sources: String) = sources.mapNotNull { latest[it] }.maxOrNull()
        val snapshots = owner.snapshots(null, 0, 1)
        fun facts(snapshot: SourceSnapshot) = CaptureSyncPresentation.SourceFacts(snapshot.source.id, snapshot.source.enabled,
            snapshot.state.optString("status"), snapshot.state.optString("lastScan"))
        val projection = config.effectiveMode() == "projection"
        val screenLive = config.screenCollectionEnabled && (if (projection) ProjectionService.running else CaptureAccessibilityService.connected)
        val observationSelected = config.notificationCollectionEnabled || config.deviceEventCollectionEnabled
        val mediaSelected = config.mediaCollectionEnabled && config.metadataEnabled
        val notifyPermission = MediaCollection.permissionAllowed(this)
        val meetingSessions = applicationContext.meetingRecordings().sessions()
        val meetingLast = meetingSessions.maxByOrNull { it.startedAt }?.startedAt
        val rows = CaptureSyncPresentation.sources(
            screen = CaptureSyncPresentation.KindFacts(present = config.screenCollectionEnabled,
                needsAction = settings.enabled && config.screenCollectionEnabled && !screenLive,
                paused = !settings.enabled, lastAt = lastAt("screen", "activity", "ui_page")),
            meeting = CaptureSyncPresentation.KindFacts(present = true, lastAt = meetingLast),
            observations = CaptureSyncPresentation.KindFacts(present = observationSelected,
                needsAction = settings.enabled && observationSelected && !notifyPermission,
                paused = !settings.enabled, lastAt = lastAt("notification", "device_event")),
            media = CaptureSyncPresentation.KindFacts(present = mediaSelected,
                needsAction = settings.enabled && mediaSelected && !notifyPermission,
                paused = !settings.enabled, lastAt = latest["media"]),
            files = snapshots.filter { it.source.kind == "local-files" }.map(::facts),
            calendars = snapshots.filter { it.source.kind == "local-calendar" }.map(::facts))
        val sendState = when {
            UploadHistoryRecovery.unavailable -> "error"
            local.error != null || (local.active?.blocked ?: 0) > 0 -> "blocked"
            else -> settings.syncState()
        }
        val send = CaptureSyncPresentation.send(config.server, config.hasSyncConnection(), config.syncPaused, sendState,
            local.pending, settings.lastAcknowledgedAt())
        val storageBytes = local.active?.diskBytes?.plus(local.quarantine?.diskBytes ?: 0)
        return Overview(rows, send, CaptureSyncPresentation.sendMethodLabel(config.syncMode, config.wifiOnly),
            config.syncPaused, CaptureSyncPresentation.storageLabel(storageBytes))
    }

    private fun showOverview(overview: Overview) {
        fun addTo(group: LinearLayout, view: View, first: Boolean) {
            if (!first) group.addView(MoteComponents.divider(this))
            group.addView(view)
        }
        list.addView(TextView(this).apply {
            text = MoteI18n.text("采集与同步")
            MoteUi.type(this, NativeFontRole.TITLE_MOBILE); MoteUi.textColor(this, NativeColorRole.INK)
            setLineSpacing(0f, 1.25f)
            setPadding(moteDp(4), moteDp(2), moteDp(4), 0)
        }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(18) })
        val sourcesGroup = MoteComponents.group(this)
        overview.rows.forEachIndexed { index, row ->
            val trailing = row.actionLabel?.let { label -> MoteComponents.smallButton(this, label) { handleSourceRow(row) } }
            val view = MoteComponents.row(this, glyphFor(row.kind), row.title, value = row.detail.takeIf(String::isNotBlank),
                valueFont = NativeFontRole.BODY,
                valueColor = if (row.warn) NativeColorRole.WARNING else NativeColorRole.MUTED, trailing = trailing, iconSizeDp = 20) {
                if (row.actionLabel != null) handleSourceRow(row) else openSourceRow(row)
            }
            addTo(sourcesGroup, view, index == 0)
        }
        addTo(sourcesGroup, MoteComponents.row(this, MoteGlyph.PLUS, MoteI18n.text("添加来源"),
            titleColor = NativeColorRole.ACCENT, iconColor = NativeColorRole.ACCENT, chevron = false, iconSizeDp = 20) {
            showAddSheet(overview.rows.map { it.kind }.toSet())
        }.apply { tag = "sources-add" }, overview.rows.isEmpty())
        list.addView(sourcesGroup, LinearLayout.LayoutParams(-1, -2))
        val sendGroup = MoteComponents.group(this)
        sendGroup.addView(MoteComponents.row(this, MoteGlyph.SEND, overview.send.host, subtitle = overview.send.text,
            subtitleColor = if (overview.send.warn) NativeColorRole.WARNING else NativeColorRole.MUTED, iconSizeDp = 20,
            trailing = overview.send.actionLabel?.let { label -> MoteComponents.smallButton(this, label) { sendAction(overview.send) } }))
        sendGroup.addView(MoteComponents.divider(this))
        sendGroup.addView(MoteComponents.row(this, MoteGlyph.CLOCK, MoteI18n.text("发送方式"), value = overview.sendMethod,
            valueFont = NativeFontRole.BODY, iconSizeDp = 20) { showSendMethod() })
        sendGroup.addView(MoteComponents.divider(this))
        sendGroup.addView(MoteComponents.row(this, MoteGlyph.PAUSE, MoteI18n.text("暂停发送"),
            iconSizeDp = 20, trailing = MoteComponents.switch(this, overview.sendPaused, MoteI18n.text("暂停发送")) { changeSendPause(it) }))
        list.addView(sendGroup, LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(24) })
        val storageGroup = MoteComponents.group(this)
        storageGroup.addView(MoteComponents.row(this, MoteGlyph.DISK, MoteI18n.text("本机存储"),
            value = overview.storageText.takeIf(String::isNotBlank), valueFont = NativeFontRole.BODY, iconSizeDp = 20) { openMoteLocalPage("STORAGE") })
        list.addView(storageGroup, LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(24) })
    }

    private fun glyphFor(kind: CaptureSyncPresentation.SourceKind) = when (kind) {
        CaptureSyncPresentation.SourceKind.SCREEN -> MoteGlyph.SCREEN
        CaptureSyncPresentation.SourceKind.MEETING -> MoteGlyph.MIC
        CaptureSyncPresentation.SourceKind.OBSERVATIONS -> MoteGlyph.BELL
        CaptureSyncPresentation.SourceKind.MEDIA -> MoteGlyph.PLAY
        CaptureSyncPresentation.SourceKind.FILES -> MoteGlyph.FOLDER
        CaptureSyncPresentation.SourceKind.CALENDAR -> MoteGlyph.CALENDAR
    }

    private fun openSourceRow(row: CaptureSyncPresentation.SourceRow) = when (row.kind) {
        CaptureSyncPresentation.SourceKind.SCREEN -> openMoteLocalPage("CAPTURE")
        CaptureSyncPresentation.SourceKind.MEETING -> startActivity(Intent(this, MeetingRecordingActivity::class.java))
        CaptureSyncPresentation.SourceKind.OBSERVATIONS, CaptureSyncPresentation.SourceKind.MEDIA -> openMoteLocalPage("OBSERVATIONS")
        CaptureSyncPresentation.SourceKind.FILES -> startActivity(Intent(this, SourcesActivity::class.java).putExtra("kind", "local-files"))
        CaptureSyncPresentation.SourceKind.CALENDAR -> startActivity(Intent(this, SourcesActivity::class.java).putExtra("kind", "local-calendar"))
    }

    private fun handleSourceRow(row: CaptureSyncPresentation.SourceRow) {
        row.attentionSourceId?.let { startActivity(Intent(this, SourcesActivity::class.java).putExtra("detailSourceId", it)); return }
        if (row.kind == CaptureSyncPresentation.SourceKind.MEETING) startActivity(Intent(this, MeetingRecordingActivity::class.java))
        else if (row.kind == CaptureSyncPresentation.SourceKind.SCREEN) openMoteLocalPage("CAPTURE") else openMoteLocalPage("PERMISSIONS")
    }

    private fun sendAction(send: CaptureSyncPresentation.SendView) = when (send.state) {
        CaptureSyncPresentation.SendState.PENDING -> requestSyncNow()
        else -> openMoteLocalPage("CONNECTION")
    }

    private fun requestSyncNow() {
        if (task.busy) return
        task.start(MoteI18n.text("正在提交同步任务…"), { operationStatus = it }, {
            ConnectionGuard.sync {
                val config = Settings(applicationContext).read(); config.validateConnection()
                if (localSources().sources().any { it.enabled }) SourceProviderPlugin.owner(applicationContext).schedule(manual = true, syncExplicit = true)
                else UploadWorker.schedule(applicationContext, config, true)
            } ?: error(MoteI18n.text("正在应用设置，请稍后重试"))
        }) { result ->
            result.onFailure { operationStatus = it.message ?: MoteI18n.text("操作失败，请重试") }
            render()
        }
    }

    private fun changeSendPause(paused: Boolean) {
        if (task.busy) { render(); return }
        task.start(MoteI18n.text("正在保存发送状态…"), { operationStatus = it }, {
            SendPauseControl.set(applicationContext, paused)
        }) { result ->
            result.onFailure { operationStatus = it.message ?: MoteI18n.text("操作失败，请重试") }
            render()
        }
    }

    private fun showSendMethod() {
        val config = Settings(this).read()
        val modes = listOf("realtime", "interval", "batch", "manual")
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(20), moteDp(8), moteDp(20), moteDp(8)) }
        val modeGroup = RadioGroup(this)
        modes.forEachIndexed { index, mode ->
            modeGroup.addView(RadioButton(this).apply { id = index; text = CaptureSyncPresentation.syncModeLabel(mode); isChecked = mode == config.syncMode; minHeight = moteDp(44) })
        }
        form.addView(modeGroup)
        val intervalLabel = TextView(this).apply { text = MoteI18n.text("同步间隔 / 分钟（批量模式下也是最长等待时间）") }
        val interval = MoteUi.field(EditText(this).apply { setText(config.syncIntervalMinutes.toString()); inputType = InputType.TYPE_CLASS_NUMBER })
        val batchLabel = TextView(this).apply { text = MoteI18n.text("批量同步条数") }
        val batch = MoteUi.field(EditText(this).apply { setText(config.syncBatchSize.toString()); inputType = InputType.TYPE_CLASS_NUMBER })
        form.addView(intervalLabel); form.addView(interval); form.addView(batchLabel); form.addView(batch)
        val wifi = CheckBox(this).apply { text = MoteI18n.text("仅非计费 Wi-Fi"); isChecked = config.wifiOnly; minHeight = moteDp(44) }
        form.addView(wifi)
        fun refreshFields() {
            val mode = modes[modeGroup.checkedRadioButtonId.coerceAtLeast(0)]
            val timed = mode in setOf("interval", "batch")
            intervalLabel.visibility = if (timed) View.VISIBLE else View.GONE; interval.visibility = intervalLabel.visibility
            batchLabel.visibility = if (mode == "batch") View.VISIBLE else View.GONE; batch.visibility = batchLabel.visibility
        }
        modeGroup.setOnCheckedChangeListener { _, _ -> refreshFields() }; refreshFields()
        MoteUi.styleTree(form)
        val dialog = MoteDialogBuilder(this).setTitle(MoteI18n.text("发送方式")).setView(form)
            .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("保存"), null).create()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            if (task.busy || modeGroup.checkedRadioButtonId < 0) return@setOnClickListener
            try {
                val mode = modes[modeGroup.checkedRadioButtonId]
                val intervalMinutes = interval.text.toString().toInt(); val batchSize = batch.text.toString().toInt()
                SyncPolicy(mode, intervalMinutes, batchSize).validate()
                val wifiOnly = wifi.isChecked
                task.start(MoteI18n.text("正在保存发送设置…"), { operationStatus = it }, {
                    SendPauseControl.setSendMethod(applicationContext, mode, intervalMinutes, batchSize, wifiOnly)
                }) { result ->
                    result.onSuccess { dialog.dismiss() }.onFailure { toast(it.message ?: MoteI18n.text("操作失败，请重试")) }
                    render()
                }
            } catch (error: Exception) { toast(if (error is IllegalArgumentException) error.message ?: MoteI18n.text("操作失败，请重试") else MoteI18n.text("操作失败，请重试")) }
        } }
        dialog.show()
    }

    private fun showAddSheet(added: Set<CaptureSyncPresentation.SourceKind>) {
        val sheetDialog = Dialog(this)
        val sheet = MoteComponents.sheet(this)
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
            setPadding(moteDp(20), 0, moteDp(6), 0)
        }
        header.addView(TextView(this).apply {
            text = MoteI18n.text("添加来源"); gravity = Gravity.CENTER_VERTICAL
            MoteUi.type(this, 16, medium = true); MoteUi.textColor(this, NativeColorRole.INK)
        }, LinearLayout.LayoutParams(0, moteDp(48), 1f))
        header.addView(MoteComponents.iconButton(this, MoteGlyph.CLOSE, description = MoteI18n.text("关闭"),
            style = MoteIconButtonStyle.MUTED) { sheetDialog.dismiss() }, LinearLayout.LayoutParams(moteDp(48), moteDp(48)))
        sheet.addView(header, LinearLayout.LayoutParams(-1, -2))
        val kindsGroup = MoteComponents.group(this)
        CaptureSyncPresentation.availableAddKinds(added).forEachIndexed { index, kind ->
            if (index > 0) kindsGroup.addView(MoteComponents.divider(this))
            kindsGroup.addView(MoteComponents.row(this, glyphFor(kind), MoteI18n.text(kind.titleKey),
                iconSizeDp = 20, trailing = if (kind.opensCentral) MoteComponents.icon(this, MoteGlyph.EXTERNAL, NativeColorRole.MUTED, 16) else null) {
                sheetDialog.dismiss(); openAddKind(kind)
            }.apply { tag = "add-source:${kind.name}" })
        }
        sheet.addView(kindsGroup, LinearLayout.LayoutParams(-1, -2).apply {
            // The system navigation area supplies the remaining bottom spacing.
            setMargins(moteDp(16), moteDp(8), moteDp(16), moteDp(8))
        })
        sheetDialog.setContentView(sheet)
        sheetDialog.window?.let { window ->
            window.setBackgroundDrawable(ColorDrawable(android.graphics.Color.TRANSPARENT))
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE or WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            NativePresentationStyles.bind(sheet, "sources-add-window") {
                @Suppress("DEPRECATION")
                window.navigationBarColor = NativeColorRole.SURFACE_RAISED.color()
                window.attributes = window.attributes.apply {
                    gravity = Gravity.BOTTOM; width = WindowManager.LayoutParams.MATCH_PARENT
                    dimAmount = if (MoteAppearance.dark()) 0.55f else 0.30f
                }
            }
        }
        sheetDialog.show()
    }

    private fun glyphFor(kind: CaptureSyncPresentation.AddKind) = when (kind) {
        CaptureSyncPresentation.AddKind.FILE -> MoteGlyph.FILE
        CaptureSyncPresentation.AddKind.FOLDER -> MoteGlyph.FOLDER
        CaptureSyncPresentation.AddKind.CALENDAR -> MoteGlyph.CALENDAR
        CaptureSyncPresentation.AddKind.SCREEN -> MoteGlyph.SCREEN
        CaptureSyncPresentation.AddKind.CLOUD -> MoteGlyph.GLOBE
    }

    private fun openAddKind(kind: CaptureSyncPresentation.AddKind) = when (kind) {
        CaptureSyncPresentation.AddKind.FILE -> startActivity(Intent(this, FileTaskActivity::class.java).putExtra("addAction", "FILE"))
        CaptureSyncPresentation.AddKind.FOLDER -> startActivity(Intent(this, FileTaskActivity::class.java).putExtra("addAction", "FOLDER"))
        CaptureSyncPresentation.AddKind.CALENDAR -> connectCalendar()
        CaptureSyncPresentation.AddKind.SCREEN -> openMoteLocalPage("CAPTURE")
        CaptureSyncPresentation.AddKind.CLOUD -> startActivity(Intent(this, CentralActivity::class.java).putExtra("page", "sources"))
    }

    private data class SourceRow(val source: LocalSource, val summary: String, val presentationStatus: String, val local: List<org.json.JSONObject>, val localTotal: Int, val contextConflict: Boolean)
    private fun connectCalendar() {
        if (checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED) chooseCalendars()
        else requestPermissions(arrayOf(Manifest.permission.READ_CALENDAR), 301)
    }
    private fun showSourceDetail(row: SourceRow) {
        val source = row.source
        (window.decorView.findViewWithTag<android.view.View>("detail-title") as? TextView)?.text = source.name
        SecondaryUi.text(list, MoteI18n.text("这台手机") + " · " + MoteI18n.text(if (source.kind == "local-calendar") "日历来源" else if (source.syncContinuously) "同步文件夹" else "单次导入"), muted = true)
        SecondaryUi.text(list, source.name, heading = true)
        val state = SecondaryUi.column(list, card = true)
        SecondaryUi.text(state, row.presentationStatus).apply { tag = "source-primary-status"; accessibilityLiveRegion = android.view.View.ACCESSIBILITY_LIVE_REGION_POLITE }
        val sourceActions = SecondaryUi.actions(state)
        SecondaryUi.action(sourceActions, MoteI18n.text(if (source.enabled) "暂停这个来源" else "恢复这个来源")) {
            work(MoteI18n.text("正在保存来源设置…")) {
                check(owner.setEnabled(source.id)) { MoteI18n.text("所选文件不可用") }
            }
        }.tag = "source-toggle"
        MoteUi.action(SecondaryUi.action(sourceActions, MoteI18n.text("编辑设置")) { edit(source) }, MoteUi.ButtonRole.TEXT).tag = "source-edit"
        val context = SecondaryUi.disclosure(list, MoteI18n.text("资料说明"), "source-description", row.contextConflict)
        SecondaryUi.text(context, source.description.ifBlank { MoteI18n.text("尚未填写") }, muted = source.description.isBlank())
        SecondaryUi.text(context, if (source.contextDirty) MoteI18n.text("资料说明保存在本机，等待中央确认。") else if (source.contextVersion > 0) MoteI18n.text("资料说明已获中央确认，版本 {0}。", source.contextVersion) else MoteI18n.text("资料说明会作为这个来源的背景保存。"), muted = true)
        if (row.contextConflict) SecondaryUi.action(context, MoteI18n.text("解决资料说明冲突")) {
            if (source.kind == "local-files") edit(source) else resolveCalendarContext(source)
        }.tag = "source-context-conflict"
        val syncDetails = SecondaryUi.disclosure(list, MoteI18n.text("来源同步状态"), "source-sync-details")
        if (!source.uri.isNullOrBlank()) SecondaryUi.text(syncDetails, source.uri, muted = true)
        SecondaryUi.text(syncDetails, row.summary.removePrefix("\n${source.name}\n"), muted = true)
        SecondaryUi.text(list, MoteI18n.text("本机内容"), heading = true)
        if (source.binaryFiles() && row.local.isEmpty()) SecondaryUi.text(list, MoteI18n.text("还没有本机记录"), muted = true)
        row.local.forEach { item ->
            val candidate = item.getJSONObject("candidate")
            SecondaryUi.row(list, candidate.optString("title", candidate.optString("externalId")), LocalContentPresentation.fileStatus(item)) {
                startActivity(Intent(this, FileContentActivity::class.java).putExtra("sourceId", source.id).putExtra("externalId", candidate.getString("externalId")))
            }
        }
        if (row.localTotal > localPageSize || localOffset > 0) {
            val paging = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }.also(list::addView)
            listOf(MoteI18n.text("上一页") to -localPageSize, MoteI18n.text("下一页") to localPageSize).forEach { (label, delta) ->
                paging.addView(MoteUi.button(Button(this).apply {
                    text = label; isEnabled = if (delta < 0) localOffset > 0 else localOffset + localPageSize < row.localTotal
                    setOnClickListener { localOffset = (localOffset + delta).coerceAtLeast(0); renderedSignature = null; render() }
                }), LinearLayout.LayoutParams(0, -2, 1f))
            }
        }
        SecondaryUi.row(list, MoteI18n.text("查看待上传队列")) { startActivity(Intent(this, SyncQueueActivity::class.java).putExtra("sourceId", source.id)) }
        SecondaryUi.row(list, MoteI18n.text("资料库")) { startActivity(Intent(this, CentralActivity::class.java).putExtra("page", "archive")) }
        val connection = SecondaryUi.disclosure(list, MoteI18n.text("连接管理"), "source-connection")
        SecondaryUi.action(connection, MoteI18n.text("移除连接")) { confirmRemove(source) }.tag = "source-remove"
    }
    private fun resolveCalendarContext(source: LocalSource) {
        if (task.busy) return
        val config = Settings(this).read()
        if (!config.hasSyncConnection()) { operationStatus = MoteI18n.text("等待网络/节点恢复"); return }
        task.start(MoteI18n.text("正在读取资料说明…"), { operationStatus = it }, {
            owner.remoteContext(source)
        }) { result ->
            result.onSuccess { remote ->
                fun apply(useRemote: Boolean) = work(MoteI18n.text("正在保存来源设置…")) {
                    check(Settings(this).read() == config && owner.source(source.id) == source) { MoteI18n.text("来源已在后台更新，请重新打开设置；当前草稿仍在页面中。") }
                    owner.save(owner.applyContextChoice(source, remote, useRemote))
                }
                MoteDialogBuilder(this).setTitle(MoteI18n.text("解决资料说明冲突"))
                    .setMessage(MoteI18n.text("中央说明（版本 {0}）：\n{1}\n\n本机说明：\n{2}", remote.version, remote.description, source.description))
                    .setPositiveButton(MoteI18n.text("以本机说明更新")) { _, _ -> apply(false) }
                    .setNeutralButton(MoteI18n.text("使用中央说明")) { _, _ -> apply(true) }
                    .setNegativeButton(MoteI18n.text("取消"), null).show()
            }.onFailure { operationStatus = MoteI18n.text("无法读取中央资料说明；本机草稿保留，请重试。") }
        }
    }
    private fun confirmRemove(source: LocalSource) {
        if (task.busy) return
        MoteDialogBuilder(this).setTitle(MoteI18n.text("移除连接")).setMessage(MoteI18n.text("移除这个来源和本机待发缓存；手机原文件与中央历史保留。"))
            .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("移除连接")) { _, _ ->
                work(MoteI18n.text("正在移除来源连接…")) {
                    owner.remove(source.id)
                }
            }.show()
    }
    private fun work(label: String, action: () -> Unit) {
        task.start(label, { operationStatus = it }, { action() }) { result ->
            operationStatus = if (result.isSuccess) MoteI18n.text("操作已完成；同步进度会自动刷新") else result.exceptionOrNull()?.message ?: MoteI18n.text("操作失败，请重试")
            render()
        }
    }
    private fun chooseCalendars() {
        task.start(MoteI18n.text("正在读取本机日历…"), { operationStatus = it }, {
            owner.calendars() to owner.sources()
        }) { result ->
            result.onSuccess { (calendars, sources) ->
                operationStatus = MoteI18n.text("已读取 {0} 个日历", calendars.size)
                if (calendars.isEmpty()) { toast(MoteI18n.text("系统日历提供者暂无日历；只有保存在本机提供者中的日历可连接")); return@onSuccess }
                MoteDialogBuilder(this).setTitle(MoteI18n.text("选择一个本机日历")).setItems(calendars.map { it.name }.toTypedArray()) { _, index ->
                    val item = calendars[index]
                    if (!item.visible) { toast(MoteI18n.text("该日历在系统中已隐藏，请先启用显示后再连接")); return@setItems }
                    val existing = sources.find { it.kind == "local-calendar" && it.calendarId == item.id }
                    edit(existing ?: LocalSource(name = item.name.take(200).ifBlank { MoteI18n.text("本机日历") }, kind = "local-calendar", calendarId = item.id), newSource = existing == null)
                }.setNegativeButton(MoteI18n.text("取消"), null).show()
            }.onFailure { operationStatus = MoteI18n.text("无法读取日历列表，请检查权限与日历应用") }
        }
    }
    @Deprecated("Platform permission callback")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 301 && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) chooseCalendars()
        else if (requestCode == 301) toast(MoteI18n.text("未授权，不读取日历；可在系统应用权限中重新允许"))
    }
    private fun releaseUnused(uri: String) = owner.releaseUnused(uri)
    private fun edit(source: LocalSource, newSource: Boolean = false) {
        if (source.kind == "local-files") {
            startActivity(Intent(this, FileTaskActivity::class.java).putExtra("sourceId", source.id)); return
        }
        editingSource = source; editingNewSource = newSource; draftControls.clear()
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(28, 12, 28, 12) }
        fun field(label: String, value: String, numeric: Boolean = false): EditText {
            form.addView(TextView(this).apply { text = label })
            return EditText(this).apply { setText(value); if (numeric) inputType = InputType.TYPE_CLASS_NUMBER; form.addView(this); draftControls[label] = this }
        }
        val name = field(MoteI18n.text("来源名称"), source.name)
        val description = field(MoteI18n.text("资料说明（选填）"), source.description).apply { MoteUi.textInput(this, InputType.TYPE_CLASS_TEXT, multiline = true); minLines = 3; filters = arrayOf(android.text.InputFilter.LengthFilter(12000)); tag = "calendar-description" }
        form.addView(TextView(this).apply { text = MoteI18n.text("读取范围：{0}", source.uri ?: source.name); MoteUi.type(this, NativeFontRole.SUPPORT) })
        val destination = Settings(this).read().server
        form.addView(TextView(this).apply { text = if (destination.isBlank()) MoteI18n.text("未连接中央：先保存本机任务，连接时确认发送范围。") else MoteI18n.text("完整文件的发送目的地：{0}", destination); MoteUi.type(this, NativeFontRole.SUPPORT) })
        val continuous = CheckBox(this).apply { text = MoteI18n.text("以后修改，也自动同步"); isChecked = source.syncContinuously }
        draftControls["continuous"] = continuous
        if (source.kind == "local-files" && !source.tree) form.addView(continuous)
        else if (source.kind != "local-calendar") form.addView(TextView(this).apply { text = MoteI18n.text("这个文件夹将持续同步，后台检查可能由系统推迟。") })
        val enabled = CheckBox(this).apply { text = MoteI18n.text("允许读取并按所选策略发送这个来源"); isChecked = source.enabled }; form.addView(enabled); draftControls["enabled"] = enabled
        form.addView(TextView(this).apply { text = MoteI18n.text("保存方式（中央已有历史不会随设置更改而删除）") })
        val modes = if (source.kind == "local-files") listOf("snapshot", "reference", "archive") else listOf("snapshot", "reference")
        val retention = Spinner(this).apply { adapter = ArrayAdapter(this@SourcesActivity, android.R.layout.simple_spinner_dropdown_item, modes.map { when(it) { "archive" -> MoteI18n.text("原件归档 · 中央保留文件"); "reference" -> MoteI18n.text("仅引用 · 不读取正文"); else -> if (source.kind == "local-files") MoteI18n.text("中央提取正文，不保留原件") else MoteI18n.text("内容快照") } }); setSelection(modes.indexOf(source.retention).coerceAtLeast(0)) }; form.addView(retention); draftControls["retention"] = retention
        form.addView(TextView(this).apply { text = MoteI18n.text("首次同步范围") })
        val allowRead = CheckBox(this).apply { text = MoteI18n.text("中央保留完整提取正文，供离线读取片段"); isChecked = source.allowRead }; draftControls["allowRead"] = allowRead; if (source.kind == "local-files") form.addView(allowRead)
        if (source.kind == "local-files") form.addView(TextView(this).apply { text = MoteI18n.text("文件快照和原件归档都会上传完整文件，由中央解析或转写。快照处理后删除中央临时原件，保留提取正文；原件归档长期保留文件。仅文件目录不读取正文。") })
        fun refreshReadOption() { allowRead.visibility = if (source.kind == "local-files" && modes[retention.selectedItemPosition] == "snapshot") android.view.View.VISIBLE else android.view.View.GONE }
        retention.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) = refreshReadOption()
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }
        refreshReadOption()
        val initial = Spinner(this).apply { adapter = ArrayAdapter(this@SourcesActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("已有内容分批导入（默认）"), MoteI18n.text("首次清点后仅同步新条目"))); setSelection(if (source.initialSync == "new_only") 1 else 0) }; draftControls["initial"] = initial; if (source.tree || source.kind == "local-calendar") form.addView(initial)
        form.addView(TextView(this).apply { text = MoteI18n.text("本地删除不影响中央原件；上传后仅清理 Mote 暂存，保留手机原文件。仅同步新增以首次完整清单为基线，重启不会重置。") })
        val advanced = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = android.view.View.GONE }
        form.addView(Button(this).apply { text = MoteI18n.text("高级选项"); setOnClickListener { advanced.visibility = if (advanced.visibility == android.view.View.VISIBLE) android.view.View.GONE else android.view.View.VISIBLE } })
        form.addView(advanced)
        val interval = EditText(this).apply { setText(source.intervalMinutes.toString()); inputType = InputType.TYPE_CLASS_NUMBER }
        advanced.addView(TextView(this).apply { text = MoteI18n.text("扫描间隔 / 分钟（15–1440，系统可能推迟）") }); advanced.addView(interval); draftControls["interval"] = interval
        val before = if (source.kind == "local-calendar") field(MoteI18n.text("过去多少天（0–365）"), source.daysBefore.toString(), true) else null
        val after = if (source.kind == "local-calendar") field(MoteI18n.text("未来多少天（1–365）"), source.daysAfter.toString(), true) else null
        val maxFileMiB = if (source.kind == "local-files") EditText(this).apply { setText(source.maxFileMiB.toString()); inputType = InputType.TYPE_CLASS_NUMBER }.also { advanced.addView(TextView(this).apply { text = MoteI18n.text("单文件上限（MiB，1–512）") }); advanced.addView(it); draftControls["maxFileMiB"] = it } else null
        val extensions = if (source.kind == "local-files") field(MoteI18n.text("允许扩展名，逗号分隔"), source.extensions) else null
        val excludes = if (source.kind == "local-files") field(MoteI18n.text("排除相对路径：每行一项，* 表示任意字符；区分大小写"), source.excluded) else null
        form.addView(TextView(this).apply { text = MoteI18n.text("更改选择、过滤或保留方式会清除这个来源的本机旧待发缓存，按新设置重新扫描；不会自动删除中央历史。停用仅暂停本机检查与同步，中央的启用状态与历史保持不变。移除只影响本机连接。") })
        restoringDraft?.takeIf { it.source.id == source.id }?.let { draft ->
            draftControls.forEach { (key, view) -> draft.values[key]?.let { value -> when (view) { is CheckBox -> view.isChecked = value.toBoolean(); is Spinner -> view.setSelection(value.toInt()); is EditText -> view.setText(value) } } }
            restoringDraft = null
        }
        MoteUi.styleTree(form)
        val dialog = MoteDialogBuilder(this).setTitle(MoteI18n.text(if (source.kind == "local-files" && !source.tree && !source.syncContinuously) "确认导入文件" else "确认同步范围")).setView(ScrollView(this).apply { addView(form) }).setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("保存来源设置"), null)
            .setNeutralButton(MoteI18n.text("移除连接")) { _, _ -> confirmRemove(source) }.create()
        // A cancelled new connection must not consume a persisted URI grant indefinitely.
        dialog.setOnDismissListener {
            editingSource = null; draftControls.clear()
            if (!worker.isShutdown) source.uri?.let { uri -> worker.execute { runCatching { releaseUnused(uri) } } }
        }
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            try {
                val descriptionText = description.text.toString()
                val next = source.copy(description = descriptionText, contextDirty = source.contextDirty || descriptionText != source.description, syncContinuously = if (source.kind == "local-files" && !source.tree) continuous.isChecked else true, centralProcessingConsent = true, allowRead = source.kind == "local-files" && modes[retention.selectedItemPosition] == "snapshot" && allowRead.isChecked, name = name.text.toString(), enabled = enabled.isChecked, retention = modes[retention.selectedItemPosition], initialSync = if (!source.tree && source.kind == "local-files") "all" else if (initial.selectedItemPosition == 1) "new_only" else "all",
                    intervalMinutes = interval.text.toString().toInt(), daysBefore = before?.text?.toString()?.toInt() ?: source.daysBefore,
                    daysAfter = after?.text?.toString()?.toInt() ?: source.daysAfter, maxFileMiB = maxFileMiB?.text?.toString()?.toInt() ?: source.maxFileMiB, extensions = extensions?.text?.toString() ?: source.extensions, excluded = excludes?.text?.toString() ?: source.excluded)
                if (task.busy) return@setOnClickListener
                next.validate()
                dialog.setCancelable(false)
                listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL).forEach { dialog.getButton(it).isEnabled = false }
                task.start(MoteI18n.text("正在保存来源设置…"), { operationStatus = it; dialog.getButton(AlertDialog.BUTTON_POSITIVE).text = it }, {
                    owner.saveAgainstOriginal(next, if (newSource) null else source, descriptionText)
                }) { result ->
                    dialog.setCancelable(true)
                    listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL).forEach { dialog.getButton(it).isEnabled = true }
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).text = MoteI18n.text("保存来源设置")
                    result.onSuccess { dialog.dismiss(); operationStatus = MoteI18n.text("来源已保存，正在等待后台扫描"); render() }
                        .onFailure { toast(it.message ?: MoteI18n.text("保存或调度失败，请重试；已保存内容不会丢失")) }
                }
            } catch (error: Exception) { toast(if (error is IllegalArgumentException) error.message ?: MoteI18n.text("请检查来源设置") else MoteI18n.text("保存或调度失败，请重试；已保存内容不会丢失")) }
        } }
        dialog.show()
    }
    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()
}
