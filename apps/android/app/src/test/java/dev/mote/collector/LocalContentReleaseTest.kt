package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

class LocalContentReleaseTest {
    @get:Rule val folder = TemporaryFolder()
    private val origin = "https://generated-central.invalid"
    private val plain = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private fun queue(root: File = folder.newFolder(), role: DurableQueue.Role = DurableQueue.Role.ACTIVE) = DurableQueue(root, plain, captureStages = CaptureStageRegistry(), role = role).apply { archiveOrigin = origin }
    private fun event(source: String = "note") = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", "generated-device").put("deviceName", "Generated phone")
        .put("platform", "android").put("capturedAt", "2026-11-17T01:00:00Z").put("durationMs", 0).put("source", source).put("appId", "generated.app").put("appName", "Generated app")
        .put("ocrText", "GENERATED_PRIVATE_BODY").put("windowTitle", "GENERATED_PRIVATE_TITLE").put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "local"))
    private fun release(queue: DurableQueue, id: String, authorized: () -> Unit = {}) {
        val stored = queue.archiveRecord(id)!!.first
        val version = stored.getJSONObject("_archiveAcknowledgment").getString("version")
        val library = stored.optJSONObject(ReleasedCapture.FIELD)?.getString("libraryVersion") ?: CaptureLibraryVersion.of(stored, stored.optString("_blob"))
        queue.releaseContent(id, version, library, authorized)
    }
    private fun export(queue: DurableQueue): ByteArray = ByteArrayOutputStream().also { QueueArchive.export(queue, origin, it) }.toByteArray()
    private fun import(bytes: ByteArray, target: DurableQueue): Int {
        val prepared = QueueArchive.prepare(bytes.inputStream(), File(folder.newFolder(), "stage"))
        try { return QueueArchive.restore(prepared, target, origin) } finally { prepared.close() }
    }

    @Test fun ownerReleaseSurvivesRestartAndBothZipDirectionsWithoutRestoringBodyOrPendingWork() {
        val root = folder.newFolder(); val queue = queue(root); val event = event(); val id = event.getString("id")
        queue.enqueue(event, null); queue.acknowledge(id); val before = export(queue)
        release(queue, id)
        val reopened = queue(root); val light = reopened.capture(id)!!
        assertTrue(light.getBoolean("uploaded")); assertFalse(light.getJSONObject("localContentRelease").getBoolean("pending"))
        assertFalse(light.has("ocrText")); assertFalse(light.has("windowTitle")); assertFalse(light.has("metadata")); assertFalse(light.getBoolean("hasImage"))
        assertTrue(reopened.peekBatch().isEmpty()); assertEquals(0, reopened.requeueRetained()); assertEquals(0, import(before, reopened))
        assertFalse(reopened.capture(id)!!.has("ocrText")); assertTrue(reopened.peekBatch().isEmpty())
        val restored = queue(); assertEquals(1, import(export(reopened), restored)); restored.verifyIntegrity()
        assertFalse(restored.capture(id)!!.has("ocrText")); assertTrue(restored.peekBatch().isEmpty()); assertEquals(0, import(before, restored))
        restored.archiveMissing(id)
        assertEquals("archive_missing", restored.capture(id)!!.getString("syncError")); assertTrue(restored.peekBatch().isEmpty()); assertFalse(restored.hasPendingConnectionWork())
        restored.verifyIntegrity()
    }

    @Test fun sharedImageAndThumbnailRemainUntilTheLastReferenceIsReleased() {
        val root = folder.newFolder(); val queue = queue(root); val bytes = byteArrayOf(1, 2, 3, 4)
        val a = event("screen").put("imageMime", "image/jpeg"); val b = event("screen").put("imageMime", "image/jpeg")
        queue.enqueue(a, bytes); queue.enqueue(b, bytes); val id = a.getString("id"); queue.cacheThumbnail(id, byteArrayOf(5))
        queue.acknowledge(id); release(queue, id)
        assertNull(queue.image(id)); assertNull(queue.thumbnail(id)); assertArrayEquals(bytes, queue.image(b.getString("id")))
        assertEquals(1, root.listFiles()!!.count { it.extension == "blob" }); assertEquals(1, queue.peekBatch().size)
        queue.acknowledge(b.getString("id")); release(queue, b.getString("id"))
        assertEquals(0, root.listFiles()!!.count { it.extension in setOf("blob", "thumb") }); queue.verifyIntegrity()
    }

    @Test fun pendingHeldQuarantineUnknownProofAndForeignOriginKeepTheirInputs() {
        for (kind in listOf("pending", "held", "quarantine", "unknown", "foreign")) {
            val root = folder.newFolder(); val queue = queue(root, if (kind == "quarantine") DurableQueue.Role.QUARANTINE else DurableQueue.Role.ACTIVE)
            val event = event(); val id = event.getString("id"); queue.enqueue(event, null)
            if (kind != "pending") queue.acknowledge(id)
            if (kind == "held") queue.holdForReview(id)
            if (kind == "unknown") { val file = File(root, "$id.event"); file.writeText(JSONObject(file.readText()).apply { remove("_archiveAcknowledgment") }.toString()) }
            if (kind == "foreign") queue.archiveOrigin = "https://another-generated.invalid"
            assertThrows(Exception::class.java) { release(queue, id) }
            assertEquals("GENERATED_PRIVATE_BODY", queue.capture(id)!!.getString("ocrText"))
        }
    }

    @Test fun actualUnlinkFailureKeepsTheIntentIncompleteAcrossRestartAndRetryDoesNotRetransmit() {
        val root = folder.newFolder(); val queue = queue(root); val event = event("screen").put("imageMime", "image/jpeg"); val id = event.getString("id")
        queue.enqueue(event, byteArrayOf(1, 2, 3)); queue.acknowledge(id)
        val blob = root.listFiles()!!.single { it.extension == "blob" }; var injected = false
        assertThrows(IllegalStateException::class.java) { release(queue, id) {
            if (!injected && JSONObject(File(root, "$id.event").readText()).has(ReleasedCapture.FIELD)) {
                injected = true; check(blob.delete()); check(blob.mkdir()); File(blob, "generated-held-child").writeText("generated")
            }
        } }
        val reopened = queue(root); assertTrue(reopened.capture(id)!!.getJSONObject("localContentRelease").getBoolean("pending"))
        assertFalse(reopened.capture(id)!!.has("ocrText")); assertTrue(reopened.peekBatch().isEmpty()); assertTrue(blob.exists())
        check(blob.deleteRecursively()); release(reopened, id)
        assertFalse(queue(root).capture(id)!!.getJSONObject("localContentRelease").getBoolean("pending")); assertTrue(reopened.peekBatch().isEmpty())
    }

    @Test fun opaqueStageStateOrHeldInputKeepsAnAcknowledgedOriginal() {
        for (extra in listOf("opaque", "held")) {
            val root = folder.newFolder(); val queue = queue(root); val event = event(); val id = event.getString("id")
            queue.enqueue(event, null); queue.acknowledge(id)
            val row = JSONObject().put("id", "generated-stage").put("version", 1).put("value", if (extra == "opaque") JSONObject().put("body", "GENERATED_HELD_BODY") else JSONObject.NULL)
                .put("held", if (extra == "held") org.json.JSONArray().put(JSONObject().put("event", event)) else org.json.JSONArray())
            File(root, ".capture-stages.checkpoint").writeText(JSONObject().put("order", org.json.JSONArray()).put("stages", org.json.JSONArray().put(row)).toString())
            assertThrows(IllegalStateException::class.java) { release(queue, id) }
            assertEquals("GENERATED_PRIVATE_BODY", queue.capture(id)!!.getString("ocrText"))
        }
    }

    @Test fun realFinalRenameFailureLeavesARecoverableIncompleteReceiptAndRetryCannotResurrectContent() {
        val root = folder.newFolder(); var failFinal = false; lateinit var eventFile: File; val preserved = File(root, "generated-preserved.event-data")
        val cipher = object : ByteCipher {
            override fun open(bytes: ByteArray) = bytes
            override fun seal(bytes: ByteArray): ByteArray {
                val value = runCatching { JSONObject(String(bytes)) }.getOrNull()
                if (failFinal && value?.optJSONObject(ReleasedCapture.FIELD)?.optBoolean("pending", true) == false) {
                    failFinal = false; check(eventFile.renameTo(preserved)); check(eventFile.mkdir()); File(eventFile, "generated-child").writeText("generated")
                }
                return bytes
            }
        }
        val queue = DurableQueue(root, cipher, captureStages = CaptureStageRegistry()).apply { archiveOrigin = origin }
        val event = event(); val id = event.getString("id"); eventFile = File(root, "$id.event")
        queue.enqueue(event, null); queue.acknowledge(id); failFinal = true
        assertThrows(IllegalStateException::class.java) { release(queue, id) }
        val retained = JSONObject(preserved.readText()); assertTrue(retained.getJSONObject(ReleasedCapture.FIELD).getBoolean("pending")); assertFalse(retained.has("ocrText"))
        check(eventFile.deleteRecursively()); check(preserved.renameTo(eventFile))
        val reopened = DurableQueue(root, cipher, captureStages = CaptureStageRegistry()).apply { archiveOrigin = origin }
        assertTrue(reopened.peekBatch().isEmpty()); release(reopened, id)
        assertFalse(reopened.capture(id)!!.getJSONObject("localContentRelease").getBoolean("pending")); assertFalse(reopened.capture(id)!!.has("ocrText"))
    }
}
