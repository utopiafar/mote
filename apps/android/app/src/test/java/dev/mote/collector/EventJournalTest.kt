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
    @Test fun `safe failure metadata survives reopen but arbitrary names paths and forged fields do not`() {
        val path = File(folder.root, "safe-events.json")
        val source = "android-c919bc95-272d-4094-92a1-7f9c0ae944ca"
        val failure = java.io.IOException("PRIVATE_TOKEN_AND_PATH")
        val journal = EventJournal(path)
        journal.record(EventStage.FILE_UPLOAD, EventJournal.failure(failure, EventStage.FILE_UPLOAD), errorName = EventJournal.errorName(failure), sourceId = source)
        journal.record(EventStage.SOURCE, EventCode.OTHER, errorName = "PRIVATE_CLASS", sourceId = "PRIVATE_PATH")
        val rows = EventJournal(path).read()
        assertEquals("IOException", rows.getJSONObject(0).getString("errorName"))
        assertEquals("network", rows.getJSONObject(0).getString("code"))
        assertEquals(source, rows.getJSONObject(0).getString("sourceId"))
        assertFalse(rows.getJSONObject(1).has("errorName")); assertFalse(rows.getJSONObject(1).has("sourceId"))
        assertFalse(path.readText().contains("PRIVATE"))
        val permissions = java.nio.file.Files.getPosixFilePermissions(path.toPath())
        assertEquals(setOf(java.nio.file.attribute.PosixFilePermission.OWNER_READ, java.nio.file.attribute.PosixFilePermission.OWNER_WRITE), permissions)
        rows.getJSONObject(0).put("errorName", "PRIVATE_NAME").put("sourceId", "PRIVATE_FILENAME")
        path.writeText(rows.toString())
        assertFalse(journal.read().toString().contains("PRIVATE"))
    }
    @Test fun `runtime failure log retains operational level and bounded private rotation without arbitrary detail`() {
        val path = File(folder.root, "safe-runtime.log")
        val log = RuntimeLog(path, 2, policy = { RuntimeLogPolicy(true, "info") })
        log.event(EventStage.SOURCE, EventCode.STARTED, errorName = "Error")
        assertFalse(path.exists())
        repeat(20) { index ->
            log.event(EventStage.UPLOAD, EventCode.NETWORK, elapsedMs = index.toLong(), errorName = EventJournal.errorName(java.io.IOException("PRIVATE_BODY")), sourceId = "PRIVATE_FILENAME")
        }
        assertEquals(7, folder.root.listFiles()!!.count { it.name.startsWith("safe-runtime.log") })
        val raw = log.exportRange(0, System.currentTimeMillis() + 1).getString("text")
        assertEquals(14, raw.lines().size)
        assertTrue(raw.contains("errorName=IOException")); assertFalse(raw.contains("PRIVATE")); assertFalse(raw.contains("STARTED"))
        for (file in folder.root.listFiles()!!.filter { it.name.startsWith("safe-runtime.log") }) {
            assertEquals(2, file.readLines().size)
            assertEquals(setOf(java.nio.file.attribute.PosixFilePermission.OWNER_READ, java.nio.file.attribute.PosixFilePermission.OWNER_WRITE), java.nio.file.Files.getPosixFilePermissions(file.toPath()))
        }
    }

    @Test fun `runtime settings affect new events without removing retained history`() {
        val path = File(folder.root, "levels.log")
        var policy = RuntimeLogPolicy.defaults(false)
        val log = RuntimeLog(path, policy = { policy })
        log.event(EventStage.UPLOAD, EventCode.STARTED)
        log.event(EventStage.UPLOAD, EventCode.OK)
        policy = RuntimeLogPolicy(true, "debug")
        log.event(EventStage.UPLOAD, EventCode.STARTED)
        policy = RuntimeLogPolicy(true, "warn")
        log.event(EventStage.UPLOAD, EventCode.OK)
        log.event(EventStage.UPLOAD, EventCode.WAIT_NETWORK)
        log.event(EventStage.UPLOAD, EventCode.AUTH)
        policy = RuntimeLogPolicy(true, "error")
        log.event(EventStage.UPLOAD, EventCode.WAIT_NETWORK)
        log.event(EventStage.UPLOAD, EventCode.AUTH)
        policy = RuntimeLogPolicy(false, "debug")
        log.event(EventStage.UPLOAD, EventCode.AUTH)
        val lines = log.readRaw().lines().filter(String::isNotBlank)
        assertEquals(5, lines.size)
        assertTrue(lines[0].contains("INFO")); assertTrue(lines[1].contains("DEBUG"))
        assertTrue(lines[2].contains("WARN")); assertTrue(lines[3].contains("AUTH")); assertTrue(lines[4].contains("AUTH"))
        assertEquals("debug", RuntimeLogPolicy.defaults(true).level)
    }

}
