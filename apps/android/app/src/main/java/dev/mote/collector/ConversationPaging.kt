package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/** Stable older-page merge for one conversation. A page may only be prepended
 * while the same server revision is still current; new turns, deletions and
 * withdrawals therefore never get hidden behind a copied stale page. */
internal object ConversationPaging {
    fun merge(current: JSONObject, older: JSONObject): JSONObject {
        val id = current.getString("id")
        require(older.getString("id") == id) { MoteI18n.text("对话状态已变化，请重新读取后继续。") }
        require(current.opt("revision") == older.opt("revision")) { MoteI18n.text("对话状态已变化，请重新读取后继续。") }
        val currentTurns = current.optJSONArray("turns") ?: JSONArray()
        val known = mutableSetOf<String>()
        for (index in 0 until currentTurns.length()) known.add(currentTurns.getJSONObject(index).getString("id"))
        val merged = JSONArray()
        val olderTurns = older.optJSONArray("turns") ?: JSONArray()
        for (index in 0 until olderTurns.length()) {
            val turn = olderTurns.getJSONObject(index)
            if (known.add(turn.getString("id"))) merged.put(JSONObject(turn.toString()))
        }
        for (index in 0 until currentTurns.length()) merged.put(JSONObject(currentTurns.getJSONObject(index).toString()))
        return JSONObject(current.toString()).apply {
            put("turns", merged)
            if (older.has("nextCursor")) put("nextCursor", older.get("nextCursor")) else remove("nextCursor")
        }
    }
}
