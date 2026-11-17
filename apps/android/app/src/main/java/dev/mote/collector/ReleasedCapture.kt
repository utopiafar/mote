package dev.mote.collector

import org.json.JSONObject
import java.time.Instant
import java.util.UUID

/** The current event format also holds a content-free receipt. Never an upload body. */
internal object ReleasedCapture {
    const val FIELD = "_localContentRelease"
    private val facts = setOf("id", "deviceId", "deviceName", "platform", "source", "capturedAt", "durationMs", "appId", "appName",
        "_archiveOrigin", "_archiveAcknowledgment", "_uploaded", "_archiveMissing", "_uploadConflict", "_reviewHeld", FIELD)
    fun light(event: JSONObject, release: JSONObject): JSONObject = JSONObject().also { next ->
        facts.filter(event::has).forEach { next.put(it, event.get(it)) }
        event.optJSONObject("_archiveAcknowledgment")?.let { next.put("_archiveOrigin", it.getString("origin")) }
        next.put(FIELD, JSONObject(release.toString()).put("cleared", true))
    }
    fun validate(event: JSONObject) {
        if (!event.has(FIELD)) return
        val release = event.getJSONObject(FIELD)
        require(release.get("pending") is Boolean && release.get("cleared") is Boolean && release.getLong("at") > 0)
        require(release.getBoolean("pending") || release.getBoolean("cleared"))
        for (key in listOf("version", "libraryVersion")) require(release.getString(key).matches(Regex("[a-f0-9]{64}")))
        require(!release.has("imageSha256") || release.getString("imageSha256").matches(Regex("[a-f0-9]{64}")))
        val ack = event.getJSONObject("_archiveAcknowledgment")
        require(event.optBoolean("_uploaded") && ack.getLong("at") > 0 && ack.getString("origin").isNotBlank() && ack.getString("version") == release.getString("version"))
        UUID.fromString(event.getString("id")); Instant.parse(event.getString("capturedAt"))
        require(event.getString("source") in setOf("screen", "note", "activity", "ui_page", "notification", "device_event", "media"))
        if (release.getBoolean("cleared")) require(event.keys().asSequence().all { it in facts } && event.getString("_archiveOrigin") == ack.getString("origin"))
    }
}
