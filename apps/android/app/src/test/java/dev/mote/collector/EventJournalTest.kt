package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.net.SocketTimeoutException
import javax.net.ssl.SSLException

class EventJournalTest {
    @org.junit.Test fun fileTransportFailuresAndCancellationKeepTheirCategory() {
        assertEquals(EventCode.NETWORK, EventJournal.failure(java.io.IOException("synthetic private URL"), EventStage.FILE_PART))
        assertEquals(EventCode.RESPONSE, EventJournal.failure(IllegalStateException("synthetic response"), EventStage.FILE_COMMIT))
        assertEquals(EventCode.CANCELLED, EventJournal.failure(java.util.concurrent.CancellationException("synthetic"), EventStage.UI))
        assertEquals(EventCode.STORAGE, EventJournal.failure(java.io.IOException("synthetic path"), EventStage.FILE_PREPARE))
    }

    @org.junit.Test fun rawTextIsNotParsedAndLevelsArePersisted() {
        val path = File(folder.root, "raw-events.json")
        val journal = EventJournal(path)
        assertEquals("", journal.readRaw())
        val raw = "  {\"level\":\"debug\"}\nmalformed <script>中文</script>\n"
        path.writeText(raw)
        assertEquals(raw, journal.readRaw())
        assertEquals(raw, path.readText())
        path.delete()
        journal.record(EventStage.MODEL, EventCode.STARTED)
        journal.record(EventStage.MODEL, EventCode.OK)
        journal.record(EventStage.OCR, EventCode.SCHEDULER)
        journal.record(EventStage.UPLOAD, EventCode.AUTH)
        val rows = journal.read()
        assertEquals(listOf("debug", "info", "warn", "error"), (0 until rows.length()).map { rows.getJSONObject(it).getString("level") })
        assertEquals(path.readText(), journal.readRaw())
    }

    @Test fun `strict viewer detects corruption and preserves file`() {
        val path = File(folder.root, "broken.json")
        val journal = EventJournal(path)
        assertEquals(0, journal.read(strict = true).length())
        path.writeText("broken generated fixture")
        assertTrue(runCatching { journal.read(strict = true) }.isFailure)
        assertEquals("broken generated fixture", path.readText())
    }
    @get:Rule val folder = TemporaryFolder()
    @Test fun `journal remains bounded after reopen and never exports arbitrary fields`() {
        val path = File(folder.root, "events.json"); val journal = EventJournal(path, 3)
        repeat(9) { journal.record(EventStage.UPLOAD, EventCode.OK, elapsedMs = it.toLong(), httpStatus = 200) }
        val saved = EventJournal(path, 3).read(); assertEquals(3, saved.length()); assertEquals(6L, saved.getJSONObject(0).getLong("elapsedMs"))
        saved.getJSONObject(0).put("token", "synthetic-secret").put("message", "synthetic private note").put("url", "https://private.example/token")
        saved.put(JSONObject().put("atMs", 1).put("stage", "untrusted-note-text").put("code", "ok"))
        path.writeText(saved.toString())
        val sanitized = EventJournal(path).read().toString()
        assertFalse(sanitized.contains("synthetic-secret")); assertFalse(sanitized.contains("private note")); assertFalse(sanitized.contains("private.example")); assertFalse(sanitized.contains("untrusted-note-text"))
    }
    @Test fun `error classification uses types and codes not arbitrary messages`() {
        assertEquals(EventCode.TIMEOUT, EventJournal.failure(RuntimeException("secret", SocketTimeoutException("body")), EventStage.UPLOAD))
        assertEquals(EventCode.TLS, EventJournal.failure(SSLException("https://private"), EventStage.HEARTBEAT))
        assertEquals(EventCode.STORAGE, EventJournal.failure(Exception("token"), EventStage.QUEUE))
        assertEquals(EventCode.AUTH, EventJournal.httpFailure(401)); assertEquals(EventCode.CONFLICT, EventJournal.httpFailure(409))
        assertEquals(EventCode.SERVER, EventJournal.httpFailure(503))
    }
    @Test fun `support sample projection retains only finite numeric allowlist and charging boolean`() {
        val raw = JSONArray().put(JSONObject().put("atMs", 1).put("batteryPct", 50).put("charging", true).put("ocrText", "private").put("token", "secret").put("prompt", "never export").put("ocrMs", "not numeric"))
        val sample = NumericSupport.sanitize(raw).getJSONObject(0)
        assertEquals(setOf("atMs", "batteryPct", "charging"), sample.keys().asSequence().toSet())
    }
}
