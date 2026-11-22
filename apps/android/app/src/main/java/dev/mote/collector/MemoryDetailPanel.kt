package dev.mote.collector

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** The Memory detail "More" contract shared by the native view and its JVM checks.
 * Wording matches the central web Memory detail; deletion sends the same owner DELETE. */
internal object MemoryDetailPanel {
    val moreItems = listOf("纠正这条记忆", "历史与有效时间", "生成信息", "删除记忆")
    val correctionFields = listOf("标题", "纠正后的内容", "判断的边界", "生效时间", "失效时间")
    val correctionAction = "纠正"
    val correctionCancel = "取消"
    val deleteTitle = "删除这条记忆？"
    val deleteMessage = "原始资料保留。同一批旧证据不会重新生成这个结论；有新证据时可以重新判断。"
    val deleteConfirm = "确认删除"
    val deleteCancel = "取消"
    private val editFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
    private fun path(id: String) = "/api/memories/" + CentralScreens.encode(id)
    fun deletePath(id: String) = path(id)
    fun correctionPath(id: String) = path(id) + "/correct"
    fun delete(client: CentralClient, id: String): JSONObject = client.delete(deletePath(id))
    fun correct(client: CentralClient, id: String, request: JSONObject): JSONObject = client.post(correctionPath(id), request)
    fun deletionNotice(receipt: JSONObject): String = when {
        receipt.optString("externalErase") == "pending" -> MoteI18n.text("记忆已禁止使用；外部清除仍待确认。")
        receipt.optString("externalErase") == "acknowledged" && !receipt.optBoolean("physicalEraseVerified") ->
            MoteI18n.text("记忆已禁止使用；外部已确认移除当前记录，物理擦除尚未核验。")
        else -> MoteI18n.text("记忆已禁止使用。")
    }
    fun correctionRequest(title: String, statement: String, uncertainty: String, validFrom: String, validUntil: String, version: Int): JSONObject {
        val request = JSONObject().put("title", title).put("statement", statement).put("uncertainty", uncertainty).put("version", version)
        validFrom.trim().takeIf(String::isNotEmpty)?.let { request.put("validFrom", instant(it)) }
        validUntil.trim().takeIf(String::isNotEmpty)?.let { request.put("validUntil", instant(it)) }
        return request
    }
    private fun instant(value: String): String {
        runCatching { return Instant.parse(value).toString() }
        runCatching { return LocalDateTime.parse(value, editFormat).atZone(ZoneId.systemDefault()).toInstant().toString() }
        runCatching { return LocalDate.parse(value).atStartOfDay(ZoneId.systemDefault()).toInstant().toString() }
        throw IllegalArgumentException(MoteI18n.text("时间格式无法识别。"))
    }
    fun text(row: JSONObject, field: String): String =
        if (!row.has(field) || row.isNull(field)) "" else row.optString(field)
    fun editTime(value: String): String = runCatching {
        Instant.parse(value).atZone(ZoneId.systemDefault()).format(editFormat)
    }.getOrDefault(value)
    fun displayTime(value: String): String = runCatching {
        Instant.parse(value).atZone(ZoneId.systemDefault())
            .format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT, FormatStyle.SHORT).withLocale(MoteI18n.locale()))
    }.getOrDefault(value)
    fun validityRange(row: JSONObject): String {
        val from = text(row, "validFrom").takeIf(String::isNotBlank)
        val until = text(row, "validUntil").takeIf(String::isNotBlank)
        return listOfNotNull(
            from?.let { MoteI18n.text("生效于") + " " + displayTime(it) },
            until?.let { MoteI18n.text("失效于") + " " + displayTime(it) },
        ).joinToString(" · ")
    }
    /** Explicit stored replacement links only; contradictions stay separate. */
    fun history(api: CentralClient, id: String): List<JSONObject> {
        val pending = ArrayDeque<String>().apply { add(id) }
        val seen = LinkedHashSet<String>()
        val items = mutableListOf<JSONObject>()
        while (pending.isNotEmpty() && seen.size < 100) {
            val next = pending.removeFirst()
            if (!seen.add(next)) continue
            val item = try { api.get(path(next)) } catch (error: CentralFailure) {
                if (next != id && error.status in setOf(404, 410)) continue else throw error
            }
            check(item.optString("id") == next) { MoteI18n.text("记忆版本暂不可用。") }
            items.add(item)
            item.optString("supersededBy").takeIf(String::isNotBlank)?.let(pending::add)
            val relations = item.optJSONArray("relations") ?: continue
            for (index in 0 until relations.length()) {
                val relation = relations.optJSONObject(index) ?: continue
                if (relation.optString("kind") == "supersedes") relation.optString("memoryId").takeIf(String::isNotBlank)?.let(pending::add)
            }
        }
        return items
    }
}
