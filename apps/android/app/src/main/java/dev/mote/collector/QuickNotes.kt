package dev.mote.collector

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.UUID

object QuickNotes {
    fun draft(context: Context) = NoteDraftStore(File(context.noBackupFilesDir, "note-draft"), SecretBox())
    fun save(context: Context, text: String, mood: String): String {
        require(text.isNotBlank() && text.length <= 100_000) { "随手记须为 1..100000 字符" }
        require(mood.length <= 80) { "心情最多 80 字符" }
        val store = draft(context)
        store.update(text, mood)
        val settings = Settings(context); val config = settings.read(); config.validate()
        val prepared = store.prepare(config.server.trimEnd('/')) {
        val id = UUID.randomUUID().toString()
        val event = JSONObject().put("id", id).put("deviceId", settings.deviceId).put("deviceName", config.deviceName)
            .put("platform", "android").put("capturedAt", Instant.now().toString()).put("durationMs", 0)
            .put("appId", "dev.mote.notes").put("appName", "随手记").put("ocrText", text).put("source", "note")
            .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none"))
        if (mood.isNotBlank()) event.put("mood", mood)
        event
        }
        val event = prepared.prepared!!
        context.queue().enqueue(event, null, config.maxQueueMiB * 1024L * 1024L)
        store.clear()
        UploadWorker.schedule(context, config)
        return event.getString("id")
    }
}
