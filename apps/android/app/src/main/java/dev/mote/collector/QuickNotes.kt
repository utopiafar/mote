package dev.mote.collector

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.UUID

object QuickNotes {
    internal val io = java.util.concurrent.Executors.newSingleThreadExecutor()
    fun draft(context: Context) = NoteDraftStore(File(context.noBackupFilesDir, "note-draft"), context.localContentCipher())
    fun save(context: Context, text: String, mood: String): String = save(context, text, mood) { config -> UploadWorker.schedule(context, config) }
    internal fun save(context: Context, text: String, mood: String, scheduleUpload: (CollectorConfig) -> Unit): String = ConnectionGuard.sync { saveCurrent(context, text, mood, scheduleUpload) } ?: throw ConnectionFailure("busy")
    private fun saveCurrent(context: Context, text: String, mood: String, scheduleUpload: (CollectorConfig) -> Unit): String {
        require(text.isNotBlank() && text.length <= 100_000) { "随手记须为 1..100000 字符" }
        require(mood.length <= 80) { "心情最多 80 字符" }
        val store = draft(context)
        store.update(text, mood)
        val settings = Settings(context); val config = settings.read(); config.validate(); settings.ensureDataOrigin(config)
        val prepared = store.prepare(settings.dataOrigin()) {
        val id = UUID.randomUUID().toString()
        val event = JSONObject().put("id", id).put("deviceId", settings.deviceId).put("deviceName", config.deviceName)
            .put("platform", "android").put("capturedAt", Instant.now().toString()).put("durationMs", 0)
            .put("appId", "dev.mote.notes").put("appName", "随手记").put("ocrText", text).put("source", "note")
            .apply { if (config.metadataEnabled) put("metadata", CollectorMetadata.snapshot(context, "manual")) }
            .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none"))
        if (mood.isNotBlank()) event.put("mood", mood)
        event
        }
        val event = prepared.prepared!!
        context.queue().enqueue(event, null, config.maxQueueMiB * 1024L * 1024L)
        SupportEvents.record(context, EventStage.NOTE, EventCode.OK)
        try { scheduleUpload(config) } catch (_: Exception) {
            SupportEvents.record(context, EventStage.NOTE, EventCode.SCHEDULER)
            settings.uploadStatus("随手记已入队，同步调度未完成；草稿保持原提交 ID，可安全重试")
            throw IllegalStateException("随手记已保存在队列；同步调度暂不可用，再次保存会重试同一条记录")
        }
        store.clear()
        return event.getString("id")
    }
}
