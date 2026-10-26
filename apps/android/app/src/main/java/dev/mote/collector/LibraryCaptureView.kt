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
) {
    private val task = UiTask(activity)
    private val projection = LibraryCaptureProjection()
    private val status = TextView(activity)
    private val rows = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
    private val more = Button(activity)
    private var deniedOrigin: String? = null
    private val sourceView by lazy { LibrarySourceView(activity, { render() }, { origin ->
        deniedOrigin = origin; projection.clearCentral(origin); remoteCursor = null; remoteMore = false; render()
    }, { origin -> deniedOrigin != origin }) }
    private var source = state?.getString("source").orEmpty()
    private var location = state?.getString("location").orEmpty()
    private var day = state?.getString("day").orEmpty()
    private var localCursor: String? = null
    private var remoteCursor: String? = null
    private var localMore = true
    private var remoteMore = true
    private var stamp = 0
    private var refreshPending = false
    private var session: Pair<String, Long>? = null
    private var files = emptyList<JSONObject>()
    private var remoteNotice = ""
    private var before = Instant.now().plusSeconds(1).toString()
    private var pages = 0
    private var restorePages = state?.getInt("pages", 1)?.coerceIn(1, 50) ?: 1
    private var anchor = state?.getString("anchor")
    private var anchorTop = state?.getInt("anchorTop") ?: 0
    init {
        val types = listOf("" to "全部记录", "file" to "文件", "source" to "来源资料", "material" to "整理资料", "screen" to "截图", "ui_page" to "页面内容采集", "note" to "随手记", "notification" to "通知", "media" to "媒体播放状态", "activity" to "应用活动", "device_event" to "设备事件")
        fun selector(label: String, choices: List<Pair<String,String>>, selected: String, changed: (String) -> Unit) {
            val spinner = Spinner(activity).apply {
                contentDescription = MoteI18n.text(label)
                adapter = ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, choices.map { MoteI18n.text(it.second) })
                setSelection(choices.indexOfFirst { it.first == selected }.coerceAtLeast(0))
            }
            parent.addView(spinner)
            spinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) = changed(choices[position].first)
            }
        }
        selector("资料类型", types, source) { if (source != it) { source = it; resetFilter() } }
        selector("资料位置", listOf("" to "全部位置", "local" to "本机", "central" to "中央可读"), location) { if (location != it) { location = it; render() } }
        parent.addView(TextView(activity).apply { text = MoteI18n.text("收集/更新时间"); MoteUi.type(this, NativeFontRole.META) })
        val date = Button(activity).apply {
            text = day.ifBlank { MoteI18n.text("选择日期") }
            setOnClickListener {
                val current = day.takeIf(String::isNotBlank)?.let(LocalDate::parse) ?: LocalDate.now()
                DatePickerDialog(activity, { _, year, month, dateOfMonth ->
                    day = LocalDate.of(year, month + 1, dateOfMonth).toString(); text = day; resetFilter()
                }, current.year, current.monthValue - 1, current.dayOfMonth).show()
            }
        }; parent.addView(MoteUi.button(date))
        parent.addView(MoteUi.button(Button(activity).apply { text = MoteI18n.text("全部日期"); setOnClickListener { day = ""; date.text = MoteI18n.text("选择日期"); resetFilter() } }))
        sourceView.restore(state?.getBundle("sourceView")); sourceView.controls(parent)
        parent.addView(status); parent.addView(rows)
        more.text = MoteI18n.text("加载更多"); more.setOnClickListener { if (!task.busy) load() }; parent.addView(MoteUi.button(more))
        parent.addView(MoteUi.button(Button(activity).apply { text = MoteI18n.text("刷新"); setOnClickListener { refresh() } }))
    }
    fun saveState(): Bundle = Bundle().apply {
        putBundle("sourceView", sourceView.save()); putString("source", source); putString("location", location); putString("day", day); putInt("pages", pages.coerceAtLeast(1))
        val row = (0 until rows.childCount).map { rows.getChildAt(it) }.firstOrNull { it.getGlobalVisibleRect(android.graphics.Rect()) }
        putString("anchor", row?.transitionName)
        val position = IntArray(2); row?.getLocationInWindow(position); putInt("anchorTop", position[1])
    }
    private fun resetFilter() { pages = 0; restorePages = 1; anchor = null; refresh() }
    fun resume() {
        val current = CentralAccess.resolve(activity)
        if (session != (current.server to current.generation)) refresh()
    }
    fun refresh() {
        if (pages > 0) {
            val saved = saveState(); anchor = saved.getString("anchor"); anchorTop = saved.getInt("anchorTop"); restorePages = pages
        }
        deniedOrigin = null
        stamp++; projection.clear(); files = emptyList(); localCursor = null; remoteCursor = null
        localMore = true; remoteMore = true; pages = 0; before = Instant.now().plusSeconds(1).toString()
        remoteNotice = ""; sourceView.refresh(source, day); render()
        if (task.busy) refreshPending = true else load()
    }
    private data class Loaded(val local: JSONObject?, val central: Result<JSONObject>?, val files: List<JSONObject>)
    private fun load() {
        if (task.busy) return
        val selection = CentralAccess.resolve(activity)
        val identity = selection.server to selection.generation
        if (session != identity) { session = identity; projection.clear(); localCursor = null; remoteCursor = null; localMore = true; remoteMore = true; pages = 0 }
        val generation = stamp
        val filter = source; val selectedDay = day; val bound = before
        val after = selectedDay.takeIf(String::isNotBlank)?.let { LocalDate.parse(it).atStartOfDay(ZoneId.systemDefault()).toInstant().toString() } ?: "1970-01-01T00:00:00Z"
        val until = selectedDay.takeIf(String::isNotBlank)?.let { LocalDate.parse(it).plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toString() } ?: bound
        val nextLocal = localCursor; val nextRemote = remoteCursor
        val readLocal = localMore; val readRemote = remoteMore
        val previousFiles = files
        val firstPage = pages == 0
        val priorCandidates = projection.candidates(selection.server)
        more.isEnabled = false
        task.start(MoteI18n.text("正在读取…"), { status.text = it }, {
            val context = activity.applicationContext
            val local = if (readLocal && filter !in setOf("file", "source", "material")) context.withNativeNotePreviews(context.queue().capturePage(after, until, nextLocal, source = filter, libraryBindings = true, libraryVersion = context::captureLibraryVersion)) else null
            val localFiles = emptyList<JSONObject>()
            // Local originals remain usable while an offline Central request waits.
            activity.runOnUiThread {
                val current = CentralAccess.resolve(activity)
                if (generation == stamp && identity == (current.server to current.generation)) {
                    files = localFiles; applyLocal(local); render()
                    status.append("\n" + MoteI18n.text("正在读取…"))
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
                if (api.get("/api/connections/self").getJSONObject("credential").getString("scope") != "owner") throw CentralFailure(403, "connection_scope_denied")
                val body = JSONObject().put("after", after).put("before", until).put("limit", 20).put("candidates", candidates)
                if (filter.isNotBlank()) body.put("source", filter)
                nextRemote?.let { body.put("cursor", it) }
                api.post("/api/library/device-view", body)
            } else null
            Loaded(local, central, localFiles)
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
            if (refreshPending) { refreshPending = false; refresh() }
        }
    }
    private fun applyLocal(page: JSONObject?) {
        page?.let {
            val bindings = it.getJSONObject("bindings"); val versions = it.getJSONObject("versions"); val items = it.getJSONArray("items")
            repeat(items.length()) { index -> val item = items.getJSONObject(index); item.put("libraryVersion", versions.getString(item.getString("id"))); projection.local(item, bindings.optString(item.getString("id")), Settings(activity).deviceId) }
            localCursor = it.optString("nextCursor").takeUnless { value -> value.isBlank() || value == "null" }; localMore = localCursor != null
        } ?: run { localMore = false }
    }
    private fun render() {
        rows.removeAllViews()
        if (location != "central") files.forEach { file(rows, it) }
        val visible = projection.visible(location).filter { sourceView.matchesCapture(it.item) }.filterNot { sourceView.containsCapture(it.identity.scope, it.item) }
        visible.forEach { row ->
            val label = when {
                row.local == null -> MoteI18n.text("中央可读")
                row.remote == LibraryCaptureProjection.Remote.OTHER_VERSION -> MoteI18n.text("本机可读 · 中央另有版本")
                row.remote == LibraryCaptureProjection.Remote.READABLE -> MoteI18n.text("本机与中央可读")
                row.remote == LibraryCaptureProjection.Remote.UNAVAILABLE -> MoteI18n.text("本机可读 · 中央暂无此记录")
                else -> MoteI18n.text("本机可读 · 中央状态未知")
            }
            capture(rows, row.item, row.remoteOnly, label, row.identity.scope)
            val card = rows.getChildAt(rows.childCount - 1)
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
    private fun restoreAnchor() {
        restorePages = 1
        anchor?.let { value -> rows.post {
            (0 until rows.childCount).map { rows.getChildAt(it) }.firstOrNull { it.transitionName == value }?.let { row ->
                var parent = rows.parent
                while (parent is android.view.View && parent !is ScrollView) parent = parent.parent
                (parent as? ScrollView)?.let { scroll -> val position = IntArray(2); row.getLocationInWindow(position); scroll.scrollBy(0, position[1] - anchorTop) }
            }
        } }
        anchor = null
    }
    fun close() { stamp++; task.close(); sourceView.close() }
}
