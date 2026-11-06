package dev.mote.collector

import android.content.Intent

import android.app.Activity
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.graphics.Bitmap
import android.graphics.Color
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
    private lateinit var recordHeading: TextView
    private var recordDescription = ""
    private lateinit var grouping: Spinner
    private lateinit var layout: Switch
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
    private data class ReaderRequest(val id: String, val remote: Boolean, val version: String? = null)
    private var openReader: ReaderRequest? = null
    private var readerDialog: AlertDialog? = null
    private var readerTeardown = false
    private var readerSequence = 0L
    private var directReaderCleanup: (() -> Unit)? = null
    private var directReaderPaused = false
    private var restoreReaderScroll: Int? = null
    private var citationExcerpt: String? = null
    private var citationScrolled = false
    @Volatile private var generation = 0
    @Volatile private var loadGeneration = 0
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (android.os.Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { navigateBack() }
        restoreReaderScroll = savedInstanceState?.getInt("directReaderScroll")
        citationExcerpt = savedInstanceState?.getString("citationExcerpt") ?: intent.getStringExtra("citationExcerpt")
        date = savedInstanceState?.getString("date")?.let(LocalDate::parse)
            ?: intent.getStringExtra("recordDate")?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: date
        central = savedInstanceState?.getBoolean("central") ?: false
        album = savedInstanceState?.getString("album")?.let(::JSONObject)
        recordSource = (savedInstanceState?.getString("recordSource") ?: intent.getStringExtra("recordSource"))?.takeIf { it in recordSources } ?: "screen"
        sessionGrouping = savedInstanceState?.getBoolean("sessionGrouping", true) ?: true
        grid = savedInstanceState?.getBoolean("grid", true) ?: true
        body = moteDetailPage(title = MoteI18n.text("采集记录")) { navigateBack() }
        recordHeading = window.decorView.findViewWithTag("detail-title")
        val compactFilters = resources.configuration.screenWidthDp < 360 || resources.configuration.fontScale > 1.2f
        val filters = LinearLayout(this).apply { orientation = if (compactFilters) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL }
        body.addView(filters, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(MoteTheme.spaceInline) })
        val source = Spinner(this).apply {
            adapter = MoteUi.choiceAdapter(this@CaptureRecordsActivity, listOf(MoteI18n.text("本机记录"), MoteI18n.text("中央归档")))
            setSelection(if (central) 1 else 0)
        }; filters.addView(source, (if (compactFilters) LinearLayout.LayoutParams(-1, -2) else LinearLayout.LayoutParams(0, -2, 1f)).apply {
            if (compactFilters) bottomMargin = moteDp(MoteTheme.spaceInline) else marginEnd = moteDp(MoteTheme.spaceInline)
        })
        source.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (central != (position == 1)) { central = position == 1; reload() }
            }
        }
        val kinds = Spinner(this).apply {
            adapter = MoteUi.choiceAdapter(this@CaptureRecordsActivity, listOf(MoteI18n.text("截图"), MoteI18n.text("媒体播放状态"), MoteI18n.text("通知事件"), MoteI18n.text("设备事件"), MoteI18n.text("记录"), MoteI18n.text("应用活动"), MoteI18n.text("页面内容采集")))
            setSelection(recordSources.indexOf(recordSource))
        }; filters.addView(kinds, if (compactFilters) LinearLayout.LayoutParams(-1, -2) else LinearLayout.LayoutParams(0, -2, 1f))
        kinds.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val chosen = recordSources[position]
                if (recordSource != chosen) { recordSource = chosen; updateRecordHeading(); reload() }
            }
        }
        grouping = Spinner(this).apply {
            adapter = MoteUi.choiceAdapter(this@CaptureRecordsActivity, listOf(MoteI18n.text("按 Session · 连续记录"), MoteI18n.text("按 App · 每 15 分钟")))
            setSelection(if (sessionGrouping) 0 else 1)
        }; body.addView(grouping)
        grouping.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (sessionGrouping != (position == 0)) { sessionGrouping = position == 0; reload() }
            }
        }
        layout = Switch(this).apply { text = MoteI18n.text("缩略图视图"); isChecked = grid; setOnCheckedChangeListener { _, checked -> grid = checked; load() } }; body.addView(layout)
        backToAlbums = button(body, MoteI18n.text("‹ 返回分组")) { closeAlbum() }.apply { visibility = View.GONE }
        // Long translated labels and scaled text need actual width, not three narrow columns.
        val compactDates = resources.configuration.screenWidthDp < 360 || resources.configuration.fontScale > 1.2f
        val days = if (compactDates) LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL } else row(body)
        val previousDay = button(days, MoteI18n.text("前一天")) { date = date.minusDays(1); reload() }
        dateButton = button(if (compactDates) body else days, MoteI18n.text("选择日期")) {
            DatePickerDialog(this, { _, year, month, day -> date = LocalDate.of(year, month + 1, day); reload() }, date.year, date.monthValue - 1, date.dayOfMonth)
                .apply { datePicker.maxDate = System.currentTimeMillis() }.show()
        }.apply { setSingleLine() }
        nextDay = button(days, MoteI18n.text("后一天")) { date = date.plusDays(1); reload() }
        if (!compactDates) {
            (previousDay.layoutParams as LinearLayout.LayoutParams).marginEnd = moteDp(MoteTheme.spaceInline)
            (dateButton.layoutParams as LinearLayout.LayoutParams).marginEnd = moteDp(MoteTheme.spaceInline)
        }
        if (compactDates) {
            previousDay.layoutParams = LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = moteDp(MoteTheme.spaceInline) }
            body.addView(days, LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(MoteTheme.spaceInline) })
        }
        val stateAndRefresh = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        body.addView(stateAndRefresh, LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(MoteTheme.spaceInline); bottomMargin = moteDp(MoteTheme.spaceInline) })
        status = text(stateAndRefresh, MoteI18n.text("正在读取…"), MoteTheme.fontBody.toFloat()).apply {
            layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
        }
        stateAndRefresh.addView(MoteUi.action(Button(this).apply { text = MoteI18n.text("刷新"); setOnClickListener { reload() } }, MoteUi.ButtonRole.TEXT), LinearLayout.LayoutParams(-2, -2))
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { isIndeterminate = true }; body.addView(progress)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(list)
        val pages = row(body)
        previousPage = button(pages, MoteI18n.text("上一页")) { if (cursors.size > 1) { cursors.removeAt(cursors.lastIndex); load() } }
        nextPage = button(pages, MoteI18n.text("下一页")) { nextCursor?.let { cursors.add(it); load() } }
        body.addView(MoteUi.action(Button(this).apply {
            text = MoteI18n.text("查看记录说明"); setOnClickListener {
                MoteDialogBuilder(this@CaptureRecordsActivity).setTitle(MoteI18n.text("查看记录说明")).setMessage(recordDescription)
                    .setPositiveButton(MoteI18n.text("知道了"), null).show()
            }
        }, MoteUi.ButtonRole.TEXT), LinearLayout.LayoutParams(-1, -2))
        MoteUi.styleTree(body)
        updateRecordHeading()
        if (!intent.getBooleanExtra("directReader",false)) load()
        val reader = if (savedInstanceState == null) intent.getStringExtra("recordId")?.let { ReaderRequest(it, intent.getBooleanExtra("recordRemote", false), intent.getStringExtra("historyOriginalVersion")) }
            else savedInstanceState.getString("readerId")?.let { ReaderRequest(it, savedInstanceState.getBoolean("readerRemote"), savedInstanceState.getString("readerVersion")) }
        reader?.let { detail(it.id, it.remote, null, generation, it.version) }
    }
    private fun updateRecordHeading() {
        val title = when (recordSource) {
            "note" -> "记录"
            "media" -> "媒体播放状态"
            "notification" -> "通知事件"
            "device_event" -> "设备事件"
            "activity" -> "应用活动"
            "ui_page" -> "页面内容采集"
            else -> "采集记录"
        }
        recordHeading.text = MoteI18n.text(title)
        recordDescription = MoteI18n.text(if (recordSource == "screen") "截图支持按连续 Session 或 App 分组，点开查看图片。" else "按日期浏览记录，点开查看原文。")
        grouping.visibility = if (recordSource == "screen") View.VISIBLE else View.GONE
        layout.visibility = if (recordSource == "screen") View.VISIBLE else View.GONE
    }
    override fun onResume() {
        super.onResume()
        if (intent.getBooleanExtra("directReader",false)) {
            if (directReaderPaused) { directReaderPaused=false; openReader?.let { detail(it.id,it.remote,null,generation,it.version) } }
            return
        }
        localStateJob = observeLocalState { snapshot ->
            if (snapshot.revision.records != lastRecordsRevision) {
                if (!central && snapshot.active != null && snapshot.error == null) {
                    lastRecordsRevision = snapshot.revision.records
                    if (metadataLoading) refreshAfterLoad = true else load(backgroundRefresh = true)
                }
            }
        }
    }
    override fun onPause() { directReaderPaused = intent.getBooleanExtra("directReader",false); localStateJob?.cancel(); localStateJob = null; super.onPause() }
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
            repeat(2) { text(placeholders, MoteI18n.text("加载预览…"), MoteTheme.fontSupport.toFloat()).apply {
                layoutParams = LinearLayout.LayoutParams(0, moteDp(188), 1f).apply { marginEnd = moteDp(6) }
                gravity = Gravity.CENTER; MoteUi.backgroundColor(this, NativeColorRole.SURFACE_RAISED)
            } }
        } else if (!backgroundRefresh) repeat(6) { text(list, MoteI18n.text("正在读取 App 与时间…"), MoteTheme.fontBody.toFloat()).apply {
            minHeight = moteDp(88); gravity = Gravity.CENTER_VERTICAL; MoteUi.backgroundColor(this, NativeColorRole.SURFACE_RAISED)
        } }
        executor.queue.clear() // Switching dates/pages keeps only the newest pending query.
        executor.execute {
            try {
                if (request != loadGeneration) return@execute
                val settings = Settings(this); val config = settings.read()
                val owner = if (remote) CentralAccess.resolve(this).client else null
                if (remote && !config.hasSyncConnection() && owner == null) error(MoteI18n.text("先在连接与同步中配置中央"))
                val client = if (remote) CaptureRecordClient(config, settings.deviceId, owner) else null
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
                        text(list, if (sessions) MoteI18n.text("同应用连续采样归为一段；切换应用或间隔超过 5 分钟分段。仅按本页日期与现存截图分组，起止范围不代表使用时长。") else MoteI18n.text("每 15 分钟按 App 汇集 · 点开查看"), MoteTheme.fontMeta.toFloat())
                        if (records.isEmpty()) text(list, MoteI18n.text("当天没有截图记录。"), MoteTheme.fontBody.toFloat())
                        for (item in records) albumRow(item, stamp)
                        previousPage.isEnabled = cursors.size > 1; nextPage.isEnabled = nextCursor != null
                        return@runOnUiThread
                    }
                    val thumbnailCount = records.count(CapturePreview::hasImage)
                    val pageStatus = if (selected == null) MoteI18n.text("{0} 条 · 第 {1} 页", total, pageNumber)
                        else MoteI18n.text("{0} · {1} 条 · 第 {2} 页", selected.optString("appName").ifBlank { selected.optString("appId").ifBlank { MoteI18n.text("系统画面") } }, total, pageNumber)
                    status.text = pageStatus + if (thumbnailCount > 0) MoteI18n.text(" · 正在加载缩略图（0/{0}）", thumbnailCount) else ""
                    if (records.isEmpty()) text(list, when {
                        source == "note" -> MoteI18n.text("当天没有记录。选择其他日期，或添加一条记录。")
                        source != "screen" -> MoteI18n.text("当天没有此类记录。请开启相应采集来源并授权，记录按同步策略上传。")
                        remote -> MoteI18n.text("当天没有此设备的中央截图记录。")
                        else -> MoteI18n.text("当天没有本机截图。已同步且完成 OCR 的图片可在中央归档查看。")
                    }, 14f)
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
                    // Removing a session anchor changes its identity. Return to fresh groups
                    // instead of leaving deleted thumbnails visible in the old selection.
                    if (!remote && error is CaptureSessionChangedException) { reload(); return@runOnUiThread }
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
        text(labels, item.optString("appName").ifBlank { item.optString("appId").ifBlank { MoteI18n.text("桌面 / 系统画面") } }, MoteTheme.fontSection.toFloat())
        text(labels, MoteI18n.text("{0} – {1} · {2} 条 · {3} 张截图", time(item.getString("firstAt")), time(item.getString("capturedAt")), item.getInt("count"), item.getInt("imageCount")), MoteTheme.fontSupport.toFloat())
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
        val preview = FrameLayout(this).apply { MoteUi.backgroundColor(this, NativeColorRole.SURFACE_RAISED); if (item.optString("source") != "screen") visibility = View.GONE }
        val image = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_INSIDE; contentDescription = MoteI18n.text("采集图片缩略图") }
        preview.addView(image, FrameLayout.LayoutParams(-1, -1))
        preview.addView(TextView(this).apply {
            text = if (CapturePreview.hasImage(item)) MoteI18n.text("正在加载…") else MoteI18n.text("无图片")
            gravity = Gravity.CENTER; MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED)
        }, FrameLayout.LayoutParams(-1, -1))
        row.addView(preview, LinearLayout.LayoutParams(if (grid) -1 else moteDp(88), moteDp(if (grid) 160 else 88)))
        val labels = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(12), 0, 0, 0) }
        row.addView(labels, if (grid) LinearLayout.LayoutParams(-1, -2) else LinearLayout.LayoutParams(0, -2, 1f))
        text(labels, "${time(item.getString("capturedAt"))} · ${item.optString("appName").ifBlank { item.optString("appId").ifBlank { if (item.optString("source") == "media") MoteI18n.text("媒体会话状态") else if (item.optString("source") == "device_event") MoteI18n.text("设备状态") else MoteI18n.text("桌面 / 系统画面") } }}", MoteTheme.fontBody.toFloat())
        if (remote || item.optString("source") != "note") text(labels, if (item.optString("source") in SystemEventRules.sources) SystemEventRules.label(item) else if (item.optString("source") == "media") CapturePreview.mediaLabel(item) else CapturePreview.ocrLabel(item, remote), MoteTheme.fontMeta.toFloat())
        if (!remote) text(labels, when (item.optString("syncError")) { "archive_missing" -> MoteI18n.text("中央记录不可更新 · 本机图片已保留"); "ocr_conflict" -> MoteI18n.text("OCR 更新冲突 · 本机图片和文字已保留"); "upload_conflict" -> MoteI18n.text("记录内容冲突 · 本机副本已保留"); else -> if (item.optBoolean("uploaded")) if (item.optLong("retainedUntil") > 0) MoteI18n.text("已同步 · 本机保留至 {0}", java.time.Instant.ofEpochMilli(item.getLong("retainedUntil")).atZone(java.time.ZoneId.systemDefault()).toLocalDate()) else MoteI18n.text("已同步 · 本机副本等待保留期清理") else MoteI18n.text("保存在本机 · 待同步") }, MoteTheme.fontMeta.toFloat())
        if (item.has("sizeBytes")) text(labels, "${String.format(java.util.Locale.ROOT, "%.1f", item.optLong("sizeBytes") / 1024.0)} KiB", MoteTheme.fontMeta.toFloat())
        item.optString("textPreview").takeIf(String::isNotBlank)?.let { text(labels, it.take(if (grid) 48 else 100), MoteTheme.fontMeta.toFloat()) }
        return image
    }
    private fun detail(id: String, remote: Boolean, client: CaptureRecordClient?, stamp: Int, version: String? = null) {
        citationScrolled = false
        directReaderCleanup?.invoke(); directReaderCleanup = null
        readerDialog?.dismiss()
        val readerStamp=++readerSequence
        openReader = ReaderRequest(id, remote, version)
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(18), moteDp(10), moteDp(18), moteDp(16)) }
        val message = text(content, MoteI18n.text("正在读取详情…"), MoteTheme.fontBody.toFloat())
        val loading = ProgressBar(this); content.addView(loading)
        val direct = intent.getBooleanExtra("directReader",false)
        val scrollPosition=restoreReaderScroll ?: (body.parent as? ScrollView)?.scrollY ?: 0
        restoreReaderScroll=null
        val dialog = MoteDialogBuilder(this).setTitle(MoteI18n.text("采集记录")).setView(ScrollView(this).apply { addView(content) }).setPositiveButton(MoteI18n.text("关闭详情"), null).create()
        var detailBitmap: Bitmap? = null
        readerDialog = dialog
        fun clearReader() { content.removeAllViews(); detailBitmap?.recycle(); detailBitmap = null }
        if (direct) directReaderCleanup = ::clearReader
        dialog.setOnDismissListener {
            clearReader()
            if (readerDialog === dialog) {
                readerDialog = null
                if (!readerTeardown) { openReader = null; if (intent.getBooleanExtra("directReader",false)) finish() }
            }
        }
        fun reading() = readerStamp == readerSequence && if (direct) !isFinishing && openReader?.id == id else dialog.isShowing
        fun closeReader() { if (direct) finish() else dialog.dismiss() }
        if (direct) {
            body.removeAllViews(); body.setPadding(moteDp(20),moteDp(24),moteDp(20),moteDp(28))
            recordHeading.text=MoteI18n.text("原文")
            (content.parent as? android.view.ViewGroup)?.removeView(content)
            content.setPadding(0,0,0,0); body.addView(content)
        } else { dialog.show(); dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE) }
        detailExecutor.execute {
            try {
                val selection = if (remote) CentralAccess.resolve(this) else null
                val workMemory=WorkMemoryReference.from(intent)
                if(workMemory!=null) {
                    check(selection!=null && intent.getStringExtra("workMemoryProcess")==WorkMemoryProcess.nonce && intent.hasExtra("workMemoryGeneration") && selection.generation==intent.getLongExtra("workMemoryGeneration",-1)) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
                }
                if (selection != null) {
                    val expected = intent.getStringExtra("recordOrigin").orEmpty()
                    check((workMemory==null && expected.isBlank()) || expected == selection.server) { MoteI18n.text("访问凭据已失效，请重新连接。") }
                    intent.getStringExtra("conversationReference")?.let { conversation -> check(CentralConversationReference.available(requireNotNull(selection.client),conversation,id)) { MoteI18n.text("引用原文已删除，历史问答仍保留。") } }
                    workMemory?.verify(requireNotNull(selection.client),id)
                }
                val readerClient = if (remote && client == null) {
                    val settings = Settings(this)
                    CaptureRecordClient(settings.read().copy(server = requireNotNull(selection).server), settings.deviceId, requireNotNull(selection.client) { MoteI18n.text("先登录中央，各页面会共用这次登录") })
                } else client
                val exact = if (version != null) {
                    check(!remote)
                    queue().captureExactVersion(id, version) ?: error(MoteI18n.text("历史版本不可用：本机原件已更新或清理，不能将当前内容作为这次上传的原文。"))
                } else null
                val record = exact?.first ?: if (remote) requireNotNull(readerClient).detail(id)
                    else queue().capture(id) ?: error(MoteI18n.text("本机记录已同步并清理，请切换到中央归档查看"))
                runOnUiThread { if (reading() && CapturePreview.hasImage(record)) message.text = MoteI18n.text("记录已读取，正在加载图片…") }
                if (remote && intent.getStringExtra("recordDeviceId").orEmpty().isNotBlank())
                    check(record.getString("deviceId") == intent.getStringExtra("recordDeviceId"))
                if (remote && intent.getStringExtra("recordVersion").orEmpty().isNotBlank())
                    check(record.optString("libraryVersion") == intent.getStringExtra("recordVersion")) { MoteI18n.text("分页内容已变化或游标无效，请返回第一页重新读取。") }
                if (remote && intent.hasExtra("recordObservationCount"))
                    check(dev.mote.collector.plugins.NativeLibraryPlugin.observations(record) == intent.getIntExtra("recordObservationCount", -1)) { MoteI18n.text("分页内容已变化或游标无效，请返回第一页重新读取。") }
                require(record.getString("id") == id); Instant.parse(record.getString("capturedAt"))
                val bytes = if (exact != null) exact.second else if (CapturePreview.hasImage(record)) if (remote) requireNotNull(readerClient).image(id, false) else queue().image(id) else null
                if (selection != null && bytes != null && intent.getStringExtra("recordVersion").orEmpty().isNotBlank()) {
                    val afterImage=requireNotNull(readerClient).detail(id)
                    check(afterImage.getString("id") == id && afterImage.optString("libraryVersion") == intent.getStringExtra("recordVersion") && afterImage.getString("deviceId") == record.getString("deviceId") && dev.mote.collector.plugins.NativeLibraryPlugin.observations(afterImage) == dev.mote.collector.plugins.NativeLibraryPlugin.observations(record)) { MoteI18n.text("分页内容已变化或游标无效，请返回第一页重新读取。") }
                }
                if (selection != null) {
                    val current = CentralAccess.resolve(this)
                    check(current.server == selection.server && current.generation == selection.generation) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
                    intent.getStringExtra("conversationReference")?.let { conversation -> check(CentralConversationReference.available(requireNotNull(current.client),conversation,id)) { MoteI18n.text("引用原文已删除，历史问答仍保留。") } }
                    workMemory?.verify(requireNotNull(current.client),id)
                }
                val bitmap = bytes?.let { CapturePreview.decode(it, 1600) }
                val localNote = if (record.optString("source") == "note") {
                    if (remote) runCatching { applicationContext.recordDraftStore().record(id) }.getOrNull()
                    else applicationContext.recordDraftStore().record(id)
                } else null
                runOnUiThread {
                    if (isDestroyed || stamp != generation || !reading()) { bitmap?.recycle(); if (reading()) closeReader(); return@runOnUiThread }
                    if (selection != null) {
                        val current=runCatching { CentralAccess.resolve(this@CaptureRecordsActivity) }.getOrNull()
                        if (current == null || current.server != selection.server || current.generation != selection.generation) {
                            bitmap?.recycle(); loading.visibility=View.GONE; message.text=MoteI18n.text("登录会话已变更，请重新打开中央页面。")
                            return@runOnUiThread
                        }
                    }
                    content.removeAllViews(); detailBitmap = bitmap
                    if (direct) body.post { (body.parent as? ScrollView)?.scrollTo(0,scrollPosition) }
                    fun centralActions() {
                        if (!intent.getBooleanExtra("centralReaderActions",false)) return
                        fun selected(): CentralClient {
                            val access=CentralAccess.resolve(this@CaptureRecordsActivity)
                            check(access.server == intent.getStringExtra("recordOrigin") && access.generation == selection?.generation) { MoteI18n.text("访问凭据已失效，请重新连接。") }
                            return requireNotNull(access.client)
                        }
                        content.addView(MoteUi.button(Button(this).apply { text=MoteI18n.text("围绕这份资料提问"); setOnClickListener { runCatching { selected(); startActivity(Intent(this@CaptureRecordsActivity,CentralActivity::class.java).putExtra("page","ask").putExtra("evidenceId",id).putExtra("evidenceOrigin",intent.getStringExtra("recordOrigin")).putExtra("evidenceLabel",NativeOriginalDetail.title(record))) }.onFailure { text(content,it.message ?: MoteI18n.text("操作失败，请重试"),MoteTheme.fontSupport.toFloat()) } } }))
                        val more=SecondaryUi.disclosure(content,MoteI18n.text("更多"),"capture-reader-more")
                        more.addView(MoteUi.button(Button(this).apply { text=MoteI18n.text("详情"); setOnClickListener {
                            detailExecutor.execute {
                                val conversations=runCatching { NativeOriginalDetail.conversations(selected()) }.getOrDefault(emptyList())
                                runOnUiThread {
                                    if (isDestroyed || !reading()) return@runOnUiThread
                                    val access=runCatching { CentralAccess.resolve(this@CaptureRecordsActivity) }.getOrNull()
                                    if (selection==null || access==null || access.server!=selection.server || access.generation!=selection.generation) return@runOnUiThread
                                    NativeOriginalDetail.show(this@CaptureRecordsActivity, NativeOriginalDetail.capture(record, conversations))
                                }
                            }
                        } }))
                        val deletionKind=CentralDeletion.kind(record)
                        if (deletionKind == null) text(more,MoteI18n.text("此引用不能直接删除原始记录。"),MoteTheme.fontSupport.toFloat())
                        else {
                            val remove=MoteUi.button(Button(this).apply { text=MoteI18n.text(if(deletionKind == "file") "删除文件" else "删除记录") })
                            var deleting=false
                            fun currentDeletion(): Boolean {
                                if (isDestroyed || directReaderPaused || stamp != generation || !reading()) return false
                                val access=runCatching { CentralAccess.resolve(this@CaptureRecordsActivity) }.getOrNull()
                                return access != null && selection != null && access.server == selection.server && access.generation == selection.generation
                            }
                            remove.setOnClickListener {
                                if (!deleting) MoteDialogBuilder(this@CaptureRecordsActivity).setTitle(MoteI18n.text(if(deletionKind == "file") "删除中央文件" else "删除中央记录"))
                                    .setMessage(MoteI18n.text(if(deletionKind == "file") "删除中央保存的这份文件。不会删除设备上的原件，也不会改变来源同步策略。删除后无法恢复。" else "删除中央保存的这条记录。不会删除本机副本或来源原件，也不会改变来源同步策略。删除后无法恢复。"))
                                    .setNegativeButton(MoteI18n.text("取消"),null).setPositiveButton(MoteI18n.text("确认")) { _,_ ->
                                        if (currentDeletion()) {
                                            deleting=true;remove.isEnabled=false
                                            detailExecutor.execute {
                                                val result=runCatching { CentralDeletion.evidence(selected(),id,deletionKind) }
                                                runOnUiThread {
                                                    if (currentDeletion()) {
                                                        deleting=false;remove.isEnabled=true
                                                        result.onSuccess { closeReader() }.onFailure { error -> text(content,error.message ?: MoteI18n.text("未能确认删除完成。请刷新查看当前状态。"),MoteTheme.fontSupport.toFloat()) }
                                                    }
                                                }
                                            }
                                        }
                                    }.show()
                            }
                            more.addView(remove)
                        }
                    }

                    val isNote = record.optString("source") == "note"
                    if (isNote && !direct) dialog.setTitle(MoteI18n.text("原文"))
                    val capturedAt = record.getString("capturedAt").let { runCatching { DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.MEDIUM, java.time.format.FormatStyle.MEDIUM).withLocale(MoteI18n.locale()).withZone(ZoneId.systemDefault()).format(Instant.parse(it)) }.getOrDefault(it) }
                    val origin = record.optString("appName").ifBlank { record.optString("appId").ifBlank { if (isNote) MoteI18n.text("记录") else if (record.optString("source") == "media") MoteI18n.text("媒体会话状态") else if (record.optString("source") == "device_event") MoteI18n.text("设备状态") else MoteI18n.text("桌面 / 系统画面") } }
                    text(content, "$capturedAt · ${if (remote) MoteI18n.text("中央归档") else MoteI18n.text("本机记录")}" + if (isNote) " · $origin" else "", MoteTheme.fontMeta.toFloat()).apply { MoteUi.textColor(this, NativeColorRole.MUTED) }
                    if (!isNote) text(content, origin, MoteTheme.fontBody.toFloat())
                    if (record.optString("source") in SystemEventRules.sources) {
                        text(content, SystemEventRules.label(record), MoteTheme.fontBody.toFloat()).setTextIsSelectable(true)
                        text(content, MoteI18n.text("原始系统事件 · 不代表已阅读通知或实际执行某项任务。熄屏不等于锁定。"), MoteTheme.fontMeta.toFloat())
                        text(content, record.getJSONObject("metadata").toString(2), MoteTheme.fontMeta.toFloat()).setTextIsSelectable(true)
                        centralActions(); return@runOnUiThread
                    }
                    record.optJSONObject("stateSeries")?.optJSONArray("samples")?.let { samples ->
                        text(content, MoteI18n.text("相同状态合并为 {0} 次观察，最近一次：{1}。统计逐次使用实测时长，观察间隙不计为连续使用。", samples.length(), time(samples.getJSONObject(samples.length() - 1).getString("at"))), MoteTheme.fontSupport.toFloat())
                    }
                    fun ownerDescription() {
                        val descriptions=NativeRecordDescription.read(record,remote)
                        if(descriptions.isNotEmpty())text(content,MoteI18n.text("资料说明"),MoteTheme.fontSupport.toFloat())
                        descriptions.forEach{description->text(content,description,MoteTheme.fontBody.toFloat()).setTextIsSelectable(true)}
                    }
                    val media = record.optJSONObject("metadata")?.optJSONObject("media")
                    if (record.optString("source") == "media") {
                        text(content, CapturePreview.mediaLabel(record), MoteTheme.fontBody.toFloat()).setTextIsSelectable(true)
                        text(content, MoteI18n.text("此记录的已观察播放时长：{0} 秒（不含观测缺口）", record.optLong("durationMs") / 1000.0), MoteTheme.fontSupport.toFloat())
                        media?.optString("observedAt")?.takeIf(String::isNotBlank)?.let { text(content, MoteI18n.text("媒体观察时间：{0}", it), MoteTheme.fontMeta.toFloat()) }
                        ownerDescription(); centralActions(); return@runOnUiThread
                    }
                    if (CapturePreview.showMediaContext(record)) text(content, CapturePreview.mediaLabel(record), MoteTheme.fontSupport.toFloat())
                    if (isNote) {
                        record.optJSONObject("metadata")?.optJSONObject("noteOrigin")?.takeIf { it.optString("text").isNotBlank() }?.let { noteOrigin ->
                            val quote=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; background=MoteUi.shape(this@CaptureRecordsActivity,NativeColorRole.TINT,NativeRadiusRole.READING); setPadding(moteDp(14),moteDp(12),moteDp(14),moteDp(12)) }
                            text(quote,MoteI18n.text("引用原文"),MoteTheme.fontSupport.toFloat())
                            val expectedOrigin = if (remote) selection?.server else Settings(this@CaptureRecordsActivity).dataOrigin()
                            val presentation = expectedOrigin?.let { NativeConversationQuote.scoped(localNote,it) }
                            text(quote,NativeConversationQuote.display(noteOrigin,presentation),MoteTheme.fontBody.toFloat()).setTextIsSelectable(true); content.addView(quote)
                        }
                        if (!intent.getBooleanExtra("centralReaderActions",false)) content.addView(MoteUi.button(Button(this).apply { text = MoteI18n.text("围绕这份资料提问"); setOnClickListener { startActivity(Intent(this@CaptureRecordsActivity, CentralActivity::class.java).putExtra("page", "ask").putExtra("evidenceId", id).putExtra("evidenceOrigin", if (remote) selection?.server else record.optString("dataOrigin").takeIf(String::isNotBlank)).putExtra("evidenceLabel",NativeOriginalDetail.title(record))) } }))
                        if (remote) record.optJSONObject("metadata")?.optJSONArray("attachments")?.let { files ->
                            for (index in 0 until files.length()) {
                                val attachmentId=files.getString(index)
                                content.addView(MoteUi.button(Button(this).apply {
                                    text=MoteI18n.text("附件")+" "+(index+1)
                                    setOnClickListener { startActivity(Intent(this@CaptureRecordsActivity,CentralActivity::class.java)
                                        .putExtra("page","files").putExtra("fileId",attachmentId).putExtra("fileOrigin",intent.getStringExtra("recordOrigin"))) }
                                }))
                            }
                        }
                        if (!remote) localNote?.getJSONArray("attachments")?.let { files ->
                            for (index in 0 until files.length()) { val attachment = files.getJSONObject(index); text(content, attachment.getString("name"), MoteTheme.fontBody.toFloat()).apply { isFocusable = true; setOnClickListener { RecordOriginalPreview.open(this@CaptureRecordsActivity, attachment) } } }
                        }
                    }
                    if (record.optString("source") in setOf("note", "activity", "ui_page", "message")) {
                        record.optJSONObject("metadata")?.optJSONObject("uiPage")?.let { text(content, "${it.optString("adapterId")} @ ${it.optString("adapterVersion")} · ${it.optString("status")}", MoteTheme.fontSupport.toFloat()) }
                        text(content, record.optString("ocrText").ifBlank { if (isNote || record.optString("source") == "message") "" else MoteI18n.text("应用活动 · {0} 毫秒", record.optLong("durationMs")) }, if (isNote) MoteTheme.fontSection.toFloat() else MoteTheme.fontBody.toFloat()).apply { setTextIsSelectable(true); if (isNote) setLineSpacing(0f, 1.4f) }
                        record.optString("syncError").takeIf(String::isNotBlank)?.let { text(content, MoteI18n.text("同步需要处理：{0}", it), MoteTheme.fontBody.toFloat()) }
                        ownerDescription(); centralActions()
                        return@runOnUiThread
                    }
                    text(content, CapturePreview.ocrLabel(record, remote), MoteTheme.fontBody.toFloat())
                    if (bitmap != null) content.addView(ImageView(this).apply { setImageBitmap(bitmap); scaleType = ImageView.ScaleType.FIT_CENTER; contentDescription = MoteI18n.text("采集图片") }, LinearLayout.LayoutParams(moteDp(240), moteDp(180)))
                    else text(content, MoteI18n.text("图片暂不可用。"), MoteTheme.fontBody.toFloat())
                    ownerDescription(); centralActions()
                    text(content, MoteI18n.text("识别文字"), MoteTheme.fontSection.toFloat())
                    if (record.optBoolean("centralPreview")) text(content, MoteI18n.text("中央识别预览；完整内容请切换中央记录查看。"), MoteTheme.fontSupport.toFloat())
                    text(content, record.optString("ocrText").ifBlank { if (record.optJSONObject("ocr")?.optString("status") == "completed") MoteI18n.text("此图片未识别到文字。") else MoteI18n.text("暂无识别文字。") }, MoteTheme.fontBody.toFloat()).setTextIsSelectable(true)
                }
            } catch (error: Exception) { runOnUiThread { if (!isDestroyed && reading()) { loading.visibility = View.GONE; message.text = errorMessage(error, remote) } } }
        }
    }
    private fun errorMessage(error: Exception, remote: Boolean): String = if (error is IllegalStateException || error is IllegalArgumentException) error.message ?: MoteI18n.text("记录读取失败，请刷新重试") else if (remote) MoteI18n.text("中央记录暂不可读取，请检查网络后重试") else MoteI18n.text("本机记录暂不可读取，请刷新重试；文件已保留")
    private fun time(at: String): String = runCatching { DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.systemDefault()).format(Instant.parse(at)) }.getOrDefault(at)
    private fun row(parent: LinearLayout) = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }.also { parent.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(10) }) }
    private fun text(parent: LinearLayout, value: String, size: Float) = TextView(this).apply {
        val range = ConversationCitationPresentation.locate(value, citationExcerpt ?: "")
        text = if (range == null) value else android.text.SpannableString(value).apply {
            setSpan(android.text.style.BackgroundColorSpan(NativeColorRole.WARNING_TINT.color()), range.first, range.last + 1, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        MoteUi.type(this, size.toInt()); MoteUi.textColor(this, NativeColorRole.INK); setPadding(0, moteDp(5), 0, moteDp(5))
        if (range != null) scrollToCitation(this, range.first)
    }.also(parent::addView)
    private fun scrollToCitation(view: TextView, offset: Int) {
        if (citationScrolled) return
        citationScrolled = true
        view.post {
            val layout = view.layout ?: return@post
            var ancestor: View? = view
            var scroll: ScrollView? = null
            while (ancestor != null) {
                if (ancestor is ScrollView) { scroll = ancestor; break }
                ancestor = ancestor.parent as? View
            }
            val target = scroll ?: return@post
            val viewLocation = IntArray(2); view.getLocationInWindow(viewLocation)
            val scrollLocation = IntArray(2); target.getLocationInWindow(scrollLocation)
            val line = layout.getLineForOffset(offset.coerceIn(0, view.text.length))
            target.scrollTo(0, (viewLocation[1] - scrollLocation[1] + target.scrollY + layout.getLineTop(line)).coerceAtLeast(0))
        }
    }
    private fun button(parent: LinearLayout, label: String, action: () -> Unit) = MoteUi.button(Button(this).apply { text = label; setOnClickListener { action() } }).also { parent.addView(it, if (parent.orientation == LinearLayout.HORIZONTAL) LinearLayout.LayoutParams(0, -2, 1f) else LinearLayout.LayoutParams(-1, -2)) }
    private fun clearList() { list.removeAllViews() }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt("directReaderScroll",(body.parent as? ScrollView)?.scrollY ?: 0)
        outState.putString("citationExcerpt", citationExcerpt)
        outState.putBoolean("grid", grid); outState.putBoolean("sessionGrouping", sessionGrouping); outState.putString("date", date.toString()); outState.putString("album", album?.toString()); outState.putBoolean("central", central); outState.putString("recordSource", recordSource)
        val reader = openReader.takeIf { intent.getBooleanExtra("directReader",false) || readerDialog?.isShowing == true }
        outState.putString("readerVersion", reader?.version); outState.putString("readerId", reader?.id); outState.putBoolean("readerRemote", reader?.remote ?: false)
        super.onSaveInstanceState(outState)
    }
    override fun onDestroy() {
        readerTeardown = true; readerSequence++; readerDialog?.dismiss(); directReaderCleanup?.invoke(); directReaderCleanup = null
        generation++; loadGeneration++; executor.shutdownNow(); imageExecutor.shutdownNow(); thumbnailWriter.shutdown(); detailExecutor.shutdownNow(); clearList(); thumbnails.evictAll(); super.onDestroy()
    }
}
