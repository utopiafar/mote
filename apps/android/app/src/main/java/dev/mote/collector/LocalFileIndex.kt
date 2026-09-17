package dev.mote.collector

import org.json.JSONObject
import java.io.InputStream
import java.io.ByteArrayOutputStream
import java.util.zip.ZipInputStream
import java.nio.charset.CodingErrorAction
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.net.HttpURLConnection
import java.net.URL
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper

object LocalFileIndex {
    data class Parsed(val text: String, val parser: String, val status: String = "ready")
    fun bytes(input: InputStream): ByteArray { val out = ByteArrayOutputStream(); val buffer = ByteArray(8192); while (true) { val n = input.read(buffer); if (n < 0) break; check(out.size() + n <= 16 * 1024 * 1024); out.write(buffer, 0, n) }; return out.toByteArray() }
    fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun extract(bytes: ByteArray, mime: String, name: String): Parsed {
        if (mime == "application/pdf" || name.endsWith(".pdf", true)) return PDDocument.load(bytes).use { document ->
            check(document.currentAccessPermission.canExtractContent()); val text = PDFTextStripper().getText(document); check(text.length <= 10000000); Parsed(text, "pdfbox")
        }
        if (name.endsWith(".docx", true)) {
            ZipInputStream(bytes.inputStream()).use { zip ->
                var entry = zip.nextEntry
                while (entry != null) {
                    if (entry.name == "word/document.xml") {
                        val xml = LocalFileIndex.bytes(zip); val reader = javax.xml.parsers.DocumentBuilderFactory.newInstance().apply { setFeature("http://apache.org/xml/features/disallow-doctype-decl", true); setFeature("http://xml.org/sax/features/external-general-entities", false); setFeature("http://xml.org/sax/features/external-parameter-entities", false); isNamespaceAware = true }.newDocumentBuilder()
                        val nodes = reader.parse(xml.inputStream()).getElementsByTagNameNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "p")
                        val text = (0 until nodes.length).joinToString("\n") { nodes.item(it).textContent }; check(text.length <= 10000000); return Parsed(text, "docx")
                    }; entry = zip.nextEntry
                }
            }; return Parsed("", "docx", "unsupported")
        }
        if (mime.startsWith("audio/")) {
            return runCatching {
                val connection = URL("http://127.0.0.1:9009/transcribe").openConnection() as HttpURLConnection
                try { connection.requestMethod = "POST"; connection.instanceFollowRedirects = false; connection.connectTimeout = 2000; connection.readTimeout = 600000; connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/octet-stream"); connection.setRequestProperty("X-Mote-Offline", "1"); connection.setFixedLengthStreamingMode(bytes.size); connection.outputStream.use { it.write(bytes) }; check(connection.responseCode == 200)
                    val transcript = JSONObject(connection.inputStream.use { String(LocalFileIndex.bytes(it), Charsets.UTF_8) }); val segments = transcript.getJSONArray("segments")
                    Parsed((0 until segments.length()).joinToString("\n") { val s = segments.getJSONObject(it); "[${s.getLong("startMs")}-${s.getLong("endMs")} ms] ${s.optString("speaker")} ${s.getString("text")}" }, "local-audio")
                } finally { connection.disconnect() }
            }.getOrElse { Parsed("", "local-audio", "pending") }
        }
        if (mime.startsWith("text/") || name.substringAfterLast('.').lowercase() in setOf("md", "txt", "csv", "json", "ics")) return Parsed(Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString(), "utf8")
        return Parsed("", "unavailable", "unsupported")
    }
    fun index(item: JSONObject, bytes: ByteArray, source: LocalSource) {
        val parsed = extract(bytes, item.optString("mimeType"), item.optString("title")); val text = parsed.text.take(if (source.lightweightIndex) 8000 else 100000)
        item.put("text", text).put("layer", "snapshot").put("document", JSONObject().put("fileIndex", JSONObject().put("version", 1).put("fileId", SourceRules.hash(item.getString("externalId"))).put("contentVersion", hash(bytes)).put("mode", "index").put("coverage", if (text.isEmpty()) "none" else if (text.length == parsed.text.length) "full" else "lightweight").put("status", parsed.status).put("parser", parsed.parser).put("totalCharacters", parsed.text.length).put("offset", 0).put("length", text.length).put("allowRead", source.allowRead)))
    }
}
