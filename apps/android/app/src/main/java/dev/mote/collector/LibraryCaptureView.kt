package dev.mote.collector

import android.app.DatePickerDialog
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.*
import dev.mote.collector.ui.MoteComponents
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
) {
    private val task = UiTask(activity)
    private val projection = dev.mote.collector.plugins.NativeLibraryPlugin.owner(activity).captureProjection()
    private val status = TextView(activity)
    private val host = parent
    private val rows = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
    private val more = Button(activity)
    private var deniedOrigin: String? = null
    private val sourceView by lazy { LibrarySourceView(activity, { render() }, { origin ->
        deniedOrigin = origin; projection.clearCentral(origin); remoteCursor = null; remoteMore = false; render()
    }, { origin -> deniedOrigin != origin }) }
    private val searchView by lazy { LibrarySearchView(activity) { render() } }
    private var searchTick: Runnable? = null
    private var category = state?.getString("category")?.takeIf { it in setOf("all", "records", "images", "notifications", "files") } ?: "all"
    private var source = when (category) { "records" -> "note"; "notifications" -> "notification"; else -> "" }
    private var location = state?.getString("location")?.takeIf { it in setOf("local", "central", "") } ?: "local"
    private var query = state?.getString("query").orEmpty()
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
    private val refreshPolicy = LocalStatusProducer.get(activity).state.value.let { dev.mote.collector.plugins.NativeLibraryPlugin.owner(activity).refreshPolicy(it.revision.records, it.active?.records?.takeIf { _ -> it.error == null }) }
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
        val search = LibraryBrowseUi.search(activity, "搜索资料", query)
        parent.addView(search, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = activity.moteDp(16) })
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                query = s?.toString().orEmpty().take(500)
                searchTick?.let(uiHandler::removeCallbacks); searchView.clear(); render()
                searchTick = Runnable { if (query.isBlank()) refresh() else searchView.reset(query, category, day, location) }.also { uiHandler.postDelayed(it, 300) }
            }
            override fun afterTextChanged(s: Editable?) = Unit
        })
        search.setOnEditorActionListener { _, _, _ -> searchTick?.let(uiHandler::removeCallbacks); if (query.isBlank()) refresh() else searchView.reset(query, category, day, location); true }
        sourceView.restore(state?.getBundle("sourceView"))
        parent.addView(status); parent.addView(rows)
        more.text = MoteI18n.text("加载更多"); more.setOnClickListener { if (query.isNotBlank()) searchView.more() else { if (!task.busy) load(); sourceView.load() } }; parent.addView(MoteUi.button(more))
    }
    private fun selectLocation(value: String) {
        if (location == value) return
        location = value
        searchTick?.let(uiHandler::removeCallbacks); searchView.clear()
        if (query.isNotBlank()) searchView.reset(query, category, day, value) else { render(); resetFilter() }
    }
    fun showFilters() = LibraryBrowseUi.filters(activity, listOf("all" to "全部", "records" to "记录", "images" to "截图与照片", "notifications" to "通知", "files" to "网页与文件"), category, { value ->
        category = value; source = when (value) { "records" -> "note"; "notifications" -> "notification"; else -> "" }; resetFilter()
    }, date = {
        val current = day.takeIf(String::isNotBlank)?.let(LocalDate::parse) ?: LocalDate.now()
        DatePickerDialog(activity, { _, year, month, dateOfMonth -> day = LocalDate.of(year, month + 1, dateOfMonth).toString(); resetFilter() }, current.year, current.monthValue - 1, current.dayOfMonth).apply {
            setButton(android.content.DialogInterface.BUTTON_NEUTRAL, MoteI18n.text("全部日期")) { _, _ -> day = ""; resetFilter() }
        }.show()
    }, dateLabel = day, location = location to ::selectLocation, refresh = ::refresh)
    fun saveState(): Bundle = Bundle().apply {
        putBundle("sourceView", sourceView.save()); putString("category", category); putString("location", location); putString("query", query); putString("day", day); putInt("pages", pages.coerceAtLeast(1))
        val row = descendants(rows).firstOrNull { it.transitionName != null && it.getGlobalVisibleRect(android.graphics.Rect()) }
        putString("anchor", row?.transitionName)
        val position = IntArray(2); row?.getLocationInWindow(position); putInt("anchorTop", position[1])
    }
    private fun descendants(view: View): List<View> = listOf(view) + if (view is android.view.ViewGroup) (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()
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
        if (query.isNotBlank()) { pendingFullRefresh = false; pendingInsertions = 0; searchView.reset(query, category, day, location); return }
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
        if (query.isNotBlank()) { searchView.reset(query, category, day, location); return }
        LocalStatusProducer.get(activity).state.value.let { refreshPolicy.baseline(it.revision.records, it.active?.records?.takeIf { _ -> it.error == null }) }
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
            val api = selection.client ?: error(MoteI18n.text("先登录中央，各页面会共用这次登录"))
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
        if (query.isNotBlank()) { renderSearch(); return }
        rows.removeAllViews()
        val visible = projection.visible(location).filter { sourceView.matchesCapture(it.item) }.filterNot { sourceView.containsCapture(it.identity.scope, it.item) }
            .filter { LibraryBrowseRules.matches(it.item, category) && LibraryBrowseRules.matchesText(it.item, query) }
        val originals = sourceView.entries(location).filter { LibraryBrowseRules.matches(it.item, category) && LibraryBrowseRules.matchesText(it.item, query) }
        renderedRows.keys.retainAll(visible.map { it.identity }.toSet())
        data class Entry(val at: String, val capture: LibraryCaptureProjection.Row? = null, val original: LibrarySourceProjection.Row? = null)
        val entries = (visible.map { Entry(it.sortAt, capture = it) } + originals.map { Entry(it.item.getString("sortAt"), original = it) }).sortedByDescending { Instant.parse(it.at) }
        var lastDay: LocalDate? = null
        var group: LinearLayout? = null
        entries.forEach { entry ->
            val currentDay = LibraryBrowseRules.day(entry.at, ZoneId.systemDefault())
            if (lastDay != currentDay) {
                val today = LocalDate.now()
                val caption = when (currentDay) {
                    today -> MoteI18n.text("今天")
                    today.minusDays(1) -> MoteI18n.text("昨天")
                    else -> java.time.format.DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.MEDIUM).withLocale(activity.resources.configuration.locales[0]).format(currentDay)
                }
                rows.addView(TextView(activity).apply { text = caption; MoteUi.type(this, NativeFontRole.SUPPORT, medium = true); MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(activity.moteDp(14), activity.moteDp(12), 0, activity.moteDp(10)) })
                group = MoteComponents.group(activity).also { rows.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = activity.moteDp(12) }) }
                lastDay = currentDay
            } else group?.addView(MoteComponents.divider(activity))
            val parent = requireNotNull(group)
            if (entry.original != null) { sourceView.renderItem(parent, entry.original); return@forEach }
            val row = requireNotNull(entry.capture)
            val label = when {
                row.local == null -> MoteI18n.text("中央可读")
                row.remote == LibraryCaptureProjection.Remote.OTHER_VERSION -> MoteI18n.text("本机可读 · 中央另有版本")
                row.remote == LibraryCaptureProjection.Remote.READABLE -> MoteI18n.text("本机与中央可读")
                row.remote == LibraryCaptureProjection.Remote.UNAVAILABLE -> MoteI18n.text("本机可读 · 中央暂无此记录")
                else -> MoteI18n.text("本机可读 · 中央状态未知")
            }
            val signature = SourceRules.canonical(row.item) + ":" + row.central?.let(SourceRules::canonical) + ":" + label
            renderedRows[row.identity]?.takeIf { it.first == signature }?.let { cached -> (cached.second.parent as? android.view.ViewGroup)?.removeView(cached.second); parent.addView(cached.second); return@forEach }
            capture(parent, row.item, row.remoteOnly, label, row.identity.scope)
            val card = parent.getChildAt(parent.childCount - 1)
            renderedRows[row.identity] = signature to card
            card.transitionName = JSONArray(listOf(row.identity.scope, row.identity.deviceId, row.identity.id)).toString()
            if (row.remote == LibraryCaptureProjection.Remote.OTHER_VERSION) {
                // A same-ID older/newer observation is not the local version.
                val centralVersion = row.central
                if (centralVersion != null) (card as? LinearLayout)?.addView(Button(activity).apply {
                    text = MoteI18n.text("查看中央版本")
                    setOnClickListener { activity.startActivity(android.content.Intent(activity, CaptureRecordsActivity::class.java)
                        .putExtra("recordId", row.identity.id).putExtra("recordRemote", true).putExtra("recordOrigin", row.identity.scope)
                        .putExtra("recordDeviceId", row.identity.deviceId).putExtra("recordObservationCount", dev.mote.collector.plugins.NativeLibraryPlugin.observations(centralVersion)).putExtra("recordVersion", dev.mote.collector.plugins.NativeLibraryPlugin.version(centralVersion))
                        .putExtra("recordSource", centralVersion.optString("source"))) }
                })
            }
        }
        status.text = remoteNotice; status.visibility = if (remoteNotice.isBlank()) View.GONE else View.VISIBLE
        if (!sourceView.isLoading && entries.isEmpty()) rows.addView(TextView(activity).apply { text = MoteI18n.text("这里还没有内容。点击添加，选择文件、屏幕或记录。") })
        sourceView.renderFooter(rows)
        more.visibility = if (localMore || remoteMore || sourceView.hasMore) View.VISIBLE else View.GONE
        more.isEnabled = !task.busy || !sourceView.isLoading
    }
    private fun renderSearch() {
        rows.removeAllViews()
        data class Entry(val at: String, val capture: LibrarySearchView.Capture? = null, val original: LibrarySearchView.Original? = null)
        val entries = (searchView.captures().map { Entry(it.item.getString("capturedAt"), capture = it) } +
            searchView.originals().map { Entry(it.item.getString("sortAt"), original = it) }).sortedByDescending { Instant.parse(it.at) }
        var lastDay: LocalDate? = null
        var group: LinearLayout? = null
        val sourceKeys = LibrarySourceProjection()
        entries.forEach { entry ->
            val date = LibraryBrowseRules.day(entry.at, ZoneId.systemDefault())
            if (date != lastDay) {
                val today = LocalDate.now()
                val label = when (date) { today -> MoteI18n.text("今天"); today.minusDays(1) -> MoteI18n.text("昨天"); else -> java.time.format.DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.MEDIUM).withLocale(activity.resources.configuration.locales[0]).format(date) }
                rows.addView(TextView(activity).apply { text = label; MoteUi.type(this, NativeFontRole.SUPPORT, medium = true); MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(activity.moteDp(14), activity.moteDp(12), 0, activity.moteDp(10)) })
                group = MoteComponents.group(activity).also { rows.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = activity.moteDp(12) }) }
                lastDay = date
            } else group?.addView(MoteComponents.divider(activity))
            val parent = requireNotNull(group)
            entry.capture?.let { hit -> capture(parent, hit.item, hit.remote, MoteI18n.text(if (hit.remote) "中央可读" else "本机可读 · 中央状态未知"), hit.scope) }
            entry.original?.let { hit ->
                val key = sourceKeys.key(hit.scope, hit.item)
                sourceView.renderItem(parent, if (hit.remote) LibrarySourceProjection.Row(key, central = hit.item) else LibrarySourceProjection.Row(key, local = hit.item))
            }
        }
        status.text = searchView.notice(); status.visibility = if (status.text.isBlank()) View.GONE else View.VISIBLE
        if (entries.isEmpty() && !searchView.loading) rows.addView(TextView(activity).apply { text = MoteI18n.text("当前范围内暂无条目。没有列出不代表不存在。") })
        more.visibility = if (searchView.hasMore) View.VISIBLE else View.GONE
        more.isEnabled = !searchView.loading
    }
    private fun restoreAnchor(keep: Boolean = false) {
        restorePages = 1
        anchor?.let { value -> rows.post {
            descendants(rows).firstOrNull { it.transitionName == value }?.let { row ->
                var parent = rows.parent
                while (parent is android.view.View && parent !is ScrollView) parent = parent.parent
                (parent as? ScrollView)?.let { scroll -> val position = IntArray(2); row.getLocationInWindow(position); scroll.scrollBy(0, position[1] - anchorTop) }
            }
        } }
        if (!keep) anchor = null
    }
    fun close() { cancelIncremental(); searchTick?.let(uiHandler::removeCallbacks); stamp++; task.close(); sourceView.close(); searchView.close() }
}
