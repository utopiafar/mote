package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/** Small volatile overlap cache. Every accepted observation is already in the durable queue. */
internal class UiPageMerge {
    private val previous = linkedMapOf<String, JSONObject>()
    @Synchronized fun reset() = previous.clear()
    private fun key(page: JSONObject, context: String): String? {
        val value = page.getJSONArray("objects").getJSONObject(0)
        val identity = value.optJSONObject("identity") ?: return null
        return JSONArray(listOf(context, page.getString("adapterId"), page.getString("adapterVersion"), page.getString("appVersion"), value.getString("kind"), identity.getString("type"), identity.getString("value"))).toString()
    }
    @Synchronized fun merge(page: JSONObject, context: String): JSONObject {
        val id = key(page, context) ?: return page
        val old = previous[id] ?: return page
        if (old.getJSONObject("observations").getInt("count") >= 256) return page
        val before = old.getJSONArray("objects").getJSONObject(0)
        val after = page.getJSONArray("objects").getJSONObject(0)
        // A changed title/author or other scalar is a new observation, never an inferred revision.
        if (listOf("title", "author", "url", "itemId").any { before.optString(it) != after.optString(it) }) return page
        val first = before.getJSONArray("body").let { blocks -> (0 until blocks.length()).map { blocks.getJSONObject(it).getString("text") } }
        val next = after.getJSONArray("body").let { blocks -> (0 until blocks.length()).map { blocks.getJSONObject(it).getString("text") } }
        val body: List<String>
        if (first == next) body = first
        else {
            val overlap = (minOf(first.size, next.size) downTo 1).firstOrNull { first.takeLast(it) == next.take(it) } ?: 0
            body = if (overlap > 0) first + next.drop(overlap)
            else {
                if (first.isEmpty() || next.isEmpty()) return page
                val left = first.last(); val right = next.first()
                val characters = overlapCharacters(left, right)
                if (characters < 32) return page
                first.dropLast(1) + (left + right.drop(characters)) + next.drop(1)
            }
        }
        // Bounds are transport limits, not a reason to discard the current visible fragment.
        if (body.size > 64 || body.any { it.length > 32000 } || body.sumOf { it.length } + listOf("title", "author", "url", "itemId").sumOf { after.optString(it).length } > 64000) return page
        val result = JSONObject(page.toString())
        result.getJSONArray("objects").getJSONObject(0).put("body", JSONArray(body.map { JSONObject().put("text", it) }))
        val current = result.getJSONObject("observations")
        val history = old.getJSONObject("observations")
        current.put("firstAt", history.getString("firstAt")).put("count", history.getInt("count") + 1)
        // A truncated earlier observation remains incomplete even if this sample is readable.
        if (old.getBoolean("truncated")) result.put("truncated", true).put("status", "partial")
        return result
    }
    /** Linear prefix-function matching keeps long visible paragraphs bounded in CPU as well as bytes. */
    private fun overlapCharacters(left: String, right: String): Int {
        val limit = minOf(left.length, right.length)
        val size = right.length + 1 + limit
        val prefix = IntArray(size)
        fun value(index: Int): Int = when { index < right.length -> right[index].code; index == right.length -> -1; else -> left[left.length - limit + index - right.length - 1].code }
        for (i in 1 until size) {
            var matched = prefix[i - 1]
            while (matched > 0 && value(i) != value(matched)) matched = prefix[matched - 1]
            if (value(i) == value(matched)) matched++
            prefix[i] = matched
        }
        return prefix.last()
    }
    /** Only called after enqueue succeeds; failure cannot consume an unseen fragment. */
    @Synchronized fun accepted(page: JSONObject, context: String) {
        val id = key(page, context) ?: return
        previous.remove(id)
        previous[id] = JSONObject(page.toString())
        while (previous.size > 8 || previous.values.sumOf { UiPageRules.text(it).length } > 256000) previous.remove(previous.keys.first())
    }
}

/** Privacy/state outcomes must never be interpreted as an empty parse. */
internal enum class UiPageOutcome { EXTRACTED, CAPTURED, SAVE_FAILED, EMPTY, PRIVACY_REJECTED, STATE_CHANGED, FAILED }
internal object UiPageCaptureChoice {
    fun screenshot(mode: String, outcome: UiPageOutcome): Boolean = outcome !in setOf(UiPageOutcome.PRIVACY_REJECTED, UiPageOutcome.STATE_CHANGED) &&
        (mode == "screen_only" || outcome in setOf(UiPageOutcome.EMPTY, UiPageOutcome.FAILED))
}
