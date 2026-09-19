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

class CaptureRecordsActivity : MoteActivity() {
    private lateinit var body: LinearLayout
    private lateinit var list: LinearLayout
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private val detailExecutor = Executors.newSingleThreadExecutor()
    private lateinit var dateButton: Button
    private lateinit var previousPage: Button
    private lateinit var nextPage: Button
    private lateinit var nextDay: Button
    private val executor = java.util.concurrent.ThreadPoolExecutor(1, 1, 0L, java.util.concurrent.TimeUnit.MILLISECONDS, java.util.concurrent.LinkedBlockingQueue<Runnable>())
    private val imageExecutor = java.util.concurrent.ThreadPoolExecutor(3, 3, 0L, java.util.concurrent.TimeUnit.MILLISECONDS, java.util.concurrent.LinkedBlockingQueue<Runnable>())
    private val thumbnailWriter = java.util.concurrent.ThreadPoolExecutor(1, 1, 0L, java.util.concurrent.TimeUnit.MILLISECONDS, java.util.concurrent.LinkedBlockingQueue<Runnable>())
    // Bound decoded bitmap memory independently of the file-backed thumbnail cache.
    private val thumbnails = object : android.util.LruCache<String, Bitmap>(12 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
    }
    private var cacheConfig: CollectorConfig? = null
    private var grid = true
    private var album: JSONObject? = null
    private var albumCursors = listOf<String?>(null)
    private lateinit var backToAlbums: Button
    private val cursors = mutableListOf<String?>(null)
    private var nextCursor: String? = null
    private var date = LocalDate.now()
    private var central = false
    private var localStateJob: kotlinx.coroutines.Job? = null
    private var lastRecordsRevision = -1L
    private var metadataLoading = false
    private var refreshAfterLoad = false
    private var renderedPage: String? = null
    private val recordSources = listOf("screen", "media", "notification", "device_event", "note", "activity", "ui_page")
    private var recordSource = "screen"
    private var sessionGrouping = true
    @Volatile private var generation = 0
    @Volatile private var loadGeneration = 0
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (android.os.Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { navigateBack() }
        date = savedInstanceState?.getString("date")?.let(LocalDate::parse) ?: date
        central = savedInstanceState?.getBoolean("central") ?: false
        album = savedInstanceState?.getString("album")?.let(::JSONObject)
        recordSource = savedInstanceState?.getString("recordSource")?.takeIf { it in recordSources } ?: "screen"
        sessionGrouping = savedInstanceState?.getBoolean("sessionGrouping", true) ?: true
        grid = savedInstanceState?.getBoolean("grid", true) ?: true
        body = moteDetailPage { navigateBack() }
        text(body, MoteI18n.text("采集记录"), 27f)
        text(body, MoteI18n.text("截图支持按连续 Session 或 App 分组，点开查看图片。"), 14f)
        val source = Spinner(this).apply {
            adapter = ArrayAdapter(this@CaptureRecordsActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("本机记录"), MoteI18n.text("中央归档")))
            setSelection(if (central) 1 else 0)
        }; body.addView(source)
        source.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (central != (position == 1)) { central = position == 1; reload() }
            }
        }
        val kinds = Spinner(this).apply {
            adapter = ArrayAdapter(this@CaptureRecordsActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("截图"), MoteI18n.text("媒体播放状态"), MoteI18n.text("通知事件"), MoteI18n.text("设备事件"), MoteI18n.text("随手记"), MoteI18n.text("应用活动"), MoteI18n.text("页面内容采集")))
            setSelection(recordSources.indexOf(recordSource))
        }; body.addView(kinds)
        kinds.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val chosen = recordSources[position]
                if (recordSource != chosen) { recordSource = chosen; reload() }
            }
        }
        val grouping = Spinner(this).apply {
            adapter = ArrayAdapter(this@CaptureRecordsActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("按 Session · 连续记录"), MoteI18n.text("按 App · 每 15 分钟")))
            setSelection(if (sessionGrouping) 0 else 1)
        }; body.addView(grouping)
        grouping.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (sessionGrouping != (position == 0)) { sessionGrouping = position == 0; reload() }
            }
        }
        val layout = Switch(this).apply { text = MoteI18n.text("缩略图视图"); isChecked = grid; setOnCheckedChangeListener { _, checked -> grid = checked; load() } }; body.addView(layout)
        backToAlbums = button(body, MoteI18n.text("‹ 返回分组")) { closeAlbum() }.apply { visibility = View.GONE }
        val days = row(body)
        button(days, MoteI18n.text("前一天")) { date = date.minusDays(1); reload() }
        dateButton = button(days, MoteI18n.text("选择日期")) {
            DatePickerDialog(this, { _, year, month, day -> date = LocalDate.of(year, month + 1, day); reload() }, date.year, date.monthValue - 1, date.dayOfMonth)
                .apply { datePicker.maxDate = System.currentTimeMillis() }.show()
        }
        nextDay = button(days, MoteI18n.text("后一天")) { date = date.plusDays(1); reload() }
        status = text(body, MoteI18n.text("正在读取…"), 14f)
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { isIndeterminate = true }; body.addView(progress)
        button(body, MoteI18n.text("刷新")) { reload() }
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(list)
        val pages = row(body)
        previousPage = button(pages, MoteI18n.text("上一页")) { if (cursors.size > 1) { cursors.removeAt(cursors.lastIndex); load() } }
        nextPage = button(pages, MoteI18n.text("下一页")) { nextCursor?.let { cursors.add(it); load() } }
        MoteUi.styleTree(body)
        load()
        intent.getStringExtra("recordId")?.let { detail(it, false, null, generation) }
    }
    override fun onResume() {
        super.onResume()
        localStateJob = observeLocalState { snapshot ->
            if (snapshot.revision.records != lastRecordsRevision) {
                if (!central && snapshot.active != null && snapshot.error == null) {
                    lastRecordsRevision = snapshot.revision.records
                    if (metadataLoading) refreshAfterLoad = true else load(backgroundRefresh = true)
                }
            }
        }
    }
    override fun onPause() { localStateJob?.cancel(); localStateJob = null; super.onPause() }
    private fun reload() { album = null; cursors.clear(); cursors.add(null); load() }
    private fun closeAlbum() { album = null; cursors.clear(); cursors.addAll(albumCursors); load() }
    private fun navigateBack() { if (album != null) closeAlbum() else finish() }
    // API 33+ uses the native dispatcher above; keep the API 29–32 fallback.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Deprecated("Native Activity back navigation")
    override fun onBackPressed() = navigateBack()
    private fun load(backgroundRefresh: Boolean = false) {
        metadataLoading = true
        val scroll = body.parent as? ScrollView
        val scrollY = scroll?.scrollY ?: 0
        val request = ++loadGeneration; val remote = central; val source = recordSource; val selected = album; val sessions = sessionGrouping
        if (!backgroundRefresh) { generation++; renderedPage = null }
        backToAlbums.visibility = if (selected != null) View.VISIBLE else View.GONE
        if (!backgroundRefresh) { progress.visibility = View.VISIBLE; progress.isIndeterminate = true }
        val zone = ZoneId.systemDefault(); val after = date.atStartOfDay(zone).toInstant().toString(); val before = date.plusDays(1).atStartOfDay(zone).toInstant().toString()
        val cursor = cursors.last(); val pageNumber = cursors.size
        dateButton.text = date.toString(); nextDay.isEnabled = date < LocalDate.now()
        if (!backgroundRefresh) {
            previousPage.isEnabled = false; nextPage.isEnabled = false; status.text = MoteI18n.text("正在读取{0}…", if (remote) MoteI18n.text("中央归档") else MoteI18n.text("本机记录"))
            clearList(); imageExecutor.queue.clear(); thumbnailWriter.queue.clear()
        }
        if (!backgroundRefresh && selected != null) repeat(3) {
            val placeholders = row(list)
            repeat(2) { text(placeholders, MoteI18n.text("加载预览…"), 13f).apply {
                layoutParams = LinearLayout.LayoutParams(0, moteDp(188), 1f).apply { marginEnd = moteDp(6) }
                gravity = Gravity.CENTER; setBackgroundColor(0xffeeeeee.toInt())
            } }
        } else if (!backgroundRefresh) repeat(6) { text(list, MoteI18n.text("正在读取 App 与时间…"), 15f).apply {
            minHeight = moteDp(88); gravity = Gravity.CENTER_VERTICAL; setBackgroundColor(0xffeeeeee.toInt())
        } }
        executor.queue.clear() // Switching dates/pages keeps only the newest pending query.
        executor.execute {
            try {
                if (request != loadGeneration) return@execute
                val settings = Settings(this); val config = settings.read()
                if (remote && !config.hasSyncConnection()) error(MoteI18n.text("请先在连接与同步中配置中央节点"))
                val client = if (remote) CaptureRecordClient(config, settings.deviceId) else null
                val page = if (source == "screen" && sessions) {
                    client?.sessions(after, before, cursor, selected?.getString("id")) ?: queue().sessionPage(after, before, cursor, selected?.getString("id"))
                } else if (source == "screen" && selected == null) {
                    client?.albums(after, before, cursor) ?: queue().albumPage(after, before, cursor)
                } else if (source == "screen" && selected != null) {
                    val start = maxOf(Instant.parse(after), Instant.parse(selected.getString("after"))).toString()
                    val end = minOf(Instant.parse(before), Instant.parse(selected.getString("before"))).toString()
                    val appId = selected.getString("appId")
                    client?.albumImages(start, end, appId, cursor) ?: queue().albumImages(start, end, appId, cursor)
                } else client?.page(after, before, cursor, source) ?: queue().capturePage(after, before, cursor, source = source)
                val items = page.getJSONArray("items")
                val records = (0 until items.length()).map { items.getJSONObject(it).also { item -> java.util.UUID.fromString(item.getString("id")); Instant.parse(item.getString("capturedAt")) } }
                val total = page.getInt("totalCount")
                val next = if (page.isNull("nextCursor")) null else page.getString("nextCursor").takeIf(String::isNotBlank)
                val images = mutableListOf<Pair<JSONObject, ImageView>>()
                runOnUiThread {
                    if (isDestroyed || request != loadGeneration) return@runOnUiThread
                    val fingerprint = page.toString()
                    // Inventory/OCR changes outside this page must not discard existing
                    // views, cancel previews or restart thumbnail decryption.
                    if (backgroundRefresh && renderedPage == fingerprint && cacheConfig == config) return@runOnUiThread
                    val stamp = if (backgroundRefresh) ++generation else generation
                    imageExecutor.queue.clear(); thumbnailWriter.queue.clear()
                    renderedPage = fingerprint
                    if (backgroundRefresh && records.isEmpty() && cursors.size > 1) {
                        cursors.removeAt(cursors.lastIndex); load(backgroundRefresh = true); return@runOnUiThread
                    }
                    clearList()
                    if (backgroundRefresh) list.post { if (!isDestroyed && stamp == generation) scroll?.scrollTo(0, scrollY) }
                    if (cacheConfig != config) { thumbnails.evictAll(); cacheConfig = config }
                    nextCursor = next
                    if (source == "screen" && selected == null) {
                        status.text = MoteI18n.text("{0} · 当天 {1} 条 · {2} 个{3} · 第 {4} 页", if (remote) MoteI18n.text("中央归档") else MoteI18n.text("本机记录"), total, page.getInt(if (sessions) "sessionCount" else "albumCount"), if (sessions) "Session" else MoteI18n.text("相册"), pageNumber)
                        progress.visibility = View.GONE
                        text(list, if (sessions) MoteI18n.text("同应用连续采样归为一段；切换应用或间隔超过 5 分钟分段。仅按本页日期与现存截图分组，起止范围不代表使用时长。") else MoteI18n.text("每 15 分钟按 App 汇集 · 点开查看"), 12f)
                        if (records.isEmpty()) text(list, MoteI18n.text("当天没有截图记录。"), 14f)
                        for (item in records) albumRow(item, stamp)
                        previousPage.isEnabled = cursors.size > 1; nextPage.isEnabled = nextCursor != null
                        return@runOnUiThread
                    }
                    val thumbnailCount = records.count(CapturePreview::hasImage)
                    val pageStatus = MoteI18n.text("{0} · {1} 条 · 第 {2} 页", selected?.optString("appName")?.ifBlank { selected.optString("appId").ifBlank { MoteI18n.text("系统画面") } } ?: if (remote) MoteI18n.text("中央归档") else MoteI18n.text("本机记录"), total, pageNumber)
                    status.text = pageStatus + if (thumbnailCount > 0) MoteI18n.text(" · 正在加载缩略图（0/{0}）", thumbnailCount) else ""
                    if (records.isEmpty()) text(list, if (source != "screen") MoteI18n.text("当天没有此类记录。请开启相应采集来源并授权，记录按同步策略上传。") else if (remote) MoteI18n.text("当天没有此设备的中央截图记录。") else MoteI18n.text("当天没有本机截图。已同步且完成 OCR 的图片可在中央归档查看。"), 14f)
                    progress.isIndeterminate = false; progress.max = maxOf(1, thumbnailCount); progress.progress = 0
                    if (thumbnailCount == 0) progress.visibility = View.GONE
                    var gridRow: LinearLayout? = null
                    for ((index, item) in records.withIndex()) {
                        val useGrid = grid && source == "screen"
                        if (useGrid && index % 2 == 0) gridRow = row(list)
                        val image = recordRow(item, remote, client, stamp, if (useGrid) gridRow!! else list, useGrid)
                        if (CapturePreview.hasImage(item)) images += item to image
                    }
                    if (grid && source == "screen" && records.size % 2 == 1) gridRow?.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
                    previousPage.isEnabled = cursors.size > 1; nextPage.isEnabled = nextCursor != null
                    var loaded = 0; var failed = 0
                    for ((item, image) in images) {
                        val id = item.getString("id")
                        val key = "${if (remote) "remote" else "local"}:$id"
                        val placeholder = (image.parent as FrameLayout).getChildAt(1) as TextView
                        var failedForImage = false
                        fun requestImage(countProgress: Boolean) {
                            placeholder.text = MoteI18n.text("正在加载…"); placeholder.setOnClickListener(null); placeholder.isClickable = false
                            fun display(bitmap: Bitmap?) {
                                if (isDestroyed || stamp != generation) { bitmap?.recycle(); return }
                                if (bitmap != null) {
                                    thumbnails.put(key, bitmap); image.setImageBitmap(bitmap); placeholder.visibility = View.GONE
                                    if (failedForImage) { failed--; failedForImage = false }
                                } else {
                                    if (!failedForImage) { failed++; failedForImage = true }
                                    placeholder.text = MoteI18n.text("加载失败\n点此重试")
                                    placeholder.setOnClickListener { requestImage(false) }
                                }
                                if (countProgress) loaded++
                                progress.progress = loaded
                                if (loaded == images.size) progress.visibility = View.GONE
                                status.text = pageStatus + MoteI18n.text(" · 已处理 {0}/{1}", loaded, images.size) + if (failed > 0) MoteI18n.text(" · {0} 张失败，可点按重试", failed) else ""
                            }
                            // Revisited thumbnails appear immediately, even if old network work is still finishing.
                            thumbnails.get(key)?.let { display(it); return }
                            imageExecutor.execute {
                                if (stamp != generation || isDestroyed) return@execute
                                var thumbnailToSave: Bitmap? = null
                                val bitmap = runCatching {
                                    if (client != null) CapturePreview.decode(client.image(id, true), 320)
                                    else {
                                        val local = queue()
                                        val cached = local.thumbnail(id)
                                        val bitmap = (cached ?: local.image(id))?.let { CapturePreview.decode(it, 320) }
                                        if (cached == null) thumbnailToSave = bitmap
                                        bitmap
                                    }
                                }.getOrNull()
                                // Encode while this worker owns the bitmap; after posting,
                                // the UI may discard/recycle a stale generation immediately.
                                val thumbnailBytes = thumbnailToSave?.takeIf { stamp == generation && !isDestroyed }?.let { preview ->
                                    runCatching {
                                        val output = java.io.ByteArrayOutputStream()
                                        preview.compress(Bitmap.CompressFormat.JPEG, 70, output)
                                        output.toByteArray()
                                    }.getOrNull()
                                }
                                // Display decoded pixels before any cache encryption/fsync.
                                runOnUiThread { display(bitmap) }
                                if (thumbnailBytes != null && !thumbnailWriter.isShutdown) runCatching {
                                    thumbnailWriter.execute {
                                        if (stamp == generation && !isDestroyed) runCatching {
                                            queue().cacheThumbnail(id, thumbnailBytes, config.maxQueueMiB * 1024L * 1024L)
                                        }
                                    }
                                }
                            }
                        }
                        requestImage(true)
                    }
                }
            } catch (error: Exception) {
                runOnUiThread { if (!isDestroyed && request == loadGeneration) {
                    if (!backgroundRefresh) { clearList(); progress.visibility = View.GONE }
                    status.text = errorMessage(error, remote); previousPage.isEnabled = cursors.size > 1
                } }
            } finally {
                runOnUiThread {
                    if (!isDestroyed && request == loadGeneration) {
                        metadataLoading = false
                        if (refreshAfterLoad) { refreshAfterLoad = false; load(backgroundRefresh = true) }
                    }
                }
            }
        }
    }
    private fun albumRow(item: JSONObject, stamp: Int) {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(moteDp(12), moteDp(12), moteDp(12), moteDp(12))
            background = MoteUi.clickable(this@CaptureRecordsActivity); isFocusable = true
            tag = "album:${item.getString("id")}"; setOnClickListener {
                albumCursors = cursors.toList(); album = item; cursors.clear(); cursors.add(null); load()
            }
        }
        list.addView(card, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(8) })
        val icon = ImageView(this).apply { setImageResource(android.R.drawable.sym_def_app_icon); contentDescription = MoteI18n.text("应用图标") }
        card.addView(icon, LinearLayout.LayoutParams(moteDp(40), moteDp(40)))
        val labels = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(14), 0, 0, 0) }
        card.addView(labels, LinearLayout.LayoutParams(0, -2, 1f))
        text(labels, item.optString("appName").ifBlank { item.optString("appId").ifBlank { MoteI18n.text("桌面 / 系统画面") } }, 17f)
        text(labels, MoteI18n.text("{0} – {1} · {2} 条 · {3} 张截图", time(item.getString("firstAt")), time(item.getString("capturedAt")), item.getInt("count"), item.getInt("imageCount")), 13f)
        text(card, "›", 24f)
        val appId = item.optString("appId")
        if (appId.isNotBlank()) imageExecutor.execute {
            if (stamp != generation) return@execute
            val drawable = runCatching { packageManager.getApplicationIcon(appId) }.getOrNull()
            runOnUiThread { if (!isDestroyed && stamp == generation && drawable != null) icon.setImageDrawable(drawable) }
        }
    }
    private fun recordRow(item: JSONObject, remote: Boolean, client: CaptureRecordClient?, stamp: Int, parent: LinearLayout, grid: Boolean): ImageView {
        val row = LinearLayout(this).apply {
            orientation = if (grid) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
            tag = "capture:${item.getString("id")}"
            gravity = Gravity.CENTER_VERTICAL; background = MoteUi.clickable(this@CaptureRecordsActivity)
            setPadding(moteDp(12), moteDp(12), moteDp(12), moteDp(12)); isFocusable = true
            setOnClickListener { detail(item.getString("id"), remote, client, stamp) }
        }
        parent.addView(row, if (grid) LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = moteDp(6) } else LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(10) })
        val preview = FrameLayout(this).apply { setBackgroundColor(0xffeeeeee.toInt()); if (item.optString("source") != "screen") visibility = View.GONE }
        val image = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_INSIDE; contentDescription = MoteI18n.text("采集图片缩略图") }
        preview.addView(image, FrameLayout.LayoutParams(-1, -1))
        preview.addView(TextView(this).apply {
            text = if (CapturePreview.hasImage(item)) MoteI18n.text("正在加载…") else MoteI18n.text("无图片")
            gravity = Gravity.CENTER; textSize = 12f; setTextColor(MoteUi.muted)
        }, FrameLayout.LayoutParams(-1, -1))
        row.addView(preview, LinearLayout.LayoutParams(if (grid) -1 else moteDp(88), moteDp(if (grid) 160 else 88)))
        val labels = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(12), 0, 0, 0) }
        row.addView(labels, if (grid) LinearLayout.LayoutParams(-1, -2) else LinearLayout.LayoutParams(0, -2, 1f))
        text(labels, "${time(item.getString("capturedAt"))} · ${item.optString("appName").ifBlank { item.optString("appId").ifBlank { if (item.optString("source") == "media") MoteI18n.text("媒体会话状态") else if (item.optString("source") == "device_event") MoteI18n.text("设备状态") else MoteI18n.text("桌面 / 系统画面") } }}", 15f)
        text(labels, if (item.optString("source") in SystemEventRules.sources) SystemEventRules.label(item) else if (item.optString("source") == "media") CapturePreview.mediaLabel(item) else CapturePreview.ocrLabel(item), 12f)
        if (!remote) text(labels, when (item.optString("syncError")) { "archive_missing" -> MoteI18n.text("中央记录不可更新 · 本机图片已保留"); "ocr_conflict" -> MoteI18n.text("OCR 更新冲突 · 本机图片和文字已保留"); "upload_conflict" -> MoteI18n.text("记录内容冲突 · 本机副本已保留"); else -> if (item.optBoolean("uploaded")) if (item.optLong("retainedUntil") > 0) MoteI18n.text("已同步 · 本机保留至 {0}", java.time.Instant.ofEpochMilli(item.getLong("retainedUntil")).atZone(java.time.ZoneId.systemDefault()).toLocalDate()) else MoteI18n.text("图片已同步 · 本机保留待更新 OCR") else MoteI18n.text("保存在本机 · 待同步") }, 12f)
        if (item.has("sizeBytes")) text(labels, "${String.format(java.util.Locale.ROOT, "%.1f", item.optLong("sizeBytes") / 1024.0)} KiB", 12f)
        item.optString("textPreview").takeIf(String::isNotBlank)?.let { text(labels, it.take(if (grid) 48 else 100), 12f) }
        return image
    }
    private fun detail(id: String, remote: Boolean, client: CaptureRecordClient?, stamp: Int) {
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(18), moteDp(10), moteDp(18), moteDp(16)) }
        val message = text(content, MoteI18n.text("正在读取详情…"), 14f)
        val loading = ProgressBar(this); content.addView(loading)
        val dialog = MoteDialogBuilder(this).setTitle(MoteI18n.text("采集记录")).setView(ScrollView(this).apply { addView(content) }).setPositiveButton(MoteI18n.text("关闭"), null).create()
        var detailBitmap: Bitmap? = null
        dialog.setOnDismissListener { content.removeAllViews(); detailBitmap?.recycle(); detailBitmap = null }
        dialog.show(); dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        detailExecutor.execute {
            try {
                val record = client?.detail(id) ?: queue().capture(id) ?: error(MoteI18n.text("本机记录已同步并清理，请切换到中央归档查看"))
                runOnUiThread { if (dialog.isShowing && CapturePreview.hasImage(record)) message.text = MoteI18n.text("记录已读取，正在加载图片…") }
                require(record.getString("id") == id); Instant.parse(record.getString("capturedAt"))
                val bytes = if (CapturePreview.hasImage(record)) client?.image(id, false) ?: queue().image(id) else null
                val bitmap = bytes?.let { CapturePreview.decode(it, 1600) }
                runOnUiThread {
                    if (isDestroyed || stamp != generation || !dialog.isShowing) { bitmap?.recycle(); if (dialog.isShowing) dialog.dismiss(); return@runOnUiThread }
                    content.removeAllViews(); detailBitmap = bitmap
                    text(content, "${time(record.getString("capturedAt"))} · ${if (remote) MoteI18n.text("中央归档") else MoteI18n.text("本机记录")}", 15f)
                    text(content, record.optString("appName").ifBlank { record.optString("appId").ifBlank { if (record.optString("source") == "media") MoteI18n.text("媒体会话状态") else if (record.optString("source") == "device_event") MoteI18n.text("设备状态") else MoteI18n.text("桌面 / 系统画面") } }, 15f)
                    if (record.optString("source") in SystemEventRules.sources) {
                        text(content, SystemEventRules.label(record), 14f).setTextIsSelectable(true)
                        text(content, MoteI18n.text("原始系统事件 · 不代表已阅读通知或实际执行某项任务。熄屏不等于锁定。"), 12f)
                        text(content, record.getJSONObject("metadata").toString(2), 12f).setTextIsSelectable(true)
                        return@runOnUiThread
                    }
                    record.optJSONObject("stateSeries")?.optJSONArray("samples")?.let { samples ->
                        text(content, MoteI18n.text("相同状态合并为 {0} 次观察，最近一次：{1}。统计逐次使用实测时长，观察间隙不计为连续使用。", samples.length(), time(samples.getJSONObject(samples.length() - 1).getString("at"))), 13f)
                    }
                    val media = record.optJSONObject("metadata")?.optJSONObject("media")
                    if (record.optString("source") == "media") {
                        text(content, CapturePreview.mediaLabel(record), 14f).setTextIsSelectable(true)
                        text(content, MoteI18n.text("此记录的已观察播放时长：{0} 秒（不含观测缺口）", record.optLong("durationMs") / 1000.0), 13f)
                        media?.optString("observedAt")?.takeIf(String::isNotBlank)?.let { text(content, MoteI18n.text("媒体观察时间：{0}", it), 12f) }
                        return@runOnUiThread
                    }
                    if (media != null) text(content, CapturePreview.mediaLabel(record), 13f)
                    if (record.optString("source") in setOf("note", "activity", "ui_page")) {
                        record.optJSONObject("metadata")?.optJSONObject("uiPage")?.let { text(content, "${it.optString("adapterId")} @ ${it.optString("adapterVersion")} · ${it.optString("status")}", 13f) }
                        text(content, record.optString("ocrText").ifBlank { MoteI18n.text("应用活动 · {0} 毫秒", record.optLong("durationMs")) }, 14f).setTextIsSelectable(true)
                        record.optString("syncError").takeIf(String::isNotBlank)?.let { text(content, MoteI18n.text("同步需要处理：{0}", it), 14f) }
                        return@runOnUiThread
                    }
                    text(content, CapturePreview.ocrLabel(record), 14f)
                    if (bitmap != null) content.addView(ImageView(this).apply { setImageBitmap(bitmap); adjustViewBounds = true; scaleType = ImageView.ScaleType.FIT_CENTER; contentDescription = MoteI18n.text("采集图片") }, LinearLayout.LayoutParams(-1, -2))
                    else text(content, MoteI18n.text("图片暂不可用。"), 14f)
                    text(content, MoteI18n.text("识别文字"), 17f)
                    if (record.optBoolean("centralPreview")) text(content, MoteI18n.text("中央识别预览；完整内容请切换中央记录查看。"), 13f)
                    text(content, record.optString("ocrText").ifBlank { if (record.optJSONObject("ocr")?.optString("status") == "completed") MoteI18n.text("此图片未识别到文字。") else MoteI18n.text("暂无识别文字。") }, 14f).setTextIsSelectable(true)
                }
            } catch (error: Exception) { runOnUiThread { if (!isDestroyed && dialog.isShowing) { loading.visibility = View.GONE; message.text = errorMessage(error, remote) } } }
        }
    }
    private fun errorMessage(error: Exception, remote: Boolean): String = if (error is IllegalStateException || error is IllegalArgumentException) error.message ?: MoteI18n.text("记录读取失败，请刷新重试") else if (remote) MoteI18n.text("中央记录暂不可读取，请检查网络后重试") else MoteI18n.text("本机记录暂不可读取，请刷新重试；文件已保留")
    private fun time(at: String): String = runCatching { DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.systemDefault()).format(Instant.parse(at)) }.getOrDefault(at)
    private fun row(parent: LinearLayout) = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }.also { parent.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(10) }) }
    private fun text(parent: LinearLayout, value: String, size: Float) = TextView(this).apply { text = value; textSize = size; setTextColor(MoteUi.ink); setLineSpacing(moteDp(3).toFloat(), 1f); setPadding(0, moteDp(5), 0, moteDp(5)) }.also(parent::addView)
    private fun button(parent: LinearLayout, label: String, action: () -> Unit) = MoteUi.button(Button(this).apply { text = label; setOnClickListener { action() } }).also { parent.addView(it, if (parent.orientation == LinearLayout.HORIZONTAL) LinearLayout.LayoutParams(0, -2, 1f) else LinearLayout.LayoutParams(-1, -2)) }
    private fun clearList() { list.removeAllViews() }
    override fun onSaveInstanceState(outState: Bundle) { outState.putBoolean("grid", grid); outState.putBoolean("sessionGrouping", sessionGrouping); outState.putString("date", date.toString()); outState.putString("album", album?.toString()); outState.putBoolean("central", central); outState.putString("recordSource", recordSource); super.onSaveInstanceState(outState) }
    override fun onDestroy() { generation++; loadGeneration++; executor.shutdownNow(); imageExecutor.shutdownNow(); thumbnailWriter.shutdown(); detailExecutor.shutdownNow(); clearList(); thumbnails.evictAll(); super.onDestroy() }
}
