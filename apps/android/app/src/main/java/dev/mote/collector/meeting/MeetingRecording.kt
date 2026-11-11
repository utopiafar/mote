package dev.mote.collector.meeting

import dev.mote.collector.ByteCipher
import dev.mote.collector.MoteI18n
import dev.mote.collector.SourceRules
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

const val MEETING_SOURCE_KIND = "local-meeting-recording"

internal data class MeetingSession(
    val id: String,
    val startedAt: String,
    val endedAt: String?,
    val state: String,
    val durationMs: Long,
    val microphone: Boolean,
    val systemAudio: Boolean,
    val noticeAcknowledgedAt: String,
    val audioFile: String? = null,
    val uploadedAt: String? = null,
    val captureId: String? = null,
    val error: String? = null,
    val warnings: List<String> = emptyList(),
) {
    fun json() = JSONObject().put("id", id).put("startedAt", startedAt).put("endedAt", endedAt ?: JSONObject.NULL)
        .put("state", state).put("durationMs", durationMs).put("microphone", microphone).put("systemAudio", systemAudio)
        .put("noticeAcknowledgedAt", noticeAcknowledgedAt).put("audioFile", audioFile ?: JSONObject.NULL)
        .put("uploadedAt", uploadedAt ?: JSONObject.NULL).put("captureId", captureId ?: JSONObject.NULL)
        .put("error", error ?: JSONObject.NULL).put("warnings", JSONArray(warnings))

    companion object {
        fun from(value: JSONObject): MeetingSession {
            val state = value.getString("state")
            require(state in setOf("recording", "completed", "uploaded", "failed"))
            val id = value.getString("id"); require(id.matches(Regex("[a-f0-9-]{36}")))
            return MeetingSession(
                id = id, startedAt = value.getString("startedAt"),
                endedAt = value.optString("endedAt").takeIf { it.isNotBlank() && !value.isNull("endedAt") },
                state = state, durationMs = value.optLong("durationMs"), microphone = value.optBoolean("microphone"),
                systemAudio = value.optBoolean("systemAudio"), noticeAcknowledgedAt = value.getString("noticeAcknowledgedAt"),
                audioFile = value.optString("audioFile").takeIf { it.isNotBlank() && !value.isNull("audioFile") },
                uploadedAt = value.optString("uploadedAt").takeIf { it.isNotBlank() && !value.isNull("uploadedAt") },
                captureId = value.optString("captureId").takeIf { it.isNotBlank() && !value.isNull("captureId") },
                error = value.optString("error").takeIf { it.isNotBlank() && !value.isNull("error") },
                warnings = (value.optJSONArray("warnings") ?: JSONArray()).let { array -> (0 until array.length()).map { array.getString(it) } },
            )
        }
    }
}

/** One durable local queue. A completed session is uploaded once, then its
 * temporary WAV is removed. No scheduler in this store starts a microphone. */
internal class MeetingRecordingStore(private val directory: File, private val cipher: ByteCipher) {
    private val stateFile = File(directory, "state.enc")

    init { directory.mkdirs() }

    @Synchronized fun read(): JSONObject = if (stateFile.exists()) JSONObject(String(cipher.open(stateFile.readBytes()), Charsets.UTF_8))
        else JSONObject().put("version", 1).put("sessions", JSONArray())

    @Synchronized fun sessions(): List<MeetingSession> {
        val records = read().optJSONArray("sessions") ?: JSONArray()
        return (0 until records.length()).mapNotNull { index -> runCatching { MeetingSession.from(records.getJSONObject(index)) }.getOrNull() }
    }

    @Synchronized fun noticeAcknowledgedAt(): String? = read().optString("noticeAcknowledgedAt").takeIf { it.isNotBlank() }

    @Synchronized fun acknowledgeNotice(at: Instant = Instant.now()): String {
        val state = read(); val value = state.optString("noticeAcknowledgedAt").takeIf { it.isNotBlank() } ?: at.toString()
        state.put("noticeAcknowledgedAt", value); write(state); return value
    }

    @Synchronized fun begin(id: String, startedAt: Instant, noticeAcknowledgedAt: String): MeetingSession {
        require(this.noticeAcknowledgedAt() == noticeAcknowledgedAt) { MoteI18n.text("开始前请先确认已告知在场的人。") }
        require(!sessions().any { it.state == "recording" })
        val session = MeetingSession(id, startedAt.toString(), null, "recording", 0, false, false, noticeAcknowledgedAt)
        val state = read(); state.getJSONArray("sessions").put(session.json()); write(state); return session
    }

    @Synchronized fun complete(id: String, endedAt: Instant, durationMs: Long, microphone: Boolean, systemAudio: Boolean,
                              audioFile: String, warnings: List<String>): MeetingSession {
        require(microphone || systemAudio) { MoteI18n.text("会议录音至少需要麦克风或系统音频") }
        val current = sessions().firstOrNull { it.id == id && it.state == "recording" } ?: error(MoteI18n.text("会议录音会话不存在"))
        val session = current.copy(endedAt = endedAt.toString(), state = "completed", durationMs = durationMs.coerceIn(0, 24 * 60 * 60 * 1000),
            microphone = microphone, systemAudio = systemAudio, audioFile = audioFile, warnings = warnings.take(20).map { it.take(500) })
        replace(session); return session
    }

    @Synchronized fun fail(id: String, error: String): MeetingSession? {
        val current = sessions().firstOrNull { it.id == id } ?: return null
        val session = current.copy(state = "failed", error = error.take(500)); replace(session); return session
    }

    @Synchronized fun markUploaded(id: String, captureId: String, at: Instant = Instant.now()): MeetingSession? {
        val current = sessions().firstOrNull { it.id == id } ?: return null
        val session = current.copy(state = "uploaded", uploadedAt = at.toString(), captureId = captureId, error = null)
        replace(session); return session
    }

    @Synchronized fun recovery(): List<MeetingSession> {
        val interrupted = sessions().filter { it.state == "recording" }
        interrupted.forEach { fail(it.id, MoteI18n.text("上一次会议录音因应用退出而中断，未自动续录。")) }
        return sessions().filter { it.state == "completed" }
    }

    private fun replace(session: MeetingSession) {
        val state = read(); val records = state.getJSONArray("sessions")
        val next = JSONArray()
        for (index in 0 until records.length()) {
            val row = records.getJSONObject(index)
            if (row.getString("id") == session.id) next.put(session.json()) else next.put(row)
        }
        state.put("sessions", next); write(state)
    }

    private fun write(state: JSONObject) {
        directory.mkdirs()
        val temp = File(directory, UUID.randomUUID().toString() + ".tmp")
        try {
            FileOutputStream(temp).use { it.write(cipher.seal(state.toString().toByteArray(Charsets.UTF_8))); it.fd.sync() }
            check(temp.renameTo(stateFile)) { MoteI18n.text("无法保存会议录音状态") }
        } finally { temp.delete() }
    }
}

internal object MeetingRecordingItems {
    fun sourceId(deviceId: String): String = "local-meeting-" + SourceRules.hash(deviceId).take(24)

    fun manifest(deviceId: String, session: MeetingSession, sizeBytes: Long, sha256: String, mimeType: String = "audio/wav"): JSONObject {
        require(session.state == "completed" && session.endedAt != null && session.audioFile != null)
        require(sizeBytes in 1..512L * 1024 * 1024)
        require(sha256.matches(Regex("[a-f0-9]{64}")))
        val meeting = JSONObject().put("version", 1).put("startedAt", session.startedAt).put("endedAt", session.endedAt)
            .put("durationMs", session.durationMs).put("microphone", session.microphone).put("systemAudio", session.systemAudio)
            .put("noticeAcknowledgedAt", session.noticeAcknowledgedAt).put("platform", "android").put("warnings", JSONArray(session.warnings))
        val item = JSONObject().put("externalId", "meeting:${session.id}").put("revision", sha256)
            .put("observedAt", session.endedAt).put("title", MoteI18n.text("本机会议录音") + " · " + session.startedAt.take(16).replace('T', ' '))
            .put("kind", "file").put("layer", "original").put("text", "").put("mimeType", mimeType).put("deleted", false)
            .put("document", JSONObject().put("recordedAt", session.startedAt).put("timeBasis", "recorded").put("contentRole", "other")
                .put("originalMetadata", JSONObject().put("meeting", meeting)))
        return JSONObject().put("sourceId", sourceId(deviceId)).put("previousRevision", JSONObject.NULL).put("sha256", sha256)
            .put("sizeBytes", sizeBytes).put("relativePath", "meetings/${session.id}.wav").put("item", item)
    }

    fun registration(deviceId: String): JSONObject = JSONObject().put("id", sourceId(deviceId))
        .put("name", MoteI18n.text("本机会议录音")).put("kind", MEETING_SOURCE_KIND).put("deviceId", deviceId)
        .put("platform", "android").put("retention", "archive").put("enabled", true)

    fun digest(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer = ByteArray(256 * 1024); while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) } }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
