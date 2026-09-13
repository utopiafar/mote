package dev.mote.collector

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

data class NoteDraft(val text: String = "", val mood: String = "", val prepared: JSONObject? = null, val server: String? = null)

/** One editable encrypted draft; a prepared submission survives enqueue/clear crash boundaries. */
class NoteDraftStore(private val directory: File, private val cipher: ByteCipher) {
    private val file = File(directory, "draft.enc")
    init { directory.mkdirs() }
    fun read(): NoteDraft = synchronized(lock) {
        if (!file.exists()) return@synchronized NoteDraft()
        val json = JSONObject(String(cipher.open(file.readBytes()), Charsets.UTF_8))
        val text = json.getString("text"); val mood = json.getString("mood")
        require(text.length <= 100000 && mood.length <= 80)
        val event = if (json.has("prepared")) json.getJSONObject("prepared") else null
        if (event != null) {
            UUID.fromString(event.getString("id")); require(event.getString("source") == "note")
            require(event.getString("ocrText") == text && event.optString("mood", "") == if (mood.isBlank()) "" else mood)
        }
        NoteDraft(text, mood, event, if (json.has("server")) json.getString("server") else null)
    }
    fun update(text: String, mood: String): NoteDraft = synchronized(lock) {
        require(text.length <= 100000 && mood.length <= 80) { "随手记最多 100000 字符，心情最多 80 字符" }
        val old = read()
        if (text == old.text && mood == old.mood) return@synchronized old
        NoteDraft(text, mood).also { write(it) } // Only an explicit edit starts a new potential submission.
    }
    fun prepare(server: String, create: (NoteDraft) -> JSONObject): NoteDraft = synchronized(lock) {
        val draft = read(); require(draft.text.isNotBlank()) { "请先填写随手记" }
        if (draft.prepared != null) {
            require(draft.server == server) { "这条随手记已准备发往原节点，请恢复原节点重试；编辑内容后才能作为新记录提交" }
            return@synchronized draft
        }
        draft.copy(prepared = create(draft), server = server).also { write(it) }
    }
    fun clear() = synchronized(lock) { write(NoteDraft()) }
    private fun write(draft: NoteDraft) {
        val value = JSONObject().put("text", draft.text).put("mood", draft.mood).put("prepared", draft.prepared).put("server", draft.server)
        val temp = File(directory, "${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temp).use { out -> out.write(cipher.seal(value.toString().toByteArray(Charsets.UTF_8))); out.fd.sync() }
            check(temp.renameTo(file)) { "无法保存加密草稿" }
        } finally { temp.delete() }
    }
    companion object { private val lock = Any() }
}
