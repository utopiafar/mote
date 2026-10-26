package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder

/** Transient original-fact digest. Never saved in a capture or used as an upload receipt. */
internal object CaptureLibraryVersion {
    private val instant = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    private fun time(value: String) = instant.format(Instant.parse(value))
    fun of(original: JSONObject, blobHash: String? = null): String {
        val value = JSONObject()
        val fields = listOf("id", "deviceId", "deviceName", "platform", "capturedAt", "durationMs", "appId", "appName", "windowTitle", "ocrText", "source", "stateSeries", "ocr", "mood", "provenance", "metadata", "privacy")
        fields.filter(original::has).forEach { value.put(it, original.get(it)) }
        // Work on an independent copy; normalization must not alter evidence.
        val copy = JSONObject(value.toString())
        listOf("appId", "appName", "windowTitle", "ocrText").filterNot(copy::has).forEach { copy.put(it, "") }
        if (!copy.has("source")) copy.put("source", "screen")
        val privacy = copy.optJSONObject("privacy") ?: JSONObject().also { copy.put("privacy", it) }
        if (!privacy.has("excluded")) privacy.put("excluded", false)
        if (!privacy.has("redacted")) privacy.put("redacted", false)
        if (!privacy.has("mode")) privacy.put("mode", "local")
        copy.optJSONObject("provenance")?.let { if (!it.has("deleted")) it.put("deleted", false) }
        copy.put("capturedAt", time(copy.getString("capturedAt")))
        copy.optJSONObject("stateSeries")?.optJSONArray("samples")?.let { samples -> repeat(samples.length()) { val sample = samples.getJSONObject(it); sample.put("at", time(sample.getString("at"))) } }
        val metadata = copy.optJSONObject("metadata"); val page = metadata?.optJSONObject("uiPage")
        if (page?.optInt("version") == 3) {
            metadata.put("observedAt", time(metadata.getString("observedAt")))
            page.getJSONObject("observations").apply { put("firstAt", time(getString("firstAt"))); put("lastAt", copy.getString("capturedAt")) }
        }
        copy.put("blobHash", blobHash?.takeIf(String::isNotBlank) ?: JSONObject.NULL)
        return SourceRules.hash(canonical(copy))
    }
    private fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { quote(it) + ":" + canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
        null, JSONObject.NULL -> "null"
        is String -> quote(value)
        is Number -> JSONObject.numberToString(value)
        else -> value.toString()
    }
    private fun quote(value: String) = JSONObject.quote(value).replace("\\/", "/")
}

/** Reuse already stored attachment acknowledgements, with no upload or queue mutation. */
internal fun android.content.Context.captureLibraryVersion(original: JSONObject, blobHash: String?): String {
    val wire = JSONObject(original.toString())
    if (original.optString("source") == "note") {
        recordDraftStore().record(original.getString("id"))?.let { record ->
            val attachments = record.getJSONArray("attachments")
            val acknowledgements = record.getJSONObject("acks")
            val ids = (0 until attachments.length()).map { acknowledgements.optString(attachments.getJSONObject(it).getString("id")) }
            if (ids.isNotEmpty() && ids.all(String::isNotBlank)) {
                val metadata = wire.optJSONObject("metadata") ?: JSONObject().also { wire.put("metadata", it) }
                metadata.put("attachments", JSONArray(ids))
            }
        }
    }
    return CaptureLibraryVersion.of(wire, blobHash)
}
