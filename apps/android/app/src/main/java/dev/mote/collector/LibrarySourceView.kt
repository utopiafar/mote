package dev.mote.collector

import android.content.Intent
import android.os.Bundle
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

internal class LibrarySourceView(private val activity: MoteActivity, private val changed: () -> Unit, private val denied: (String) -> Unit, private val allowsCentral: (String) -> Boolean) {
    private val task = UiTask(activity)
    private val projection = LibrarySourceProjection()
    private var stamp = 0
    private var identity: Pair<String, Long>? = null
    private var localCursor: Pair<String,String>? = null
    private var originalCursor: String? = null
    private var materialCursor: String? = null
    private var localMore = true
    private var originalMore = true
    private var materialMore = true
    private var pages = 0
    private var restore = 1
    private var filter = ""
    private var day = ""
    private var source = ""
    private var before = ""
    private var notice = ""
    private var pendingRefresh = false
    private data class Loaded(val local: LibraryLocalSources.Page?, val originals: JSONObject?, val materials: JSONObject?)
    private var sourceSelector: Spinner? = null
    private var sourceChoices = listOf("" to MoteI18n.text("全部来源"))
    fun controls(parent: LinearLayout) {
        sourceSelector = Spinner(activity).apply { contentDescription = MoteI18n.text("来源（已加载）") }
        parent.addView(sourceSelector); updateSources()
    }
    private fun updateSources() {
        val choices = linkedMapOf("" to MoteI18n.text("全部来源"))
        projection.visible("").forEach { row ->
            val item = row.item
            val id = if (row.key.type == "material") item.optJSONObject("origin")?.optString("sourceId").orEmpty() else row.key.source
            if (id.isNotBlank()) choices[id] = item.optString("sourceName").ifBlank { MoteI18n.text("未命名来源") }
        }
        if (source.isNotBlank() && !choices.containsKey(source)) choices[source] = sourceChoices.firstOrNull { it.first == source }?.second ?: MoteI18n.text("已选来源")
        val next = choices.toList(); val spinner = sourceSelector ?: return
        if (next == sourceChoices && spinner.adapter != null) return
        sourceChoices = next; spinner.onItemSelectedListener = null
        spinner.adapter = ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, next.map { it.second })
        spinner.setSelection(next.indexOfFirst { it.first == source }.coerceAtLeast(0))
        spinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) {
                val selected = next[position].first
                if (source != selected) { source = selected; pages = 0; restore = 1; refresh(filter, day) }
            }
        }
    }
    fun matchesCapture(item: JSONObject) = source.isBlank() || item.optJSONObject("provenance")?.optString("sourceId") == source
    val isLoading get() = task.busy
    fun count(location: String) = projection.visible(location).size
    fun save() = Bundle().apply { putInt("pages", pages.coerceAtLeast(1)); putString("sourceId", source) }
    fun restore(state: Bundle?) { restore = state?.getInt("pages", 1)?.coerceIn(1,50) ?: 1; source = state?.getString("sourceId").orEmpty() }
    fun refresh(kind: String, selectedDay: String) {
        if (kind == filter && selectedDay == day && pages > 0) restore = pages else if (kind != filter || selectedDay != day) restore = 1
        stamp++; filter = kind; day = selectedDay; projection.clear(); localCursor = null; originalCursor = null; materialCursor = null
        localMore = kind != "material"; originalMore = kind != "material"; materialMore = kind.isBlank() || kind == "material"
        pages = 0; notice = ""; before = Instant.now().plusSeconds(1).toString(); changed()
        if (task.busy) pendingRefresh = true else load()
    }
    fun clearRemote() { projection.clearCentral(); originalCursor = null; materialCursor = null; originalMore = false; materialMore = false; sourceChoices = listOf("" to MoteI18n.text("全部来源")); changed() }
    fun containsCapture(origin: String, item: JSONObject) = projection.containsCapture(origin, item)
    fun load() {
        if (task.busy) return
        val access = CentralAccess.resolve(activity); val scope = access.server to access.generation; identity = scope
        val generation = stamp; val after = day.takeIf(String::isNotBlank)?.let { LocalDate.parse(it).atStartOfDay(ZoneId.systemDefault()).toInstant().toString() } ?: "1970-01-01T00:00:00Z"
        val until = day.takeIf(String::isNotBlank)?.let { LocalDate.parse(it).plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toString() } ?: before
        val kind = filter; val sourceId = source
        var loadedLocal: LibraryLocalSources.Page? = null
        task.start("", {}, {
            val local = if (localMore) LibraryLocalSources.page(activity.applicationContext, after, until, localCursor, kind, sourceId) else null
            loadedLocal = local
            activity.runOnUiThread { if (generation == stamp && CentralAccess.resolve(activity).let { scope == it.server to it.generation }) { local?.items?.forEach { projection.local(access.server.ifBlank { "local:" + Settings(activity).deviceId }, it) }; changed() } }
            val candidates = JSONArray()
            local?.items?.filter { !it.optBoolean("provisional") }?.forEach { row ->
                candidates.put(JSONObject().put("sourceId", row.getString("sourceId")).put("externalId", row.getString("externalId")).put("revision", row.getString("revision")).put("deviceId", row.getString("deviceId")).apply { row.optString("captureId").takeIf(String::isNotBlank)?.let { put("captureId", it) } })
            }
            val api = access.client ?: throw IllegalStateException(MoteI18n.text("请先登录中央节点，各页面会共用这次登录。"))
            fun remote(stream: String, cursor: String?): JSONObject {
                val q = JSONObject().put("after", after).put("before", until).put("stream", stream).put("limit", 20)
                if (stream == "originals") q.put("candidates", candidates)
                cursor?.let { q.put("cursor", it) }; if (sourceId.isNotBlank()) q.put("sourceId", sourceId)
                if (kind.isNotBlank() && kind !in setOf("source", "material")) q.put("kind", kind)
                return api.post("/api/library/source-view", q)
            }
            Loaded(local, if (originalMore || candidates.length() > 0) remote("originals", originalCursor) else null, if (materialMore) remote("materials", materialCursor) else null)
        }) { result ->
            val current = CentralAccess.resolve(activity)
            if (generation == stamp && scope == current.server to current.generation) {
                loadedLocal?.let { localCursor = it.cursor; localMore = it.cursor != null }; pages++
                result.onSuccess { data ->
                    data.local?.let { localCursor = it.cursor; localMore = it.cursor != null }
                    fun apply(page: JSONObject?) { page ?: return; val items = page.getJSONArray("items"); repeat(items.length()) { projection.central(access.server, items.getJSONObject(it)) }; val matches = page.getJSONArray("matches"); repeat(matches.length()) { matches.getJSONObject(it).optJSONObject("original")?.let { original -> projection.central(access.server, original) } } }
                    if (allowsCentral(access.server)) { apply(data.originals); apply(data.materials) } else projection.clearCentral()
                    if (allowsCentral(access.server)) {
                    data.originals?.let { originalCursor = it.optString("nextCursor").takeUnless { value -> value.isBlank() || value == "null" }; originalMore = originalCursor != null }
                    data.materials?.let { materialCursor = it.optString("nextCursor").takeUnless { value -> value.isBlank() || value == "null" }; materialMore = materialCursor != null }
                    } else { originalCursor = null; materialCursor = null; originalMore = false; materialMore = false }
                    notice = ""; changed()
                    if (pages < restore && (localMore || originalMore || materialMore)) load() else restore = 1
                }.onFailure { error ->
                    projection.clearCentral(); originalCursor = null; materialCursor = null; originalMore = false; materialMore = false
                    if (error is CentralFailure && (error.status in setOf(401, 403) || error.code == "connection_revoked")) denied(access.server)
                    sourceChoices = listOf("" to MoteI18n.text("全部来源")); notice = if (error is java.io.IOException) MoteI18n.text("中央暂不可用 · 保留本机状态，恢复连接后重试") else error.message.orEmpty(); changed()
                    if (error is CentralFailure && error.status == 409) { restore = 1; pendingRefresh = true }
                }
            } else { projection.clearCentral(); changed(); pendingRefresh = true }
            if (pendingRefresh) { pendingRefresh = false; refresh(filter, day) }
        }
    }
    fun render(parent: LinearLayout, location: String) {
        updateSources()
        val visible = projection.visible(location)
        for (row in visible) {
            val item = row.item
            val card = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL; transitionName = row.key.toString()
                background = MoteUi.clickable(activity); setPadding(activity.moteDp(12), activity.moteDp(14), activity.moteDp(12), activity.moteDp(14))
                layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = activity.moteDp(10) }
            }
            card.addView(TextView(activity).apply { text = item.optString("title"); MoteUi.type(this, NativeFontRole.ROW); MoteUi.textColor(this, NativeColorRole.INK) })
            val otherVersion = projection.visible("").any { other -> row.local != null && other.central != null && other.key.origin == row.key.origin && other.key.type == row.key.type && other.key.source == row.key.source && other.key.external == row.key.external && other.key.device == row.key.device && other.key.revision != row.key.revision }
            val label = if (row.key.type == "material") MoteI18n.text("整理资料") else if (row.local?.optBoolean("localReadable") == true) MoteI18n.text(if (row.central != null) "本机与中央可读" else if (otherVersion) "本机可读 · 中央另有版本" else "本机可读 · 中央状态未知") else MoteI18n.text(if (row.central != null) "中央可读" else "仅目录信息")
            val at = runCatching { java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.MEDIUM, java.time.format.FormatStyle.SHORT).withLocale(activity.resources.configuration.locales[0]).withZone(ZoneId.systemDefault()).format(Instant.parse(item.getString("sortAt"))) }.getOrDefault(item.optString("sortAt"))
            card.addView(TextView(activity).apply { text = label + " · " + item.optString("sourceName").ifBlank { MoteI18n.text("未命名来源") } + "\n" + at; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED) })
            card.addView(MoteUi.button(Button(activity).apply { text = MoteI18n.text("查看详情"); setOnClickListener {
                if (row.local?.optBoolean("localFile") == true) activity.startActivity(Intent(activity, FileContentActivity::class.java).putExtra("sourceId", row.key.source).putExtra("externalId", row.key.external).putExtra("sourceRevision", row.key.revision))
                else LibrarySourceReaderActivity.open(activity, row.key.origin, row.key.type, row.key.source, row.key.external, row.key.device, row.key.revision, row.central?.optString("captureId").orEmpty(), row.local != null)
            } }))
            if (row.central != null && row.local != null) card.addView(MoteUi.button(Button(activity).apply { text = MoteI18n.text("查看中央版本"); setOnClickListener { LibrarySourceReaderActivity.open(activity, row.key.origin, row.key.type, row.key.source, row.key.external, row.key.device, row.key.revision, row.central.optString("captureId"), false) } }))
            parent.addView(card)
        }
        if (notice.isNotBlank()) parent.addView(TextView(activity).apply { text = notice })
        if (localMore || originalMore || materialMore) parent.addView(MoteUi.button(Button(activity).apply { text = MoteI18n.text("加载更多来源资料"); isEnabled = !task.busy; setOnClickListener { load() } }))
    }
    fun close() { stamp++; task.close() }
}
