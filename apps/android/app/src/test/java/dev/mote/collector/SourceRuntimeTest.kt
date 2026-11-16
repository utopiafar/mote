package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class SourceRuntimeTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }
    private fun source() = LocalSource(id = "generated-source", name = "Generated", kind = "local-files", retention = "archive", uri = "content://fixture/root", extensions = "txt")
    private fun item(id: String = "a") = JSONObject().put("externalId", "content://fixture/$id").put("uri", "content://fixture/$id")
        .put("title", "$id.txt").put("kind", "file").put("layer", "original").put("text", "").put("mimeType", "text/plain").put("observedAt", "2026-10-01T00:00:00Z")
    private fun scan() = SourceScan(listOf(item().put("layer", "reference")), true, "2026-10-01T00:00:00Z")

    @Test fun removedSourceRejectsLateObserveFinishAndCheckpointWithoutRecreatingItsDirectory() {
        val store = LocalSourceStore(folder.newFolder(), cipher); val source = source(); store.save(source)
        val directory = folder.newFolder(); val queue = FileArchiveQueue(directory, cipher, store)
        val lease = store.lease(source)!!; val generation = queue.configure(source, lease).getString("generation")
        store.remove(source.id); queue.remove(source.id)
        repeat(2) {
            queue.observe(source, item(), generation, 0, lease)
            queue.finish(source, generation, lease) { error("A removed source must never query its provider") }
            queue.checkpoint(source, JSONObject().put("stack", JSONArray()), generation, lease)
            queue.captured(source, lease)
            assertNull(queue.prepare(source, { error("Removed source must not open") }, { true }, 61000, lease = lease))
        }
        assertEquals(0, queue.pendingSync().count); assertEquals(0, queue.pendingCount(source.id))
        assertFalse(File(directory, source.id).exists()); assertTrue(store.sources().isEmpty())
    }

    @Test fun pauseResumeAndRemoveReaddInvalidateIndexedAndFileLeasesAcrossStoreInstances() {
        val config = folder.newFolder(); val store = LocalSourceStore(config, cipher); val source = source().copy(retention = "reference"); store.save(source)
        val queue = FileArchiveQueue(folder.newFolder(), cipher, store)
        val lease = store.lease(source)!!; val generation = queue.configure(source, lease).getString("generation")
        val editor = LocalSourceStore(config, cipher)
        editor.save(source.copy(enabled = false)); editor.save(source)
        store.scan(source, scan(), lease = lease); queue.observe(source, item().put("layer", "reference"), generation, 0, lease)
        assertEquals(0, store.state(source.id).optJSONArray("pending")?.length() ?: 0); assertEquals(0, queue.pendingCount(source.id))
        assertFalse(store.current(lease))
        val next = store.lease(source)!!; editor.remove(source.id); editor.save(source)
        store.scan(source, scan(), lease = next); assertFalse(store.current(next))
        val current = store.lease(source)!!; store.scan(source, scan(), lease = current)
        assertEquals(1, store.state(source.id).getJSONArray("pending").length())
    }

    @Test fun selectionScopeEditRejectsOldManifestBeforeOpeningAndRequiresCurrentConfiguration() {
        val store = LocalSourceStore(folder.newFolder(), cipher); val source = source(); store.save(source)
        val directory = folder.newFolder(); val queue = FileArchiveQueue(directory, cipher, store)
        queue.observe(source, item(), queue.configure(source).getString("generation"), 0)
        assertNull(queue.prepare(source, { error("Old selection must not open") }, { true }, 61000, onSelected = {
            store.save(source.copy(excluded = "a.txt"))
        }))
        assertNull(queue.next(source.id)); assertThrows(SourceLeaseRevoked::class.java) { queue.configure(source) }
        queue.configure(store.sources().single()); assertEquals(1, queue.pendingCount(source.id))
        assertTrue(queue.row(source.id, item().getString("externalId")).has("quarantine"))
        assertFalse(directory.listFiles()!!.any { it.name.startsWith(".staging-") })
    }

    @Test fun blockingReadAllowsStatusAndRemovalAndCannotDeleteANewerPublishedSpool() {
        val store = LocalSourceStore(folder.newFolder(), cipher); val source = source(); store.save(source)
        val directory = folder.newFolder(); val queue = FileArchiveQueue(directory, cipher, store)
        queue.observe(source, item(), queue.configure(source).getString("generation"), 0)
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val closed = AtomicBoolean()
        val executor = Executors.newFixedThreadPool(2)
        try {
            val old = executor.submit<JSONObject?> {
                queue.prepare(source, { object : ByteArrayInputStream("old generated bytes".toByteArray()) {
                    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                        entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); return super.read(buffer, offset, length)
                    }
                    override fun close() { closed.set(true); super.close() }
                } }, { true }, 61000)
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            executor.submit {
                assertEquals(1, queue.pendingSync().count); store.status(source.id, "paused")
                store.remove(source.id); queue.remove(source.id)
            }.get(2, TimeUnit.SECONDS)
            assertFalse(File(directory, source.id).exists())
            store.save(source)
            val restarted = FileArchiveQueue(directory, cipher, store)
            restarted.observe(source, item("new"), restarted.configure(source).getString("generation"), 0)
            val bytes = "new generated bytes".toByteArray()
            val published = restarted.prepare(source, { ByteArrayInputStream(bytes) }, { true }, 61000)!!
            release.countDown(); assertNull(old.get(5, TimeUnit.SECONDS)); assertTrue(closed.get())
            assertEquals(published.toString(), restarted.next(source.id).toString()); assertArrayEquals(bytes, restarted.part(source.id, 0))
            assertFalse(directory.listFiles()!!.any { it.name.startsWith(".staging-") })
        } finally { release.countDown(); executor.shutdownNow(); assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS)) }
    }

    @Test fun pauseResumeDuringReadCannotCommitEvenWhenConfigurationEqualsItsOriginalValue() {
        val store = LocalSourceStore(folder.newFolder(), cipher); val source = source(); store.save(source)
        val directory = folder.newFolder(); val queue = FileArchiveQueue(directory, cipher, store)
        queue.observe(source, item(), queue.configure(source).getString("generation"), 0)
        assertNull(queue.prepare(source, {
            store.save(source.copy(enabled = false)); store.save(source)
            ByteArrayInputStream("late bytes".toByteArray())
        }, { true }, 61000))
        assertNull(queue.next(source.id)); assertEquals(1, queue.pendingCount(source.id))
        assertFalse(directory.listFiles()!!.any { it.name.startsWith(".staging-") })
        assertNotNull(queue.prepare(source, { ByteArrayInputStream("current bytes".toByteArray()) }, { true }, 62000))
    }

    @Test fun failedAndCancelledReadsCleanOnlyOwnStagingAndRemainRetryableAfterRestart() {
        val store = LocalSourceStore(folder.newFolder(), cipher); val source = source(); store.save(source)
        val directory = folder.newFolder(); val queue = FileArchiveQueue(directory, cipher, store)
        queue.observe(source, item(), queue.configure(source).getString("generation"), 0)
        assertThrows(IOException::class.java) {
            queue.prepare(source, { object : ByteArrayInputStream(ByteArray(FileArchiveQueue.PART_BYTES + 2) { 7 }) {
                override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                    if (pos >= FileArchiveQueue.PART_BYTES) throw IOException("Generated failure after one staged chunk")
                    return super.read(buffer, offset, minOf(length, FileArchiveQueue.PART_BYTES - pos))
                }
            } }, { true }, 61000)
        }
        assertNull(queue.next(source.id)); assertEquals(1, queue.pendingCount(source.id))
        assertFalse(directory.listFiles()!!.any { it.name.startsWith(".staging-") })
        val cancelled = AtomicBoolean()
        assertNull(queue.prepare(source, { cancelled.set(true); ByteArrayInputStream(byteArrayOf(1)) }, { true }, 122000, cancelled = { cancelled.get() }))
        assertFalse(directory.listFiles()!!.any { it.name.startsWith(".staging-") })
        File(directory, ".staging-abandoned").mkdirs(); File(directory, ".staging-abandoned/0").writeText("generated orphan")
        val restarted = FileArchiveQueue(directory, cipher, store)
        assertFalse(File(directory, ".staging-abandoned").exists())
        assertNotNull(restarted.prepare(source, { ByteArrayInputStream("retry".toByteArray()) }, { true }, 123000))
    }

    @Test fun blockedAbsenceProbeAllowsRevocationAndCannotPublishDeletionOrScanCompletion() {
        val store = LocalSourceStore(folder.newFolder(), cipher); val source = source(); store.save(source)
        val directory = folder.newFolder(); val queue = FileArchiveQueue(directory, cipher, store)
        val lease = store.lease(source)!!; val generation = queue.configure(source, lease).getString("generation")
        queue.observe(source, item(), generation, 0, lease); queue.finish(source, generation, lease) { false }
        val next = queue.state(source.id).getString("generation")
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val finishing = executor.submit {
                queue.finish(source, next, lease) { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); true }
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            executor.submit { store.remove(source.id); queue.remove(source.id) }.get(2, TimeUnit.SECONDS)
            release.countDown(); finishing.get(5, TimeUnit.SECONDS)
            assertFalse(File(directory, source.id).exists()); assertEquals(0, queue.pendingSync().count)
        } finally { release.countDown(); executor.shutdownNow(); assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS)) }
    }
}
