package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/** Mirrors @mote/shared/native-status; both implementations consume the same fixture. */
internal object NativeStatus {
    fun project(facts: JSONObject): JSONObject {
        fun count(key: String): Any = (facts.opt(key) as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 && it <= 9007199254740991.0 && it % 1 == 0.0 }?.toLong() ?: JSONObject.NULL
        fun optional(value: Any?): Any = value?.takeUnless { it == JSONObject.NULL } ?: JSONObject.NULL
        val pending = count("pending"); val ack = facts.optString("lastAcknowledgedAt").takeUnless { it.isBlank() || it == "null" }
        val acknowledged = facts.optBoolean("archiveAcknowledged") || ack != null
        val state = facts.getString("syncState")
        val error = facts.optString("errorCode").takeUnless { it.isBlank() || it == "null" } ?: when(state) { "unconfigured" -> "connection_required"; "error" -> "transport_error"; else -> null }
        val actions = JSONArray()
        when { state == "unconfigured" -> actions.put("configure_connection"); error == "permission_required" -> actions.put("grant_permission"); state == "paused" -> actions.put("resume_sync"); state != "uploading" -> actions.put("retry_sync") }
        if (state != "unconfigured" && ack != null) actions.put("open_processing")
        val processing = facts.optJSONObject("processing")
        return JSONObject()
            .put("archive", JSONObject().put("state", if (pending == JSONObject.NULL) "unknown" else if ((pending as Long) > 0) { if (!acknowledged) "local" else "partial" } else if (!acknowledged) "unknown" else "acknowledged").put("pending", pending).put("lastAcknowledgedAt", optional(ack)))
            .put("processing", JSONObject().put("state", processing?.optString("state") ?: "unknown").put("allowedActions", processing?.optJSONArray("allowedActions") ?: JSONArray()).put("errorCode", optional(processing?.opt("errorCode"))).put("retryAt", optional(processing?.opt("retryAt"))))
            .put("sync", JSONObject().put("state", state).put("errorCode", optional(error)).put("retryAt", optional(facts.opt("retryAt"))).put("allowedActions", actions))
            .put("coverage", JSONObject().put("state", if (!facts.has("scanComplete") || facts.isNull("scanComplete")) "unknown" else if (facts.getBoolean("scanComplete")) "scanned" else "partial").put("knownItems", count("knownItems")).put("skipped", count("skipped")))
    }
    fun summary(view: JSONObject): String = when(view.getJSONObject("archive").getString("state")) {
        "acknowledged" -> MoteI18n.text("当前待发已获中央确认")
        "partial" -> MoteI18n.text("部分资料已确认，仍有本机待发")
        "local" -> MoteI18n.text("资料保存在本机，等待中央确认")
        else -> MoteI18n.text("资料确认状态待查询")
    } + " · " + MoteI18n.text("中央处理状态待查询，请在中央任务中心查看")
}
