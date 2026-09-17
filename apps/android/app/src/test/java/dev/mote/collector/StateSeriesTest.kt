package dev.mote.collector

import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
import java.util.UUID
import java.nio.file.Files

class StateSeriesTest {
    private fun event(at: String, idle: Int = 0) = JSONObject().put("id", UUID.randomUUID().toString()).put("capturedAt", at).put("durationMs", 5000).put("source", "activity").put("appId", "fixture.app").put("appName", "Generated")
        .put("privacy", JSONObject().put("excluded", false).put("collection", "activity"))
        .put("metadata", JSONObject().put("version", 1).put("state", JSONObject().put("idleSeconds", idle)))
    @Test fun compactedSeriesSurvivesRestartAndOlderAcknowledgement() {
        val dir = Files.createTempDirectory("mote-series").toFile()
        val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
        try {
            val queue = DurableQueue(dir, cipher); val first = event("2026-09-17T00:00:00Z")
            queue.enqueue(first, null, 1000000); queue.enqueue(event("2026-09-17T00:00:05Z", 5), null, 1000000)
            assertEquals(1, queue.depth()); val restored = DurableQueue(dir, cipher)
            val samples = restored.peek()!!.getJSONObject("stateSeries").getJSONArray("samples")
            assertEquals(2, samples.length()); assertEquals(5, samples.getJSONObject(1).getInt("idleSeconds"))
            restored.acknowledge(first.getString("id"), 0, observations = 1)
            assertNotNull(restored.peek())
        } finally { dir.deleteRecursively() }
    }
    @Test fun textAndDocxAreParsedLocally() {
        assertEquals("Generated text", LocalFileIndex.extract("Generated text".toByteArray(), "text/plain", "a.txt").text)
        val bytes = java.io.ByteArrayOutputStream()
        java.util.zip.ZipOutputStream(bytes).use { zip -> zip.putNextEntry(java.util.zip.ZipEntry("word/document.xml")); zip.write("<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>Generated Word</w:t></w:r></w:p></w:body></w:document>".toByteArray()); zip.closeEntry() }
        assertEquals("Generated Word", LocalFileIndex.extract(bytes.toByteArray(), "application/octet-stream", "a.docx").text)
    }
}
