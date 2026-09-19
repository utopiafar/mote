package dev.mote.collector

import org.json.JSONObject
import java.io.BufferedWriter
import java.io.ByteArrayOutputStream
import java.io.OutputStreamWriter
import java.util.zip.GZIPOutputStream

/**
 * The upload wire format is one gzip-compressed JSONL stream. Keeping one JSON
 * object per line lets the server validate and acknowledge records individually
 * while avoiding hundreds of tiny HTTP requests.
 */
internal object CaptureBundle {
    const val CONTENT_TYPE = "application/x-ndjson+gzip"

    fun encode(events: List<JSONObject>): ByteArray {
        require(events.isNotEmpty())
        val output = ByteArrayOutputStream()
        GZIPOutputStream(output).use { gzip ->
            BufferedWriter(OutputStreamWriter(gzip, Charsets.UTF_8)).use { writer ->
                events.forEach { event ->
                    writer.write(event.toString())
                    writer.newLine()
                }
            }
        }
        return output.toByteArray()
    }
}
