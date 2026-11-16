package dev.mote.collector.meeting

import dev.mote.collector.CentralUploadClient
import dev.mote.collector.FilePartReceipts
import dev.mote.collector.FileTransfer
import dev.mote.collector.FileUploadConfirmation
import dev.mote.collector.TransferRequestGuard
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** The production audio→manifest→part receipts→exact ACK path also runs on JVM.
 * The adapter owns network conditions and the connection lease, never audio capture. */
internal class MeetingArchiveTransfer(private val store: MeetingRecordingStore, private val directory: File,
    private val deviceId: String, private val origin: String, private val client: CentralUploadClient,
    private val requireCurrent: () -> Unit, private val commitCurrent: ((() -> Unit) -> Unit)) {
    fun flush(): Boolean {
        val pending = store.recovery()
        if (pending.isEmpty()) return !store.hasPendingConnectionWork()
        requireCurrent()
        val registration = post("/api/sources", MeetingRecordingItems.registration(deviceId))
        check(registration.optString("id") == MeetingRecordingItems.sourceId(deviceId) && registration.optBoolean("enabled", true))
        for (session in pending) {
            requireCurrent()
            if (session.origin == null || session.origin.isNotEmpty() && session.origin != origin) { store.quarantine(session); continue }
            val name = session.audioFile ?: continue
            require(File(name).name == name)
            val file = File(directory, name)
            check(file.isFile && file.canonicalFile.parentFile == directory.canonicalFile)
            val size = file.length(); require(size in 1..FileTransfer.MAX_BYTES)
            val hash = MeetingRecordingItems.digest(file)
            val manifest = MeetingRecordingItems.manifest(deviceId, session, size, hash)
            val begun = post("/api/file-sync/v1/uploads", manifest)
            val existing = begun.optJSONObject("ack")
            if (existing != null) { finish(session, file, manifest, existing); continue }
            val uploadId = begun.getString("uploadId"); UUID.fromString(uploadId)
            check(begun.getInt("partBytes") == FileTransfer.PART_BYTES)
            val received = FilePartReceipts(begun, size, "uploadId", uploadId) { after -> bytes("GET", "/api/file-sync/v1/uploads/$uploadId?afterPart=$after", null) }
            file.inputStream().use { input ->
                var part = 0L
                while (part < FileTransfer.count(size)) {
                    requireCurrent()
                    val data = ByteArray(minOf(FileTransfer.PART_BYTES.toLong(), size - part * FileTransfer.PART_BYTES).toInt())
                    var offset = 0
                    while (offset < data.size) { val n = input.read(data, offset, data.size - offset); check(n > 0); offset += n }
                    val response = received.receipt(part) ?: bytes("PUT", "/api/file-sync/v1/uploads/$uploadId/parts/$part", data)
                    FileUploadConfirmation.part(response, FileTransfer.index(part), data); part++
                }
                check(input.read() == -1)
            }
            received.finish()
            val committed = post("/api/file-sync/v1/uploads/$uploadId/commit", JSONObject())
            finish(session, file, manifest, committed)
        }
        return !store.hasPendingConnectionWork()
    }
    private fun post(path: String, body: JSONObject): JSONObject { requireCurrent(); return TransferRequestGuard.within(requireCurrent) { client.post(path, body) } }
    private fun bytes(method: String, path: String, body: ByteArray?): JSONObject { requireCurrent(); return TransferRequestGuard.within(requireCurrent) { client.bytes(method, path, body, "application/octet-stream") } }
    private fun finish(session: MeetingSession, file: File, manifest: JSONObject, ack: JSONObject) {
        val captureId = FileUploadConfirmation.canonicalId(manifest.getString("sourceId"), manifest, ack)
        requireCurrent()
        check(file.length() == manifest.getLong("sizeBytes") && MeetingRecordingItems.digest(file) == manifest.getString("sha256"))
        commitCurrent { checkNotNull(store.markUploaded(session, captureId, origin, manifest)) }
    }
}
