package dev.mote.collector

import org.json.JSONObject

/** Both saved-conversation readers share the server's history and erasure states.
 * Accepted, queued and running turns have no answer yet; they keep their exact
 * server status visible instead of showing a stale or invented result. */
internal object CentralConversationPresentation {
    data class Turn(val notice: String?, val result: JSONObject?, val status: String = "completed", val error: JSONObject? = null)

    fun read(turn: JSONObject): Turn {
        val status = turn.optString("status").takeIf(String::isNotBlank) ?: "completed"
        val error = turn.optJSONObject("error")
        val result = turn.optJSONObject("result") ?: return Turn(null, null, status, error)
        return when {
            turn.optBoolean("evidenceDeleted") ->
                Turn(MoteI18n.text("相关证据已删除，这条历史回答已清除。可以继续提问查阅现有记录。"), null, status, error)
            turn.optBoolean("evidenceUnavailable") ->
                Turn(MoteI18n.text("引用原文已删除，历史问答仍保留。"), result, status, error)
            turn.optBoolean("evidenceStale") ->
                Turn(MoteI18n.text("这是历史版本，当前资料已更新。"), result, status, error)
            else -> Turn(null, result, status, error)
        }
    }
}
