package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

internal data class MemoryTopicNode(val id: String, val label: String, val parentId: String?)
internal data class MemoryTopicTree(val id: String, val label: String, val nodes: List<MemoryTopicNode>)
internal data class MemoryTopicCatalog(val trees: List<MemoryTopicTree>, val state: String) {
    companion object {
        private val identity = Regex("^[a-z][a-z0-9.-]{0,99}$")
        fun validId(value: String) = identity.matches(value)
        fun read(value: JSONObject): MemoryTopicCatalog {
            val rows = value.getJSONArray("items")
            val trees = (0 until rows.length()).map { index ->
                val row = rows.getJSONObject(index); val id = row.getString("id"); val label = row.getString("label")
                require(validId(id) && label.length in 1..100)
                val entries = row.getJSONArray("nodes"); require(entries.length() <= 500)
                val nodes = (0 until entries.length()).map { i ->
                    val node = entries.getJSONObject(i); val key = node.getString("id"); val title = node.getString("label")
                    val parent = if (node.isNull("parentId")) null else node.getString("parentId")
                    require(validId(key) && title.length in 1..100 && (parent == null || validId(parent)))
                    MemoryTopicNode(key, title, parent)
                }
                require(nodes.distinctBy { it.id }.size == nodes.size)
                val byId = nodes.associateBy { it.id }
                nodes.forEach { node ->
                    val seen = mutableSetOf(node.id); var parent = node.parentId
                    while (parent != null) { require(parent in byId && seen.add(parent)); parent = byId.getValue(parent).parentId }
                }
                MemoryTopicTree(id, label, nodes)
            }
            require(trees.distinctBy { it.id }.size == trees.size)
            return MemoryTopicCatalog(trees, value.optJSONObject("classification")?.optString("state").orEmpty())
        }
    }
}

/** Navigation IDs only; saved state is never a cached Memory body or an authority. */
internal class MemoryTopicNavigation {
    var treeId = "topics"; private set
    var nodeId: String? = null; private set
    var selectedMemory: String? = null; private set
    private val cursors = mutableListOf<String?>(null)
    var scroll = 0
    val canGoBack get() = cursors.size > 1
    fun choose(tree: String, node: String? = null) {
        require(MemoryTopicCatalog.validId(tree) && (node == null || MemoryTopicCatalog.validId(node)))
        treeId = tree; nodeId = node; selectedMemory = null; cursors.clear(); cursors.add(null); scroll = 0
    }
    fun selectMemory(id: String) { require(UUID.matches(id)); selectedMemory = id }
    fun returnToList() { selectedMemory = null }
    fun next(cursor: String) { require(cursor.isNotBlank() && cursor.length <= 8192); cursors.add(cursor); scroll = 0 }
    fun previous() { if (canGoBack) cursors.removeAt(cursors.lastIndex); scroll = 0 }
    fun first() { cursors.clear(); cursors.add(null); scroll = 0 }
    fun valid(catalog: MemoryTopicCatalog) = nodeId == null || catalog.trees.any { it.id == treeId && it.nodes.any { node -> node.id == nodeId } }
    fun path(): String = (nodeId?.let { "/api/context-trees/${enc(treeId)}/nodes/${enc(it)}" } ?: "/api/memories") + "?limit=30" + (cursors.last()?.let { "&cursor=${enc(it)}" } ?: "")
    fun save(): JSONObject = JSONObject().put("tree", treeId).put("node", nodeId).put("memory", selectedMemory).put("cursors", JSONArray(cursors.map { it.orEmpty() })).put("scroll", scroll)
    fun restore(value: JSONObject) {
        choose(value.optString("tree").takeIf(MemoryTopicCatalog::validId) ?: "topics", value.optString("node").takeIf(MemoryTopicCatalog::validId))
        value.optString("memory").takeIf(UUID::matches)?.let(::selectMemory)
        val saved = value.optJSONArray("cursors")
        if (saved != null && saved.length() in 1..100) {
            val entries = (0 until saved.length()).map { saved.optString(it) }
            if (entries.first().isEmpty() && entries.all { it.length <= 8192 }) { cursors.clear(); cursors.addAll(entries.map { it.takeIf(String::isNotBlank) }) }
        }
        scroll = value.optInt("scroll").coerceAtLeast(0)
    }
    companion object {
        private val UUID = Regex("^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$")
        private fun enc(value: String) = URLEncoder.encode(value, "UTF-8")
    }
}
