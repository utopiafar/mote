package dev.mote.collector

import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class CaptureJourneyTest {
    private val plain = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private fun event(id: String = UUID.randomUUID().toString()) = JSONObject().put("id", id).put("source", "screen")
        .put("capturedAt", "2026-10-05T00:00:00Z").put("imageMime", "image/png")
        .put("privacy", JSONObject().put("excluded", false).put("mode", "local").put("reason", "upload review pending"))
    private fun <T> fixture(action: (File) -> T): T {
        val directory = java.nio.file.Files.createTempDirectory("mote-generated-capture-journey-").toFile()
        return try { action(directory) } finally { directory.deleteRecursively() }
    }
    @Test fun backupRestoreAndRestartKeepReviewHoldUntilExplicitRelease() = fixture { directory ->
        val source = DurableQueue(File(directory, "source"), plain); val capture = event(); val id = capture.getString("id")
        source.enqueue(capture, byteArrayOf(1, 2, 3), 3_000_000, reviewHeld = true)
        val bytes = ByteArrayOutputStream().also { QueueArchive.export(source, "https://fixture.example", it) }.toByteArray()
        val prepared = QueueArchive.prepare(bytes.inputStream(), File(directory, "staged"), 3_000_000)
        val target = DurableQueue(File(directory, "target"), plain)
        assertEquals(1, QueueArchive.restore(prepared, target, "https://fixture.example", 3_000_000))
        val restarted = DurableQueue(File(directory, "target"), plain)
        assertTrue(restarted.peekBatch().isEmpty()); restarted.requeueRetained(); assertTrue(restarted.peekBatch().isEmpty())
        assertTrue(restarted.syncIssues().single().getBoolean("reviewHeld"))
        assertTrue(restarted.retryConflict(id, 3_000_000))
        assertEquals(id, restarted.peekBatch().single().getString("id"))
    }
    @Test fun duplicateArchiveMergesAuthorizationConservatively() = fixture { directory ->
        val source = DurableQueue(File(directory, "source"), plain); val target = DurableQueue(File(directory, "target"), plain); val capture = event()
        source.enqueue(capture, byteArrayOf(1), 3_000_000, reviewHeld = true)
        target.enqueue(capture, byteArrayOf(1), 3_000_000)
        val bytes = ByteArrayOutputStream().also { QueueArchive.export(source, "https://fixture.example", it) }.toByteArray()
        val prepared = QueueArchive.prepare(bytes.inputStream(), File(directory, "staged"), 3_000_000)
        assertEquals(0, QueueArchive.restore(prepared, target, "https://fixture.example", 3_000_000))
        assertTrue(target.peekBatch().isEmpty())
        val unheld = DurableQueue(File(directory, "unheld"), plain); unheld.enqueue(capture, byteArrayOf(1), 3_000_000)
        val other = ByteArrayOutputStream().also { QueueArchive.export(unheld, "https://fixture.example", it) }.toByteArray()
        val allowed = QueueArchive.prepare(other.inputStream(), File(directory, "allowed"), 3_000_000)
        QueueArchive.restore(allowed, target, "https://fixture.example", 3_000_000)
        assertTrue(target.peekBatch().isEmpty())
    }
    @Test fun malformedReviewAuthorizationRejectsBackupBeforeRestore() = fixture { directory ->
        val capture = event().put("_reviewHeld", "false")
        val bytes = ByteArrayOutputStream().also { out -> ZipOutputStream(out).use { zip ->
            fun entry(name: String, value: String) { zip.putNextEntry(ZipEntry(name)); zip.write(value.toByteArray()); zip.closeEntry() }
            entry("archive.json", JSONObject().put("format", "mote-android-records").put("version", LocalDataFormat.VERSION).put("origin", "https://fixture.example").toString())
            entry("records/${capture.getString("id")}.json", capture.toString())
        } }.toByteArray()
        assertThrows(IllegalArgumentException::class.java) { QueueArchive.prepare(bytes.inputStream(), File(directory, "staged"), 3_000_000) }
        assertFalse(File(directory, "staged").exists())
    }
    @Test fun notificationRulesReviewEveryCapturedTextFieldWithoutSemanticDispatch() {
        val config = UploadGateConfig(blockedText = "FORBIDDEN")
        for (key in listOf("title", "text", "bigText", "subText", "channelId", "category")) {
            val payload = JSONObject().put(key, "Generated FORBIDDEN text")
            assertEquals("drop", UploadGate.review(config) { NotificationObservations.text(payload) })
        }
        assertEquals("drop", UploadGate.review(config) { NotificationObservations.text(JSONObject().put("textLines", JSONArray(listOf("Generated", "FORBIDDEN")))) })
        assertEquals("allow", UploadGate.review(config) { NotificationObservations.text(JSONObject().put("text", "Generated allowed text")) })
        assertEquals("hold", UploadGate.review(config) { NotificationObservations.text(JSONObject().put("text", JSONObject())) })
    }
    @Test fun portableConfigurationPreservesUploadRulesAndRejectsRetiredModelControls() {
        val config = CollectorConfig(deviceName = "Generated phone", uploadGate = UploadGateConfig(blockedText = "literal fixture", failureAction = "hold"), ocrMode = "dual")
        val encoded = ConfigurationArchive.encode(config)
        val values = JSONObject(encoded).getJSONObject("settings")
        assertFalse(values.has("nsfw")); assertFalse(values.has("localReviewUrl"))
        val restored = ConfigurationArchive.decode(encoded, config.copy(uploadGate = UploadGateConfig(), ocrMode = "latin"))
        assertEquals(config.uploadGate, restored.uploadGate); assertEquals("dual", restored.ocrMode)
        for (key in listOf("nsfw", "localReviewUrl")) {
            val obsolete = JSONObject(encoded).apply { getJSONObject("settings").put(key, if (key == "nsfw") JSONObject().put("enabled", true) else "http://127.0.0.1:1/review") }
            assertThrows(IllegalArgumentException::class.java) { ConfigurationArchive.decode(obsolete.toString(), config) }
        }
    }
    @Test fun releaseArtifactChecksStayStrictAfterModelRuntimeRetirement() = fixture { directory ->
        val apk = File(directory, "generated.apk").apply { writeText("generated release bytes") }
        assertEquals("e71821edfdeda5fd74d5422168170bb79806570d76650190db57e63ac11f64b8", UpdateArtifactValidation.sha256(apk))
        UpdateArtifactValidation.validateRange("bytes 5-9/10", 5, 10)
        for (range in listOf(null, "bytes 0-9/10", "bytes 5-10/10", "bytes 5-9/11", "bytes */10"))
            assertThrows(Exception::class.java) { UpdateArtifactValidation.validateRange(range, 5, 10) }
    }
    @Test fun pageAndImageObservationsShareClockAndRespectPrivacyBoundaries() {
        val clock = ForegroundObservationClock()
        assertEquals(0L, clock.interval(0, "generated.app", AppCollectionMode.CONTENT, 15_000))
        clock.accept(0, "generated.app", AppCollectionMode.CONTENT)
        assertEquals(15_000L, clock.interval(15_000, "generated.app", AppCollectionMode.CONTENT, 15_000))
        clock.accept(15_000, "generated.app", AppCollectionMode.CONTENT)
        assertEquals(15_000L, clock.interval(30_000, "generated.app", AppCollectionMode.CONTENT, 15_000))
        assertEquals(0L, clock.interval(30_000, "other.app", AppCollectionMode.CONTENT, 15_000))
        assertEquals(0L, clock.interval(30_000, "generated.app", AppCollectionMode.ACTIVITY, 15_000))
        assertEquals(0L, clock.interval(14_000, "generated.app", AppCollectionMode.CONTENT, 15_000))
        clock.reset(); assertEquals(0L, clock.interval(60_000, "generated.app", AppCollectionMode.CONTENT, 15_000))
    }
}
