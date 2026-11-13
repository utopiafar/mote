package dev.mote.collector

import org.json.JSONObject

/** People are references supplied by the existing commitment projection. A
 * person identity is the exact `personMemoryId`; titles, labels and names never
 * group or merge rows. The Memory body itself is always read from its own
 * current Central endpoint. */
internal object MemoryPeoplePresentation {
    data class Person(val memoryId: String, val commitments: List<JSONObject>) {
        val commitmentCount get() = commitments.size
        val matterCount get() = commitments.mapNotNull { it.optString("matterId").takeIf(String::isNotBlank) }.toSet().size
        val signature get() = memoryId + ":" + commitments.joinToString(",") { it.optString("id") + "@" + it.optInt("revision") }
    }

    fun scope() = JSONObject().put("kind", "all")

    fun path(cursor: String? = null): String = buildString {
        append("/api/assistant/commitments?scope=").append(CentralScreens.encode(scope().toString())).append("&limit=50")
        if (!cursor.isNullOrBlank()) append("&cursor=").append(CentralScreens.encode(cursor))
    }

    /** Group only by the exact server-provided memory identity. Null identities
     * are not inferred from a title, so a person without a link stays absent. */
    fun groups(page: JSONObject): List<Person> {
        val items = page.optJSONArray("items") ?: return emptyList()
        val found = linkedMapOf<String, MutableList<JSONObject>>()
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            val id = item.optString("personMemoryId")
            if (!isUuid(id)) continue
            found.getOrPut(id) { mutableListOf() }.add(item)
        }
        return found.map { (id, values) -> Person(id, values) }
    }

    /** The current Memory detail for one exact person identity. A missing,
     * deleted or no-longer-readable body yields null instead of a stale row. */
    fun person(client: CentralClient, id: String): JSONObject? = try {
        val row = client.get("/api/memories/" + CentralScreens.encode(id))
        row.takeIf { it.optString("id") == id && it.optInt("version", 0) >= 1 }
    } catch (error: CentralFailure) {
        if (error.status in setOf(403, 404, 410)) null else throw error
    }

    /** The stored replacement link only; the client never computes identity from
     * matching titles or timestamps. */
    fun replacement(row: JSONObject): String? =
        row.optString("supersededBy").takeIf(::isUuid)

    private val uuid = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
    fun isUuid(value: String) = uuid.matches(value)

    fun stateLabel(row: JSONObject, now: Long = System.currentTimeMillis()): String {
        val replacement = replacement(row)
        val supersededAt = row.optString("supersededAt").takeIf(String::isNotBlank)
        if (replacement != null && (supersededAt == null || runCatching { java.time.Instant.parse(supersededAt).toEpochMilli() }.getOrDefault(0) <= now)) {
            return MoteI18n.text("已由新版本替代")
        }
        val validUntil = row.optString("validUntil").takeIf(String::isNotBlank)
        if (validUntil != null && runCatching { java.time.Instant.parse(validUntil).toEpochMilli() }.getOrDefault(Long.MAX_VALUE) <= now) {
            return MoteI18n.text("已过期")
        }
        return when (row.optString("status")) {
            "stale" -> MoteI18n.text("需要重验")
            "proposed" -> MoteI18n.text("待重新处理")
            "published" -> MoteI18n.text("已生效")
            else -> row.optString("status")
        }
    }
}
