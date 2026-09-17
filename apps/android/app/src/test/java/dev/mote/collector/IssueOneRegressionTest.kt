package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.*
import java.util.UUID
import java.util.zip.*

class IssueOneRegressionTest {
    @get:Rule val folder = TemporaryFolder()
    private val plain = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private fun event(pending: Boolean = false) = JSONObject().put("id", UUID.randomUUID().toString()).put("source", "screen")
        .put("capturedAt", "2026-09-16T00:00:00Z").put("privacy", JSONObject().put("excluded", false))
        .put("imageMime", "image/png").put("ocrText", "generated fixture")
        .put("ocr", JSONObject().put("status", if (pending) "pending" else "completed"))
    @Test fun uploadedImagesRemainBrowsableUntilDeadlineWithoutReuploading() {
        val dir = folder.newFolder(); val queue = DurableQueue(dir, plain); val first = event(); val pending = event()
        queue.enqueue(first, byteArrayOf(1, 2), 2_000_000); queue.enqueue(pending, byteArrayOf(1, 2), 2_000_000)
        queue.acknowledge(first.getString("id"), retentionDays = 7, now = 1000)
        val restarted = DurableQueue(dir, plain)
        assertArrayEquals(byteArrayOf(1, 2), restarted.image(first.getString("id")))
        assertTrue(restarted.capture(first.getString("id"))!!.getBoolean("uploaded"))
        assertEquals(listOf(pending.getString("id")), restarted.peekBatch().map { it.getString("id") })
        assertEquals(1, restarted.pendingPage().getInt("total"))
        assertEquals(0, restarted.pruneUploaded(1000 + 7 * 86_400_000L - 1))
        assertEquals(1, restarted.pruneUploaded(1000 + 7 * 86_400_000L))
        assertArrayEquals(byteArrayOf(1, 2), restarted.image(pending.getString("id")))
    }
    @Test fun deferredOcrMustBeAcknowledgedBeforeRetentionAndConflictsNeverExpire() {
        val queue = DurableQueue(folder.newFolder(), plain); val event = event(true); val id = event.getString("id")
        queue.enqueue(event, byteArrayOf(9), 2_000_000); queue.acknowledge(id, retentionDays = 1, now = 1000)
        assertEquals(0, queue.pruneUploaded(Long.MAX_VALUE)); assertNotNull(queue.pendingOcr())
        queue.completeOcr(id, "generated OCR", "completed", 2_000_000)
        assertNotNull(queue.nextOcrUpdate()); queue.acknowledgeOcr(id, 1, 2000)
        assertNull(queue.nextOcrUpdate()); assertEquals(0, queue.pendingSync().count)
        assertEquals("generated OCR", queue.capture(id)!!.getString("ocrText"))
        queue.ocrConflict(id); assertEquals(0, queue.pruneUploaded(Long.MAX_VALUE))
    }
    @Test fun archivesRoundTripImagesAndRejectCorruptionBeforeMutatingDestination() {
        val source = DurableQueue(folder.newFolder(), plain); val record = event(); source.enqueue(record, byteArrayOf(4, 5, 6), 2_000_000)
        source.acknowledge(record.getString("id"), retentionDays = 7)
        val bytes = ByteArrayOutputStream().also { assertEquals(1, QueueArchive.export(source, "https://fixture.example", it)) }.toByteArray()
        val prepared = QueueArchive.prepare(bytes.inputStream(), File(folder.root, "staged"), 2_000_000)
        val target = DurableQueue(folder.newFolder(), plain)
        assertThrows(IllegalArgumentException::class.java) { QueueArchive.restore(prepared, target, "https://different.example", 2_000_000) }
        assertEquals(0, target.depth())
        assertEquals(1, QueueArchive.restore(prepared, target, "https://fixture.example", 2_000_000))
        assertEquals(0, QueueArchive.restore(prepared, target, "https://fixture.example", 2_000_000))
        assertArrayEquals(byteArrayOf(4, 5, 6), target.image(record.getString("id")))
        assertEquals(1, target.pendingSync().count); prepared.close()
        val bad = ByteArrayOutputStream().also { out -> ZipOutputStream(out).use { zip -> zip.putNextEntry(ZipEntry("../escape")); zip.write(byteArrayOf(1)); zip.closeEntry() } }.toByteArray()
        assertThrows(Exception::class.java) { QueueArchive.prepare(bad.inputStream(), File(folder.root, "bad"), 1000) }
        assertFalse(File(folder.root, "escape").exists()); assertFalse(File(folder.root, "bad").exists())
    }
    @Test fun archivePreflightFindsConflictingIdsBeforeAddingOtherRecords() {
        val source = DurableQueue(folder.newFolder(), plain); val target = DurableQueue(folder.newFolder(), plain); val first = event(); val second = event()
        source.enqueue(first, byteArrayOf(1), 2_000_000); source.enqueue(second, byteArrayOf(2), 2_000_000)
        target.enqueue(JSONObject(second.toString()).put("ocrText", "different generated text"), byteArrayOf(2), 2_000_000)
        val bytes = ByteArrayOutputStream().also { QueueArchive.export(source, "", it) }.toByteArray()
        val prepared = QueueArchive.prepare(bytes.inputStream(), File(folder.root, "staged"), 2_000_000)
        assertThrows(IllegalArgumentException::class.java) { QueueArchive.restore(prepared, target, "", 2_000_000) }
        assertEquals(1, target.depth()); assertNull(target.capture(first.getString("id"))); prepared.close()
    }
    @Test fun originalLogHasTimeLevelThreadAndLoggerAndBoundedHistory() {
        val file = File(folder.root, "mote.log"); val log = RuntimeLog(file, 3)
        log.event(EventStage.APP, EventCode.STARTED)
        log.event(EventStage.UPLOAD, EventCode.OK, 12, 200)
        log.event(EventStage.UPLOAD, EventCode.WAIT_NETWORK)
        log.event(EventStage.UPLOAD, EventCode.AUTH, httpStatus = 401)
        val raw = log.readRaw(); assertEquals(file.readText(), raw)
        val lines = log.exportRange(0, System.currentTimeMillis() + 1000).getString("text").trim().lines(); assertEquals(4, lines.size)
        assertTrue(lines[0].contains("DEBUG ")); assertTrue(lines[1].contains("elapsedMs=12 httpStatus=200"))
        assertTrue(lines[2].contains("WARN ")); assertTrue(lines[3].contains("ERROR"))
        assertTrue(lines.drop(1).all { it.matches(Regex("\\S+ (INFO |WARN |ERROR) \\[thread-\\d+] UPLOAD - .+")) })
    }
    @Test fun updateActionsTrackActualProgressAndRecoverableFailures() {
        assertEquals("check", UpdatePresentation.action("idle", false))
        assertEquals("download", UpdatePresentation.action("available", true))
        assertEquals("busy", UpdatePresentation.action("waiting_wifi", true))
        assertEquals("install", UpdatePresentation.action("ready", true))
        assertEquals("busy", UpdatePresentation.action("awaiting_user", true))
        assertEquals("download", UpdatePresentation.action("scheduler", true))
        assertEquals("check", UpdatePresentation.action("cancelled", false))
    }
    @Test fun deferredOcrArchiveKeepsBothOriginalCaptureAndRecognizedText() {
        val source = DurableQueue(folder.newFolder(), plain); val record = event(true); val id = record.getString("id")
        source.enqueue(record, byteArrayOf(1), 2_000_000)
        source.completeOcr(id, "recognized generated text", "completed", 2_000_000)
        source.acknowledge(id); source.acknowledgeOcr(id, 7)
        val bytes = ByteArrayOutputStream().also { QueueArchive.export(source, "", it) }.toByteArray()
        val prepared = QueueArchive.prepare(bytes.inputStream(), File(folder.root, "ocr"), 2_000_000)
        val target = DurableQueue(folder.newFolder(), plain)
        QueueArchive.restore(prepared, target, "", 2_000_000)
        assertEquals("recognized generated text", target.capture(id)!!.getString("ocrText"))
        assertEquals(record.getString("ocrText"), target.peek()!!.getString("ocrText"))
        target.acknowledge(id); assertEquals("recognized generated text", target.nextOcrUpdate()!!.getString("ocrText"))
        prepared.close()
    }
    @Test fun resumedDownloadUsesRangeAndValidatesCompleteBytes() {
        val bytes = "generated update bytes".toByteArray()
        val hash = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val asset = AppReleaseAsset("fixture.apk", "https://github.com/utopiafar/mote/releases/download/v1.0.0/fixture.apk", bytes.size.toLong(), hash, "dev.mote.collector", 999, "0".repeat(64))
        val part = File(folder.root, "fixture.part").apply { writeBytes(bytes.take(4).toByteArray()) }
        val connection = object : java.net.HttpURLConnection(java.net.URL(asset.url)) {
            override fun connect() = Unit
            override fun disconnect() = Unit
            override fun usingProxy() = false
            override fun getResponseCode() = 206
            override fun getContentLengthLong() = (bytes.size - 4).toLong()
            override fun getHeaderField(name: String?) = if (name == "Content-Range") "bytes 4-${bytes.size - 1}/${bytes.size}" else null
            override fun getInputStream(): InputStream = bytes.drop(4).toByteArray().inputStream()
        }
        UpdateNetwork(open = { connection }).download(asset, part) { }
        assertEquals("bytes=4-", connection.getRequestProperty("Range")); assertArrayEquals(bytes, part.readBytes())
        part.writeBytes(ByteArray(bytes.size))
        assertThrows(UpdateFailure::class.java) { UpdateNetwork(open = { error("Complete partial must verify without network") }).download(asset, part) { } }
        assertFalse(part.exists())
    }

}
