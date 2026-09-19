package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.concurrent.Executors

class ActivityStatsActivity : MoteActivity() {
    private lateinit var body: LinearLayout
    private lateinit var summary: LinearLayout
    private lateinit var inventory: TextView
    private lateinit var history: LinearLayout
    private val executor = Executors.newSingleThreadExecutor()
    private val task by lazy { UiTask(this) }
    private lateinit var operationStatus: TextView
    private var loading = false
    private var localStateJob: kotlinx.coroutines.Job? = null
    private var refreshPending = false
    private var historyPage = 0
    private var pendingPage = 0
    private var snapshot: JSONObject? = null
    private var queueSnapshot: JSONObject? = null
    private val directorySizes = mutableMapOf<String, Long>()
    private var directorySizesAt = 0L
    @Volatile private var refreshDirectorySizes = true
    private lateinit var progress: ProgressBar
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        body = moteDetailPage()
        text(MoteI18n.text("采集与存储详情"), 27f)
        text(MoteI18n.text("这些统计始终在本机保存，与开发者诊断开关独立。记录固定结果与数字，不记录画面、文字、应用名、邀请或令牌。"))
        inventory = TextView(this).apply { textSize = 15f }; body.addView(inventory)
        summary = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(summary)
        renderSummary(MoteI18n.text("正在读取本机统计…"))
        progress = ProgressBar(this); body.addView(progress)
        operationStatus = TextView(this); body.addView(operationStatus)
        button(MoteI18n.text("刷新实际存储与统计")) { refreshDirectorySizes = true; refresh() }
        button(MoteI18n.text("设置图片保存位置")) { startActivity(Intent(this, StorageActivity::class.java)) }
        button(MoteI18n.text("查看采集记录")) { startActivity(Intent(this, CaptureRecordsActivity::class.java)) }
        button(MoteI18n.text("导出无正文统计 JSON")) { startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "mote-activity-stats.json"), 1) }
        button(MoteI18n.text("重置统计起点（保留队列和数据）")) {
            MoteDialogBuilder(this).setTitle(MoteI18n.text("重置本机统计")).setMessage(MoteI18n.text("只清空累计数字和最近事件，并记录新起算时间。不会删除队列、模型、配置或中央资料。"))
                .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("重置")) { _, _ ->
                    task.start(MoteI18n.text("正在重置统计…"), { operationStatus.text = it }, {
                        Operations.ledger(applicationContext).reset(); getSharedPreferences("operation-health", 0).edit().remove("incomplete").commit()
                        LocalStateChanges.changed(immediate = true)
                    }) { result -> operationStatus.text = if (result.isSuccess) MoteI18n.text("统计起点已重置") else MoteI18n.text("重置失败，请重试"); refresh() }
                }.show()
        }
        text(MoteI18n.text("最近结果"), 20f)
        history = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(history)
        MoteUi.styleTree(body)
    }
    override fun onResume() { super.onResume(); localStateJob = observeLocalState { inventory.text = it.storageLabel(); refresh() } }
    override fun onPause() { localStateJob?.cancel(); localStateJob = null; super.onPause() }
    private fun refresh() {
        if (loading) { refreshPending = true; return }; loading = true
        progress.visibility = android.view.View.VISIBLE
        executor.execute {
            try {
                val now = android.os.SystemClock.elapsedRealtime()
                if (refreshDirectorySizes || now - directorySizesAt > 30000) {
                    refreshDirectorySizes = false; directorySizes.clear(); directorySizesAt = now
                }
                // Live inventory is published independently. Directory sizes are expensive,
                // approximate diagnostics and need not walk every file on every record change.
                fun directoryBytes(file: File): Long = directorySizes.getOrPut(file.absolutePath) { bytes(file) }
                val state = Operations.ledger(this).read(); val counts = state.getJSONObject("counts")
                val queue = queue().summary(); val config = Settings(this).read()
                fun count(kind: OperationKind) = counts.getLong(kind.name)
                val models = File(noBackupFilesDir, "models"); val sources = File(noBackupFilesDir, "local-sources")
                val sourceStore = localSources()
                val sourcePending = sourceStore.sources().sumOf { sourceStore.state(it.id).optJSONArray("pending")?.length() ?: 0 }
                val content = buildString {
                    append(MoteI18n.text("当前采集\n状态：{0}\n", if (Settings(this@ActivityStatsActivity).enabled) MoteI18n.text("已启用") else MoteI18n.text("已停止")))
                    append(MoteI18n.text("起算：{0}\n", Instant.ofEpochMilli(state.getLong("epochAtMs"))))
                    append(MoteI18n.text("统计起点：{0}\n", when (state.getString("epochReason")) { "recovered" -> MoteI18n.text("统计文件曾不可读，已重新起算"); "user_reset" -> MoteI18n.text("用户主动重置"); else -> MoteI18n.text("首次建立统计，之前历史不可用") }))
                    if (getSharedPreferences("operation-health", 0).getBoolean("incomplete", false)) append(MoteI18n.text("⚠ 曾有统计写入失败，本周期数据不完整。\n"))
                    append(MoteI18n.text("\n累计结果\n截图请求 {0} · 收到画面 {1}\n", count(OperationKind.CAPTURE_REQUESTED), count(OperationKind.FRAME_RECEIVED)))
                    append(MoteI18n.text("累计截图记录 {0} · 已保存随手记 {1}\n", count(OperationKind.SCREEN_QUEUED), count(OperationKind.NOTE_QUEUED)))
                    append(MoteI18n.text("系统事件已保存 {0} · 已确认 {1}\n", count(OperationKind.SYSTEM_EVENT_QUEUED), count(OperationKind.SYSTEM_EVENT_ACK)))
                    append(MoteI18n.text("媒体已保存 {0} · 已确认 {1} · 失败 {2}\n", count(OperationKind.MEDIA_QUEUED), count(OperationKind.MEDIA_ACK), count(OperationKind.MEDIA_FAILED)))
                    append(MoteI18n.text("应用活动已保存 {0} · 已确认 {1} · 失败 {2}（无内容）\n", count(OperationKind.ACTIVITY_QUEUED), count(OperationKind.ACTIVITY_ACK), count(OperationKind.ACTIVITY_FAILED)))
                    append(MoteI18n.text("已丢弃画面 {0} · 截图/处理失败 {1}\n", count(OperationKind.FRAME_BLOCKED), count(OperationKind.CAPTURE_FAILED)))
                    append(MoteI18n.text("截图已确认上传 {0} · 随手记已确认上传 {1}\n", count(OperationKind.SCREEN_ACK), count(OperationKind.NOTE_ACK)))
                    append(MoteI18n.text("上传待重试结果 {0} · 来源版本已确认 {1} / 失败 {2}\n设备心跳失败 {3}\n", count(OperationKind.UPLOAD_RETRY), count(OperationKind.SOURCE_ACK), count(OperationKind.SOURCE_FAILED), count(OperationKind.HEARTBEAT_FAILED)))
                    append(MoteI18n.text("已确认上传 JSON 字节 {0}（不含 TLS/HTTP 开销）\n", size(state.getLong("confirmedUploadBytes"))))
                    append(MoteI18n.text("\n记录明细抽样\n采集区保留：{0} 条，截图 {1} / 活动 {2} / 媒体 {3} / 系统事件 {4} / 笔记 {5} / 无法读取 {6} / 未检查 {7}（分类最多读取100条）\n", queue.getInt("total"), queue.getInt("screens"), queue.getInt("activities"), queue.optInt("media"), queue.optInt("systemEvents"), queue.getInt("notes"), queue.getInt("unreadable"), queue.getInt("uninspected")))
                    append(MoteI18n.text("\n资料在哪里\n队列存储：{0} / 上限 {1} MiB\n{2}\n", size(queue.getLong("bytes")), config.maxQueueMiB, QueueStorage(this@ActivityStatsActivity).current().path))
                    append(MoteI18n.text("待 OCR 文字预留：{0}（计入存储上限，完成识别后按实际大小计）\n", size(queue.getLong("reservedOcrBytes"))))
                    append(MoteI18n.text("来源待确认版本：{0} · 本机来源缓存 {1}\n{2}\n", sourcePending, size(directoryBytes(sources)), sources.absolutePath))
                    append(MoteI18n.text("模型及下载断点：{0}\n{1}\n", size(directoryBytes(models)), models.absolutePath))
                    append(MoteI18n.text("临时缓存：{0}\n{1}\n", size(directoryBytes(cacheDir)), cacheDir.absolutePath))
                    append(MoteI18n.text("应用私有文件合计：{0}\n设备此分区可用：{1}\n", size(directoryBytes(File(applicationInfo.dataDir))), size(noBackupFilesDir.usableSpace)))
                    append(MoteI18n.text("目录大小为最近测量值，最多缓存 30 秒；可点击上方刷新重新测量。\n"))
                    append(MoteI18n.text("\n生效设置\n实际配置：每 {0} 秒，JPEG {1}，最长边 {2}px\n", config.intervalSeconds, config.jpegQuality, config.captureMaxSide))
                    append(MoteI18n.text("仅非计费 Wi-Fi：{0} · 仅充电采集：{1} · 低于 {2}% 暂停（0 关闭）\n", if (config.wifiOnly) MoteI18n.text("开启") else MoteI18n.text("关闭"), if (config.chargingOnly) MoteI18n.text("开启") else MoteI18n.text("关闭"), config.batteryPauseBelowPct))
                    append(MoteI18n.text("仅充电 OCR：{0}\n", if (config.ocrChargingOnly) MoteI18n.text("开启，充电后补做历史图片") else MoteI18n.text("关闭")))
                    append(MoteI18n.text("本机过滤：{0} · {1} 线程 · {2}ms 超时\n", if (config.nsfw.enabled) MoteI18n.text("开启") else MoteI18n.text("关闭"), config.nsfw.threads, config.nsfw.timeoutMs))
                    append(MoteI18n.text("设备元数据：{0} · 应用规则 {1} 项\n", if (config.metadataEnabled) MoteI18n.text("上传新记录的实际状态") else MoteI18n.text("新记录不附带"), AppCollectionRules.parse(config.appCollectionRules).apps.size))
                    append(MoteI18n.text("\n统计口径与限制\n已保存表示本机入队成功；已上传表示节点已确认收到。待 OCR 的图片在确认上传后仍会保留，补做结果也同步成功后才清理。被过滤的画面不会入队。暂停是原因变更次数，不等于丢弃截图次数；请求可能因系统/进程中断没有后续结果。统计与队列分开持久化，进程在两次写入之间终止时累计数可能少记；当前队列数量包含待识别和同步失败保留的图片。\n"))
                    append(MoteI18n.text("文件字节合计不是 Android 系统的安装占用；不含 APK、系统配额或其他分区。目录仅可由本应用读取，不是共享相册。"))
                }
                runOnUiThread {
                    if (isDestroyed) return@runOnUiThread
                    renderSummary(content); history.removeAllViews()
                    snapshot = state; queueSnapshot = queue; historyPage = historyPage.coerceAtMost(((state.getJSONArray("events").length() - 1) / 10).coerceAtLeast(0)); pendingPage = pendingPage.coerceAtMost(((queue.getJSONArray("pending").length() - 1) / 10).coerceAtLeast(0)); renderHistory()
                }
            } catch (_: Exception) { runOnUiThread { if (!isDestroyed) renderSummary(MoteI18n.text("统计或队列暂不可读取，不能按零展示；原始文件保留，请查看支持诊断。")) } }
            finally { runOnUiThread { loading = false; if (!isDestroyed) { progress.visibility = android.view.View.GONE; if (refreshPending) { refreshPending = false; refresh() } } } }
        }
    }
    private fun pager(page: Int, total: Int, select: (Int) -> Unit) {
        val row = LinearLayout(this)
        row.addView(Button(this).apply { text = MoteI18n.text("上一页"); isEnabled = page > 0; setOnClickListener { select(page - 1) } })
        row.addView(Button(this).apply { text = MoteI18n.text("下一页"); isEnabled = (page + 1) * 10 < total; setOnClickListener { select(page + 1) } })
        history.addView(row)
    }
    private fun renderHistory() {
        val state = snapshot ?: return
        val queue = queueSnapshot ?: return
        history.removeAllViews()
        history.addView(TextView(this).apply { text = MoteI18n.text("本机保留记录（第 {0} 页，每页 10 条；图片与文字请打开采集记录）", pendingPage + 1) })
        val pending = queue.getJSONArray("pending")
        for (i in pendingPage * 10 until minOf((pendingPage + 1) * 10, pending.length())) {
            val item = pending.getJSONObject(i)
            history.addView(Button(this).apply {
                text = "${if (item.optBoolean("archiveMissing")) MoteI18n.text("中央不可更新") else if (item.optBoolean("uploaded")) MoteI18n.text("已同步保留") else MoteI18n.text("待确认")} · ${when (item.getString("kind")) { "screen" -> MoteI18n.text("截图"); "activity" -> MoteI18n.text("应用活动"); "media" -> MoteI18n.text("媒体状态"); "notification" -> MoteI18n.text("通知事件"); "device_event" -> MoteI18n.text("设备事件"); else -> MoteI18n.text("随手记") }} · ${item.getString("id").take(8)}\n${item.getString("createdAt")}"
                setOnClickListener { MoteDialogBuilder(this@ActivityStatsActivity).setTitle(MoteI18n.text("本机记录")).setMessage(MoteI18n.text("记录 ID：{0}\n创建：{1}\n条目字节：{2}\n本机仍保留此记录；下方历史同一 ID 可关联上传失败和确认。图片与文字可从采集记录查看。", item.getString("id"), item.getString("createdAt"), item.getLong("bytes"))).setPositiveButton(MoteI18n.text("关闭"), null).show() }
            })
        }
        pager(pendingPage, pending.length()) { pendingPage = it; renderHistory() }
        history.addView(TextView(this).apply { text = MoteI18n.text("最近固定结果 · 第 {0} 页，每页 10 条", historyPage + 1) })
        val events = state.getJSONArray("events")
        for (i in events.length() - 1 - historyPage * 10 downTo maxOf(0, events.length() - (historyPage + 1) * 10)) {
            val event = events.getJSONObject(i)
            history.addView(Button(this).apply {
                text = "${Instant.ofEpochMilli(event.getLong("atMs"))}\n${kind(OperationKind.valueOf(event.getString("kind")))} · ${reason(OperationReason.valueOf(event.getString("reason")))} · ${event.optString("recordId").take(8)}"
                setOnClickListener { MoteDialogBuilder(this@ActivityStatsActivity).setTitle(MoteI18n.text("本机结果详情")).setMessage(detail(event)).setPositiveButton(MoteI18n.text("关闭"), null).show() }
            })
        }
        pager(historyPage, events.length()) { historyPage = it; renderHistory() }
        MoteUi.styleTree(history)
        if (events.length() == 0) history.addView(TextView(this).apply { text = MoteI18n.text("此统计周期还没有事件，不能推断此前没有采集。") })
    }
    private fun renderSummary(content: String) {
        val expanded = (0 until summary.childCount).map { summary.getChildAt(it) }.filterIsInstance<TextView>()
            .filter { it !is Button && it.visibility == android.view.View.VISIBLE }.map { it.text.toString().substringBefore('\n') }.toSet()
        summary.removeAllViews()
        content.split("\n\n").filter { it.isNotBlank() }.forEachIndexed { index, block ->
            val value = android.text.SpannableString(block)
            value.setSpan(android.text.style.StyleSpan(android.graphics.Typeface.BOLD), 0, block.indexOf('\n').takeIf { it >= 0 } ?: block.length, 0)
            val detail = TextView(this).apply {
                text = value; textSize = 15f; setLineSpacing(5f, 1f); setPadding(moteDp(16), moteDp(16), moteDp(16), moteDp(16)); setTextColor(MoteUi.ink); background = MoteUi.shape(this@ActivityStatsActivity)
            }
            if (index > 1) {
                detail.visibility = if (block.substringBefore('\n') in expanded) android.view.View.VISIBLE else android.view.View.GONE
                summary.addView(MoteUi.button(Button(this).apply {
                    text = block.substringBefore('\n') + MoteI18n.text(" · 展开 / 收起")
                    setOnClickListener { detail.visibility = if (detail.visibility == android.view.View.GONE) android.view.View.VISIBLE else android.view.View.GONE }
                }))
            }
            summary.addView(detail, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 16 })
        }
    }
    private fun text(value: String, size: Float = 15f) = TextView(this).apply { text = value; textSize = size; setPadding(0, 14, 0, 14) }.also(body::addView)
    private fun button(label: String, action: () -> Unit) { body.addView(Button(this).apply { text = label; setOnClickListener { action() } }) }
    @Deprecated("Native Activity document result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 1 || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        task.start(MoteI18n.text("正在导出统计…"), { operationStatus.text = it }, {
            val output = JSONObject().put("format", "mote.activity-stats").put("version", 1).put("statistics", Operations.ledger(applicationContext).read())
                .put("incomplete", getSharedPreferences("operation-health", 0).getBoolean("incomplete", false))
            contentResolver.openOutputStream(uri)!!.use { it.write(output.toString(2).toByteArray(Charsets.UTF_8)) }
        }) { result -> operationStatus.text = if (result.isSuccess) MoteI18n.text("统计已导出，不含本机目录或正文") else MoteI18n.text("统计导出失败") }
    }
    override fun onDestroy() { executor.shutdown(); super.onDestroy() }
    companion object {
        private fun bytes(directory: File): Long {
            if (!directory.exists()) return 0L
            var entries = 0; var total = 0L; val deadline = android.os.SystemClock.elapsedRealtime() + 2000
            for (entry in directory.walkTopDown().onEnter { !java.nio.file.Files.isSymbolicLink(it.toPath()) }) {
                if (++entries > 20000 || android.os.SystemClock.elapsedRealtime() > deadline) return -1L
                if (entry.isFile && !java.nio.file.Files.isSymbolicLink(entry.toPath())) total += entry.length()
            }; return total
        }
        private fun size(value: Long) = when { value < 0 -> MoteI18n.text("文件过多，未完成统计"); value >= 1073741824 -> "%.2f GiB".format(value / 1073741824.0); value >= 1048576 -> "%.1f MiB".format(value / 1048576.0); value >= 1024 -> "%.1f KiB".format(value / 1024.0); else -> "$value B" }
        fun kind(value: OperationKind): String = when (value) {
            OperationKind.PAGE_QUEUED -> MoteI18n.text("页面内容已保存"); OperationKind.PAGE_ACK -> MoteI18n.text("页面记录已确认上传")
            OperationKind.CAPTURE_REQUESTED -> MoteI18n.text("请求截图"); OperationKind.FRAME_RECEIVED -> MoteI18n.text("收到内存画面"); OperationKind.SCREEN_QUEUED -> MoteI18n.text("截图已保存")
            OperationKind.NOTE_QUEUED -> MoteI18n.text("随手记已保存"); OperationKind.SCREEN_ACK -> MoteI18n.text("截图已确认上传"); OperationKind.NOTE_ACK -> MoteI18n.text("随手记已确认上传")
            OperationKind.FRAME_BLOCKED -> MoteI18n.text("画面已丢弃，未入队"); OperationKind.CAPTURE_FAILED -> MoteI18n.text("截图或处理失败"); OperationKind.CAPTURE_PAUSED -> MoteI18n.text("采集暂停原因变化")
            OperationKind.HEARTBEAT_FAILED -> MoteI18n.text("设备心跳未确认")
            OperationKind.SYSTEM_EVENT_QUEUED -> MoteI18n.text("系统事件已入队"); OperationKind.SYSTEM_EVENT_ACK -> MoteI18n.text("系统事件已确认上传")
            OperationKind.UPLOAD_RETRY -> MoteI18n.text("同步未完成，保留队列待重试"); OperationKind.SOURCE_ACK -> MoteI18n.text("来源版本已确认"); OperationKind.SOURCE_FAILED -> MoteI18n.text("来源同步失败")
            OperationKind.CONNECTION_OK -> MoteI18n.text("连接身份校验成功"); OperationKind.CONNECTION_FAILED -> MoteI18n.text("连接失败"); OperationKind.CAPTURE_STARTED -> MoteI18n.text("用户启用采集"); OperationKind.CAPTURE_STOPPED -> MoteI18n.text("用户停止采集")
            OperationKind.MEDIA_QUEUED -> MoteI18n.text("媒体状态已保存"); OperationKind.MEDIA_ACK -> MoteI18n.text("媒体状态已确认上传"); OperationKind.MEDIA_FAILED -> MoteI18n.text("媒体状态保存失败")
            OperationKind.ACTIVITY_QUEUED -> MoteI18n.text("应用活动已保存，无内容"); OperationKind.ACTIVITY_ACK -> MoteI18n.text("应用活动已确认上传"); OperationKind.ACTIVITY_FAILED -> MoteI18n.text("应用活动保存失败")
        }
        fun reason(value: OperationReason): String = when (value) {
            OperationReason.NONE -> MoteI18n.text("已完成"); OperationReason.LOCKED -> MoteI18n.text("锁屏或熄屏"); OperationReason.CHARGING -> MoteI18n.text("仅充电设置"); OperationReason.BATTERY -> MoteI18n.text("电量限制")
            OperationReason.MODEL_MISSING -> MoteI18n.text("本机模型未就绪"); OperationReason.EXCLUDED -> MoteI18n.text("用户排除应用"); OperationReason.WINDOW_UNKNOWN -> MoteI18n.text("无法可靠识别窗口")
            OperationReason.QUEUE_FULL -> MoteI18n.text("队列空间已满"); OperationReason.MODEL_DENIED -> MoteI18n.text("本机模型拒绝"); OperationReason.LOCAL_DENIED -> MoteI18n.text("额外隐私审查拒绝")
            OperationReason.STATE_CHANGED -> MoteI18n.text("采集或窗口状态变化"); OperationReason.SYSTEM -> MoteI18n.text("系统未提供截图"); OperationReason.MODEL -> MoteI18n.text("本机推理失败")
            OperationReason.OCR -> MoteI18n.text("文字识别失败"); OperationReason.PRIVACY -> MoteI18n.text("隐私审查失败"); OperationReason.STORAGE -> MoteI18n.text("存储失败"); OperationReason.NETWORK -> MoteI18n.text("网络不可用")
            OperationReason.WIFI -> MoteI18n.text("等待非计费 Wi-Fi"); OperationReason.AUTH -> MoteI18n.text("凭据被拒绝"); OperationReason.HTTP -> MoteI18n.text("服务器 HTTP 失败")
            OperationReason.ACK -> MoteI18n.text("节点确认内容不匹配"); OperationReason.CANCELLED -> MoteI18n.text("已取消"); OperationReason.RESPONSE -> MoteI18n.text("响应不符合协议")
            OperationReason.CONFIGURATION -> MoteI18n.text("配置无效"); OperationReason.TIMEOUT -> MoteI18n.text("操作超时")
        }
        private fun detail(event: JSONObject) = MoteI18n.text("{0}\n{1}\n记录 ID：{2}\n原因：{3}\n记录字节：{4}\nHTTP：{5}\n耗时：{6}\n不保存内容预览；待上传记录只有匹配节点 ACK 后删除。", Instant.ofEpochMilli(event.getLong("atMs")), kind(OperationKind.valueOf(event.getString("kind"))), event.optString("recordId", MoteI18n.text("无关联记录")), reason(OperationReason.valueOf(event.getString("reason"))), event.getLong("bytes"), event.opt("httpStatus") ?: MoteI18n.text("无"), event.opt("elapsedMs") ?: MoteI18n.text("未测量"))
    }
}
