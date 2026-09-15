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

class ActivityStatsActivity : Activity() {
    private lateinit var body: LinearLayout
    private lateinit var summary: LinearLayout
    private lateinit var history: LinearLayout
    private val executor = Executors.newSingleThreadExecutor()
    private var loading = false
    private var historyPage = 0
    private var pendingPage = 0
    private var snapshot: JSONObject? = null
    private var queueSnapshot: JSONObject? = null
    private lateinit var progress: ProgressBar
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        body = moteDetailPage()
        text("采集与存储详情", 27f)
        text("这些统计始终在本机保存，与开发者诊断开关独立。记录固定结果与数字，不记录画面、文字、应用名、邀请或令牌。")
        summary = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(summary)
        renderSummary("正在读取本机统计…")
        progress = ProgressBar(this); body.addView(progress)
        button("刷新实际存储与统计") { refresh() }
        button("设置图片保存位置") { startActivity(Intent(this, StorageActivity::class.java)) }
        button("查看采集记录") { startActivity(Intent(this, CaptureRecordsActivity::class.java)) }
        button("导出无正文统计 JSON") { startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "mote-activity-stats.json"), 1) }
        button("重置统计起点（保留队列和数据）") {
            AlertDialog.Builder(this).setTitle("重置本机统计").setMessage("只清空累计数字和最近事件，并记录新起算时间。不会删除队列、模型、配置或中央资料。")
                .setNegativeButton("取消", null).setPositiveButton("重置") { _, _ ->
                    Operations.ledger(this).reset(); getSharedPreferences("operation-health", 0).edit().remove("incomplete").commit(); refresh()
                }.show()
        }
        text("最近结果", 20f)
        history = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(history)
        MoteUi.styleTree(body)
    }
    override fun onResume() { super.onResume(); refresh() }
    private fun refresh() {
        if (loading) return; loading = true
        progress.visibility = android.view.View.VISIBLE
        executor.execute {
            try {
                val state = Operations.ledger(this).read(); val counts = state.getJSONObject("counts")
                val queue = queue().summary(); val config = Settings(this).read()
                fun count(kind: OperationKind) = counts.getLong(kind.name)
                val models = File(noBackupFilesDir, "models"); val sources = File(noBackupFilesDir, "local-sources")
                val sourceStore = localSources()
                val sourcePending = sourceStore.sources().sumOf { sourceStore.state(it.id).optJSONArray("pending")?.length() ?: 0 }
                val content = buildString {
                    append("当前采集\n状态：${if (Settings(this@ActivityStatsActivity).enabled) "已启用" else "已停止"}\n")
                    append("起算：${Instant.ofEpochMilli(state.getLong("epochAtMs"))}\n")
                    append("统计起点：${when (state.getString("epochReason")) { "recovered" -> "统计文件曾不可读，已重新起算"; "user_reset" -> "用户主动重置"; else -> "首次建立统计，之前历史不可用" }}\n")
                    if (getSharedPreferences("operation-health", 0).getBoolean("incomplete", false)) append("⚠ 曾有统计写入失败，本周期数据不完整。\n")
                    append("\n累计结果\n截图请求 ${count(OperationKind.CAPTURE_REQUESTED)} · 收到画面 ${count(OperationKind.FRAME_RECEIVED)}\n")
                    append("已保存截图 ${count(OperationKind.SCREEN_QUEUED)} · 已保存随手记 ${count(OperationKind.NOTE_QUEUED)}\n")
                    append("系统事件已保存 ${count(OperationKind.SYSTEM_EVENT_QUEUED)} · 已确认 ${count(OperationKind.SYSTEM_EVENT_ACK)}\n")
                    append("媒体已保存 ${count(OperationKind.MEDIA_QUEUED)} · 已确认 ${count(OperationKind.MEDIA_ACK)} · 失败 ${count(OperationKind.MEDIA_FAILED)}\n")
                    append("应用活动已保存 ${count(OperationKind.ACTIVITY_QUEUED)} · 已确认 ${count(OperationKind.ACTIVITY_ACK)} · 失败 ${count(OperationKind.ACTIVITY_FAILED)}（无内容）\n")
                    append("已丢弃画面 ${count(OperationKind.FRAME_BLOCKED)} · 截图/处理失败 ${count(OperationKind.CAPTURE_FAILED)}\n")
                    append("截图已确认上传 ${count(OperationKind.SCREEN_ACK)} · 随手记已确认上传 ${count(OperationKind.NOTE_ACK)}\n")
                    append("上传待重试结果 ${count(OperationKind.UPLOAD_RETRY)} · 来源版本已确认 ${count(OperationKind.SOURCE_ACK)} / 失败 ${count(OperationKind.SOURCE_FAILED)}\n设备心跳失败 ${count(OperationKind.HEARTBEAT_FAILED)}\n")
                    append("已确认上传 JSON 字节 ${size(state.getLong("confirmedUploadBytes"))}（不含 TLS/HTTP 开销）\n")
                    append("\n当前本机记录\n加密保留：${queue.getInt("total")} 条，截图 ${queue.getInt("screens")} / 活动 ${queue.getInt("activities")} / 媒体 ${queue.optInt("media")} / 系统事件 ${queue.optInt("systemEvents")} / 笔记 ${queue.getInt("notes")} / 无法读取 ${queue.getInt("unreadable")} / 未检查 ${queue.getInt("uninspected")}（分类最多读取100条）\n")
                    append("\n资料在哪里\n队列存储：${size(queue.getLong("bytes"))} / 上限 ${config.maxQueueMiB} MiB\n${QueueStorage(this@ActivityStatsActivity).current().path}\n")
                    append("待 OCR 文字预留：${size(queue.getLong("reservedOcrBytes"))}（计入存储上限，完成识别后按实际大小计）\n")
                    append("来源待确认版本：$sourcePending · 本机来源缓存 ${size(bytes(sources))}\n${sources.absolutePath}\n")
                    append("模型及下载断点：${size(bytes(models))}\n${models.absolutePath}\n")
                    append("临时缓存：${size(bytes(cacheDir))}\n${cacheDir.absolutePath}\n")
                    append("应用私有文件合计：${size(bytes(File(applicationInfo.dataDir)))}\n设备此分区可用：${size(noBackupFilesDir.usableSpace)}\n")
                    append("\n生效设置\n实际配置：每 ${config.intervalSeconds} 秒，JPEG ${config.jpegQuality}，最长边 ${config.captureMaxSide}px\n")
                    append("仅非计费 Wi-Fi：${if (config.wifiOnly) "开启" else "关闭"} · 仅充电采集：${if (config.chargingOnly) "开启" else "关闭"} · 低于 ${config.batteryPauseBelowPct}% 暂停（0 关闭）\n")
                    append("仅充电 OCR：${if (config.ocrChargingOnly) "开启，充电后补做历史图片" else "关闭"}\n")
                    append("本机过滤：${if (config.nsfw.enabled) "开启" else "关闭"} · ${config.nsfw.threads} 线程 · ${config.nsfw.timeoutMs}ms 超时\n")
                    append("设备元数据：${if (config.metadataEnabled) "上传新记录的实际状态" else "新记录不附带"} · 应用规则 ${AppCollectionRules.parse(config.appCollectionRules).apps.size} 项\n")
                    append("\n统计口径与限制\n已保存表示加密入队成功；已上传表示节点已确认收到。待 OCR 的图片在确认上传后仍会加密保留，补做结果也同步成功后才清理。被过滤的画面不会入队。暂停是原因变更次数，不等于丢弃截图次数；请求可能因系统/进程中断没有后续结果。统计与队列分开持久化，进程在两次写入之间终止时累计数可能少记；当前队列数量包含待识别和同步失败保留的图片。\n")
                    append("文件字节合计不是 Android 系统的安装占用；不含 APK、系统配额或其他分区。目录仅可由本应用读取，不是共享相册。")
                }
                runOnUiThread {
                    if (isDestroyed) return@runOnUiThread
                    renderSummary(content); history.removeAllViews()
                    snapshot = state; queueSnapshot = queue; historyPage = 0; pendingPage = 0; renderHistory()
                }
            } catch (_: Exception) { runOnUiThread { if (!isDestroyed) renderSummary("统计或队列暂不可读取，不能按零展示；原始文件保留，请查看支持诊断。") } }
            finally { runOnUiThread { loading = false; if (!isDestroyed) progress.visibility = android.view.View.GONE } }
        }
    }
    private fun pager(page: Int, total: Int, select: (Int) -> Unit) {
        val row = LinearLayout(this)
        row.addView(Button(this).apply { text = "上一页"; isEnabled = page > 0; setOnClickListener { select(page - 1) } })
        row.addView(Button(this).apply { text = "下一页"; isEnabled = (page + 1) * 10 < total; setOnClickListener { select(page + 1) } })
        history.addView(row)
    }
    private fun renderHistory() {
        val state = snapshot ?: return
        val queue = queueSnapshot ?: return
        history.removeAllViews()
        history.addView(TextView(this).apply { text = "本机保留记录（第 ${pendingPage + 1} 页，每页 10 条；图片与文字请打开采集记录）" })
        val pending = queue.getJSONArray("pending")
        for (i in pendingPage * 10 until minOf((pendingPage + 1) * 10, pending.length())) {
            val item = pending.getJSONObject(i)
            history.addView(Button(this).apply {
                text = "${if (item.optBoolean("archiveMissing")) "中央不可更新" else if (item.optBoolean("uploaded")) "已同步保留" else "待确认"} · ${when (item.getString("kind")) { "screen" -> "截图"; "activity" -> "应用活动"; "media" -> "媒体状态"; "notification" -> "通知事件"; "device_event" -> "设备事件"; else -> "随手记" }} · ${item.getString("id").take(8)}\n${item.getString("createdAt")}"
                setOnClickListener { AlertDialog.Builder(this@ActivityStatsActivity).setTitle("本机记录").setMessage("记录 ID：${item.getString("id")}\n创建：${item.getString("createdAt")}\n加密条目字节：${item.getLong("bytes")}\n本机仍保留此记录；下方历史同一 ID 可关联上传失败和确认。图片与文字可从采集记录查看。").setPositiveButton("关闭", null).show() }
            })
        }
        pager(pendingPage, pending.length()) { pendingPage = it; renderHistory() }
        history.addView(TextView(this).apply { text = "最近固定结果 · 第 ${historyPage + 1} 页，每页 10 条" })
        val events = state.getJSONArray("events")
        for (i in events.length() - 1 - historyPage * 10 downTo maxOf(0, events.length() - (historyPage + 1) * 10)) {
            val event = events.getJSONObject(i)
            history.addView(Button(this).apply {
                text = "${Instant.ofEpochMilli(event.getLong("atMs"))}\n${kind(OperationKind.valueOf(event.getString("kind")))} · ${reason(OperationReason.valueOf(event.getString("reason")))} · ${event.optString("recordId").take(8)}"
                setOnClickListener { AlertDialog.Builder(this@ActivityStatsActivity).setTitle("本机结果详情").setMessage(detail(event)).setPositiveButton("关闭", null).show() }
            })
        }
        pager(historyPage, events.length()) { historyPage = it; renderHistory() }
        MoteUi.styleTree(history)
        if (events.length() == 0) history.addView(TextView(this).apply { text = "此统计周期还没有事件，不能推断此前没有采集。" })
    }
    private fun renderSummary(content: String) {
        summary.removeAllViews()
        content.split("\n\n").filter { it.isNotBlank() }.forEachIndexed { index, block ->
            val value = android.text.SpannableString(block)
            value.setSpan(android.text.style.StyleSpan(android.graphics.Typeface.BOLD), 0, block.indexOf('\n').takeIf { it >= 0 } ?: block.length, 0)
            val detail = TextView(this).apply {
                text = value; textSize = 15f; setLineSpacing(5f, 1f); setPadding(moteDp(16), moteDp(16), moteDp(16), moteDp(16)); setTextColor(MoteUi.ink); background = MoteUi.shape(this@ActivityStatsActivity)
            }
            if (index > 1) {
                detail.visibility = android.view.View.GONE
                summary.addView(MoteUi.button(Button(this).apply {
                    text = block.substringBefore('\n') + " · 展开 / 收起"
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
        if (requestCode == 1 && resultCode == RESULT_OK && data?.data != null) try {
            val output = JSONObject().put("format", "mote.activity-stats").put("version", 1).put("statistics", Operations.ledger(this).read())
                .put("incomplete", getSharedPreferences("operation-health", 0).getBoolean("incomplete", false))
            contentResolver.openOutputStream(data.data!!)!!.use { it.write(output.toString(2).toByteArray(Charsets.UTF_8)) }
            Toast.makeText(this, "统计已导出，不含本机目录或正文", Toast.LENGTH_LONG).show()
        } catch (_: Exception) { Toast.makeText(this, "统计导出失败", Toast.LENGTH_LONG).show() }
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
        private fun size(value: Long) = when { value < 0 -> "文件过多，未完成统计"; value >= 1073741824 -> "%.2f GiB".format(value / 1073741824.0); value >= 1048576 -> "%.1f MiB".format(value / 1048576.0); value >= 1024 -> "%.1f KiB".format(value / 1024.0); else -> "$value B" }
        fun kind(value: OperationKind): String = when (value) {
            OperationKind.CAPTURE_REQUESTED -> "请求截图"; OperationKind.FRAME_RECEIVED -> "收到内存画面"; OperationKind.SCREEN_QUEUED -> "截图已加密保存"
            OperationKind.NOTE_QUEUED -> "随手记已加密保存"; OperationKind.SCREEN_ACK -> "截图已确认上传"; OperationKind.NOTE_ACK -> "随手记已确认上传"
            OperationKind.FRAME_BLOCKED -> "画面已丢弃，未入队"; OperationKind.CAPTURE_FAILED -> "截图或处理失败"; OperationKind.CAPTURE_PAUSED -> "采集暂停原因变化"
            OperationKind.HEARTBEAT_FAILED -> "设备心跳未确认"
            OperationKind.SYSTEM_EVENT_QUEUED -> "系统事件已入队"; OperationKind.SYSTEM_EVENT_ACK -> "系统事件已确认上传"
            OperationKind.UPLOAD_RETRY -> "同步未完成，保留队列待重试"; OperationKind.SOURCE_ACK -> "来源版本已确认"; OperationKind.SOURCE_FAILED -> "来源同步失败"
            OperationKind.CONNECTION_OK -> "连接身份校验成功"; OperationKind.CONNECTION_FAILED -> "连接失败"; OperationKind.CAPTURE_STARTED -> "用户启用采集"; OperationKind.CAPTURE_STOPPED -> "用户停止采集"
            OperationKind.MEDIA_QUEUED -> "媒体状态已保存"; OperationKind.MEDIA_ACK -> "媒体状态已确认上传"; OperationKind.MEDIA_FAILED -> "媒体状态保存失败"
            OperationKind.ACTIVITY_QUEUED -> "应用活动已保存，无内容"; OperationKind.ACTIVITY_ACK -> "应用活动已确认上传"; OperationKind.ACTIVITY_FAILED -> "应用活动保存失败"
        }
        fun reason(value: OperationReason): String = when (value) {
            OperationReason.NONE -> "已完成"; OperationReason.LOCKED -> "锁屏或熄屏"; OperationReason.CHARGING -> "仅充电设置"; OperationReason.BATTERY -> "电量限制"
            OperationReason.MODEL_MISSING -> "本机模型未就绪"; OperationReason.EXCLUDED -> "用户排除应用"; OperationReason.WINDOW_UNKNOWN -> "无法可靠识别窗口"
            OperationReason.QUEUE_FULL -> "队列空间已满"; OperationReason.MODEL_DENIED -> "本机模型拒绝"; OperationReason.LOCAL_DENIED -> "额外隐私审查拒绝"
            OperationReason.STATE_CHANGED -> "采集或窗口状态变化"; OperationReason.SYSTEM -> "系统未提供截图"; OperationReason.MODEL -> "本机推理失败"
            OperationReason.OCR -> "文字识别失败"; OperationReason.PRIVACY -> "隐私审查失败"; OperationReason.STORAGE -> "存储失败"; OperationReason.NETWORK -> "网络不可用"
            OperationReason.WIFI -> "等待非计费 Wi-Fi"; OperationReason.AUTH -> "凭据被拒绝"; OperationReason.HTTP -> "服务器 HTTP 失败"
            OperationReason.ACK -> "节点确认内容不匹配"; OperationReason.CANCELLED -> "已取消"; OperationReason.RESPONSE -> "响应不符合协议"
            OperationReason.CONFIGURATION -> "配置无效"; OperationReason.TIMEOUT -> "操作超时"
        }
        private fun detail(event: JSONObject) = "${Instant.ofEpochMilli(event.getLong("atMs"))}\n${kind(OperationKind.valueOf(event.getString("kind")))}\n记录 ID：${event.optString("recordId", "无关联记录")}\n原因：${reason(OperationReason.valueOf(event.getString("reason")))}\n记录字节：${event.getLong("bytes")}\nHTTP：${event.opt("httpStatus") ?: "无"}\n耗时：${event.opt("elapsedMs") ?: "未测量"}\n不保存内容预览；待上传记录只有匹配节点 ACK 后删除。"
    }
}
