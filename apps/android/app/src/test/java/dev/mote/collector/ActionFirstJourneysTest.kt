package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream

class ActionFirstJourneysTest {
    @get:Rule val temporary = TemporaryFolder()
    private val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private fun source() = LocalSource(id = "generated-once", name = "Generated note", kind = "local-files", uri = "content://generated/document/note.txt", tree = false, syncContinuously = false, centralProcessingConsent = true, extensions = "txt")
    private fun item() = JSONObject().put("externalId", "content://generated/document/note.txt").put("uri", "content://generated/document/note.txt").put("title", "note.txt").put("kind", "file").put("layer", "snapshot").put("text", "").put("mimeType", "text/plain").put("observedAt", "2026-10-11T00:00:00Z")

    @Test fun oneTimeSelectionCapturesImmutableBytesImmediatelyAndSurvivesRestartOffline() {
        val directory = temporary.newFolder(); val files = FileArchiveQueue(directory, cipher); val selected = source(); val now = 130000L
        val original = "Generated original 中文\n".repeat(300).toByteArray()
        val generation = files.configure(selected).getString("generation")
        files.observe(selected, item(), generation, now); files.finish(selected, generation) { false }
        assertNull("Continuous stability checks stay active unless explicitly capturing once", files.prepare(selected, { ByteArrayInputStream(original) }, { true }, now = now))
        val saved = files.prepare(selected, { ByteArrayInputStream(original) }, { true }, now = now, captureImmediately = true)!!
        assertEquals(now, saved.getLong("stableSince"))
        val manifest = saved.getJSONObject("pending").getJSONObject("manifest")
        val restored = FileArchiveQueue(directory, cipher)
        assertTrue(restored.configure(selected).getBoolean("importCaptured"))
        assertEquals(saved.toString(), restored.next(selected.id).toString())
        assertArrayEquals(original, restored.part(selected.id, 0))
        val preview = restored.pendingPreview(selected.id, selected.uri!!, manifest.getJSONObject("item").getString("revision"))!!
        assertEquals(String(original), preview.first); assertTrue(preview.second)
        val exported = java.io.ByteArrayOutputStream()
        restored.exportPending(selected.id, selected.uri, manifest.getJSONObject("item").getString("revision"), exported)
        assertArrayEquals(original, exported.toByteArray())
        assertThrows(Exception::class.java) { restored.pendingPreview(selected.id, selected.uri, "wrong-revision") }
        restored.saveState(selected.id, restored.state(selected.id).apply { remove("importCaptured") })
        val crashRecovery = FileArchiveQueue(directory, cipher)
        assertTrue("Pending durable bytes recover the completion marker before scanning", crashRecovery.configure(selected).getBoolean("importCaptured"))
        assertEquals(saved.toString(), crashRecovery.next(selected.id).toString())
    }
    @Test fun failedCopyCannotFreezeAnImportAndContinuousFoldersRetainStabilityWindow() {
        val files = FileArchiveQueue(temporary.newFolder(), cipher); val selected = source(); val now = 123000L
        files.observe(selected, item(), files.configure(selected).getString("generation"), now)
        assertThrows(Exception::class.java) { files.prepare(selected, { ByteArrayInputStream(byteArrayOf(1)) }, { false }, now = now, captureImmediately = true) }
        assertFalse(files.state(selected.id).optBoolean("importCaptured")); assertNull(files.next(selected.id))
        val continuous = selected.copy(syncContinuously = true, tree = true)
        val folders = FileArchiveQueue(temporary.newFolder(), cipher)
        folders.observe(continuous, item(), folders.configure(continuous).getString("generation"), now)
        assertNull(folders.prepare(continuous, { error("Folder stability wait cannot be bypassed") }, { true }, now = now, captureImmediately = true))
    }
    @Test fun priorSourcesStayContinuousAndNewExplicitChoiceSurvivesConfigurationRoundTrip() {
        val selected = source()
        assertFalse(LocalSource.from(selected.json()).syncContinuously)
        assertTrue(LocalSource.from(selected.json().apply { remove("syncContinuously") }).syncContinuously)
        assertThrows(IllegalArgumentException::class.java) { selected.copy(tree = true).validate() }
    }
    @Test fun sendPausePreservesCaptureIdentityButRealPrivacyChangesInvalidateIt() {
        val selected = CollectorConfig(deviceName = "Generated device")
        assertEquals(selected.captureStamp(), selected.copy(syncPaused = true).captureStamp())
        assertTrue(selected.sameCaptureConfiguration(selected.copy(syncPaused = true)))
        assertFalse(selected.sameCaptureConfiguration(selected.copy(screenCollectionEnabled = false)))
        assertFalse(selected.sameCaptureConfiguration(selected.copy(masks = "0,0,1,0.08")))
        assertNotEquals(SyncSchedule.stamp(selected), SyncSchedule.stamp(selected.copy(syncPaused = true)))
    }
    @Test fun receivingAFileNeverClaimsItIsSearchableWithoutMatchingCentralIndexRevision() {
        val receipt = JSONObject().put("captureId", "generated-receipt").put("candidate", item()).put("signature", SourceRules.fileSignature(item())).put("revision", "received-revision")
        assertTrue(LocalContentPresentation.fileStatus(receipt).contains("整理状态"))
        assertEquals("generated-receipt", LocalContentPresentation.currentReceipt(receipt))
        receipt.getJSONObject("candidate").put("modifiedAt", "2026-10-11T01:00:00Z")
        assertNull(LocalContentPresentation.currentReceipt(receipt))
        assertTrue(LocalContentPresentation.fileStatus(receipt).contains("正在准备保存"))
        receipt.put("pending", JSONObject())
        assertNull(LocalContentPresentation.currentReceipt(receipt))
        assertTrue(LocalContentPresentation.fileStatus(receipt).contains("等待中央接收"))
        assertTrue(LocalContentPresentation.centralStatus(JSONObject(), null).contains("尚未确认"))
        val material = JSONObject().put("revision", "new").put("coverage", JSONObject().put("state", "complete")).put("indexing", JSONObject().put("state", "indexed").put("revision", "old"))
        assertTrue(LocalContentPresentation.centralStatus(JSONObject(), material).contains("尚未确认"))
        material.getJSONObject("coverage").put("state", "partial")
        assertTrue(LocalContentPresentation.centralStatus(JSONObject(), material).contains("尚未确认"))
        material.getJSONObject("indexing").put("revision", "new")
        assertTrue(LocalContentPresentation.centralStatus(JSONObject(), material).contains("部分整理"))
        material.getJSONObject("coverage").put("state", "complete")
        assertTrue(LocalContentPresentation.centralStatus(JSONObject(), material).contains("完整整理"))
    }
}
