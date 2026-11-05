package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.WeekFields
import java.util.Locale

/** One validated conversation summary from the Central page. */
internal data class HistoryConversation(val id: String, val title: String, val updatedAt: Instant)

/** Pure grouping, date labels and delete-menu state for the conversation list.
 * No View or network access: JVM tests pin the same rules the screen renders. */
internal object ConversationHistory {
    data class Group(val key: String, val items: List<HistoryConversation>)

    /** Strict page validation, same contract as the home reader: a malformed row fails the read. */
    fun items(rows: JSONArray): List<HistoryConversation> {
        val items = mutableListOf<HistoryConversation>()
        for (index in 0 until rows.length()) {
            val item = rows.getJSONObject(index)
            val id = item.getString("id")
            require(java.util.UUID.fromString(id).toString() == id)
            require(item.get("title") is String && item.get("updatedAt") is String)
            val updatedAt = Instant.parse(item.getString("updatedAt"))
            require(item.get("turnCount") is Number && item.getInt("turnCount") >= 0)
            items.add(HistoryConversation(id, item.getString("title"), updatedAt))
        }
        return items
    }

    /** ISO calendar weeks in the owner's zone; empty groups are omitted. */
    fun groups(conversations: List<HistoryConversation>, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): List<Group> {
        val today = now.atZone(zone).toLocalDate()
        val weekStart = today.with(WeekFields.ISO.dayOfWeek(), 1L)
        val ordered = conversations.sortedByDescending { it.updatedAt }
        fun inWeek(date: Instant) = date.atZone(zone).toLocalDate() in weekStart..weekStart.plusDays(6)
        return listOf(
            Group("本周", ordered.filter { inWeek(it.updatedAt) }),
            Group("更早", ordered.filter { !inWeek(it.updatedAt) })
        ).filter { it.items.isNotEmpty() }
    }

    /** 今天 / 昨天 nearby, weekday inside the current week, month-day otherwise. */
    fun dateLabel(date: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.SIMPLIFIED_CHINESE): String {
        val zoned = date.atZone(zone)
        val day = zoned.toLocalDate()
        val today = now.atZone(zone).toLocalDate()
        if (day == today) return "今天"
        if (day == today.minusDays(1)) return "昨天"
        val weekStart = today.with(WeekFields.ISO.dayOfWeek(), 1L)
        val pattern = if (day in weekStart..weekStart.plusDays(6)) "EEE" else "M月d日"
        return zoned.format(DateTimeFormatter.ofPattern(pattern, locale))
    }

    private const val DELETE_FAILURE_KEY = "conversationDeleteFailure"

    fun deleteFailure(state: JSONObject, id: String): JSONObject? =
        state.optJSONObject(DELETE_FAILURE_KEY)?.takeIf { it.optString("conversationId") == id }

    /** Row actions: delete is always first; a recorded failure adds the details entry. */
    fun deleteActions(state: JSONObject, id: String): List<String> =
        listOf("删除这段对话") + if (deleteFailure(state, id) != null) listOf("查看详情") else emptyList()

    fun clearDeleteFailure(state: JSONObject, id: String) {
        if (deleteFailure(state, id) != null) state.remove(DELETE_FAILURE_KEY)
    }

    /** Records the full causal chain the detail dialog renders, same shape the thread path wrote. */
    fun recordDeleteFailure(state: JSONObject, id: String, error: Throwable) {
        val errors = JSONArray()
        var current: Throwable? = error
        val seen = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Throwable, Boolean>())
        while (current != null && seen.add(current)) {
            val value = current
            errors.put(JSONObject().put("message", value.message.orEmpty()).apply {
                if (value is CentralFailure) { put("status", value.status); put("code", value.code); put("detail", value.detail) }
            })
            current = value.cause
        }
        state.put(DELETE_FAILURE_KEY, JSONObject().put("conversationId", id).put("errors", errors))
    }
}
