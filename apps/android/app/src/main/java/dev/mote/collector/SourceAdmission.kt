package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

/** Local authorization facts, never sent as a Central receipt or reconstructed
 * from a later source choice. SAF IDs remain opaque provider identities. */
internal object SourceAdmission {
    fun capture(source: LocalSource, at: String = Instant.now().toString()): JSONObject = JSONObject()
        .put("id", UUID.randomUUID().toString()).put("at", at).put("kind", source.kind)
        .put("uri", source.uri ?: JSONObject.NULL).put("tree", source.tree)
        .put("calendarId", source.calendarId ?: JSONObject.NULL)
        .put("daysBefore", source.daysBefore).put("daysAfter", source.daysAfter)
        .put("privacy", privacy(source)).put("scope", scope(source))

    private fun scope(source: LocalSource) = SourceRules.hash(SourceRules.canonical(source.json().apply {
        listOf("enabled", "name", "intervalMinutes", "description", "contextVersion", "contextDirty", "contextTarget").forEach(::remove)
    }))

    private fun privacy(source: LocalSource) = SourceRules.hash(SourceRules.canonical(JSONObject()
        .put("retention", source.retention).put("allowRead", source.allowRead)
        .put("centralProcessingConsent", source.centralProcessingConsent)))

    fun permits(source: LocalSource, item: JSONObject, proof: JSONObject?): Boolean = runCatching {
        require(proof != null && proof.getString("id").isNotBlank())
        require(proof.getString("kind") == source.kind && proof.getString("privacy") == privacy(source))
        SourcePrivacyGate.validate(source, item)
        if (source.kind == "local-files") {
            require(proof.getBoolean("tree") == source.tree)
            val savedUri = proof.getString("uri")
            require(savedUri == source.uri || SafIdentity.root(savedUri, source.tree)?.let { it == SafIdentity.root(source.uri, source.tree) } == true)
            val path = item.optString("_relativePath", item.optString("title"))
            require(SourceRules.include(path, source))
            val parts = path.split('/')
            require(parts.indices.none { index -> SourceRules.patterns(source.excluded).any { it.matches(parts.take(index + 1).joinToString("/")) } })
            val size = item.optJSONObject("metadata")?.optJSONObject("file")?.optLong("sizeBytes") ?: item.optLong("size")
            require(source.maxFileMiB == 0 || size <= source.maxFileMiB * 1024L * 1024L)
        } else if (source.kind == "local-calendar") {
            require(!proof.isNull("calendarId") && proof.getLong("calendarId") == source.calendarId)
            if (source.daysBefore < proof.getInt("daysBefore") || source.daysAfter < proof.getInt("daysAfter")) {
                val at = Instant.parse(proof.getString("at")).toEpochMilli()
                require(SourceRules.withinWindow(item, at - source.daysBefore * 86_400_000L, at + source.daysAfter * 86_400_000L))
            }
        } else require(proof.optString("scope") == scope(source))
        true
    }.getOrDefault(false)

    fun quarantine(): JSONObject = JSONObject().put("at", Instant.now().toString()).put("localPolicy", true)
        .put("reason", "source_scope_changed")

    fun key(item: JSONObject) = item.getString("externalId") + "\u0000" + item.getString("revision")

    /** A revoked pending version is retained even after subsequent widening. */
    fun reconcile(state: JSONObject, source: LocalSource?): Boolean {
        val pending = state.optJSONArray("pending") ?: return false
        val proofs = state.optJSONObject("pendingScopes") ?: JSONObject()
        val next = JSONArray(); val held = state.optJSONArray("quarantine") ?: JSONArray()
        var changed = false
        repeat(pending.length()) { index ->
            val item = pending.getJSONObject(index); val key = key(item); val proof = proofs.optJSONObject(key)
            if (source != null && permits(source, item, proof)) next.put(item)
            else {
                held.put(JSONObject().put("item", item).put("sourceScope", proof ?: JSONObject.NULL).put("policy", quarantine()))
                proofs.remove(key); changed = true
            }
        }
        if (changed) state.put("pending", next).put("pendingScopes", proofs).put("quarantine", held)
        return changed
    }
}
