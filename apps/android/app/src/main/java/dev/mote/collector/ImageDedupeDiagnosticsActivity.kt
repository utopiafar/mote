package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Bitmap
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import org.json.JSONObject
import java.text.DateFormat
import java.time.Instant
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/** Local-only inspection of opt-in, privacy-filtered duplicate/reference pairs. */
class ImageDedupeDiagnosticsActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var body: LinearLayout
    private lateinit var list: LinearLayout
    private lateinit var status: TextView
    private lateinit var clear: Button
    private lateinit var refresh: Button
    private var revision = 0
    private var currentDialog: AlertDialog? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        body = moteDetailPage()
        text(body, "图片去重诊断", 27f)
        text(body, "仅保留开启诊断后命中的图片对。图片已完成隐私检查和遮罩，仅在本机保存，不会同步。", 14f)
        text(body, "最多 20 组、32 MiB，保存期限 24 小时。读取时清理过期记录；系统休眠可能延后后台清理。关闭诊断后清空。", 12f)
        status = text(body, "正在读取…", 14f)
        refresh = button(body, "刷新诊断") { load() }
        clear = button(body, "清空全部诊断图片") { mutate { imageDedupeDiagnostics().clear() } }
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(list)
        MoteUi.styleTree(body)
    }
    override fun onResume() { super.onResume(); if (::list.isInitialized) load() }
    private fun load() {
        val stamp = ++revision; clear.isEnabled = false; refresh.isEnabled = false
        list.removeAllViews(); status.text = "正在读取…"
        executor.execute {
            val result = runCatching { imageDedupeDiagnostics().list() to Settings(applicationContext).read().imageDedupeDiagnosticsEnabled }
            runOnUiThread {
                if (isDestroyed || isFinishing || stamp != revision) return@runOnUiThread
                refresh.isEnabled = true
                result.onSuccess { (rows, enabled) ->
                    clear.isEnabled = rows.isNotEmpty()
                    status.text = if (enabled) "本机保留 ${rows.size} 组去重诊断" else "诊断已关闭，临时图片已清空。可在开发者选项中开启。"
                    if (rows.isEmpty()) text(list, "暂无图片对。开启后，下一次采集到重复画面时会在这里显示。", 14f)
                    rows.forEach { item ->
                        button(list, "${time(item.optString("capturedAt"))} · ${ImageDedupeDiagnosticsDetails.modeName(item.optString("mode"))}\n哈希相似度 ${percent(item.optDouble("hashSimilarityPercent"))}\n${ImageDedupeDiagnosticsDetails.reason(item)}") { detail(item.getString("id")) }
                            .tag = "dedupe:${item.getString("id")}"
                    }
                }.onFailure { status.text = "诊断读取失败，请重试。采集队列不受影响。" }
            }
        }
    }
    private fun mutate(action: () -> Unit) {
        ++revision; currentDialog?.dismiss(); clear.isEnabled = false; refresh.isEnabled = false
        status.text = "正在删除临时图片…"
        executor.execute {
            val result = runCatching(action)
            runOnUiThread {
                if (isDestroyed || isFinishing) return@runOnUiThread
                if (result.isSuccess) load() else { refresh.isEnabled = true; clear.isEnabled = true; status.text = "临时图片删除失败，请重试。" }
            }
        }
    }
    private fun detail(id: String) {
        currentDialog?.dismiss()
        val stamp = revision
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(16), moteDp(8), moteDp(16), moteDp(12)) }
        text(content, "正在读取图片对…", 14f)
        val bitmaps = mutableListOf<Bitmap>()
        val dialog = AlertDialog.Builder(this).setTitle("去重图片对")
            .setView(ScrollView(this).apply { addView(content) })
            .setNegativeButton("关闭", null).setPositiveButton("删除这组图片") { _, _ -> mutate { imageDedupeDiagnostics().delete(id) } }.create()
        currentDialog = dialog
        dialog.setOnDismissListener { content.removeAllViews(); bitmaps.forEach { it.recycle() }; bitmaps.clear(); if (currentDialog === dialog) currentDialog = null }
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
                    text(content, "档位：${ImageDedupeDiagnosticsDetails.modeName(item.getString("mode"))}\n依据：${ImageDedupeDiagnosticsDetails.reason(item)}", 15f)
                    text(content, "哈希相似度 ${percent(item.getDouble("hashSimilarityPercent"))}\n计算：1 − ${item.getInt("hashDistance")}/64；这是像素哈希指标，不是模型置信度或语义相似度。", 14f)
                    text(content, measurements(item), 13f).setTextIsSelectable(true)
                    text(content, "处理后基准图 · 上一次保留的非重复帧\n${time(item.getString("referenceCapturedAt"))}", 15f)
                    image(content, decoded[0], "处理后基准图")
                    text(content, "被去重图片 · 本次未进入图片上传队列\n${time(item.getString("capturedAt"))}", 15f)
                    image(content, decoded[1], "被去重图片")
                    text(content, "处理后图片：${item.getInt("width")} × ${item.getInt("height")} px\n去重采样：${item.getInt("sampleWidth")} × ${item.getInt("sampleHeight")} px\n缩略比较网格：32 × 32；区块：8 × 8。", 12f)
                    MoteUi.styleTree(content)
                }.onFailure { decoded.forEach { it.recycle() }; text(content, "图片已过期、已删除或暂时无法读取。请关闭后刷新列表。", 14f) }
            }
        }
    }
    private fun measurements(item: JSONObject): String {
        val limit = item.getJSONObject("thresholds")
        return "哈希距离：${item.getInt("hashDistance")} / 阈值 ${limit.getInt("maxHashDistance")}\n" +
            "缩略图变化像素：${percent(item.getDouble("changedPixelRatio") * 100)} / 阈值 ${percent(limit.getDouble("maxChangedPixelRatio") * 100)}\n" +
            "变化区块：${item.getInt("changedBlocks")} / 阈值 ${limit.getInt("maxChangedBlocks")}\n" +
            "变化行 / 列：${item.getInt("changedRows")} / ${item.getInt("changedCols")}；各自阈值 ${limit.getInt("maxChangedRowsCols")}" +
            (if (item.getString("reason") == "exact_match") "\n本次由像素哈希一致直接命中，未进入近似阈值判断。" else "") +
            "\n基准采集 ID：${item.getString("referenceCaptureId")}\n本次采集 ID：${item.getString("captureId")}" +
            item.optString("appId").takeIf { it.isNotBlank() }?.let { "\n应用：$it" }.orEmpty()
    }
    private fun image(parent: LinearLayout, bitmap: Bitmap, label: String) {
        parent.addView(ImageView(this).apply { setImageBitmap(bitmap); adjustViewBounds = true; scaleType = ImageView.ScaleType.FIT_CENTER; contentDescription = label }, LinearLayout.LayoutParams(-1, -2))
    }
    private fun text(parent: LinearLayout, value: String, size: Float) = TextView(this).apply { text = value; textSize = size; setPadding(0, moteDp(8), 0, moteDp(8)) }.also(parent::addView)
    private fun button(parent: LinearLayout, label: String, action: () -> Unit) = MoteUi.button(Button(this).apply { text = label; isAllCaps = false; setOnClickListener { action() } }).also(parent::addView)
    private fun percent(value: Double) = String.format(Locale.ROOT, "%.2f%%", value)
    private fun time(value: String) = runCatching { DateFormat.getDateTimeInstance().format(Date.from(Instant.parse(value))) }.getOrDefault(value)
    override fun onPause() { currentDialog?.dismiss(); super.onPause() }
    override fun onDestroy() { revision++; currentDialog?.dismiss(); executor.shutdown(); super.onDestroy() }
}
