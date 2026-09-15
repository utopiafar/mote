package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.UUID

class SyncRecoveryTest {
    private val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private fun screen() = JSONObject().put("id", UUID.randomUUID().toString()).put("source", "screen")
        .put("capturedAt", "2026-09-15T00:00:00Z").put("imageMime", "image/jpeg").put("ocrText", "")
        .put("ocr", JSONObject().put("status", "pending")).put("privacy", JSONObject().put("excluded", false))
    @Test fun fullReplayKeepsOriginalEventOcrPatchAndBlockedRecordsAcrossRestart() {
        val dir = Files.createTempDirectory("mote-sync-replay").toFile()
        try {
            val queue = DurableQueue(dir, cipher)
            val healthy = screen(); val conflict = screen(); val deleted = screen()
            for (event in listOf(healthy,conflict,deleted)) queue.enqueue(event, byteArrayOf(1,2,3), 3_000_000)
            val id = healthy.getString("id")
            val original = JSONObject(healthy.toString()).put("imageBase64", "AQID").toString()
            queue.acknowledge(id); queue.completeOcr(id, "Generated OCR", "completed", 3_000_000)
            queue.uploadConflict(conflict.getString("id")); queue.archiveMissing(deleted.getString("id"))
            assertEquals(2, queue.syncInventory().getInt("blocked"))
            assertEquals(1, queue.requeueRetained()); assertEquals(1, queue.requeueRetained())
            val restarted = DurableQueue(dir, cipher)
            assertEquals(original, restarted.peek()!!.toString()); assertNull(restarted.nextOcrUpdate())
            assertEquals(2, restarted.syncIssues().size)
            restarted.acknowledge(id)
            assertEquals("Generated OCR", restarted.nextOcrUpdate()!!.getString("ocrText"))
            restarted.acknowledgeOcr(id)
            assertEquals(0, restarted.pendingSync().count); assertEquals(2, restarted.depth())
            assertEquals(2, restarted.syncInventory().getInt("blocked")); assertEquals(0, restarted.requeueRetained())
            assertFalse(restarted.retryConflict(deleted.getString("id"), 3_000_000))
            assertTrue(restarted.retryConflict(conflict.getString("id"), 3_000_000))
            assertEquals(conflict.getString("id"), restarted.peek()!!.getString("id"))
            restarted.uploadConflict(conflict.getString("id")); assertEquals(2, restarted.syncInventory().getInt("blocked"))
        } finally { dir.deleteRecursively() }
    }
    @Test fun fullSourceReplayDeduplicatesPendingVersionsAndDoesNotEnablePausedSources() {
        val dir = Files.createTempDirectory("mote-source-replay").toFile()
        try {
            val store = LocalSourceStore(dir, cipher)
            val active = LocalSource(name="Generated calendar", kind="local-calendar", calendarId=1)
            val paused = active.copy(id="paused", name="Paused generated calendar", enabled=false)
            store.save(active); store.save(paused)
            val body = JSONObject().put("externalId", "fixture-1").put("kind", "calendar").put("layer", "snapshot")
                .put("observedAt", "2026-09-15T00:00:00Z").put("title", "Generated").put("text", "Fixture body")
            store.scan(active, SourceScan(listOf(body), true, "2026-09-15T00:00:00Z"))
            store.selectTarget(active.id, "fixture-target")
            val pending = store.next(active.id, "fixture-target")!!
            store.acknowledge(active.id, "fixture-target", pending.getString("externalId"), pending.getString("revision"))
            assertThrows(IllegalStateException::class.java) { store.requeueRetained(1) }
            assertNull(store.next(active.id, "fixture-target"))
            assertEquals(1, store.requeueRetained()); assertEquals(1, store.requeueRetained())
            assertEquals(pending.toString(), store.next(active.id, "fixture-target")!!.toString())
            assertFalse(store.sources().single { it.id==paused.id }.enabled)
            assertFalse(store.state(active.id).optBoolean("registered"))
        } finally { dir.deleteRecursively() }
    }
}
