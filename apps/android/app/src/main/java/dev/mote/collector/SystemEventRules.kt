package dev.mote.collector

import org.json.JSONObject
import java.time.Instant
import java.util.UUID

internal object SystemEventRules {
    val sources = setOf("notification", "device_event")
    private val contentKeys = setOf("title", "text", "bigText", "subText", "textLines", "channelId")
    fun validate(event: JSONObject) {
        val source = event.getString("source"); require(source in sources)
        require(event.getLong("durationMs") == 0L && event.getString("platform") == "android")
        require(listOf("ocrText", "windowTitle", "mood", "provenance", "imageMime", "imageBase64").none(event::has))
        val metadata = event.getJSONObject("metadata")
        require(!metadata.has("media") && !metadata.has("capture"))
        require(metadata.getInt("version") == 1 && metadata.getJSONObject("collector").getString("method") == "notification_listener")
        Instant.parse(metadata.getString("observedAt"))
        val observation = metadata.getJSONObject("observation")
        UUID.fromString(observation.getString("sessionId")); require(observation.getLong("elapsedRealtimeMs") >= 0)
        if (source == "notification") {
            require(event.getString("appId").isNotBlank() && !metadata.has("deviceEvent"))
            val n = metadata.getJSONObject("notification")
            require(n.getString("action") in setOf("posted", "updated", "removed"))
            require(n.getString("notificationKey").matches(Regex("[a-f0-9]{64}")))
            Instant.parse(n.getString("postedAt")); n.getBoolean("ongoing"); n.getBoolean("groupSummary")
            if (event.getJSONObject("privacy").optString("collection") == "activity" || n.getString("action") == "removed") require(contentKeys.none(n::has))
        } else {
            require(!metadata.has("notification") && !event.has("appId") && !event.has("appName"))
            require(event.getJSONObject("privacy").optString("collection") != "activity")
            val e = metadata.getJSONObject("deviceEvent")
            require(e.getString("action") in setOf("screen_on", "screen_off", "user_present", "state_observed"))
            e.getBoolean("keyguardLocked"); e.getBoolean("screenInteractive")
        }
    }
    fun label(record: JSONObject): String {
        val metadata = record.optJSONObject("metadata") ?: return record.optString("textPreview").ifBlank { "系统事件" }
        val n = metadata.optJSONObject("notification")
        if (n != null) return listOfNotNull(when (n.optString("action")) { "removed" -> "通知已移除"; "updated" -> "通知已更新"; else -> "收到通知" },
            n.optString("title").takeIf(String::isNotBlank), n.optString("text").takeIf(String::isNotBlank),
            n.optString("bigText").takeIf(String::isNotBlank), n.optString("category").takeIf(String::isNotBlank)?.let { "应用声明类别：$it" },
            if (n.optBoolean("ongoing")) "持续通知" else null).distinct().joinToString("\n")
        val e = metadata.optJSONObject("deviceEvent") ?: return "系统事件"
        val action = when (e.optString("action")) { "screen_on" -> "亮屏"; "screen_off" -> "熄屏"; "user_present" -> "用户解锁 / 在场"; else -> "锁定状态观察" }
        return "$action · ${if (e.optBoolean("keyguardLocked")) "系统报告已锁定" else "系统报告未锁定"} · ${if (e.optBoolean("screenInteractive")) "屏幕可交互" else "屏幕不可交互"}"
    }
}
