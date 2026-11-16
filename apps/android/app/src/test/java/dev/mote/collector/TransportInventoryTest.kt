package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.UUID

class TransportInventoryTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }
    private fun source() = LocalSource(id = "generated-files", name = "Generated", kind = "local-files", retention = "archive", uri = "content://fixture/root", extensions = "txt")
    private fun file() = JSONObject().put("externalId", "content://fixture/a").put("uri", "content://fixture/a").put("title", "a.txt")
        .put("kind", "file").put("layer", "original").put("text", "").put("mimeType", "text/plain").put("observedAt", "2026-10-01T00:00:00Z")
    private fun capture() = JSONObject().put("id", UUID.randomUUID().toString()).put("capturedAt", "2026-10-01T00:00:00Z")
        .put("source", "note").put("platform", "android").put("text", "Generated note").put("privacy", JSONObject().put("excluded", false))

    @Test fun fileOnlyBacklogKeepsTheExistingSchedulingDeadlineAndDispatch() {
        val captures = DurableQueue(folder.newFolder(), cipher); val sources = LocalSourceStore(folder.newFolder(), cipher)
        val files = FileArchiveQueue(folder.newFolder(), cipher, sources); val source = source(); sources.save(source)
        sources.selectTarget(source.id, "generated-target"); sources.registered(source.id, "generated-target")
        files.observe(source, file(), files.configure(source).getString("generation"), 0)
        val inventory = TransportInventory(captures.pendingSync(), sources.pendingSync(), files.pendingSync())
        assertFalse(inventory.captures.hasWork); assertFalse(inventory.sources.hasWork); assertEquals(1, inventory.files.count)
        assertEquals(1, inventory.pending.count); assertEquals(0, inventory.pending.pendingUpdates)
        assertEquals(inventory.files.oldestAt, inventory.pending.oldestAt)
        assertEquals(0L, SyncPolicy().delayMillis(1_000_000, inventory.pending.count, inventory.pending.oldestAt, 0))
    }

    @Test fun metadataRemainsSeparateFromRecordThresholdsAndRetainsItsDeadline() {
        val captures = DurableQueue(folder.newFolder(), cipher); val sources = LocalSourceStore(folder.newFolder(), cipher)
        val files = FileArchiveQueue(folder.newFolder(), cipher, sources); val source = source(); sources.save(source)
        val metadata = TransportInventory(captures.pendingSync(), sources.pendingSync(), files.pendingSync()).pending
        assertEquals(0, metadata.count); assertEquals(1, metadata.pendingUpdates); assertTrue(metadata.hasWork)
        val oldest = metadata.oldestAt!!; val policy = SyncPolicy("batch", 15, 2)
        assertEquals(900_000L, policy.delayMillis(oldest, metadata.count, metadata.oldestAt, 0, pendingUpdates = metadata.pendingUpdates))
        captures.enqueue(capture(), null)
        files.observe(source, file(), files.configure(source).getString("generation"), 0)
        val mixed = TransportInventory(captures.pendingSync(), sources.pendingSync(), files.pendingSync())
        assertEquals(2, mixed.pending.count); assertEquals(1, mixed.pending.pendingUpdates)
        assertEquals(listOfNotNull(mixed.captures.oldestAt, mixed.sources.oldestAt, mixed.files.oldestAt).minOrNull(), mixed.pending.oldestAt)
        assertEquals(0L, policy.delayMillis(oldest, mixed.pending.count, mixed.pending.oldestAt, 0, pendingUpdates = mixed.pending.pendingUpdates))
    }

    @Test fun restartAndSourcePauseRetainTheSamePendingFactsWithoutClassifyingRunnability() {
        val captureDir = folder.newFolder(); val sourceDir = folder.newFolder(); val fileDir = folder.newFolder()
        val captures = DurableQueue(captureDir, cipher); val sources = LocalSourceStore(sourceDir, cipher)
        val files = FileArchiveQueue(fileDir, cipher, sources); val source = source(); sources.save(source)
        sources.selectTarget(source.id, "generated-target"); sources.registered(source.id, "generated-target")
        captures.enqueue(capture(), null)
        files.observe(source, file(), files.configure(source).getString("generation"), 0)
        val before = TransportInventory(captures.pendingSync(), sources.pendingSync(), files.pendingSync())
        sources.save(source.copy(enabled = false))
        val restartedSources = LocalSourceStore(sourceDir, cipher)
        val after = TransportInventory(DurableQueue(captureDir, cipher).pendingSync(), restartedSources.pendingSync(), FileArchiveQueue(fileDir, cipher, restartedSources).pendingSync())
        assertEquals(before, after); assertEquals(2, after.pending.count); assertEquals(0, after.pending.pendingUpdates)
        assertNull(SyncPolicy("manual").delayMillis(1_000_000, after.pending.count, after.pending.oldestAt, 0))
    }
}
