package dev.mote.collector

import android.app.DatePickerDialog
import android.os.Bundle
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** The native library joins exact capture identities; other resource types keep their existing readers. */
internal class LibraryCaptureView(
    private val activity: MoteActivity,
    parent: LinearLayout,
    state: Bundle?,
    private val capture: (LinearLayout, JSONObject, Boolean, String, String) -> Unit,
    private val file: (LinearLayout, JSONObject) -> Unit,
    private val moreRecords: () -> Unit,
    private val retention: () -> Unit,
) {
    private val task = UiTask(activity)
    private val projection = LibraryCaptureProjection()
    private val status = TextView(activity)
    private val host = parent
    private val rows = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
    private val more = Button(activity)
    private var locationSelector: Spinner? = null
    private var deniedOrigin: String? = null
    private val sourceView by lazy { LibrarySourceView(activity, { render() }, { origin ->
        deniedOrigin = origin; projection.clearCentral(origin); remoteCursor = null; remoteMore = false; render()
    }, { origin -> deniedOrigin != origin }) }
    private var source = state?.getString("source").orEmpty()
    private var location = state?.getString("location") ?: "local"
    private var day = state?.getString("day").orEmpty()
    private var localCursor: String? = null
    private var remoteCursor: String? = null
    // Deepest range merged into the projection, independent of remoteCursor.
    private var remoteBoundary: LibraryRefreshPolicy.Position? = null
    private var localMore = true
    private var remoteMore = true
    private var stamp = 0
    private var refreshPending = false
    private var activeFilter = ""
    private var activeDay = ""
    private var session: Pair<String, Long>? = null
    private var files = emptyList<JSONObject>()
    private var remoteNotice = ""
    @Volatile private var verifiedConnection: Pair<String, Long>? = null
    private val refreshPolicy = LocalStateRepository.get(activity).state.value.let { LibraryRefreshPolicy(it.revision.records, it.active?.records?.takeIf { _ -> it.error == null }) }
    private val uiHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var incrementalScheduled = false
    private var incrementalPending = false
    private var pendingFullRefresh = false
    private var pendingInsertions = 0
    private val renderedRows = mutableMapOf<LibraryCaptureProjection.Identity, Pair<String, android.view.View>>()
    private val incrementalTick = Runnable { incrementalScheduled = false; incrementalRefresh() }
    private var visibilityObserver: android.view.ViewTreeObserver? = null
    private val recordsVisible = android.view.ViewTreeObserver.OnPreDrawListener {
        if (!hasPendingRecords()) stopWaitingForVisibility()
        else if (host.isShown && host.windowVisibility == android.view.View.VISIBLE) {
            stopWaitingForVisibility()
            if (!incrementalScheduled) { incrementalScheduled = true; uiHandler.post(incrementalTick) }
        }
        true
    }
    private var before = Instant.now().plusSeconds(1).toString()
    private var pages = 0
    private var restorePages = state?.getInt("pages", 1)?.coerceIn(1, 50) ?: 1
    private var anchor = state?.getString("anchor")
    private var anchorTop = state?.getInt("anchorTop") ?: 0
    init {
        lateinit var locations: NativeSectionTabs
        locations=NativeSectionTabs(activity,listOf("local" to "本机","central" to "中央资料"),"library-locations",changed={value->location=value;locationSelector?.setSelection(if(value=="local")1 else 2);locations.select(value);render()},choiceStyle=true)
        locations.select(location);parent.addView(locations)
        val options = SecondaryUi.disclosure(parent,MoteI18n.text("筛选"),"library-filters",state?.getBoolean("filtersExpanded") ?: false)
        val types = listOf("" to "全部记录", "file" to "文件", "source" to "来源资料", "material" to "整理资料", "screen" to "截图", "ui_page" to "页面内容采集", "note" to "随手记", "notification" to "通知", "media" to "媒体播放状态", "activity" to "应用活动", "device_event" to "设备事件")
        fun selector(label: String, choices: List<Pair<String,String>>, selected: String, changed: (String) -> Unit) {
            val spinner = Spinner(activity).apply {
                contentDescription = MoteI18n.text(label)
                adapter = ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, choices.map { MoteI18n.text(it.second) })
                setSelection(choices.indexOfFirst { it.first == selected }.coerceAtLeast(0))
            }
            options.addView(spinner)
            if(label=="资料位置")locationSelector=spinner
            spinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) = changed(choices[position].first)
            }
        }
        selector("资料类型", types, source) { if (source != it) { source = it; resetFilter() } }
        selector("资料位置", listOf("" to "全部位置", "local" to "本机", "central" to "中央可读"), location) { if (location != it) { location = it; locations.select(it); render() } }
        options.addView(TextView(activity).apply { text = MoteI18n.text("收集/更新时间"); MoteUi.type(this, NativeFontRole.META) })
        val date = Button(activity).apply {
            text = day.ifBlank { MoteI18n.text("选择日期") }
            setOnClickListener {
                val current = day.takeIf(String::isNotBlank)?.let(LocalDate::parse) ?: LocalDate.now()
                DatePickerDialog(activity, { _, year, month, dateOfMonth ->
                    day = LocalDate.of(year, month + 1, dateOfMonth).toString(); text = day; resetFilter()
                }, current.year, current.monthValue - 1, current.dayOfMonth).show()
            }
        }; options.addView(MoteUi.button(date))
        options.addView(MoteUi.button(Button(activity).apply { text = MoteI18n.text("全部日期"); setOnClickListener { day = ""; date.text = MoteI18n.text("选择日期"); resetFilter() } }))
        sourceView.restore(state?.getBundle("sourceView")); sourceView.controls(options)
        SecondaryUi.action(options,MoteI18n.text("按日期浏览更多记录"),action=moreRecords)
        parent.addView(status); parent.addView(rows)
        more.text = MoteI18n.text("加载更多"); more.setOnClickListener { if (!task.busy) load() }; parent.addView(MoteUi.button(more))
        parent.addView(MoteUi.button(Button(activity).apply { text = MoteI18n.text("刷新"); setOnClickListener { refresh() } }))
        parent.addView(TextView(activity).apply { text=MoteI18n.text("上传后的本机保留设置")+"  ›";MoteUi.type(this,NativeFontRole.SUPPORT);MoteUi.textColor(this,NativeColorRole.ACCENT);minHeight=activity.moteDp(42);gravity=android.view.Gravity.CENTER_VERTICAL;isFocusable=true;setOnClickListener { retention() } })
    }
    fun saveState(): Bundle = Bundle().apply {
        putBoolean("filtersExpanded", host.findViewWithTag<android.view.View>("library-filters:content")?.visibility == android.view.View.VISIBLE)
        putBundle("sourceView", sourceView.save()); putString("source", source); putString("location", location); putString("day", day); putInt("pages", pages.coerceAtLeast(1))
        val row = (0 until rows.childCount).map { rows.getChildAt(it) }.firstOrNull { it.getGlobalVisibleRect(android.graphics.Rect()) }
        putString("anchor", row?.transitionName)
        val position = IntArray(2); row?.getLocationInWindow(position); putInt("anchorTop", position[1])
    }
    private fun resetFilter() { pages = 0; restorePages = 1; anchor = null; refresh() }
    fun resume() {
        val current = CentralAccess.resolve(activity)
        if (session != (current.server to current.generation)) refresh()
        else if (!incrementalScheduled && hasPendingRecords()) waitForRecordsVisibility()
    }
    private fun hasPendingRecords() = pendingFullRefresh || pendingInsertions > 0
    private fun waitForRecordsVisibility() {
        // onResume can precede window visibility. Consume the invalidation at
        // the next visible frame, without background polling or hidden reads.
        if (visibilityObserver?.isAlive != true) {
            visibilityObserver = host.viewTreeObserver.also { it.addOnPreDrawListener(recordsVisible) }
        }
        host.postInvalidateOnAnimation()
    }
    private fun stopWaitingForVisibility() {
        visibilityObserver?.takeIf { it.isAlive }?.removeOnPreDrawListener(recordsVisible)
        visibilityObserver = null
    }
    /** Every committed record change lands here; only a proven pure-insert burst merges into the loaded pages. */
    fun recordsChanged(revision: Long, count: Int?) {
        when (refreshPolicy.recordsChanged(revision, count)) {
            LibraryRefreshPolicy.Action.NONE -> return
            LibraryRefreshPolicy.Action.FULL -> pendingFullRefresh = true
            LibraryRefreshPolicy.Action.INCREMENTAL -> pendingInsertions += refreshPolicy.insertions
        }
        if (!incrementalScheduled) {
            incrementalScheduled = true; uiHandler.postDelayed(incrementalTick, LibraryRefreshPolicy.DEBOUNCE_MILLIS)
        }
    }
    private fun cancelIncremental() { incrementalScheduled = false; incrementalPending = false; pendingFullRefresh = false; pendingInsertions = 0; uiHandler.removeCallbacks(incrementalTick); stopWaitingForVisibility() }
    private fun incrementalRefresh() {
        if (!hasPendingRecords()) { incrementalPending = false; stopWaitingForVisibility(); return }
        if (!host.isShown || host.windowVisibility != android.view.View.VISIBLE) {
            if (hasPendingRecords()) waitForRecordsVisibility()
            return
        }
        val current = CentralAccess.resolve(activity)
        if (session != (current.server to current.generation)) { refresh(); return }
        if (task.busy) { incrementalPending = true; return }
        if (pendingFullRefresh || pendingInsertions !in 1..20) { refresh(); return }
        if (projection.scopedIdentities(current.server).size + pendingInsertions > 100) { refresh(); return }
        // A busy completion can drain a burst before its newer debounce tick.
        // Retire that tick before consuming, so it cannot later reload an empty
        // batch. A subsequent mutation starts its own fresh five-second window.
        incrementalScheduled = false; uiHandler.removeCallbacks(incrementalTick)
        incrementalPending = false; stopWaitingForVisibility()
        if (pages > 0) { val saved = saveState(); anchor = saved.getString("anchor"); anchorTop = saved.getInt("anchorTop") }
        val insertions = pendingInsertions; pendingInsertions = 0
        incrementalLoad(insertions)
    }
    fun refresh() {
        cancelIncremental()
        LocalStateRepository.get(activity).state.value.let { refreshPolicy.baseline(it.revision.records, it.active?.records?.takeIf { _ -> it.error == null }) }
        val current = CentralAccess.resolve(activity)
        if (task.busy && session == current.server to current.generation && activeFilter == source && activeDay == day) {
            refreshPending = true; sourceView.refresh(source, day); return
        }
        if (pages > 0) {
            val saved = saveState(); anchor = saved.getString("anchor"); anchorTop = saved.getInt("anchorTop"); restorePages = pages
        }
        deniedOrigin = null
        stamp++; projection.clear(); files = emptyList(); localCursor = null; remoteCursor = null; remoteBoundary = null
        localMore = true; remoteMore = true; pages = 0; before = Instant.now().plusSeconds(1).toString()
        remoteNotice = ""; sourceView.refresh(source, day); render()
        if (task.busy) refreshPending = true else load()
    }
    private data class Loaded(val local: JSONObject?, val central: Result<JSONObject>?, val files: List<JSONObject>, val needsFullRefresh: Boolean = false)
    private data class AppendRead(val insertions: Int, val priorLocal: Set<Pair<String, String>>)
    private fun remotePosition(items: JSONArray) = if (items.length() == 0) null else items.getJSONObject(items.length() - 1).let { LibraryRefreshPolicy.Position(it.getString("capturedAt"), it.getString("id")) }
    private fun load() {
        if (task.busy) return
        val selection = CentralAccess.resolve(activity)
        val identity = selection.server to selection.generation
        if (session != identity) { session = identity; projection.clear(); localCursor = null; remoteCursor = null; remoteBoundary = null; localMore = true; remoteMore = true; pages = 0 }
        val generation = stamp
        val filter = source; val selectedDay = day; activeFilter = filter; activeDay = selectedDay; val bound = before
        val after = selectedDay.takeIf(String::isNotBlank)?.let { LocalDate.parse(it).atStartOfDay(ZoneId.systemDefault()).toInstant().toString() } ?: "1970-01-01T00:00:00Z"
        val until = selectedDay.takeIf(String::isNotBlank)?.let { LocalDate.parse(it).plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toString() } ?: bound
        val nextLocal = localCursor; val nextRemote = remoteCursor
        val readLocal = localMore; val readRemote = remoteMore
        val previousFiles = files
        val firstPage = pages == 0
        val priorCandidates = projection.candidates(selection.server)
        more.isEnabled = false
        task.start(MoteI18n.text("正在读取…"), { status.text = it }, {
            requestPage(selection, identity, generation, filter, after, until, nextLocal, nextRemote, readLocal, readRemote, priorCandidates)
        }) { result ->
            val current = CentralAccess.resolve(activity)
            if (generation == stamp && identity == (current.server to current.generation)) {
                result.onSuccess { loaded ->
                    files = loaded.files
                    applyLocal(loaded.local)
                    loaded.central?.onSuccess { page ->
                        if (deniedOrigin == selection.server) return@onSuccess
                        remoteNotice = ""; val items = page.getJSONArray("items")
                        repeat(items.length()) { projection.central(items.getJSONObject(it), selection.server) }
                        val matches = page.getJSONArray("matches")
                        repeat(matches.length()) { val match = matches.getJSONObject(it); projection.availability(selection.server, match.getString("deviceId"), match.getString("id"), match.getString("state") == "readable", match.optInt("observationCount"), match.optString("libraryVersion")) }
                        remoteCursor = page.optString("nextCursor").takeUnless { it.isBlank() || it == "null" }; remoteMore = remoteCursor != null
                        remoteBoundary = if (remoteMore) refreshPolicy.extendCentralCoverage(remoteBoundary, remotePosition(items)) else null
                    }?.onFailure {
                        if (it is CentralFailure && (it.status in setOf(401, 403) || it.code == "connection_revoked")) {
                            deniedOrigin = selection.server; sourceView.clearRemote()
                            projection.clearCentral(selection.server); remoteCursor = null
                        }
                        if (it is CentralFailure && it.status == 409) { refreshPending = true; pages = 0; restorePages = 1 }
                        remoteNotice = if (it is java.io.IOException) MoteI18n.text("中央暂不可用 · 保留本机状态，恢复连接后重试") else it.message.orEmpty(); remoteMore = false
                    }
                    if (filter in setOf("file", "source", "material")) remoteMore = false
                    pages++; render()
                    if (pages < restorePages && (localMore || remoteMore)) load() else restoreAnchor()
                }.onFailure { status.text = MoteI18n.text("资料暂不可读取，请稍后重试。"); more.isEnabled = true }
            } else { projection.clear(); files = emptyList(); render(); refreshPending = true }
            if (refreshPending) { refreshPending = false; incrementalPending = false; refresh() }
            else if (incrementalPending) { incrementalPending = false; incrementalRefresh() }
        }
    }
    /** A proven insert burst merges a fresh local page and a Central prefix that covers the retained range. */
    private fun incrementalLoad(insertions: Int) {
        if (task.busy) return
        val selection = CentralAccess.resolve(activity)
        val identity = selection.server to selection.generation
        if (session != identity) { refresh(); return }
        val generation = stamp
        val filter = source; val selectedDay = day
        val after = selectedDay.takeIf(String::isNotBlank)?.let { LocalDate.parse(it).atStartOfDay(ZoneId.systemDefault()).toInstant().toString() } ?: "1970-01-01T00:00:00Z"
        val until = selectedDay.takeIf(String::isNotBlank)?.let { LocalDate.parse(it).plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toString() } ?: Instant.now().plusSeconds(1).toString()
        val priorCandidates = projection.candidates(selection.server)
        val priorLocal = projection.localIdentities()
        val priorRemote = projection.remoteVersions(selection.server)
        val boundary = remoteBoundary; val hadMore = remoteMore
        more.isEnabled = false
        task.start(MoteI18n.text("正在读取…"), { status.text = it }, {
            requestPage(selection, identity, generation, filter, after, until, null, null, readLocal = true, readRemote = true, priorCandidates, AppendRead(insertions, priorLocal))
        }) { result ->
            val current = CentralAccess.resolve(activity)
            if (generation == stamp && identity == (current.server to current.generation)) {
                result.onSuccess { loaded ->
                    if (loaded.needsFullRefresh) { refreshPending = true; return@onSuccess }
                    val remotePage = loaded.central?.getOrNull()
                    if (remotePage != null) {
                        val remoteItems = remotePage.getJSONArray("items")
                        val hasMore = remotePage.optString("nextCursor").let { it.isNotBlank() && it != "null" }
                        if (!refreshPolicy.centralRangeCovers(boundary, hadMore, remotePosition(remoteItems), hasMore)) { refreshPending = true; return@onSuccess }
                        val supplied = (0 until remoteItems.length()).map { remoteItems.getJSONObject(it) }.associateBy { it.getString("deviceId") to it.getString("id") }
                        val matches = remotePage.getJSONArray("matches")
                        val observations = (0 until matches.length()).map { matches.getJSONObject(it) }.associateBy { it.getString("deviceId") to it.getString("id") }
                        if (priorRemote.any { (id, version) ->
                            val observed = observations[id]
                            observed == null || observed.getString("state") == "readable" && id !in supplied && (version.isNullOrBlank() || observed.optString("libraryVersion") != version)
                        }) { refreshPending = true; return@onSuccess }
                    }
                    applyLocal(loaded.local, updateCursor = false)
                    loaded.central?.onSuccess { page ->
                        if (deniedOrigin == selection.server) return@onSuccess
                        remoteNotice = ""; val items = page.getJSONArray("items")
                        repeat(items.length()) { projection.central(items.getJSONObject(it), selection.server) }
                        val matches = page.getJSONArray("matches")
                        repeat(matches.length()) { val match = matches.getJSONObject(it); projection.availability(selection.server, match.getString("deviceId"), match.getString("id"), match.getString("state") == "readable", match.optInt("observationCount"), match.optString("libraryVersion")) }
                        if (page.optString("nextCursor").let { it.isBlank() || it == "null" }) { remoteCursor = null; remoteBoundary = null; remoteMore = false }
                        else remoteBoundary = refreshPolicy.extendCentralCoverage(remoteBoundary, remotePosition(items))
                    }?.onFailure {
                        // A previous successful read cannot claim current Central
                        // availability after this read failed. Keep local originals
                        // and the cursors so a later append can revalidate the range.
                        projection.clearCentral(selection.server)
                        if (it is CentralFailure && (it.status in setOf(401, 403) || it.code == "connection_revoked")) {
                            deniedOrigin = selection.server; sourceView.clearRemote()
                            remoteCursor = null; remoteMore = false
                        }
                        if (it is CentralFailure && it.status == 409) { refreshPending = true; pages = 0; restorePages = 1 }
                        remoteNotice = if (it is java.io.IOException) MoteI18n.text("中央暂不可用 · 保留本机状态，恢复连接后重试") else it.message.orEmpty()
                    }
                    render(); restoreAnchor()
                }.onFailure { status.text = MoteI18n.text("资料暂不可读取，请稍后重试。"); more.isEnabled = localMore || remoteMore }
            } else { projection.clear(); files = emptyList(); render(); refreshPending = true }
            if (refreshPending) { refreshPending = false; incrementalPending = false; refresh() }
            else if (incrementalPending) { incrementalPending = false; incrementalRefresh() }
        }
    }
    private fun requestPage(selection: CentralAccess.Selection, identity: Pair<String, Long>, generation: Int, filter: String, after: String, until: String, nextLocal: String?, nextRemote: String?, readLocal: Boolean, readRemote: Boolean, priorCandidates: List<LibraryCaptureProjection.Identity>, append: AppendRead? = null): Loaded {
        val context = activity.applicationContext
        val local = if (readLocal && filter !in setOf("file", "source", "material")) context.withNativeNotePreviews(context.queue().capturePage(after, until, nextLocal, source = filter, libraryBindings = true, libraryVersion = context::captureLibraryVersion)) else null
        val localFiles = emptyList<JSONObject>()
        if (append != null) {
            val items = local?.getJSONArray("items")
            val deviceId = Settings(context).deviceId
            val added = if (items == null) 0 else (0 until items.length()).map { items.getJSONObject(it) }
                .count { (it.optString("deviceId").ifBlank { deviceId } to it.getString("id")) !in append.priorLocal }
            if (!refreshPolicy.firstPageCovers(append.insertions, added)) return Loaded(local, null, localFiles, needsFullRefresh = true)
        }
        // Local originals remain usable while an offline Central request waits.
        activity.runOnUiThread {
            val current = CentralAccess.resolve(activity)
            if (generation == stamp && identity == (current.server to current.generation)) {
                if (append == null) {
                    files = localFiles
                    applyLocal(local); render()
                    status.append("\n" + MoteI18n.text("正在读取…"))
                } else {
                    applyLocal(local, updateCursor = false); render(); restoreAnchor(keep = true)
                }
            }
        }
        val candidates = JSONArray()
        priorCandidates.forEach { candidates.put(JSONObject().put("deviceId", it.deviceId).put("id", it.id)) }
        local?.let { page -> val bindings = page.getJSONObject("bindings"); val items = page.getJSONArray("items")
            repeat(items.length()) { index -> val item = items.getJSONObject(index)
                if (bindings.optString(item.getString("id")) == selection.server && selection.server.isNotBlank() && candidates.length() < 100)
                    candidates.put(JSONObject().put("deviceId", item.optString("deviceId").ifBlank { Settings(context).deviceId }).put("id", item.getString("id")))
            }
        }
        val central = if (readRemote && filter !in setOf("file", "source", "material")) runCatching {
            val api = selection.client ?: error(MoteI18n.text("请先登录中央节点，各页面会共用这次登录。"))
            // The owner-scope check is per connection generation; device-view still authorizes each response.
            if (verifiedConnection != identity) {
                if (api.get("/api/connections/self").getJSONObject("credential").getString("scope") != "owner") throw CentralFailure(403, "connection_scope_denied")
                verifiedConnection = identity
            }
            // A bounded fresh prefix must cover the retained remote cursor range;
            // overlap alone cannot account for cross-device backfills into deep pages.
            val body = JSONObject().put("after", after).put("before", until).put("limit", if (append == null) 20 else 60).put("candidates", candidates)
            if (filter.isNotBlank()) body.put("source", filter)
            nextRemote?.let { body.put("cursor", it) }
            api.post("/api/library/device-view", body)
        } else null
        return Loaded(local, central, localFiles)
    }
    private fun applyLocal(page: JSONObject?, updateCursor: Boolean = true) {
        page?.let {
            val bindings = it.getJSONObject("bindings"); val versions = it.getJSONObject("versions"); val items = it.getJSONArray("items")
            repeat(items.length()) { index -> val item = items.getJSONObject(index); item.put("libraryVersion", versions.getString(item.getString("id"))); projection.local(item, bindings.optString(item.getString("id")), Settings(activity).deviceId) }
            if (updateCursor) { localCursor = it.optString("nextCursor").takeUnless { value -> value.isBlank() || value == "null" }; localMore = localCursor != null }
        } ?: run { if (updateCursor) localMore = false }
    }
    private fun render() {
        rows.removeAllViews()
        if (location != "central") files.forEach { file(rows, it) }
        val visible = projection.visible(location).filter { sourceView.matchesCapture(it.item) }.filterNot { sourceView.containsCapture(it.identity.scope, it.item) }
        renderedRows.keys.retainAll(visible.map { it.identity }.toSet())
        visible.forEach { row ->
            val label = when {
                row.local == null -> MoteI18n.text("中央可读")
                row.remote == LibraryCaptureProjection.Remote.OTHER_VERSION -> MoteI18n.text("本机可读 · 中央另有版本")
                row.remote == LibraryCaptureProjection.Remote.READABLE -> MoteI18n.text("本机与中央可读")
                row.remote == LibraryCaptureProjection.Remote.UNAVAILABLE -> MoteI18n.text("本机可读 · 中央暂无此记录")
                else -> MoteI18n.text("本机可读 · 中央状态未知")
            }
            val signature = SourceRules.canonical(row.item) + ":" + row.central?.let(SourceRules::canonical) + ":" + label
            renderedRows[row.identity]?.takeIf { it.first == signature }?.let { cached -> rows.addView(cached.second); return@forEach }
            capture(rows, row.item, row.remoteOnly, label, row.identity.scope)
            val card = rows.getChildAt(rows.childCount - 1)
            renderedRows[row.identity] = signature to card
            card.transitionName = JSONArray(listOf(row.identity.scope, row.identity.deviceId, row.identity.id)).toString()
            if (row.remote == LibraryCaptureProjection.Remote.OTHER_VERSION) {
                // A same-ID older/newer observation is not the local version.
                val centralVersion = row.central
                if (centralVersion != null) ((card as? LinearLayout)?.getChildAt(1) as? LinearLayout)?.addView(Button(activity).apply {
                    text = MoteI18n.text("查看中央版本")
                    setOnClickListener { activity.startActivity(android.content.Intent(activity, CaptureRecordsActivity::class.java)
                        .putExtra("recordId", row.identity.id).putExtra("recordRemote", true).putExtra("recordOrigin", row.identity.scope)
                        .putExtra("recordDeviceId", row.identity.deviceId).putExtra("recordObservationCount", LibraryCaptureProjection.observations(centralVersion)).putExtra("recordVersion", LibraryCaptureProjection.version(centralVersion))
                        .putExtra("recordSource", centralVersion.optString("source"))) }
                })
            }
        }
        status.text = MoteI18n.text("已加载 {0} 条资料", visible.size + sourceView.count(location)) + if (remoteNotice.isNotBlank()) "\n$remoteNotice" else ""
        if (!sourceView.isLoading && visible.isEmpty() && sourceView.count(location) == 0 && (files.isEmpty() || location == "central")) rows.addView(TextView(activity).apply { text = MoteI18n.text("这里还没有内容。点击添加，选择文件、屏幕或随手记。") })
        sourceView.render(rows, location)
        more.isEnabled = !task.busy && (localMore || remoteMore)
    }
    private fun restoreAnchor(keep: Boolean = false) {
        restorePages = 1
        anchor?.let { value -> rows.post {
            (0 until rows.childCount).map { rows.getChildAt(it) }.firstOrNull { it.transitionName == value }?.let { row ->
                var parent = rows.parent
                while (parent is android.view.View && parent !is ScrollView) parent = parent.parent
                (parent as? ScrollView)?.let { scroll -> val position = IntArray(2); row.getLocationInWindow(position); scroll.scrollBy(0, position[1] - anchorTop) }
            }
        } }
        if (!keep) anchor = null
    }
    fun close() { cancelIncremental(); stamp++; task.close(); sourceView.close() }
}
