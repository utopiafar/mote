package dev.mote.collector.meeting

import dev.mote.collector.ByteCipher
import dev.mote.collector.MoteI18n
import dev.mote.collector.SourceRules
import dev.mote.collector.FileTransfer
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
    val origin: String? = "",
    val archiveFingerprint: String? = null,
    val archiveSha256: String? = null,
    val archiveSizeBytes: Long? = null,
    val quarantined: Boolean = false,
    val localContentRelease: MeetingContentRelease? = null,
) {
    fun json() = JSONObject().put("id", id).put("startedAt", startedAt).put("endedAt", endedAt ?: JSONObject.NULL)
        .put("state", state).put("durationMs", durationMs).put("microphone", microphone).put("systemAudio", systemAudio)
        .put("noticeAcknowledgedAt", noticeAcknowledgedAt).put("audioFile", audioFile ?: JSONObject.NULL)
        .put("uploadedAt", uploadedAt ?: JSONObject.NULL).put("captureId", captureId ?: JSONObject.NULL)
        .put("error", error ?: JSONObject.NULL).put("warnings", JSONArray(warnings))
        .put("origin", origin ?: JSONObject.NULL).put("archiveFingerprint", archiveFingerprint ?: JSONObject.NULL).put("quarantined", quarantined)
        .put("archiveSha256", archiveSha256 ?: JSONObject.NULL).put("archiveSizeBytes", archiveSizeBytes ?: JSONObject.NULL)
        .put("localContentRelease", localContentRelease?.json() ?: JSONObject.NULL)

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
                origin = value.opt("origin") as? String,
                archiveFingerprint = value.opt("archiveFingerprint") as? String,
                archiveSha256 = value.opt("archiveSha256") as? String,
                archiveSizeBytes = (value.opt("archiveSizeBytes") as? Number)?.toLong(),
                quarantined = value.optBoolean("quarantined"),
                localContentRelease = value.optJSONObject("localContentRelease")?.let(MeetingContentRelease::from),
            )
        }
    }
}

internal data class MeetingContentRelease(val at: String, val pending: Boolean, val sourceId: String, val deviceId: String, val audioFile: String) {
    fun json() = JSONObject().put("at", at).put("pending", pending).put("sourceId", sourceId).put("deviceId", deviceId).put("audioFile", audioFile)
    companion object {
        fun from(value: JSONObject): MeetingContentRelease {
            Instant.parse(value.getString("at")); require(value.get("pending") is Boolean)
            val device = value.getString("deviceId"); require(device.isNotBlank() && value.getString("sourceId") == MeetingRecordingItems.sourceId(device))
            val name = value.getString("audioFile"); require(File(name).name == name && name.endsWith(".wav"))
            return MeetingContentRelease(value.getString("at"), value.getBoolean("pending"), value.getString("sourceId"), device, name)
        }
    }
}

/** Formal local recordings remain on disk after exact archive confirmation. */
internal class MeetingRecordingStore(private val directory: File, private val cipher: ByteCipher) {
    companion object { private val lock = Any() }
    private val stateFile = File(directory, "state.enc")

    init { directory.mkdirs() }

    fun read(): JSONObject = synchronized(lock) { if (stateFile.exists()) JSONObject(String(cipher.open(stateFile.readBytes()), Charsets.UTF_8))
        else JSONObject().put("version", 1).put("sessions", JSONArray()) }

    fun sessions(): List<MeetingSession> = synchronized(lock) {
        val records = read().optJSONArray("sessions") ?: JSONArray()
        return@synchronized (0 until records.length()).mapNotNull { index -> runCatching { MeetingSession.from(records.getJSONObject(index)) }.getOrNull() }
    }

    fun noticeAcknowledgedAt(): String? = synchronized(lock) { read().optString("noticeAcknowledgedAt").takeIf { it.isNotBlank() } }

    fun acknowledgeNotice(at: Instant = Instant.now()): String = synchronized(lock) {
        val state = read(); val value = state.optString("noticeAcknowledgedAt").takeIf { it.isNotBlank() } ?: at.toString()
        state.put("noticeAcknowledgedAt", value); write(state); return@synchronized value
    }

    fun begin(id: String, startedAt: Instant, noticeAcknowledgedAt: String, origin: String = ""): MeetingSession = synchronized(lock) {
        require(this.noticeAcknowledgedAt() == noticeAcknowledgedAt) { MoteI18n.text("开始前告知在场的人") }
        require(!sessions().any { it.state == "recording" })
        val session = MeetingSession(id, startedAt.toString(), null, "recording", 0, false, false, noticeAcknowledgedAt, origin = origin.trim().trimEnd('/'))
        val state = read(); state.getJSONArray("sessions").put(session.json()); write(state); return@synchronized session
    }

    fun complete(id: String, endedAt: Instant, durationMs: Long, microphone: Boolean, systemAudio: Boolean,
                              audioFile: String, warnings: List<String>): MeetingSession = synchronized(lock) {
        require(microphone || systemAudio) { MoteI18n.text("会议录音至少需要麦克风或系统音频") }
        val current = sessions().firstOrNull { it.id == id && it.state == "recording" } ?: error(MoteI18n.text("会议录音会话不存在"))
        val session = current.copy(endedAt = endedAt.toString(), state = "completed", durationMs = durationMs.coerceIn(0, 24 * 60 * 60 * 1000),
            microphone = microphone, systemAudio = systemAudio, audioFile = audioFile, warnings = warnings.take(20).map { it.take(500) })
        replace(session); return@synchronized session
    }

    fun fail(id: String, error: String): MeetingSession? = synchronized(lock) {
        val current = sessions().firstOrNull { it.id == id } ?: return@synchronized null
        val session = current.copy(state = "failed", error = error.take(500)); replace(session); return@synchronized session
    }

    fun markUploaded(expected: MeetingSession, captureId: String, origin: String, manifest: JSONObject, at: Instant = Instant.now()): MeetingSession? = synchronized(lock) {
        val current = sessions().firstOrNull { it.id == expected.id } ?: return@synchronized null
        check(current == expected && current.state == "completed" && !current.quarantined && (current.origin == "" || current.origin == origin))
        UUID.fromString(captureId)
        val session = current.copy(state = "uploaded", uploadedAt = at.toString(), captureId = captureId, error = null, origin = origin,
            archiveFingerprint = SourceRules.hash(SourceRules.canonical(manifest)), archiveSha256 = manifest.getString("sha256"), archiveSizeBytes = manifest.getLong("sizeBytes"))
        replace(session); return@synchronized session
    }
    fun quarantine(session: MeetingSession) = synchronized(lock) {
        if (sessions().find { it.id == session.id } == session && !session.quarantined) replace(session.copy(quarantined = true))
    }
    /** No proof upgrade: incomplete old receipts keep their only local input. */
    fun releaseContent(id: String, deviceId: String, authorize: () -> Unit) = synchronized(lock) {
        authorize()
        val current = sessions().first { it.id == id }
        check(current.state == "uploaded" && !current.quarantined && !current.origin.isNullOrBlank() && current.uploadedAt != null)
        UUID.fromString(current.captureId); Instant.parse(current.uploadedAt)
        check(current.archiveSha256?.matches(Regex("[a-f0-9]{64}")) == true && (current.archiveSizeBytes ?: 0) > 0 && current.archiveFingerprint?.matches(Regex("[a-f0-9]{64}")) == true)
        val existing = current.localContentRelease
        if (existing != null && !existing.pending) return@synchronized
        val name = existing?.audioFile ?: requireNotNull(current.audioFile)
        require(File(name).name == name && name.endsWith(".wav"))
        val audio = File(directory, name)
        check(!java.nio.file.Files.isSymbolicLink(audio.toPath()) && audio.canonicalFile.parentFile == directory.canonicalFile)
        if (existing == null) {
            val manifest = MeetingRecordingItems.manifest(deviceId, current.copy(state = "completed"), current.archiveSizeBytes!!, current.archiveSha256!!)
            check(SourceRules.hash(SourceRules.canonical(manifest)) == current.archiveFingerprint)
            check(audio.isFile && audio.length() == current.archiveSizeBytes && MeetingRecordingItems.digest(audio) == current.archiveSha256)
        } else check(existing.deviceId == deviceId)
        val release = existing ?: MeetingContentRelease(Instant.now().toString(), true, MeetingRecordingItems.sourceId(deviceId), deviceId, name)
        fun persist(session: MeetingSession) { authorize(); replace(session, authorize); syncDirectory(); dev.mote.collector.LocalStateChanges.changed(records = true) }
        if (existing == null) persist(current.copy(localContentRelease = release))
        val light = current.copy(audioFile = null, warnings = emptyList(), error = null, localContentRelease = release)
        persist(light); authorize()
        if (sessions().none { it.id != id && it.audioFile == name }) {
            check(!audio.exists() || audio.delete()) { MoteI18n.text("无法保存会议录音状态") }; syncDirectory()
        }
        try { persist(light.copy(localContentRelease = release.copy(pending = false))) }
        catch (error: Exception) { runCatching { replace(light) }; throw error }
    }
    private fun syncDirectory() { java.nio.channels.FileChannel.open(directory.toPath(), java.nio.file.StandardOpenOption.READ).use { it.force(true) } }
    fun hasPendingConnectionWork(): Boolean = synchronized(lock) {
        val all = sessions()
        if (all.any { it.state == "recording" || it.uploadedAt == null && it.audioFile != null || it.quarantined }) return@synchronized true
        val confirmed = all.filter { it.uploadedAt != null }.flatMap { listOfNotNull(it.audioFile, it.localContentRelease?.audioFile) }.toSet()
        return@synchronized directory.listFiles()?.any { it.isFile && it.extension == "wav" && it.name !in confirmed } == true
    }

    fun recovery(): List<MeetingSession> = synchronized(lock) {
        val interrupted = sessions().filter { it.state == "recording" }
        interrupted.forEach { fail(it.id, MoteI18n.text("上一次会议录音因应用退出而中断，未自动续录。")) }
        return@synchronized sessions().filter { it.state == "completed" && !it.quarantined }
    }

    private fun replace(session: MeetingSession, authorize: (() -> Unit)? = null) {
        val state = read(); val records = state.getJSONArray("sessions")
        val next = JSONArray()
        for (index in 0 until records.length()) {
            val row = records.getJSONObject(index)
            if (row.getString("id") == session.id) next.put(session.json()) else next.put(row)
        }
        state.put("sessions", next); write(state, authorize)
    }

    private fun write(state: JSONObject, authorize: (() -> Unit)? = null) {
        directory.mkdirs()
        val temp = File(directory, UUID.randomUUID().toString() + ".tmp")
        try {
            FileOutputStream(temp).use { it.write(cipher.seal(state.toString().toByteArray(Charsets.UTF_8))); it.fd.sync() }
            authorize?.invoke()
            check(temp.renameTo(stateFile)) { MoteI18n.text("无法保存会议录音状态") }
        } finally { temp.delete() }
    }
}

internal object MeetingRecordingItems {
    fun sourceId(deviceId: String): String = "local-meeting-" + SourceRules.hash(deviceId).take(24)

    fun manifest(deviceId: String, session: MeetingSession, sizeBytes: Long, sha256: String, mimeType: String = "audio/wav"): JSONObject {
        require(session.state == "completed" && session.endedAt != null && session.audioFile != null)
        require(sizeBytes in 1..FileTransfer.MAX_BYTES)
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
