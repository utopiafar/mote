package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Bitmap
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import dev.mote.collector.ui.MoteComponents
import org.json.JSONObject
import java.text.DateFormat
import java.time.Instant
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/** Local-only inspection of opt-in, privacy-filtered duplicate/reference pairs. */
class ImageDedupeDiagnosticsActivity : MoteActivity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var body: LinearLayout
    private lateinit var list: LinearLayout
    private lateinit var status: TextView
    private lateinit var clear: Button
    private lateinit var refresh: Button
    private var revision = 0
    private var currentDialog: AlertDialog? = null
    private var zoomDialog: AlertDialog? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        body = moteDetailPage(title = MoteI18n.text("去重对比诊断"))
        status = SecondaryUi.text(body, MoteI18n.text("正在读取…"), muted = true).also { MoteComponents.reading(it, it.text.toString()) }
        list = SecondaryUi.column(body)
        val actions = SecondaryUi.actions(body)
        refresh = SecondaryUi.action(actions, MoteI18n.text("刷新诊断")) { load() }
        clear = SecondaryUi.action(actions, MoteI18n.text("清空诊断副本")) { mutate { imageDedupeDiagnostics().clear() } }
        val details = SecondaryUi.disclosure(body, MoteI18n.text("诊断范围与保留"), "dedupe-diagnostic-scope")
        SecondaryUi.text(details, MoteI18n.text("仅保留开启诊断后命中的图片对。图片已完成隐私检查和遮罩，仅在本机保存，不会同步。"), muted = true)
        SecondaryUi.text(details, MoteI18n.text("最多 20 组、32 MiB，保存期限 24 小时。读取时清理过期记录；系统休眠可能延后后台清理。关闭诊断后清空。"), muted = true)
        MoteUi.styleTree(body)
    }
    override fun onResume() { super.onResume(); if (::list.isInitialized) load() }
    private fun load() {
        val stamp = ++revision; clear.isEnabled = false; refresh.isEnabled = false
        list.removeAllViews(); MoteComponents.reading(status)
        executor.execute {
            val result = runCatching { imageDedupeDiagnostics().list() to Settings(applicationContext).read().imageDedupeDiagnosticsEnabled }
            runOnUiThread {
                if (isDestroyed || isFinishing || stamp != revision) return@runOnUiThread
                refresh.isEnabled = true
                result.onSuccess { (rows, enabled) ->
                    clear.isEnabled = rows.isNotEmpty(); clear.visibility = if (rows.isEmpty()) android.view.View.GONE else android.view.View.VISIBLE
                    status.text = if (enabled) MoteI18n.text("本机保留 {0} 组去重诊断", rows.size) else MoteI18n.text("诊断已关闭。")
                    if (rows.isEmpty()) {
                        val card = SecondaryUi.column(list, card = true)
                        SecondaryUi.text(card, MoteI18n.text("暂无对比诊断记录"), heading = true)
                        SecondaryUi.text(card, MoteI18n.text("可在图像设置开启并保存。"), muted = true)
                    }
                    rows.forEach { item ->
                        SecondaryUi.row(list, MoteI18n.text("当前图与最近保留图"), MoteI18n.text("{0} · {1} · 哈希相似度 {2}", time(item.optString("capturedAt")), ImageDedupeDiagnosticsDetails.modeName(item.optString("mode")), percent(item.optDouble("hashSimilarityPercent")))) { detail(item.getString("id")) }
                            .tag = "dedupe:${item.getString("id")}"
                    }
                }.onFailure { status.text = MoteI18n.text("诊断读取失败，请重试。采集队列不受影响。") }
            }
        }
    }
    private fun mutate(action: () -> Unit) {
        ++revision; currentDialog?.dismiss(); clear.isEnabled = false; refresh.isEnabled = false
        MoteComponents.working(status, MoteI18n.text("正在删除临时图片…"))
        executor.execute {
            val result = runCatching(action)
            runOnUiThread {
                if (isDestroyed || isFinishing) return@runOnUiThread
                if (result.isSuccess) load() else { refresh.isEnabled = true; clear.isEnabled = true; status.text = MoteI18n.text("临时图片删除失败，请重试。") }
            }
        }
    }
    private fun detail(id: String) {
        currentDialog?.dismiss()
        val stamp = revision
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(16), moteDp(8), moteDp(16), moteDp(12)) }
        content.addView(MoteComponents.skeletonTile(this, MoteI18n.text("正在读取图片对…")), LinearLayout.LayoutParams(-1, moteDp(220)))
        val bitmaps = mutableListOf<Bitmap>()
        val dialog = MoteDialogBuilder(this).setTitle(MoteI18n.text("原图与保留图"))
            .setView(ScrollView(this).apply { addView(content) })
            .setNegativeButton(MoteI18n.text("关闭"), null).setPositiveButton(MoteI18n.text("删除这组图片")) { _, _ -> mutate { imageDedupeDiagnostics().delete(id) } }.create()
        currentDialog = dialog
        dialog.setOnDismissListener { zoomDialog?.dismiss(); zoomDialog = null; content.removeAllViews(); bitmaps.forEach { it.recycle() }; bitmaps.clear(); if (currentDialog === dialog) currentDialog = null }
        dialog.show(); dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        executor.execute {
            val decoded = mutableListOf<Bitmap>()
            val result = runCatching {
                val record = imageDedupeDiagnostics().read(id) ?: error("expired")
                decoded += requireNotNull(CapturePreview.decode(record.referenceImage, 1200))
                decoded += requireNotNull(CapturePreview.decode(record.duplicateImage, 1200))
                record.metadata
            }
            runOnUiThread {
                if (isDestroyed || isFinishing || stamp != revision || !dialog.isShowing) { decoded.forEach { it.recycle() }; return@runOnUiThread }
                content.removeAllViews()
                result.onSuccess { item ->
                    bitmaps.addAll(decoded)
                    val pair = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
                    content.addView(pair)
                    listOf(1 to MoteI18n.text("被去重图片"), 0 to MoteI18n.text("处理后基准图")).forEach { (index, label) ->
                        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
                        pair.addView(column, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = moteDp(MoteTheme.spaceInline) })
                        image(column, decoded[index], label)
                        SecondaryUi.text(column, label, muted = true)
                    }
                    SecondaryUi.text(content, MoteI18n.text("点击图片放大比较。"), muted = true)
                    val details = SecondaryUi.disclosure(content, MoteI18n.text("评分与采集时的对比依据"), "dedupe-measurements")
                    text(details, MoteI18n.text("档位：{0}\n依据：{1}", ImageDedupeDiagnosticsDetails.modeName(item.getString("mode")), ImageDedupeDiagnosticsDetails.reason(item)), 15f)
                    text(details, MoteI18n.text("哈希相似度 {0}\n计算：1 − {1}/64；这是像素哈希指标，不是模型置信度或语义相似度。", percent(item.getDouble("hashSimilarityPercent")), item.getInt("hashDistance")), 14f)
                    text(details, measurements(item), 13f).setTextIsSelectable(true)
                    text(details, MoteI18n.text("处理后基准图 · 上一次保留的非重复帧\n{0}", time(item.getString("referenceCapturedAt"))), 15f)
                    text(details, MoteI18n.text("被去重图片 · 本次未进入图片上传队列\n{0}", time(item.getString("capturedAt"))), 15f)
                    text(details, MoteI18n.text("处理后图片：{0} × {1} px\n去重采样：{2} × {3} px\n缩略比较网格：32 × 32；区块：8 × 8。", item.getInt("width"), item.getInt("height"), item.getInt("sampleWidth"), item.getInt("sampleHeight")), 12f)
                    MoteUi.styleTree(content)
                }.onFailure { decoded.forEach { it.recycle() }; text(content, MoteI18n.text("图片已过期、已删除或暂时无法读取。请关闭后刷新列表。"), 14f) }
            }
        }
    }
    private fun measurements(item: JSONObject): String {
        val limit = item.getJSONObject("thresholds")
        return MoteI18n.text("哈希距离：{0} / 阈值 {1}\n", item.getInt("hashDistance"), limit.getInt("maxHashDistance")) +
            MoteI18n.text("缩略图变化像素：{0} / 阈值 {1}\n", percent(item.getDouble("changedPixelRatio") * 100), percent(limit.getDouble("maxChangedPixelRatio") * 100)) +
            MoteI18n.text("变化区块：{0} / 阈值 {1}\n", item.getInt("changedBlocks"), limit.getInt("maxChangedBlocks")) +
            MoteI18n.text("变化行 / 列：{0} / {1}；各自阈值 {2}", item.getInt("changedRows"), item.getInt("changedCols"), limit.getInt("maxChangedRowsCols")) +
            (if (item.getString("reason") == "exact_match") MoteI18n.text("\n本次由像素哈希一致直接命中，未进入近似阈值判断。") else "") +
            MoteI18n.text("\n基准采集 ID：{0}\n本次采集 ID：{1}", item.getString("referenceCaptureId"), item.getString("captureId")) +
            item.optString("appId").takeIf { it.isNotBlank() }?.let { MoteI18n.text("\n应用：{0}", it) }.orEmpty()
    }
    private fun image(parent: LinearLayout, bitmap: Bitmap, label: String) {
        parent.addView(ImageView(this).apply {
            setImageBitmap(bitmap); scaleType = ImageView.ScaleType.FIT_CENTER; contentDescription = label
            setOnClickListener {
                zoomDialog?.dismiss()
                val image = BulkDedupeImageView(this@ImageDedupeDiagnosticsActivity).apply { setImageBitmap(bitmap); contentDescription = label }
                zoomDialog = MoteDialogBuilder(this@ImageDedupeDiagnosticsActivity).setTitle(label).setView(image)
                    .setPositiveButton(MoteI18n.text("关闭"), null).create().also { dialog ->
                        dialog.show(); dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                        image.layoutParams = image.layoutParams.apply { height = (resources.displayMetrics.heightPixels * .65).toInt() }
                    }
            }
        }, LinearLayout.LayoutParams(-1, moteDp(200)))
    }
    private fun text(parent: LinearLayout, value: String, size: Float) = TextView(this).apply { text = value; textSize = size; setPadding(0, moteDp(8), 0, moteDp(8)) }.also(parent::addView)
    private fun button(parent: LinearLayout, label: String, action: () -> Unit) = MoteUi.button(Button(this).apply { text = label; isAllCaps = false; setOnClickListener { action() } }).also(parent::addView)
    private fun percent(value: Double) = String.format(Locale.ROOT, "%.2f%%", value)
    private fun time(value: String) = runCatching { DateFormat.getDateTimeInstance(DateFormat.DEFAULT, DateFormat.DEFAULT, MoteI18n.locale()).format(Date.from(Instant.parse(value))) }.getOrDefault(value)
    override fun onPause() { currentDialog?.dismiss(); super.onPause() }
    override fun onDestroy() { revision++; currentDialog?.dismiss(); executor.shutdown(); super.onDestroy() }
}
