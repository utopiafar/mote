package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/** Private draft, immutable submission and encrypted attachment originals share one atomic journal. */
internal class RecordDraftStore(private val directory: File, private val cipher: ByteCipher, private val availableBytes: () -> Long = { Long.MAX_VALUE }) {
    private val stateFile = File(directory, "record.enc")
    private fun emptyDraft() = JSONObject().put("text", "").put("attachments", JSONArray()).put("origin", JSONObject().put("kind", "manual"))
    private fun state() = if (stateFile.exists()) JSONObject(String(cipher.open(stateFile.readBytes()), Charsets.UTF_8)) else JSONObject().put("draft", emptyDraft()).put("records", JSONObject())
    fun hasPrepared(): Boolean = state().getJSONObject("draft").has("prepared")
    @Synchronized fun diskBytes(): Long = directory.listFiles().orEmpty().filter { it.isFile }.sumOf { it.length() }
    @Synchronized fun pendingMedia(): JSONArray = JSONArray(state().optJSONArray("pendingMedia")?.toString() ?: "[]")
    @Synchronized fun holdMedia(item: JSONObject) {
        val state = state(); val pending = state.optJSONArray("pendingMedia") ?: JSONArray()
        if ((0 until pending.length()).none { pending.getJSONObject(it).getString("id") == item.getString("id") }) pending.put(item)
        state.put("pendingMedia", pending); write(state)
    }
    @Synchronized fun finishMedia(id: String) {
        val state = state(); val pending = state.optJSONArray("pendingMedia") ?: return
        state.put("pendingMedia", JSONArray((0 until pending.length()).map { pending.getJSONObject(it) }.filter { it.getString("id") != id })); write(state)
    }
    @Synchronized fun draft(): JSONObject = JSONObject(state().getJSONObject("draft").toString())
    @Synchronized fun edit(text: String, attachments: JSONArray, origin: JSONObject) {
        require(text.length <= 100000 && attachments.length() <= 10)
        val state = state(); val next = JSONObject().put("text", text).put("attachments", attachments).put("origin", origin)
        if (state.getJSONObject("draft").let { old -> old.optString("text") == text && old.getJSONArray("attachments").toString() == attachments.toString() && old.getJSONObject("origin").toString() == origin.toString() }) return
        state.put("draft", next); write(state)
    }
    @Synchronized fun stage(bytes: ByteArray, name: String, mime: String, stagedId: String? = null): JSONObject {
        require(bytes.isNotEmpty() && bytes.size <= CentralAttachments.MAX_BYTES)
        directory.mkdirs(); val id = stagedId?.let { UUID.fromString(it).toString() } ?: UUID.randomUUID().toString()
        atomic(File(directory, "$id.enc"), cipher.seal(bytes))
        return JSONObject().put("id", id).put("name", name.take(250)).put("mime", mime).put("size", bytes.size)
    }
    @Synchronized fun prepare(origin: String, create: (JSONObject) -> JSONObject): JSONObject {
        val state = state(); val draft = state.getJSONObject("draft")
        require(draft.getString("text").isNotBlank() || draft.getJSONArray("attachments").length() > 0 || draft.getJSONObject("origin").optString("text").isNotBlank()) { MoteI18n.text("请先填写随手记") }
        val prepared = draft.optJSONObject("prepared")
        if (prepared != null) { require(draft.getString("server") == origin); return JSONObject(prepared.toString()) }
        val event = create(draft)
        draft.put("prepared", event).put("server", origin)
        state.getJSONObject("records").put(event.getString("id"), JSONObject().put("server", origin).put("attachments", draft.getJSONArray("attachments")).put("acks", JSONObject()))
        write(state); return JSONObject(event.toString())
    }
    @Synchronized fun finish(id: String) {
        val state = state()
        if (state.getJSONObject("draft").optJSONObject("prepared")?.optString("id") == id) { state.put("draft", emptyDraft()); write(state) }
    }
    @Synchronized fun record(id: String): JSONObject? = state().getJSONObject("records").optJSONObject(id)?.let { JSONObject(it.toString()) }
    @Synchronized fun acknowledge(id: String, attachment: String, captureId: String) {
        UUID.fromString(captureId); val state = state(); val record = state.getJSONObject("records").getJSONObject(id)
        record.getJSONObject("acks").put(attachment, captureId); write(state)
    }
    @Synchronized internal fun acknowledgeExact(identity: ItemUploadIdentity, captureId: String): Boolean {
        UUID.fromString(captureId)
        val state = state(); val record = state.getJSONObject("records").optJSONObject(identity.recordId) ?: return true
        val bound = record.getString("server")
        if (bound.isNotBlank() && bound != identity.origin) return false
        val items = record.getJSONArray("attachments")
        if ((0 until items.length()).none { items.getJSONObject(it).getString("id")==identity.attachmentId }) return false
        val content = bytes(identity.attachmentId)
        val hash = java.security.MessageDigest.getInstance("SHA-256").digest(content).joinToString("") { "%02x".format(it) }
        if (hash != identity.sha256 || content.size.toLong() != identity.sizeBytes) return false
        val acks = record.getJSONObject("acks")
        if (acks.has(identity.attachmentId)) return acks.getString(identity.attachmentId)==captureId
        acks.put(identity.attachmentId,captureId); write(state); return true
    }
    fun bytes(id: String): ByteArray { UUID.fromString(id); return cipher.open(File(directory, "$id.enc").readBytes()) }
    @Synchronized fun prune(retained: (String) -> Boolean) {
        val state = state(); val records = state.getJSONObject("records"); val draft = state.getJSONObject("draft")
        val prepared = draft.optJSONObject("prepared")?.optString("id")
        records.keys().asSequence().toList().filter { it != prepared && !retained(it) }.forEach(records::remove)
        val references = mutableSetOf<String>()
        fun add(files: JSONArray) { for (index in 0 until files.length()) references.add(files.getJSONObject(index).getString("id") + ".enc") }
        add(draft.getJSONArray("attachments")); records.keys().forEach { add(records.getJSONObject(it).getJSONArray("attachments")) }
        write(state)
        directory.listFiles().orEmpty().filter { it.name != stateFile.name && it.name.endsWith(".enc") && it.name !in references && it.lastModified() < System.currentTimeMillis() - 86400000L }.forEach { it.delete() }
    }
    private fun write(value: JSONObject) { directory.mkdirs(); atomic(stateFile, cipher.seal(value.toString().toByteArray(Charsets.UTF_8))) }
    private fun atomic(file: File, bytes: ByteArray) {
        DurableQueue.exclusive {
        if (diskBytes() - (if (file.exists()) file.length() else 0L) + bytes.size > availableBytes()) throw QueueFull()
        val temp = File(directory, UUID.randomUUID().toString() + ".tmp")
        try { FileOutputStream(temp).use { it.write(bytes); it.fd.sync() }; check(temp.renameTo(file)) } finally { temp.delete() }
        }
    }
}
private val recordStores = java.util.concurrent.ConcurrentHashMap<String, RecordDraftStore>()
internal fun android.content.Context.recordDraftStore(): RecordDraftStore {
    LocalDataFormat.requireCurrent(this)
    val app = applicationContext
    val directory = File(app.noBackupFilesDir, "record-draft")
    return recordStores.computeIfAbsent(directory.absolutePath) { RecordDraftStore(directory, app.localContentCipher()) { app.getSharedPreferences("mote", android.content.Context.MODE_PRIVATE).getInt("maxQueue", 256) * 1024L * 1024L - QueueStorage(app).openQueue().stats().bytes - File(app.filesDir, "record-pending").listFiles().orEmpty().sumOf { it.length() } } }
}
