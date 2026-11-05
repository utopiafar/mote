package dev.mote.collector

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Searches the existing local originals and owner-only Central readers, with independent cursors. */
internal class LibrarySearchView(private val activity: MoteActivity, private val changed: () -> Unit) {
    data class Capture(val item: JSONObject, val scope: String, val remote: Boolean)
    data class Original(val item: JSONObject, val scope: String, val remote: Boolean)
    private data class Criteria(val query: String, val category: String, val after: String, val before: String, val identity: Pair<String, Long>)
    private data class Cursor(var value: String? = null, var more: Boolean = true)
    private data class LocalPage(val captures: List<Capture>, val originals: List<Original>, val captureNext: String?, val sourceNext: Pair<String, String>?)
    private data class RemotePage(val captures: List<Capture>, val originals: List<Original>, val captureNext: String?, val materialNext: Map<String, String?>)

    private val localTask = UiTask(activity)
    private val remoteTask = UiTask(activity)
    @Volatile private var generation = 0
    private var criteria: Criteria? = null
    private var location = "local"
    private var localPending = false
    private var remotePending = false
    private val captureCursor = Cursor()
    private var sourceCursor: Pair<String, String>? = null
    private var sourceMore = true
    private val remoteCursor = Cursor()
    private val materialCursors = linkedMapOf<String, Cursor>()
    private val localCaptures = mutableListOf<Capture>()
    private val localOriginals = mutableListOf<Original>()
    private val remoteCaptures = mutableListOf<Capture>()
    private val remoteOriginals = mutableListOf<Original>()
    private var notice = ""

    fun reset(query: String, category: String, day: String, location: String = "local") {
        generation++
        val selection = CentralAccess.resolve(activity)
        val after = day.takeIf(String::isNotBlank)?.let { LocalDate.parse(it).atStartOfDay(ZoneId.systemDefault()).toInstant().toString() } ?: "1970-01-01T00:00:00Z"
        val before = day.takeIf(String::isNotBlank)?.let { LocalDate.parse(it).plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toString() } ?: Instant.now().plusSeconds(1).toString()
        criteria = Criteria(query.trim().take(500), category, after, before, selection.server to selection.generation)
        this.location = location
        captureCursor.value = null; captureCursor.more = location != "central"; sourceCursor = null; sourceMore = location != "central"
        remoteCursor.value = null; remoteCursor.more = selection.client != null && location != "local"
        materialCursors.clear()
        val materialTypes = when (category) { "all" -> listOf(""); "records" -> listOf("note"); "images" -> listOf("image"); "files" -> listOf("document", "reference"); else -> emptyList() }
        if (selection.client != null && location != "local") materialTypes.forEach { materialCursors[it] = Cursor() }
        localCaptures.clear(); localOriginals.clear(); remoteCaptures.clear(); remoteOriginals.clear(); notice = ""
        localPending = false; remotePending = false
        changed(); loadLocal(); loadRemote()
    }
    fun clear() { generation++; criteria = null; localCaptures.clear(); localOriginals.clear(); remoteCaptures.clear(); remoteOriginals.clear() }
    val loading get() = localTask.busy || remoteTask.busy
    val hasMore get() = captureCursor.more || sourceMore || remoteCursor.more || materialCursors.values.any { it.more }
    fun more() { loadLocal(); loadRemote() }
    fun notice() = notice
    fun captures(): List<Capture> {
        val localVersions = localCaptures.associateBy { Triple(it.scope, it.item.optString("deviceId"), it.item.getString("id")) }
        return localCaptures + remoteCaptures.filterNot { remote ->
            val local = localVersions[Triple(remote.scope, remote.item.optString("deviceId"), remote.item.getString("id"))]
            local != null && local.item.optString("libraryVersion").isNotBlank() && local.item.optString("libraryVersion") == remote.item.optString("libraryVersion")
        }
    }
    fun originals(): List<Original> = localOriginals + remoteOriginals

    private fun localSource(category: String) = when (category) { "records" -> "note"; "notifications" -> "notification"; else -> "" }
    private fun loadLocal() {
        val current = criteria ?: return
        if (!captureCursor.more && !sourceMore) return
        if (localTask.busy) { localPending = true; return }
        val stamp = generation; val captureAt = captureCursor.value; val readCaptures = captureCursor.more; val sourceAt = sourceCursor; val readSources = sourceMore
        localTask.start("", {}, {
            val context = activity.applicationContext; val queue = context.queue(); val matches = mutableListOf<Capture>(); var nextCapture = captureAt
            if (readCaptures) do {
                val page = context.withNativeNotePreviews(queue.capturePage(current.after, current.before, nextCapture, source = localSource(current.category), libraryBindings = true, libraryVersion = context::captureLibraryVersion))
                val items = page.getJSONArray("items"); val bindings = page.getJSONObject("bindings"); val versions = page.getJSONObject("versions")
                repeat(items.length()) { index ->
                    val row = items.getJSONObject(index); val full = queue.capture(row.getString("id"))
                    if (full != null && LibraryBrowseRules.matches(row, current.category) && LibraryBrowseRules.matchesText(full, current.query)) {
                        row.put("libraryVersion", versions.getString(row.getString("id")))
                        val device = row.optString("deviceId").ifBlank { Settings(context).deviceId }; row.put("deviceId", device)
                        val scope = bindings.optString(row.getString("id")).ifBlank { "local:$device" }
                        matches.add(Capture(row, scope, false))
                    }
                }
                nextCapture = page.optString("nextCursor").takeUnless { it.isBlank() || it == "null" }
            } while (matches.isEmpty() && nextCapture != null && generation == stamp)
            val originals = mutableListOf<Original>(); var nextSource = sourceAt
            if (readSources) do {
                val page = dev.mote.collector.plugins.NativeLibraryPlugin.owner(activity).localPage(context, current.after, current.before, nextSource, localSource(current.category), "")
                page.items.filter { LibraryBrowseRules.matches(it, current.category) && LibraryBrowseRules.matchesText(it, current.query) }.forEach { row ->
                    originals.add(Original(row, current.identity.first.ifBlank { "local:" + Settings(context).deviceId }, false))
                }
                nextSource = page.cursor
            } while (originals.isEmpty() && nextSource != null && generation == stamp)
            LocalPage(matches, originals, nextCapture, nextSource)
        }) { result ->
            if (stamp == generation && criteria == current) result.onSuccess { page ->
                localCaptures.addAll(page.captures); localOriginals.addAll(page.originals)
                if (readCaptures) { captureCursor.value = page.captureNext; captureCursor.more = page.captureNext != null }
                if (readSources) { sourceCursor = page.sourceNext; sourceMore = page.sourceNext != null }
                changed()
            }.onFailure { notice = MoteI18n.text("操作失败"); captureCursor.more = false; sourceMore = false; changed() }
            if (stamp != generation || localPending) { localPending = false; loadLocal() }
        }
    }
    private fun loadRemote() {
        val current = criteria ?: return
        if (!remoteCursor.more && materialCursors.values.none { it.more }) return
        if (remoteTask.busy) { remotePending = true; return }
        val selection = CentralAccess.resolve(activity); val api = selection.client ?: return
        if (current.identity != (selection.server to selection.generation)) { clear(); changed(); return }
        val stamp = generation; val captureAt = remoteCursor.value; val readCaptures = remoteCursor.more
        val requestedMaterials = materialCursors.filterValues { it.more }.mapValues { it.value.value }
        remoteTask.start("", {}, {
            val matches = mutableListOf<Capture>(); var nextCapture = captureAt
            val encode = CentralScreens::encode
            val base = "&after=${encode(current.after)}&before=${encode(current.before)}&query=${encode(current.query)}&limit=20"
            if (readCaptures) do {
                val source = localSource(current.category)
                val path = "/api/context/search?" + base.removePrefix("&") + (if (source.isBlank()) "" else "&source=${encode(source)}") + (nextCapture?.let { "&cursor=${encode(it)}" } ?: "")
                val page = api.get(path); val items = page.getJSONArray("items")
                repeat(items.length()) { index ->
                    val hit = items.getJSONObject(index); val id = hit.getString("id")
                    val row = api.get("/api/capture-browser/" + encode(id))
                    check(row.getString("id") == id)
                    if (LibraryBrowseRules.matches(row, current.category)) matches.add(Capture(row, selection.server, true))
                }
                nextCapture = page.optString("nextCursor").takeUnless { it.isBlank() || it == "null" }
            } while (matches.isEmpty() && nextCapture != null && generation == stamp)
            val materials = mutableListOf<Original>(); val positions = linkedMapOf<String, String?>()
            requestedMaterials.forEach { (type, cursor) ->
                val path = "/api/library/browse?" + base.removePrefix("&") + (if (type.isBlank()) "" else "&type=${encode(type)}") + (cursor?.let { "&cursor=${encode(it)}" } ?: "")
                val page = api.get(path); val items = page.getJSONArray("items")
                repeat(items.length()) { index ->
                    val hit = items.getJSONObject(index)
                    if (hit.optString("entryType") == "material") {
                        val material = hit.getJSONObject("material")
                        material.put("type", "material").put("sortAt", hit.getString("contentAt"))
                        materials.add(Original(material, selection.server, true))
                    }
                }
                positions[type] = page.optString("nextCursor").takeUnless { it.isBlank() || it == "null" }
            }
            RemotePage(matches, materials, nextCapture, positions)
        }) { result ->
            val selected = CentralAccess.resolve(activity)
            if (stamp == generation && criteria == current && current.identity == (selected.server to selected.generation)) result.onSuccess { page ->
                remoteCaptures.addAll(page.captures); remoteOriginals.addAll(page.originals)
                if (readCaptures) { remoteCursor.value = page.captureNext; remoteCursor.more = page.captureNext != null }
                page.materialNext.forEach { (type, next) -> materialCursors[type]?.let { it.value = next; it.more = next != null } }
                changed()
            }.onFailure { error ->
                remoteCaptures.clear(); remoteOriginals.clear(); remoteCursor.more = false; materialCursors.values.forEach { it.more = false }
                notice = if (error is java.io.IOException) MoteI18n.text("中央暂不可用 · 保留本机状态，恢复连接后重试") else error.message ?: MoteI18n.text("操作失败")
                changed()
            }
            if (stamp != generation || remotePending) { remotePending = false; loadRemote() }
        }
    }
    fun close() { clear(); localTask.close(); remoteTask.close() }
}
