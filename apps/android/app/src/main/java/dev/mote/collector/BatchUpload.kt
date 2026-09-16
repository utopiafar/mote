package dev.mote.collector

import org.json.JSONObject

object BatchUpload {
    /** Validate the complete receipt before clearing anything. Missing IDs remain pending. */
    fun receipts(expected: Set<String>, response: JSONObject?): Map<String, Int> {
        val items = requireNotNull(response).getJSONArray("results")
        require(items.length() <= expected.size)
        val result = linkedMapOf<String, Int>()
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            val id = item.getString("id")
            val status = item.get("status")
            require(id in expected && id !in result && status is Int && (status in setOf(200, 201) || status in 400..599))
            result[id] = status
        }
        return result
    }
}
