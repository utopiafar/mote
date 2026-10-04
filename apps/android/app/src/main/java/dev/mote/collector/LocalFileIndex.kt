package dev.mote.collector

import org.json.JSONObject
import java.security.MessageDigest

/** Mechanical input metadata only. Central owns decoding, transcription and indexing. */
object LocalFileIndex {
    const val VERSION = 1
    fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun pending(item: JSONObject, inputVersion: String, source: LocalSource) {
        item.put("text", "").put("document", JSONObject().put("fileIndex", JSONObject().put("version", VERSION)
            .put("fileId", SourceRules.hash(item.getString("externalId"))).put("contentVersion", inputVersion)
            .put("mode", "index").put("coverage", "none").put("status", "pending").put("parser", "central-pending").put("maxIndexCharacters", 100000)
            .put("totalCharacters", 0).put("offset", 0).put("length", 0).put("allowRead", source.allowRead)))
    }
}
