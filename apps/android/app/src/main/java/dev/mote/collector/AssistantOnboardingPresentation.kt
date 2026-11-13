package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Owner-facing presentation for the existing A6 onboarding product command.
 * It validates ids, refs and reported coverage; it never selects materials,
 * creates model authorization or widens a scope from an empty selection. */
internal object AssistantOnboardingPresentation {
    private val refPattern = Regex("^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$")
    private val uuidPattern = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")

    data class Material(val ref: String, val title: String, val sourceId: String, val state: String)

    data class Coverage(val completed: Int, val total: Int, val partial: Int, val pending: Int, val failed: Int)

    data class Item(val ref: String, val title: String, val state: String, val reason: String?)

    data class Progress(
        val id: String, val revision: Long, val state: String,
        val sync: Coverage, val extraction: Coverage, val semantic: Coverage,
        val completed: Int, val pending: Int, val failed: Int, val cancelled: Int,
        val items: List<Item>,
    ) {
        val terminal get() = state in setOf("completed", "failed", "cancelled", "empty")
        val signature get() = listOf(id, revision, state, sync.completed, sync.total, extraction.completed, extraction.total,
            extraction.partial, extraction.pending, extraction.failed, semantic.completed, semantic.total,
            completed, pending, failed, cancelled, items.joinToString(",") { it.ref + ":" + it.state }).joinToString("|")
    }

    data class Session(val requestId: String, val refs: List<String>, val scope: String, val id: String? = null, val revision: Long? = null, val state: String? = null) {
        fun json() = JSONObject().put("requestId", requestId).put("refs", JSONArray(refs)).put("scope", scope)
            .put("id", id ?: JSONObject.NULL).put("revision", revision ?: JSONObject.NULL).put("state", state ?: JSONObject.NULL)
        /** A late response for another command or an older revision is never
         * allowed to replace the current progress. */
        fun accepted(progress: Progress): Session? {
            if (id != null && id != progress.id) return null
            if (revision != null && progress.revision < revision) return null
            return copy(id = progress.id, revision = progress.revision, state = progress.state)
        }
        val canRetryStart get() = id == null
    }

    fun materials(page: JSONObject): List<Material> {
        val rows = page.optJSONArray("items") ?: return emptyList()
        return (0 until rows.length()).mapNotNull { index ->
            val row = rows.optJSONObject(index) ?: return@mapNotNull null
            val ref = row.optString("ref")
            val match = refPattern.matchEntire(ref) ?: return@mapNotNull null
            val origin = row.optJSONObject("origin") ?: return@mapNotNull null
            val sourceId = origin.optString("sourceId")
            if (sourceId.isBlank()) return@mapNotNull null
            Material(ref, row.optString("title").take(500).ifBlank { match.groupValues[1] }, sourceId, row.optJSONObject("coverage")?.optString("state").orEmpty())
        }
    }

    /** Selection is explicit. An empty set is rejected instead of becoming all. */
    fun scope(materials: Collection<Material>): JSONObject {
        val sourceIds = materials.map { it.sourceId }.filter(String::isNotBlank).distinct().sorted()
        require(sourceIds.isNotEmpty()) { MoteI18n.text("尚未选择资料") }
        return JSONObject().put("kind", "selection").put("sourceIds", JSONArray(sourceIds))
    }

    fun refs(materials: Collection<Material>): List<String> = materials.map { it.ref }.distinct()
        .also { refs -> require(refs.isNotEmpty()) { MoteI18n.text("尚未选择资料") } }

    fun startRequest(requestId: String, materials: Collection<Material>): JSONObject =
        request(requestId, refs(materials), scope(materials))

    fun request(requestId: String, refs: Collection<String>, scope: JSONObject): JSONObject {
        require(isUuid(requestId)) { MoteI18n.text("输入格式无效，请检查必填项和取值范围。") }
        val values = refs.distinct()
        require(values.isNotEmpty()) { MoteI18n.text("尚未选择资料") }
        require(values.size <= 100) { MoteI18n.text("最多选择 {0} 份资料", 100) }
        require(values.all(refPattern::matches)) { MoteI18n.text("资料已变化，请重新选择当前版本。") }
        require(scope.optString("kind") in setOf("all", "selection")) { MoteI18n.text("请求的操作或资源已失效，请重新读取后再确认。") }
        return JSONObject().put("requestId", requestId).put("scope", scope).put("materialRefs", JSONArray(values))
    }

    fun cancelRequest(progress: Progress, scope: JSONObject): JSONObject = cancelRequest(progress.id, progress.revision, scope)

    fun cancelRequest(id: String, revision: Long, scope: JSONObject): JSONObject {
        require(isUuid(id) && revision >= 0) { invalid() }
        return JSONObject().put("expectedRevision", revision).put("scope", scope)
    }

    fun scopeOf(session: Session): JSONObject = runCatching {
        val scope = JSONObject(session.scope)
        require(scope.optString("kind") in setOf("all", "selection"))
        if (scope.optString("kind") == "selection") {
            val ids = scope.optJSONArray("sourceIds") ?: throw IllegalArgumentException()
            require((0 until ids.length()).all { ids.optString(it).isNotBlank() })
        }
        scope
    }.getOrElse {
        throw IllegalArgumentException(MoteI18n.text("请求的操作或资源已失效，请重新读取后再确认。"))
    }

    fun progress(value: JSONObject): Progress {
        val id = value.optString("id")
        require(isUuid(id)) { invalid() }
        val revision = value.optLong("revision", -1)
        require(revision >= 0) { invalid() }
        val state = value.optString("state")
        require(state in setOf("pending", "running", "completed", "failed", "cancelled", "empty")) { invalid() }
        val coverage = value.optJSONObject("coverage") ?: throw IllegalArgumentException(invalid())
        fun counts(source: JSONObject): Coverage {
            fun count(key: String): Int {
                val number = source.opt(key)
                require(number is Number) { invalid() }
                val result = number.toInt()
                require(number.toDouble() == result.toDouble() && result >= 0) { invalid() }
                return result
            }
            val completed = count("completed"); val total = count("total")
            require(completed <= total) { invalid() }
            val partial = if (source.has("partial")) count("partial") else 0
            val pending = if (source.has("pending")) count("pending") else 0
            val failed = if (source.has("failed")) count("failed") else 0
            return Coverage(completed, total, partial, pending, failed)
        }
        val sync = coverage.optJSONObject("sync")?.let { counts(it) } ?: throw IllegalArgumentException(invalid())
        val extraction = coverage.optJSONObject("extraction")?.let { counts(it) } ?: throw IllegalArgumentException(invalid())
        val semantic = coverage.optJSONObject("semantic")?.let { counts(it) } ?: throw IllegalArgumentException(invalid())
        fun overall(key: String): Int {
            val number = value.opt(key)
            require(number is Number) { invalid() }
            val result = number.toInt()
            require(number.toDouble() == result.toDouble() && result >= 0) { invalid() }
            return result
        }
        val rows = value.optJSONArray("items") ?: JSONArray()
        val items = (0 until rows.length()).mapNotNull { index ->
            val row = rows.optJSONObject(index) ?: return@mapNotNull null
            val material = row.optJSONObject("material") ?: return@mapNotNull null
            val ref = material.optString("ref")
            require(refPattern.matches(ref)) { invalid() }
            val itemState = row.optString("state")
            require(itemState in setOf("completed", "pending", "failed", "cancelled")) { invalid() }
            Item(ref, material.optString("title").take(500), itemState, row.optString("reason").takeIf(String::isNotBlank))
        }
        return Progress(id, revision, state, sync, extraction, semantic, overall("completed"), overall("pending"),
            overall("failed"), overall("cancelled"), items)
    }

    fun stateLabel(state: String): String = when (state) {
        "completed" -> MoteI18n.text("已完成")
        "failed" -> MoteI18n.text("有失败项")
        "cancelled" -> MoteI18n.text("已取消")
        "empty" -> MoteI18n.text("没有可认识的资料")
        "running" -> MoteI18n.text("进行中")
        else -> MoteI18n.text("待处理")
    }

    /** The server maps an active task to the overall "pending" state; an item
     * with the same word is still waiting, so the two labels differ. */
    fun progressStateLabel(state: String): String = when (state) {
        "pending", "running" -> MoteI18n.text("进行中")
        else -> stateLabel(state)
    }

    fun coverageLabel(value: Coverage): String {
        if (value.total == 0) return MoteI18n.text("没有可认识的资料")
        return listOfNotNull(
            MoteI18n.text("已完成 {0}/{1}", value.completed, value.total),
            value.partial.takeIf { it > 0 }?.let { MoteI18n.text("部分 {0}", it) },
            value.pending.takeIf { it > 0 }?.let { MoteI18n.text("待补 {0}", it) },
            value.failed.takeIf { it > 0 }?.let { MoteI18n.text("失败 {0}", it) },
        ).joinToString(" · ")
    }

    fun save(session: Session): JSONObject = session.json()

    fun restore(value: JSONObject): Session? = runCatching {
        val requestId = value.optString("requestId")
        require(isUuid(requestId))
        val refs = value.optJSONArray("refs") ?: JSONArray()
        val list = (0 until refs.length()).map { refs.getString(it) }
        require(list.isNotEmpty() && list.size <= 100 && list.all(refPattern::matches) && list.distinct().size == list.size)
        val scope = value.optString("scope").takeIf(String::isNotBlank) ?: throw IllegalArgumentException(invalid())
        JSONObject(scope)
        val id = value.optString("id").takeIf(::isUuid)
        val revision = value.optLong("revision", -1).takeIf { it >= 0 }
        require((id == null) == (revision == null))
        Session(requestId, list, scope, id, revision, value.optString("state").takeIf(String::isNotBlank))
    }.getOrNull()

    fun isUuid(value: String) = uuidPattern.matches(value)
    fun newRequestId(): String = UUID.randomUUID().toString()

    private fun invalid() = MoteI18n.text("中央响应格式无效，请刷新后重试。")
}
