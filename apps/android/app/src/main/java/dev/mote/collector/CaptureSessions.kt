package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.Base64

/** Observed app continuity only; no inferred tasks, topics or unobserved duration. */
internal object CaptureSessions {
    const val GAP_MS = 300_000L
    private fun groups(rows: List<JSONObject>): List<List<JSONObject>> {
        val result = mutableListOf<MutableList<JSONObject>>()
        for (row in rows.sortedWith(compareBy<JSONObject> { Instant.parse(it.getString("capturedAt")) }.thenBy { it.getString("id") })) {
            val previous = result.lastOrNull()?.lastOrNull()
            if (previous == null || row.optString("appId").isBlank() || previous.optString("appId") != row.optString("appId") ||
                Instant.parse(row.getString("capturedAt")).toEpochMilli() - Instant.parse(previous.getString("capturedAt")).toEpochMilli() > GAP_MS) result.add(mutableListOf())
            result.last().add(row)
        }
        return result
    }
    private fun position(cursor: String?) = cursor?.let { JSONObject(String(Base64.getUrlDecoder().decode(it), Charsets.UTF_8)) }
    private fun cursor(at: String, id: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(JSONObject().put("at", at).put("id", id).toString().toByteArray())
    fun page(rows: List<JSONObject>, cursor: String?, limit: Int = 20): JSONObject {
        require(limit in 1..60)
        val position = position(cursor)
        val groups = groups(rows).map { items ->
            val first = items.first(); val last = items.last()
            JSONObject().put("id", first.getString("id")).put("appId", first.optString("appId")).put("appName", first.optString("appName"))
                .put("firstAt", first.getString("capturedAt")).put("capturedAt", last.getString("capturedAt"))
                .put("after", first.getString("capturedAt")).put("before", Instant.parse(last.getString("capturedAt")).plusMillis(1).toString())
                .put("count", items.size).put("imageCount", items.count { it.optBoolean("hasImage") })
        }.sortedWith(compareByDescending<JSONObject> { Instant.parse(it.getString("firstAt")) }.thenBy { it.getString("id") })
        val page = groups.filter { position == null || Instant.parse(it.getString("firstAt")) < Instant.parse(position.getString("at")) ||
            Instant.parse(it.getString("firstAt")) == Instant.parse(position.getString("at")) && it.getString("id") > position.getString("id") }.take(limit + 1)
        val last = page.take(limit).lastOrNull()
        return JSONObject().put("items", JSONArray(page.take(limit))).put("totalCount", rows.size).put("sessionCount", groups.size).put("gapMs", GAP_MS)
            .put("nextCursor", if (page.size > limit && last != null) cursor(last.getString("firstAt"), last.getString("id")) else JSONObject.NULL)
    }
    fun images(rows: List<JSONObject>, sessionId: String, cursor: String?, limit: Int = 20): JSONObject {
        require(limit in 1..60)
        val members = groups(rows).find { it.first().getString("id") == sessionId } ?: error("Session 已变化或被清理，请刷新分组列表")
        val position = position(cursor)
        val page = members.asReversed().filter { position == null || Instant.parse(it.getString("capturedAt")) < Instant.parse(position.getString("at")) ||
            Instant.parse(it.getString("capturedAt")) == Instant.parse(position.getString("at")) && it.getString("id") < position.getString("id") }.take(limit + 1)
        val items = page.take(limit).map { row -> JSONObject().apply { for (key in listOf("id", "source", "capturedAt", "appId", "appName", "hasImage")) put(key, row.get(key)) } }
        return JSONObject().put("items", JSONArray(items)).put("totalCount", members.size)
            .put("nextCursor", if (page.size > limit) cursor(items.last().getString("capturedAt"), items.last().getString("id")) else JSONObject.NULL)
    }
}
