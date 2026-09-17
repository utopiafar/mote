package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.graphics.BitmapFactory
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import androidx.work.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class BulkDedupeActivity : MoteActivity() {
    private lateinit var body: LinearLayout
    private lateinit var status: TextView
    private lateinit var summary: TextView
    private lateinit var list: LinearLayout
    private lateinit var progress: ProgressBar
    private lateinit var selectionStatus: TextView
    private lateinit var cancel: Button
    private val selectionChecks = mutableMapOf<String, CheckBox>()
    private val pageBitmaps = mutableListOf<android.graphics.Bitmap>()
    private val dialogs = mutableListOf<AlertDialog>()
    @Volatile private var imageGeneration = 0
    private lateinit var modes: Spinner
    private val controls = mutableListOf<android.view.View>()
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val images = Executors.newSingleThreadExecutor()
    private var rows = listOf<JSONObject>()
    private val selected = mutableSetOf<String>()
    @Volatile private var pending = false
    private var page = 0
    private var busy = false
    private var cancellationRequested = false
    private var localStateJob: kotlinx.coroutines.Job? = null
    private var polling: java.util.concurrent.ScheduledFuture<*>? = null
    private var lastRecordsRevision = -1L
    private var stamp = ""
    private var renderedRowsKey = ""
    @Volatile private var refresh = true
    private val modeValues = listOf("exact", "conservative", "balanced", "aggressive")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        pending = savedInstanceState?.getBoolean("pending") ?: false
        selected.addAll(savedInstanceState?.getStringArrayList("selected").orEmpty())
        page = savedInstanceState?.getInt("page") ?: 0
        body = moteDetailPage()
        label(body, MoteI18n.text("本机图片批量去重"), 25f)
        label(body, MoteI18n.text("扫描开始时本机保存的全部采集图片，按时间从早到晚扫描，与上一张保留图比较；相似则标记为重复，否则更新保留图。应用或尺寸变化时重新开始比较，不限制时间间隔。只处理本机副本；已上传中央的记录仍然保留。待决定区独立保存在本机，不参与同步和自动清理，仍占用磁盘空间。"))
        label(body, MoteI18n.text("扫描和处理均在后台执行，可以离开本页。取消后已完成的处理保留，剩余记录留在原处。"))
        modes = Spinner(this).apply {
            adapter = ArrayAdapter(this@BulkDedupeActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("精确"), MoteI18n.text("保守"), MoteI18n.text("均衡"), MoteI18n.text("激进")))
            isEnabled = false
        }; body.addView(modes); controls += modes
        action(body, MoteI18n.text("开始全量扫描")) {
            val mode = modeValues[modes.selectedItemPosition]
            submit(workDataOf("action" to "scan", "mode" to mode))
        }
        status = label(body, MoteI18n.text("正在读取后台任务…"))
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); body.addView(progress)
        cancel = Button(this).apply { text = MoteI18n.text("取消后台任务"); isEnabled = false; setOnClickListener {
            cancellationRequested = true
            text = MoteI18n.text("正在取消…"); isEnabled = false
            WorkManager.getInstance(this@BulkDedupeActivity).cancelUniqueWork(BulkDedupeWorker.NAME)
        } }; body.addView(cancel)
        action(body, MoteI18n.text("切换：扫描结果 / 待决定区")) {
            pending = !pending; page = 0; selected.clear(); rows = emptyList(); renderedRowsKey = ""
            summary.text = MoteI18n.text("正在读取{0}…", if (pending) MoteI18n.text("待决定区") else MoteI18n.text("扫描结果")); render(); refresh = true
        }
        summary = label(body, "")
        action(body, MoteI18n.text("选择本页")) { rows.drop(page * 10).take(10).forEach { selected += id(it) }; updateSelection() }
        action(body, MoteI18n.text("选择全部候选")) { rows.forEach { selected += id(it) }; updateSelection() }
        action(body, MoteI18n.text("取消全部选择")) { selected.clear(); updateSelection() }
        action(body, MoteI18n.text("移入待决定区 / 恢复所选")) { confirm(if (pending) "restore" else "move") }
        action(body, MoteI18n.text("永久删除所选")) { confirm(if (pending) "purge" else "delete") }
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(list)
        action(body, MoteI18n.text("上一页"), requiresIdle = false) { if (page > 0) { page--; render() } }
        action(body, MoteI18n.text("下一页"), requiresIdle = false) { if ((page + 1) * 10 < rows.size) { page++; render() } }
        MoteUi.styleTree(body)
        render()
        executor.execute {
            val mode = runCatching { Settings(applicationContext).read().imageDedupeMode }
            runOnUiThread { if (!isDestroyed) { mode.onSuccess { modes.setSelection(modeValues.indexOf(it).coerceAtLeast(0)) }; modes.isEnabled = !busy } }
        }
    }
    override fun onResume() {
        super.onResume()
        refresh = true
        polling = executor.scheduleWithFixedDelay({ poll() }, 0, 700, TimeUnit.MILLISECONDS)
        localStateJob = observeLocalState {
            if (it.revision.records != lastRecordsRevision) { lastRecordsRevision = it.revision.records; refresh = true }
        }
    }
    override fun onPause() { polling?.cancel(false); polling = null; localStateJob?.cancel(); localStateJob = null; super.onPause() }
    private fun id(pair: JSONObject) = pair.getJSONObject("candidate").getString("id")
    private fun poll() {
        try {
            val info = WorkManager.getInstance(this).getWorkInfosForUniqueWork(BulkDedupeWorker.NAME).get().let { work -> work.firstOrNull { !it.state.isFinished } ?: work.firstOrNull() }
            val active = info != null && !info.state.isFinished
            val key = "${info?.id}:${info?.state}"
            val changed = refresh || key != stamp
            val recordsVersion = LocalStateRepository.get(this).state.value.revision.records
            val store = BulkDedupeStore(this)
            val showingPending = pending
            var loaded: List<JSONObject>? = null
            var title = ""
            var rowsKey = ""
            if (changed && !active) {
                if (showingPending) {
                    val queue = store.quarantine()
                    loaded = queue.dedupeIds().mapNotNull { queue.dedupeRow(it)?.let { row -> JSONObject().put("candidate", row) } }
                    title = MoteI18n.text("待决定区 · {0} 条 · 本机记录与图片，可恢复", loaded.size)
                    rowsKey = "pending"
                } else {
                    val report = store.read("report")
                    val pairs = report.optJSONArray("pairs") ?: JSONArray()
                    val queue = queue()
                    // Membership is sufficient for browsing a report. Exact candidate and
                    // reference blobs are revalidated at the mutation boundary by the worker.
                    val available = queue.dedupeIds().toHashSet()
                    loaded = if (report.optBoolean("complete")) (0 until pairs.length()).map { pairs.getJSONObject(it) }
                        .filter { id(it) in available } else emptyList()
                    title = if (report.optBoolean("complete")) MoteI18n.text("扫描结果 · {0} · {1}\n扫描 {2} 张 · 失败 {3} 张 · 候选 {4} 张\n时间 {5}", report.optString("mode"), if (report.optString("comparison") == "last_retained") MoteI18n.text("与上一张保留图比较") else MoteI18n.text("旧规则结果，请重新扫描"), report.optInt("scanned"), report.optInt("errors"), loaded.size, report.optString("at")) else MoteI18n.text("尚无完整扫描结果；取消或中断后请重新扫描。")
                    rowsKey = "report:${report.optString("at")}:${report.optString("mode")}:${report.optBoolean("complete")}"
                }
                rowsKey += loaded.joinToString(separator = "|") { id(it) + ":" + it.getJSONObject("candidate").optString("blob") }
                refresh = LocalStateRepository.get(this).state.value.revision.records != recordsVersion
            }
            stamp = key
            val data = info?.progress ?: Data.EMPTY
            val message = if (active) MoteI18n.text("{0} · {1}/{2} · 命中/成功 {3} · 跳过/失败 {4}", data.getString("stage") ?: MoteI18n.text("等待后台执行"), data.getInt("done", 0), data.getInt("total", 0), data.getInt("found", 0), data.getInt("errors", 0)) else when (info?.state) {
                WorkInfo.State.CANCELLED -> MoteI18n.text("任务已取消，已完成的处理保留；可重新扫描或查看待决定区。")
                else -> info?.outputData?.getString("message") ?: MoteI18n.text("就绪")
            }
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                busy = active; controls.forEach { it.isEnabled = !active }
                selectionChecks.values.forEach { it.isEnabled = !active }
                if (!active) cancellationRequested = false
                cancel.isEnabled = active && !cancellationRequested
                cancel.text = if (cancellationRequested) MoteI18n.text("正在取消…") else MoteI18n.text("取消后台任务")
                status.text = message
                progress.isIndeterminate = active && data.getInt("total", 0) == 0
                progress.max = data.getInt("total", 1).coerceAtLeast(1); progress.progress = data.getInt("done", 0)
                if (loaded != null && pending == showingPending) {
                    rows = loaded; selected.retainAll(rows.map(::id).toSet()); page = page.coerceAtMost(((rows.size - 1) / 10).coerceAtLeast(0))
                    summary.text = title
                    if (rowsKey != renderedRowsKey) { renderedRowsKey = rowsKey; render() }
                } else if (loaded != null) refresh = true
            }
        } catch (error: Exception) { runOnUiThread { if (!isDestroyed) status.text = MoteI18n.text("读取失败：{0}", error.message) } }
    }
    private fun render() {
        imageGeneration++
        val generation = imageGeneration
        list.removeAllViews(); selectionChecks.clear(); pageBitmaps.forEach { it.recycle() }; pageBitmaps.clear()
        selectionStatus = label(list, "")
        selectionSummary()
        if (rows.isEmpty()) label(list, MoteI18n.text("没有待处理图片。"))
        val usePending = pending
        val source by lazy { if (usePending) BulkDedupeStore(this).quarantine() else queue() }
        rows.drop(page * 10).take(10).forEach { pair ->
            val row = pair.getJSONObject("candidate")
            val check = CheckBox(this).apply {
                text = "${row.optString("capturedAt")}\n${row.optString("appName").ifBlank { row.optString("appId") }}"
                isChecked = id(pair) in selected; isEnabled = !busy
                setOnCheckedChangeListener { _, checked -> if (checked) selected += id(pair) else selected -= id(pair); selectionSummary() }
            }; list.addView(check); selectionChecks[id(pair)] = check
            pair.optJSONObject("reference")?.let { label(list, MoteI18n.text("保留 {0}\n{1} · 哈希距离 {2} · 变化像素 {3}%\n变化块 {4} · 行 {5} · 列 {6}", it.optString("capturedAt"), pair.optString("reason"), pair.optInt("hashDistance"), "%.2f".format(pair.optDouble("changedPixelRatio") * 100), pair.optInt("changedBlocks"), pair.optInt("changedRows"), pair.optInt("changedCols"))) }
            val thumbnails = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }; list.addView(thumbnails)
            listOfNotNull(pair.optJSONObject("reference"), pair.getJSONObject("candidate")).forEach { row ->
                val image = ImageView(this).apply { contentDescription = if (row === pair.optJSONObject("reference")) MoteI18n.text("保留图缩略图") else MoteI18n.text("候选图缩略图"); setOnClickListener { preview(pair) } }
                thumbnails.addView(image, LinearLayout.LayoutParams(0, moteDp(160), 1f))
                images.execute {
                    if (generation != imageGeneration) return@execute
                    val bitmap = runCatching {
                        source.image(row.getString("id"))?.let { decodePreview(it, 320) }
                    }.getOrNull()
                    runOnUiThread {
                        if (isDestroyed || generation != imageGeneration) bitmap?.recycle()
                        else if (bitmap != null) { pageBitmaps += bitmap; image.setImageBitmap(bitmap) }
                        else image.contentDescription = MoteI18n.text("图片已不可用")
                    }
                }
            }
            val preview = Button(this).apply { text = MoteI18n.text("预览图片与保留图"); setOnClickListener { preview(pair) } }; list.addView(preview)
        }
    }
    private fun preview(pair: JSONObject) {
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        label(content, MoteI18n.text("正在后台读取图片…"))
        val dialog = AlertDialog.Builder(this).setTitle(MoteI18n.text("双指缩放 · 拖动查看 · 双击复位")).setView(ScrollView(this).apply { addView(content) }).setPositiveButton(MoteI18n.text("关闭"), null).create()
        val bitmaps = mutableListOf<android.graphics.Bitmap>()
        dialog.setOnDismissListener { content.removeAllViews(); bitmaps.forEach { it.recycle() }; bitmaps.clear() }
        dialogs += dialog
        dialog.show(); dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val quarantine = pending
        images.execute {
            val source = runCatching { if (quarantine) BulkDedupeStore(this).quarantine() else queue() }.getOrNull()
            val results = listOfNotNull(pair.optJSONObject("reference")?.let { MoteI18n.text("保留图") to it }, MoteI18n.text("候选图") to pair.getJSONObject("candidate")).map { (title, row) ->
                val bitmap = runCatching { source?.image(row.getString("id"))?.let { decodePreview(it, 1600) } }.getOrNull()
                Triple(title, row, bitmap)
            }
            runOnUiThread {
                if (isDestroyed || !dialog.isShowing) { results.forEach { it.third?.recycle() }; return@runOnUiThread }
                content.removeAllViews()
                results.forEach { (title, row, bitmap) ->
                    label(content, "$title · ${row.optString("capturedAt")}")
                    if (bitmap == null) label(content, MoteI18n.text("图片不可用，可能已经同步清理；执行时会重新检查。"))
                    else {
                        bitmaps += bitmap
                        content.addView(BulkDedupeImageView(this).apply {
                            setImageBitmap(bitmap); contentDescription = title
                        }, LinearLayout.LayoutParams(-1, moteDp(320)))
                    }
                }
            }
        }
    }
    private fun decodePreview(bytes: ByteArray, maxSide: Int): android.graphics.Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val opts = BitmapFactory.Options().apply { inSampleSize = 1; while (maxOf(bounds.outWidth, bounds.outHeight) / inSampleSize > maxSide) inSampleSize *= 2 }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
    }
    private fun selectionSummary() {
        val bytes = rows.filter { id(it) in selected }.sumOf { it.optLong("bytes") }
        selectionStatus.text = MoteI18n.text("第 {0}/{1} 页 · 已选 {2} 条", page + 1, ((rows.size + 9) / 10).coerceAtLeast(1), selected.size) +
            if (bytes > 0) MoteI18n.text(" · 图片合计 {0} MiB（共享文件实际释放可能更少）", "%.1f".format(bytes / 1048576.0)) else ""
    }
    private fun updateSelection() {
        selectionChecks.forEach { (id, check) -> check.isChecked = id in selected }
        selectionSummary()
    }
    private fun confirm(action: String) {
        val items = rows.filter { id(it) in selected }
        if (items.isEmpty()) { Toast.makeText(this, MoteI18n.text("请先选择图片"), Toast.LENGTH_SHORT).show(); return }
        val verb = when (action) { "move" -> MoteI18n.text("移入待决定区"); "restore" -> MoteI18n.text("恢复到本机采集队列"); else -> MoteI18n.text("永久删除本机记录及图片") }
        AlertDialog.Builder(this).setTitle(MoteI18n.text("确认{0}？", verb)).setMessage(MoteI18n.text("所选 {0} 条。{1}保留图不会删除。已同步的中央副本不受影响。恢复后会继续原有同步与 OCR 流程。", items.size, if (action in listOf("delete", "purge")) MoteI18n.text("无法撤销。") else ""))
            .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("确认")) { _, _ ->
                val job = UUID.randomUUID().toString()
                submit(workDataOf("action" to action, "job" to job), JSONObject().put("job", job).put("items", JSONArray(items)))
            }.show()
    }
    private fun submit(data: Data, plan: JSONObject? = null) {
        busy = true; cancellationRequested = false; controls.forEach { it.isEnabled = false }; status.text = MoteI18n.text("正在提交后台任务…")
        executor.execute {
            try {
                val manager = WorkManager.getInstance(this)
                check(manager.getWorkInfosForUniqueWork(BulkDedupeWorker.NAME).get().none { !it.state.isFinished }) { MoteI18n.text("已有后台任务正在执行") }
                if (plan != null) BulkDedupeStore(this).write("plan", plan)
                manager.enqueueUniqueWork(BulkDedupeWorker.NAME, ExistingWorkPolicy.KEEP, OneTimeWorkRequestBuilder<BulkDedupeWorker>().setInputData(data).build()).result.get()
                refresh = true
            } catch (error: Exception) { runOnUiThread { if (!isDestroyed) { status.text = MoteI18n.text("提交失败：{0}", error.message); busy = false; controls.forEach { it.isEnabled = true } } } }
        }
    }
    private fun label(parent: LinearLayout, value: String, size: Float = 14f) = TextView(this).apply { text = value; textSize = size; setPadding(0, moteDp(6), 0, moteDp(6)) }.also(parent::addView)
    private fun action(parent: LinearLayout, value: String, requiresIdle: Boolean = true, callback: () -> Unit) = Button(this).apply {
        text = value; setOnClickListener { if (!requiresIdle || !busy) callback() }
    }.also { parent.addView(it); if (requiresIdle) controls += it }
    override fun onSaveInstanceState(outState: Bundle) { outState.putStringArrayList("selected", ArrayList(selected)); outState.putInt("page", page); outState.putBoolean("pending", pending); super.onSaveInstanceState(outState) }
    override fun onDestroy() { imageGeneration++; dialogs.forEach { it.dismiss() }; list.removeAllViews(); pageBitmaps.forEach { it.recycle() }; pageBitmaps.clear(); executor.shutdownNow(); images.shutdownNow(); super.onDestroy() }
}
