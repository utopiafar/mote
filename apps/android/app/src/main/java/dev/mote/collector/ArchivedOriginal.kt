package dev.mote.collector

import dev.mote.collector.meeting.MeetingSession
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.security.MessageDigest

/** Exact existing Central readers. No retained remote cache or new storage owner. */
internal object ArchivedOriginal {
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun capture(client: CentralClient, local: JSONObject, current: () -> Unit): Pair<JSONObject, ByteArray?> = TransferRequestGuard.within(current) {
        val release = local.getJSONObject(ReleasedCapture.FIELD)
        check(!release.getBoolean("pending")) { MoteI18n.text("操作状态已变化，重新读取后再确认") }
        check(client.server == local.getJSONObject("_archiveAcknowledgment").getString("origin")) { MoteI18n.text("原中央与当前连接不一致，未发送读取请求。") }
        val id = local.getString("id")
        fun detail(): JSONObject = client.get("/api/capture-browser/$id").also {
            current(); check(it.getString("id") == id && it.getString("deviceId") == local.getString("deviceId") &&
                it.getString("source") == local.getString("source") && it.getString("libraryVersion") == release.getString("libraryVersion")) { MoteI18n.text("此版本已变化，返回资料列表重新选择") }
        }
        val record = detail()
        val image = if (release.has("imageSha256")) client.image("/api/capture-browser/$id/image").also {
            current(); check(hash(it) == release.getString("imageSha256")) { MoteI18n.text("中央原件校验确认不匹配") }; detail()
        } else null
        current(); record to image
    }
    /** Validate before opening the selected destination. Audio stays streamed on disk. */
    fun saveMeeting(client: CentralClient, session: MeetingSession, cache: File, destination: () -> OutputStream, current: () -> Unit) = TransferRequestGuard.within(current) {
        val release = requireNotNull(session.localContentRelease)
        check(!release.pending && session.state == "uploaded" && !session.quarantined && session.origin == client.server && session.archiveFingerprint?.matches(Regex("[a-f0-9]{64}")) == true && session.archiveSha256?.matches(Regex("[a-f0-9]{64}")) == true && (session.archiveSizeBytes ?: 0) > 0)
        val id = requireNotNull(session.captureId)
        fun metadata() {
            val file = client.get("/api/files/$id"); current()
            val item = file.getJSONObject("item")
            check(file.getString("captureId") == id && file.getString("sourceId") == release.sourceId &&
                item.getString("externalId") == "meeting:${session.id}" && item.getString("revision") == session.archiveSha256 &&
                file.getString("sha256") == session.archiveSha256 && file.getLong("sizeBytes") == session.archiveSizeBytes) { MoteI18n.text("此版本已变化，返回资料列表重新选择") }
        }
        metadata(); cache.mkdirs()
        val temporary = File.createTempFile("meeting-original-", ".wav", cache)
        try {
            temporary.outputStream().use { client.download("/api/files/$id/content", it, session.archiveSizeBytes!!) }
            current(); check(temporary.length() == session.archiveSizeBytes && dev.mote.collector.meeting.MeetingRecordingItems.digest(temporary) == session.archiveSha256) { MoteI18n.text("中央原件校验确认不匹配") }
            metadata(); current()
            destination().use { output -> temporary.inputStream().use { input ->
                val buffer = ByteArray(65536)
                while (true) { current(); val n = input.read(buffer); current(); if (n < 0) break; output.write(buffer, 0, n) }
                current(); output.flush()
            } }
            current()
        } finally { check(!temporary.exists() || temporary.delete()) }
    }
}
