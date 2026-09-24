package dev.mote.collector

import org.json.JSONObject
import java.net.URL
import java.util.UUID

/** Transport identity and durable receipt checks for the intentionally broken
 * v2 collector protocol. A successful HTTP code alone never clears an outbox. */
object IngressV2Protocol {
    const val HEADER = "X-Mote-Ingress-Version"
    const val VERSION = "2"
    private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

    fun uploadWrite(method: String, url: String): Boolean {
        if (method !in setOf("POST", "PUT", "PATCH")) return false
        val path = URL(url).path
        return path == "/api/notes" || path == "/api/captures" || path.startsWith("/api/captures/") ||
            path.startsWith("/api/capture-browser/") || path == "/api/sources" || path.startsWith("/api/sources/") ||
            path.startsWith("/api/file-sync/v1/")
    }

    private fun receipt(envelope: JSONObject?, kind: String, id: String? = null,
                        sourceId: String? = null, externalId: String? = null, revision: String? = null): JSONObject? {
        if (envelope == null) return null
        val value = envelope.optJSONObject("receipt") ?: return null
        if (value.opt("version") !is Int || value.optInt("version") != 2 || value.optString("kind") != kind ||
            value.optString("state") != "received" || value.opt("duplicate") !is Boolean) return null
        val actualId = value.optString("id")
        if (!uuid.matches(actualId) || runCatching { UUID.fromString(actualId) }.isFailure || envelope.optString("id") != actualId || id != null && actualId != id) return null
        if (envelope.has("duplicate") && (envelope.opt("duplicate") !is Boolean || envelope.optBoolean("duplicate") != value.optBoolean("duplicate"))) return null
        if (kind == "capture") {
            if (value.has("sourceId") || value.has("externalId") || value.has("revision")) return null
        } else {
            if (sourceId.isNullOrEmpty() || externalId.isNullOrEmpty() || revision.isNullOrEmpty() ||
                !value.has("sourceId") || !value.has("externalId") || !value.has("revision") ||
                value.optString("sourceId") != sourceId || value.optString("externalId") != externalId || value.optString("revision") != revision ||
                envelope.optString("sourceId") != sourceId || envelope.optString("externalId") != externalId || envelope.optString("revision") != revision) return null
        }
        return value
    }

    fun validCapture(id: String, envelope: JSONObject?) = receipt(envelope, "capture", id) != null
    fun validSource(sourceId: String, body: JSONObject, envelope: JSONObject?) =
        receipt(envelope, "source-item", sourceId = sourceId, externalId = body.optString("externalId"), revision = body.optString("revision")) != null
    fun validFile(sourceId: String, item: JSONObject, envelope: JSONObject?) =
        receipt(envelope, "file-revision", sourceId = sourceId, externalId = item.optString("externalId"), revision = item.optString("revision")) != null

    /** The collector's allowed GET /api/sources lists only its own sources.
     * A 409 is a pause only when that list confirms the source is disabled. */
    fun sourcePaused(sourceId: String, listing: JSONObject?): Boolean {
        val items = listing?.optJSONArray("items") ?: return false
        for (index in 0 until items.length()) {
            val source = items.optJSONObject(index) ?: continue
            if (source.optString("id") == sourceId) return source.opt("enabled") == false
        }
        return false
    }
}
