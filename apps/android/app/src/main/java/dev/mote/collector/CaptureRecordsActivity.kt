package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.graphics.Bitmap
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.*
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors

class CaptureRecordsActivity : Activity() {
    private lateinit var body: LinearLayout
    private lateinit var list: LinearLayout
    private lateinit var status: TextView
    private lateinit var dateButton: Button
    private lateinit var previousPage: Button
    private lateinit var nextPage: Button
    private lateinit var nextDay: Button
    private val executor = Executors.newSingleThreadExecutor()
    private val bitmaps = mutableListOf<Bitmap>()
    private val cursors = mutableListOf<String?>(null)
    private var nextCursor: String? = null
    private var date = LocalDate.now()
    private var central = false
    @Volatile private var generation = 0
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        date = savedInstanceState?.getString("date")?.let(LocalDate::parse) ?: date
        central = savedInstanceState?.getBoolean("central") ?: false
        body = moteDetailPage()
        text(body, "采集记录", 27f)
        text(body, "查看本机待同步、待识别图片，或此设备已同步到中央归档的记录。", 14f)
        val source = Spinner(this).apply {
            adapter = ArrayAdapter(this@CaptureRecordsActivity, android.R.layout.simple_spinner_dropdown_item, listOf("本机记录", "中央归档"))
            setSelection(if (central) 1 else 0)
        }; body.addView(source)
        source.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (central != (position == 1)) { central = position == 1; reload() }
            }
        }
        val days = row(body)
        button(days, "前一天") { date = date.minusDays(1); reload() }
        dateButton = button(days, "选择日期") {
            DatePickerDialog(this, { _, year, month, day -> date = LocalDate.of(year, month + 1, day); reload() }, date.year, date.monthValue - 1, date.dayOfMonth)
                .apply { datePicker.maxDate = System.currentTimeMillis() }.show()
        }
        nextDay = button(days, "后一天") { date = date.plusDays(1); reload() }
        status = text(body, "正在读取…", 14f)
        button(body, "刷新") { reload() }
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(list)
        val pages = row(body)
        previousPage = button(pages, "上一页") { if (cursors.size > 1) { cursors.removeAt(cursors.lastIndex); load() } }
        nextPage = button(pages, "下一页") { nextCursor?.let { cursors.add(it); load() } }
        MoteUi.styleTree(body)
        load()
    }
    private fun reload() { cursors.clear(); cursors.add(null); load() }
    private fun load() {
        val stamp = ++generation; val remote = central
        val zone = ZoneId.systemDefault(); val after = date.atStartOfDay(zone).toInstant().toString(); val before = date.plusDays(1).atStartOfDay(zone).toInstant().toString()
        val cursor = cursors.last(); val pageNumber = cursors.size
        dateButton.text = date.toString(); nextDay.isEnabled = date < LocalDate.now()
        previousPage.isEnabled = false; nextPage.isEnabled = false; status.text = "正在读取${if (remote) "中央归档" else "本机记录"}…"
        clearList()
        executor.execute {
            try {
                val settings = Settings(this); val config = settings.read()
                if (remote && !config.hasSyncConnection()) error("请先在连接与同步中配置中央节点")
                val client = if (remote) CaptureRecordClient(config, settings.deviceId) else null
                val page = client?.page(after, before, cursor) ?: queue().screenPage(after, before, cursor)
                val items = page.getJSONArray("items")
                val records = (0 until items.length()).map { items.getJSONObject(it).also { item -> java.util.UUID.fromString(item.getString("id")); Instant.parse(item.getString("capturedAt")) } }
                val total = page.getInt("totalCount")
                val next = if (page.isNull("nextCursor")) null else page.getString("nextCursor").takeIf(String::isNotBlank)
                val images = mutableListOf<Pair<JSONObject, ImageView>>()
                runOnUiThread {
                    if (isDestroyed || stamp != generation) return@runOnUiThread
                    nextCursor = next
                    status.text = "${if (remote) "中央归档" else "本机记录"} · 当天 $total 条 · 第 $pageNumber 页 · 正在加载缩略图（0/${records.size}）"
                    if (records.isEmpty()) text(list, if (remote) "当天没有此设备的中央截图记录。" else "当天没有本机截图。已同步且完成 OCR 的图片可在中央归档查看。", 14f)
                    for (item in records) {
                        images += item to recordRow(item, remote, client, stamp)
                    }
                    previousPage.isEnabled = cursors.size > 1; nextPage.isEnabled = nextCursor != null
                    executor.execute {
                        var loaded = 0
                        for ((item, image) in images) {
                            if (stamp != generation || isDestroyed) break
                            if (!item.optBoolean("hasImage")) continue
                            val bitmap = runCatching {
                                val bytes = client?.image(item.getString("id"), true) ?: queue().image(item.getString("id"))
                                bytes?.let { CapturePreview.decode(it, 256) }
                            }.getOrNull()
                            runOnUiThread {
                                if (isDestroyed || stamp != generation) { bitmap?.recycle(); return@runOnUiThread }
                                if (bitmap != null) { bitmaps += bitmap; image.setImageBitmap(bitmap) }
                                else image.contentDescription = "缩略图暂不可用，点按查看详情或刷新"
                                loaded += 1
                                status.text = "${if (remote) "中央归档" else "本机记录"} · 当天 $total 条 · 第 $pageNumber 页 · 缩略图 ${loaded}/${images.size}"
                            }
                        }
                    }
                }
            } catch (error: Exception) {
                runOnUiThread { if (!isDestroyed && stamp == generation) { status.text = errorMessage(error, remote); previousPage.isEnabled = cursors.size > 1 } }
            }
        }
    }
    private fun recordRow(item: JSONObject, remote: Boolean, client: CaptureRecordClient?, stamp: Int): ImageView {
        val row = row(list).apply {
            tag = "capture:${item.getString("id")}"
            gravity = Gravity.CENTER_VERTICAL; background = MoteUi.clickable(this@CaptureRecordsActivity)
            setPadding(moteDp(12), moteDp(12), moteDp(12), moteDp(12)); isFocusable = true
            setOnClickListener { detail(item.getString("id"), remote, client, stamp) }
        }
        val image = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_INSIDE; contentDescription = "采集图片缩略图"; setImageDrawable(MoteNavigationIcon(this@CaptureRecordsActivity, "capture", true)) }
        row.addView(image, LinearLayout.LayoutParams(moteDp(88), moteDp(88)))
        val labels = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(12), 0, 0, 0) }
        row.addView(labels, LinearLayout.LayoutParams(0, -2, 1f))
        text(labels, "${time(item.getString("capturedAt"))} · ${item.optString("appName").ifBlank { item.optString("appId").ifBlank { "桌面 / 系统画面" } }}", 15f)
        text(labels, CapturePreview.ocrLabel(item), 12f)
        if (!remote) text(labels, when (item.optString("syncError")) { "archive_missing" -> "中央记录不可更新 · 本机图片已保留"; "ocr_conflict" -> "OCR 更新冲突 · 本机图片和文字已保留"; else -> if (item.optBoolean("uploaded")) "图片已同步 · 本机保留待更新 OCR" else "保存在本机 · 待同步" }, 12f)
        item.optString("textPreview").takeIf(String::isNotBlank)?.let { text(labels, it.take(100), 12f) }
        return image
    }
    private fun detail(id: String, remote: Boolean, client: CaptureRecordClient?, stamp: Int) {
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(18), moteDp(10), moteDp(18), moteDp(16)) }
        val message = text(content, "正在读取详情…", 14f)
        val dialog = AlertDialog.Builder(this).setTitle("采集记录").setView(ScrollView(this).apply { addView(content) }).setPositiveButton("关闭", null).create()
        var detailBitmap: Bitmap? = null
        dialog.setOnDismissListener { content.removeAllViews(); detailBitmap?.recycle(); detailBitmap = null }
        dialog.show(); dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        executor.execute {
            try {
                val record = client?.detail(id) ?: queue().capture(id) ?: error("本机图片已同步并清理，请切换到中央归档查看")
                require(record.getString("id") == id); Instant.parse(record.getString("capturedAt"))
                val bytes = if (record.optBoolean("hasImage", record.has("imagePath") || record.has("imageMime"))) client?.image(id, false) ?: queue().image(id) else null
                val bitmap = bytes?.let { CapturePreview.decode(it, 1600) }
                runOnUiThread {
                    if (isDestroyed || stamp != generation || !dialog.isShowing) { bitmap?.recycle(); if (dialog.isShowing) dialog.dismiss(); return@runOnUiThread }
                    content.removeAllViews(); detailBitmap = bitmap
                    text(content, "${time(record.getString("capturedAt"))} · ${if (remote) "中央归档" else "本机记录"}", 15f)
                    text(content, record.optString("appName").ifBlank { record.optString("appId").ifBlank { "桌面 / 系统画面" } }, 15f)
                    text(content, CapturePreview.ocrLabel(record), 14f)
                    if (bitmap != null) content.addView(ImageView(this).apply { setImageBitmap(bitmap); adjustViewBounds = true; scaleType = ImageView.ScaleType.FIT_CENTER; contentDescription = "采集图片" }, LinearLayout.LayoutParams(-1, -2))
                    else text(content, "图片暂不可用。", 14f)
                    text(content, "识别文字", 17f)
                    text(content, record.optString("ocrText").ifBlank { if (record.optJSONObject("ocr")?.optString("status") == "completed") "此图片未识别到文字。" else "暂无识别文字。" }, 14f).setTextIsSelectable(true)
                }
            } catch (error: Exception) { runOnUiThread { if (!isDestroyed && dialog.isShowing) message.text = errorMessage(error, remote) } }
        }
    }
    private fun errorMessage(error: Exception, remote: Boolean): String = if (error is IllegalStateException || error is IllegalArgumentException) error.message ?: "记录读取失败，请刷新重试" else if (remote) "中央记录暂不可读取，请检查网络后重试" else "本机记录暂不可读取，请刷新重试；文件已保留"
    private fun time(at: String): String = runCatching { DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.systemDefault()).format(Instant.parse(at)) }.getOrDefault(at)
    private fun row(parent: LinearLayout) = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }.also { parent.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(10) }) }
    private fun text(parent: LinearLayout, value: String, size: Float) = TextView(this).apply { text = value; textSize = size; setTextColor(MoteUi.ink); setLineSpacing(moteDp(3).toFloat(), 1f); setPadding(0, moteDp(5), 0, moteDp(5)) }.also(parent::addView)
    private fun button(parent: LinearLayout, label: String, action: () -> Unit) = MoteUi.button(Button(this).apply { text = label; setOnClickListener { action() } }).also { parent.addView(it, if (parent.orientation == LinearLayout.HORIZONTAL) LinearLayout.LayoutParams(0, -2, 1f) else LinearLayout.LayoutParams(-1, -2)) }
    private fun clearList() { list.removeAllViews(); bitmaps.forEach(Bitmap::recycle); bitmaps.clear() }
    override fun onSaveInstanceState(outState: Bundle) { outState.putString("date", date.toString()); outState.putBoolean("central", central); super.onSaveInstanceState(outState) }
    override fun onDestroy() { generation++; executor.shutdown(); clearList(); super.onDestroy() }
}
