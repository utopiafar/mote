package dev.mote.collector

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import dev.mote.collector.plugins.BackupCompletion
import dev.mote.collector.plugins.BackupKind
import dev.mote.collector.plugins.BackupObserver
import dev.mote.collector.plugins.BackupOutcome
import dev.mote.collector.plugins.BackupSnapshot
import dev.mote.collector.plugins.RestorePreview
import dev.mote.collector.plugins.StorageBackupPlugin
import dev.mote.collector.ui.MoteComponents

/** Routes backup, restore and configuration intents to the storage plugin;
 * this Activity only selects documents, renders returned snapshots and asks
 * for the one accepted operation to continue after recreate. */
class BackupActivity : MoteActivity() {
    private val task by lazy { UiTask(this) }
    private lateinit var status: TextView
    private lateinit var secrets: CheckBox
    private var includeToken = false
    private var exportOrigin: String? = null
    private var exportGeneration = -1L
    private var configTab = false
    private var pendingPicker = 0
    private lateinit var operation: BackupOperationView
    private lateinit var inventory: TextView
    private var inventoryKnown = false
    private lateinit var inventoryUnit: TextView
    private var localStateJob: kotlinx.coroutines.Job? = null
    private var renderedOperation = 0L
    private val owner get() = StorageBackupPlugin.owner(this)
    private val observer = object : BackupObserver {
        override fun onBackupProgress(snapshot: BackupSnapshot) { if (!isFinishing && !isDestroyed) renderProgress(snapshot) }
        override fun onBackupResult(completion: BackupCompletion) { if (!isFinishing && !isDestroyed) renderCompletion(completion) }
    }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        includeToken = state?.getBoolean("includeToken") ?: false
        exportOrigin = state?.getString("exportOrigin"); exportGeneration = state?.getLong("exportGeneration") ?: -1L
        configTab = state?.getBoolean("configTab") ?: false
        pendingPicker = state?.getInt("pendingPicker") ?: 0
        val page = moteDetailPage(title = MoteI18n.text("备份与恢复"), onBack = { returnOrFinish() })
        val body = SecondaryUi.column(page)
        val tabs = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }.also(body::addView)
        val recordsTab = Button(this).apply { text = MoteI18n.text("本机记录"); tag = "backup-records-tab" }
        val settingsTab = Button(this).apply { text = MoteI18n.text("客户端配置"); tag = "backup-config-tab" }
        tabs.addView(recordsTab, LinearLayout.LayoutParams(-2, -2))
        tabs.addView(settingsTab, LinearLayout.LayoutParams(-2, -2))
        val records = SecondaryUi.column(body)
        val recordCard = SecondaryUi.column(records, card = true)
        SecondaryUi.text(recordCard, MoteI18n.text("这台手机仍保留的记录"), muted = true)
        val count = LinearLayout(this).apply { gravity = android.view.Gravity.BOTTOM }.also(recordCard::addView)
        inventory = TextView(this).apply {
            MoteComponents.reading(this, MoteI18n.text("正在读取本机同步状态…")); tag = "backup-record-count"
            MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.INK)
            NativePresentationStyles.bind(this, "backup-count") { (it as TextView).apply { textSize = if (inventoryKnown) 35f else NativeFontRole.SUPPORT.size().toFloat(); letterSpacing = if (inventoryKnown) -.04f else 0f; typeface = android.graphics.Typeface.create(MoteTheme.fontFamily(false), android.graphics.Typeface.NORMAL) } }
        }.also { count.addView(it, LinearLayout.LayoutParams(-2,-2)) }
        inventoryUnit = TextView(this).apply {
            text = MoteI18n.text("条"); visibility = android.view.View.GONE
            MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED)
            NativePresentationStyles.bind(this,"backup-count-unit") { (it as TextView).textSize = 13f }
        }.also { count.addView(it, LinearLayout.LayoutParams(-2,-2).apply { marginStart = moteDp(7); bottomMargin = moteDp(5) }) }
        SecondaryUi.text(recordCard, MoteI18n.text("导出为本机记录 ZIP，之后可以重新导入。"), muted = true)
        val recordActions = SecondaryUi.actions(recordCard)
        SecondaryUi.action(recordActions, MoteI18n.text("导出本机记录"), primary = true) { create(12, "application/zip", "mote-records.zip") }.tag = "backup-export-records"
        SecondaryUi.action(recordActions, MoteI18n.text("从备份恢复")) { chooseRestore() }.tag = "backup-restore-records"
        val range = SecondaryUi.disclosure(records, MoteI18n.text("备份包含什么"), "backup-scope")
        SecondaryUi.text(range, MoteI18n.text("备份本机仍保留的截图、应用活动、通知、媒体和记录。ZIP 为明文，不含中央归档、来源文件原件、未提交草稿或模型文件。"), muted = true)
        SecondaryUi.text(range, MoteI18n.text("已清理的本机副本不在其中。"), muted = true)
        SecondaryUi.text(range, MoteI18n.text("备份文件为明文，仅保存在自己信任的位置。"), muted = true)
        SecondaryUi.action(range, MoteI18n.text("导出本机元数据 JSON")) { create(14, "application/json", "mote-local-metadata.json") }
        SecondaryUi.row(records, MoteI18n.text("本机存储位置")) { startActivity(Intent(this, StorageActivity::class.java)) }
        val central = SecondaryUi.disclosure(records, MoteI18n.text("中央资料导出"), "backup-central")
        SecondaryUi.text(central, MoteI18n.text("中央导出与问答、资料库共用登录状态。"), muted = true)
        SecondaryUi.action(central, MoteI18n.text("中央登录与账户")) { startActivity(Intent(this, CentralActivity::class.java).putExtra("page", "vault")) }
        SecondaryUi.action(central, MoteI18n.text("导出中央元数据")) { create(15, "application/gzip", "mote-central-metadata.tar.gz") }
        SecondaryUi.action(central, MoteI18n.text("导出中央资料与附件")) { create(16, "application/gzip", "mote-central-data.tar.gz") }
        val config = SecondaryUi.column(body, card = true)
        SecondaryUi.text(config, MoteI18n.text("迁移采集与同步设置"), heading = true)
        SecondaryUi.text(config, MoteI18n.text("迁移采集、应用规则、同步和诊断设置。系统权限和来源文件授权需在新设备重新授予。"), muted = true)
        val options = SecondaryUi.disclosure(config, MoteI18n.text("导出选项"), "backup-export-options", includeToken)
        secrets = CheckBox(this).apply { text = MoteI18n.text("导出时包含节点令牌（文件为明文，请妥善保管）"); isChecked = includeToken; setOnCheckedChangeListener { _, checked -> includeToken = checked } }.also(options::addView)
        val configActions = SecondaryUi.actions(config)
        SecondaryUi.action(configActions, MoteI18n.text("导出配置 JSON"), primary = true) { includeToken = secrets.isChecked; create(10, "application/json", "mote-settings.json") }
        SecondaryUi.action(configActions, MoteI18n.text("导入配置 JSON")) { open(11, "application/json") }
        status = SecondaryUi.text(body, "", muted = true).apply { tag = "backup-status"; accessibilityLiveRegion = android.view.View.ACCESSIBILITY_LIVE_REGION_POLITE }
        operation = owner.operationView(this, page, body) { returnFromOperation() }
        fun select() {
            records.visibility = if (configTab) android.view.View.GONE else android.view.View.VISIBLE
            config.visibility = if (configTab) android.view.View.VISIBLE else android.view.View.GONE
            recordsTab.isSelected = !configTab; settingsTab.isSelected = configTab
            MoteUi.action(recordsTab, MoteUi.ButtonRole.TEXT); MoteUi.action(settingsTab, MoteUi.ButtonRole.TEXT)
            recordsTab.paintFlags = if (!configTab) android.graphics.Paint.UNDERLINE_TEXT_FLAG else 0
            settingsTab.paintFlags = if (configTab) android.graphics.Paint.UNDERLINE_TEXT_FLAG else 0
        }
        recordsTab.setOnClickListener { configTab = false; select() }
        settingsTab.setOnClickListener { configTab = true; select() }
        select(); MoteUi.styleTree(body)
    }
    override fun onResume() {
        super.onResume()
        localStateJob = observeLocalState { state ->
            inventoryKnown = state.active != null
            if (state.active == null && state.imagesReading) MoteComponents.reading(inventory, state.imageLabel()) else inventory.text = state.active?.let { java.text.NumberFormat.getIntegerInstance(MoteI18n.locale()).format(it.records) } ?: state.imageLabel()
            inventoryUnit.visibility = if (inventoryKnown) android.view.View.VISIBLE else android.view.View.GONE
            NativePresentationStyles.refresh(inventory)
        }
        val snapshot = owner.attach(observer)
        if (snapshot != null) renderSnapshot(snapshot) else if (!operation.showing) operation.landing()
    }
    override fun onPause() { owner.detach(observer); localStateJob?.cancel(); localStateJob = null; super.onPause() }
    override fun onDestroy() {
        if (!isChangingConfigurations) owner.detachPermanently()
        super.onDestroy()
    }
    private fun chooseRestore() {
        if (!canChooseFile()) return
        operation.show(MoteI18n.text("从备份恢复"), "", MoteI18n.text("选择本机记录 ZIP"),
            MoteI18n.text("导入前先校验备份。已有记录保留，已有的同一条记录不重复添加。"),
            actions = listOf(Triple(MoteI18n.text("选择备份文件"), true) { open(13, "application/zip") }))
    }
    private fun returnFromOperation() {
        owner.abandonSurface()
        operation.landing()
    }
    private fun returnOrFinish() { if (::operation.isInitialized && operation.showing) returnFromOperation() else finish() }
    @Deprecated("Native back callback") override fun onBackPressed() = returnOrFinish()
    private fun create(code: Int, mime: String, name: String) {
        if (!canChooseFile()) return
        if (code in setOf(15, 16)) {
            task.start(MoteI18n.text("正在读取…"), MoteComponents.progress(status), { CentralAccess.requireClient(this).server to CentralSession.get(this).generation }) { result ->
                result.onSuccess { (origin, generation) -> exportOrigin = origin; exportGeneration = generation
                    launchPicker(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, name), code)
                }.onFailure { status.text = it.message }
            }
        } else launchPicker(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, name), code)
    }
    private fun canChooseFile() = pendingPicker == 0 && !task.busy && !owner.busy
    private fun launchPicker(intent: Intent, code: Int) {
        if (!canChooseFile()) return
        owner.clearDocument()
        if (::operation.isInitialized) operation.updateFile(null)
        pendingPicker = code
        try { startActivityForResult(intent, code) } catch (error: Exception) { pendingPicker = 0; status.text = error.message }
    }
    private fun open(code: Int, mime: String) = launchPicker(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime), code)
    @Deprecated("Native document picker")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode !in 10..16 || requestCode != pendingPicker) return
        pendingPicker = 0
        if (isFinishing || task.busy || owner.busy) return
        if (resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        when (requestCode) {
            10, 12, 14, 15, 16 -> owner.export(
                uri.toString(), requestCode, includeToken,
                if (requestCode == 15 || requestCode == 16) exportOrigin?.let { it to exportGeneration } else null,
            )
            11 -> owner.readConfiguration(uri.toString())
            13 -> owner.prepareRestore(uri.toString())
        }
    }
    private fun renderSnapshot(snapshot: BackupSnapshot) {
        renderedOperation = snapshot.id
        status.text = snapshot.heading
        operation.show(snapshot.title, snapshot.state, snapshot.heading, snapshot.message, loading = true, file = snapshot.file,
            content = { card -> if (snapshot.detail.isNotBlank()) SecondaryUi.text(card, snapshot.detail) })
    }
    private fun renderProgress(snapshot: BackupSnapshot) {
        status.text = snapshot.message.ifBlank { snapshot.heading }
        if (!operation.showing || snapshot.id != renderedOperation) renderSnapshot(snapshot)
        else { operation.updateProgress(snapshot.message); operation.updateFile(snapshot.file) }
    }
    private fun renderCompletion(completion: BackupCompletion) {
        val snapshot = completion.snapshot
        completion.outcome.onSuccess { outcome ->
            when (outcome) {
                is BackupOutcome.Exported -> exportResult(snapshot, outcome)
                is BackupOutcome.ConfigurationRead -> previewConfiguration(outcome.current, outcome.next)
                is BackupOutcome.RestorePrepared -> previewRestore(RestorePreview(outcome.displayName, outcome.count, outcome.origin))
                is BackupOutcome.RestoreApplied -> restoreResult(snapshot, outcome.displayName, null)
                is BackupOutcome.ConfigurationApplied -> configurationResult(true, null)
            }
        }.onFailure { error ->
            when (snapshot.kind) {
                BackupKind.EXPORT -> exportFailure(snapshot)
                BackupKind.CONFIGURATION_READ -> errorStage(MoteI18n.text("导入客户端配置"), MoteI18n.text("配置无法导入：{0}", error.message ?: MoteI18n.text("文件无效"))) { open(11, "application/json") }
                BackupKind.RESTORE_PREPARE -> errorStage(MoteI18n.text("从备份恢复"), MoteI18n.text("备份无法导入：{0}", error.message ?: MoteI18n.text("文件无效"))) { open(13, "application/zip") }
                BackupKind.RESTORE_APPLY -> restoreResult(snapshot, null, error.message ?: MoteI18n.text("导入未完成"))
                BackupKind.CONFIGURATION_APPLY -> configurationResult(false, error.message ?: MoteI18n.text("配置导入失败，原设置保留"))
            }
        }
    }
    private fun errorStage(title: String, message: String, retry: () -> Unit) {
        status.text = message
        if (!operation.showing) return
        operation.show(title, MoteI18n.text("未完成"), title, message, actions = listOf(
            Triple(MoteI18n.text("重新选择文件"), true, retry), Triple(MoteI18n.text("返回"), false) { returnFromOperation() }))
    }
    private fun exportResult(snapshot: BackupSnapshot, outcome: BackupOutcome.Exported) {
        val message = when {
            outcome.includeToken -> MoteI18n.text("配置文件包含节点令牌，请妥善保管。")
            outcome.code == 10 -> MoteI18n.text("配置文件不含节点令牌。系统权限需在目标设备上重新授予。")
            outcome.code == 14 -> MoteI18n.text("元数据文件可用于查看记录信息，不是带附件的备份。")
            else -> MoteI18n.text("导出没有清空本机内容。")
        }
        status.text = MoteI18n.text("已保存到所选位置")
        operation.show(snapshot.title, MoteI18n.text("导出文件已生成"), MoteI18n.text("已保存到所选位置"), message, file = owner.documentFacts(),
            actions = listOf(Triple(MoteI18n.text("完成"), true) { returnFromOperation() }))
    }
    private fun exportFailure(snapshot: BackupSnapshot) {
        status.text = MoteI18n.text("导出未完成")
        operation.show(snapshot.title, MoteI18n.text("导出未完成"), MoteI18n.text("备份未能生成"), MoteI18n.text("请删除刚才不完整的文件，再重新导出。本机记录保留。"), file = owner.documentFacts(),
            actions = listOf(Triple(MoteI18n.text("重新导出"), true) { retryExport(snapshot.request) }, Triple(MoteI18n.text("返回"), false) { returnFromOperation() }))
    }
    private fun retryExport(code: Int) {
        val (mime, name) = when (code) {
            10 -> "application/json" to "mote-settings.json"
            12 -> "application/zip" to "mote-records.zip"
            14 -> "application/json" to "mote-local-metadata.json"
            15 -> "application/gzip" to "mote-central-metadata.tar.gz"
            else -> "application/gzip" to "mote-central-data.tar.gz"
        }
        create(code, mime, name)
    }
    private fun previewRestore(preview: RestorePreview) {
        operation.show(MoteI18n.text("从备份恢复"), MoteI18n.text("备份已校验"), MoteI18n.text("导入 {0} 条本机记录？", preview.count), content = { card ->
            SecondaryUi.text(card, preview.displayName)
            SecondaryUi.fact(card, MoteI18n.text("导入到"), MoteI18n.text("这台手机"))
            SecondaryUi.fact(card, MoteI18n.text("Central"), if (preview.origin.isBlank()) MoteI18n.text("未连接") else MoteI18n.text("与当前连接一致"))
            SecondaryUi.fact(card, MoteI18n.text("已有内容"), MoteI18n.text("已有记录保留，同 ID 自动去重。"))
            SecondaryUi.fact(card, MoteI18n.text("发送方式"), MoteI18n.text("导入后切换为手动同步"))
        }, actions = listOf(Triple(MoteI18n.text("导入到此手机"), true) { restore() }, Triple(MoteI18n.text("取消"), false) { returnFromOperation() }))
    }
    private fun restore() {
        if (!canChooseFile()) return
        if (!owner.restore(this)) status.text = MoteI18n.text("操作正在进行")
    }
    private fun restoreResult(snapshot: BackupSnapshot, name: String?, failure: String?) {
        val preview = owner.preparedPreview()
        val success = failure == null
        status.text = if (success) MoteI18n.text("记录已导入 · 手动同步") else MoteI18n.text("导入未完成：{0}。已导入记录保留，可重试同一备份。", failure)
        operation.show(MoteI18n.text("从备份恢复"), MoteI18n.text(if (success) "已导入本机" else "导入尚未完成"),
            MoteI18n.text(if (success) "记录已回来" else "请检查本机内容后重试"), status.text.toString(),
            content = { card -> (name ?: preview?.displayName)?.let { SecondaryUi.text(card, it) } },
            actions = (if (!success && preview != null) listOf(Triple(MoteI18n.text("重试同一备份"), true) { previewRestore(preview) }) else emptyList()) + listOf(
                Triple(MoteI18n.text("查看本机内容"), success) { startActivity(Intent(this, CaptureRecordsActivity::class.java)) },
                Triple(MoteI18n.text("查看待发送"), false) { startActivity(Intent(this, SyncQueueActivity::class.java)) }))
    }
    private fun previewConfiguration(current: CollectorConfig, next: CollectorConfig) {
        operation.show(MoteI18n.text("导入客户端配置"), "", MoteI18n.text("替换这台手机的偏好设置？"),
            MoteI18n.text("已有记录和设备身份保留，系统权限不会自动开启。"), content = { card ->
                fun row(label: String, before: String, after: String) {
                    val line = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
                    listOf(label, before, after).forEach { value -> line.addView(TextView(this).apply { text = value; MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK); setPadding(0, moteDp(12), moteDp(8), moteDp(12)) }, LinearLayout.LayoutParams(0, -2, 1f)) }
                    card.addView(line); card.addView(android.view.View(this).apply { MoteUi.backgroundColor(this, NativeColorRole.DIVIDER) }, LinearLayout.LayoutParams(-1, moteDp(1)))
                }
                row(MoteI18n.text("设置"), MoteI18n.text("当前"), MoteI18n.text("导入后"))
                row(MoteI18n.text("采集间隔"), MoteI18n.text("{0} 秒", current.intervalSeconds), MoteI18n.text("{0} 秒", next.intervalSeconds))
                row(MoteI18n.text("本机保留"), MoteI18n.text("{0} 天", current.uploadedRetentionDays), MoteI18n.text("{0} 天", next.uploadedRetentionDays))
                row(MoteI18n.text("发送方式"), syncLabel(current), syncLabel(next))
                row(MoteI18n.text("应用规则"), current.collectionRules.apps.size.toString(), next.collectionRules.apps.size.toString())
                SecondaryUi.text(card, if (current.server == next.server) MoteI18n.text("中央不变") else MoteI18n.text("中央将改变；未携带令牌时需重新连接"), muted = true)
            }, actions = listOf(Triple(MoteI18n.text("导入配置"), true, applyConfiguration@{
                if (!canChooseFile()) return@applyConfiguration
                if (!owner.applyConfiguration(this, current, next)) status.text = MoteI18n.text("操作正在进行")
            }), Triple(MoteI18n.text("取消"), false) { returnFromOperation() }))
    }
    private fun configurationResult(success: Boolean, failure: String?) {
        status.text = if (success) MoteI18n.text("配置已导入") else failure
        operation.show(MoteI18n.text("客户端配置"), "", status.text.toString(), MoteI18n.text("已有记录和设备身份保留，系统权限不会自动开启。"),
            actions = listOf(Triple(MoteI18n.text("返回"), true) { returnFromOperation() }))
    }
    private fun syncLabel(config: CollectorConfig) = when (config.syncMode) {
        "manual" -> MoteI18n.text("仅手动发送")
        "interval" -> MoteI18n.text("定时发送")
        "realtime" -> MoteI18n.text("有新内容时发送")
        else -> MoteI18n.text("凑够一批后发送")
    }
    override fun onSaveInstanceState(outState: Bundle) { outState.putInt("pendingPicker", pendingPicker); outState.putBoolean("configTab", configTab); outState.putBoolean("includeToken", includeToken); outState.putString("exportOrigin", exportOrigin); outState.putLong("exportGeneration", exportGeneration); super.onSaveInstanceState(outState) }
}
