package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/** Private draft, immutable submission and encrypted attachment originals share one atomic journal. */
internal class RecordDraftStore(private val directory: File, private val cipher: ByteCipher, private val availableBytes: () -> Long = { Long.MAX_VALUE }) {
    private val stateFile = File(directory, "record.enc")
    private fun emptyDraft() = JSONObject().put("text", "").put("description", "").put("attachments", JSONArray()).put("origin", JSONObject().put("kind", "manual"))
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
    @Synchronized fun draft(): JSONObject = JSONObject(state().getJSONObject("draft").toString()).also { if (!it.has("description")) it.put("description", "") }
    @Synchronized fun edit(text: String, attachments: JSONArray, origin: JSONObject, description: String = "", originPresentation: JSONObject? = null) {
        require(text.length <= 100000 && attachments.length() <= 10 && description.length <= 12000)
        val state = state(); val next = JSONObject().put("text", text).put("description", description).put("attachments", attachments).put("origin", origin)
        originPresentation?.let { next.put("originPresentation", it) }
        if (state.getJSONObject("draft").let { old -> old.optString("text") == text && old.optString("description") == description && old.getJSONArray("attachments").toString() == attachments.toString() && old.getJSONObject("origin").toString() == origin.toString() && old.optJSONObject("originPresentation")?.toString() == originPresentation?.toString() }) return
        state.put("draft", next); write(state)
    }
    @Synchronized fun stage(bytes: ByteArray, name: String, mime: String, stagedId: String? = null): JSONObject {
        require(bytes.isNotEmpty() && bytes.size <= CentralAttachments.MAX_BYTES)
        directory.mkdirs(); val id = stagedId?.let { UUID.fromString(it).toString() } ?: UUID.randomUUID().toString()
        atomic(File(directory, "$id.enc"), cipher.seal(bytes))
        return JSONObject().put("id", id).put("name", name.take(250)).put("mime", mime).put("size", bytes.size)
    }

    /** Streams an attachment original into the same store without loading it whole. */
    @Synchronized fun stageFile(source: File, name: String, mime: String, stagedId: String? = null): JSONObject {
        require(source.isFile)
        val size = source.length()
        require(size in 1..CentralAttachments.MAX_BYTES.toLong())
        directory.mkdirs()
        val id = stagedId?.let { UUID.fromString(it).toString() } ?: UUID.randomUUID().toString()
        val target = File(directory, "$id.enc")
        DurableQueue.exclusive {
            val replaced = if (target.exists()) target.length() else 0L
            if (diskBytes() - replaced + size > availableBytes()) throw QueueFull()
            val temp = File(directory, UUID.randomUUID().toString() + ".tmp")
            try {
                FileOutputStream(temp).use { output ->
                    source.inputStream().use { input -> cipher.seal(input, output) }
                    output.fd.sync()
                }
                check(temp.renameTo(target))
            } finally { temp.delete() }
        }
        return JSONObject().put("id", id).put("name", name.take(250)).put("mime", mime).put("size", size)
    }

    /** Appends one staged attachment to the retained draft. */
    @Synchronized fun attach(attachment: JSONObject) {
        UUID.fromString(attachment.getString("id"))
        require(attachment.getLong("size") in 1..CentralAttachments.MAX_BYTES.toLong())
        val state = state(); val draft = state.getJSONObject("draft"); val attachments = draft.getJSONArray("attachments")
        val id = attachment.getString("id")
        if ((0 until attachments.length()).any { attachments.getJSONObject(it).getString("id") == id }) return
        require(attachments.length() < 10) { MoteI18n.text("最多 10 个附件") }
        attachments.put(JSONObject(attachment.toString()))
        write(state)
    }

    @Synchronized fun prepare(origin: String, create: (JSONObject) -> JSONObject): JSONObject {
        val state = state(); val draft = state.getJSONObject("draft")
        require(draft.getString("text").isNotBlank() || draft.getJSONArray("attachments").length() > 0 || draft.getJSONObject("origin").optString("text").isNotBlank()) { MoteI18n.text("请先填写记录") }
        val prepared = draft.optJSONObject("prepared")
        if (prepared != null) { require(draft.getString("server") == origin); return JSONObject(prepared.toString()) }
        val event = create(draft)
        draft.put("prepared", event).put("server", origin)
        state.getJSONObject("records").put(event.getString("id"), JSONObject().put("server", origin).put("attachments", draft.getJSONArray("attachments")).put("acks", JSONObject()).also { record ->
            draft.optJSONObject("originPresentation")?.let { record.put("originPresentation", it) }
        })
        write(state); return JSONObject(event.toString())
    }

    /** The single draft is emptied and its whole previous content is returned for an undo restore. */
    @Synchronized fun clear(): JSONObject {
        val state = state()
        val removed = JSONObject(state.getJSONObject("draft").toString())
        state.put("draft", emptyDraft()); write(state)
        return removed
    }

    /** A draft returned by clear() is restored verbatim, including its prepared submission identity. */
    @Synchronized fun restore(draft: JSONObject) {
        require(draft.optString("text").length <= 100000 && (draft.optJSONArray("attachments")?.length() ?: 0) <= 10 && draft.optString("description").length <= 12000)
        require(draft.optJSONObject("origin") != null)
        val state = state()
        state.put("draft", JSONObject(draft.toString())); write(state)
    }

    /** A journaled submission whose event never reached the durable queue still pins the data origin. */
    fun pendingSubmission(reachedQueue: (String) -> Boolean): Boolean =
        state().getJSONObject("draft").optJSONObject("prepared")?.optString("id")?.takeIf { it.isNotBlank() }?.let { !reachedQueue(it) } == true
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
internal fun android.content.Context.recordDraftStore(): RecordDraftStore = dev.mote.collector.plugins.NotesPlugin.draftStore(this)
