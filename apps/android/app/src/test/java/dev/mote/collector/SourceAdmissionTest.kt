package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

class SourceAdmissionTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private val at = "2026-11-17T01:00:00Z"
    private fun source() = LocalSource(id = "generated-admission", name = "Generated", kind = "local-files", uri = "content://fixture/root", extensions = "txt,wav")
    private fun item() = JSONObject().put("externalId", "content://fixture/a").put("uri", "content://fixture/a").put("title", "a.txt")
        .put("kind", "file").put("layer", "original").put("text", "").put("mimeType", "text/plain").put("observedAt", at)
    private fun ack(row: JSONObject): JSONObject {
        val manifest = row.getJSONObject("pending").getJSONObject("manifest"); val item = manifest.getJSONObject("item"); val id = UUID.randomUUID().toString()
        return JSONObject().put("id", id).put("captureId", id).put("sourceId", manifest.getString("sourceId")).put("externalId", item.getString("externalId"))
            .put("revision", item.getString("revision")).put("sha256", manifest.getString("sha256")).put("sizeBytes", manifest.getLong("sizeBytes"))
            .put("receipt", JSONObject().put("version", 2).put("id", id).put("kind", "file-revision").put("state", "received").put("duplicate", false)
                .put("sourceId", manifest.getString("sourceId")).put("externalId", item.getString("externalId")).put("revision", item.getString("revision")))
    }
    private fun export(queue: FileArchiveQueue, source: LocalSource, row: JSONObject): ByteArray {
        val item = row.getJSONObject("pending").getJSONObject("manifest").getJSONObject("item")
        return ByteArrayOutputStream().also { queue.exportPending(source.id, item.getString("externalId"), item.getString("revision"), it) }.toByteArray()
    }

    @Test fun immediateNarrowThenWidenSurvivesRestartAndRequiresANewAdmissionWithoutClobberingOldSpool() {
        val config = folder.newFolder(); val root = folder.newFolder(); val store = LocalSourceStore(config, cipher, root); val source = source(); store.save(source)
        val queue = FileArchiveQueue(root, cipher, store); val oldLease = store.lease(source)!!
        queue.observe(source, item(), queue.configure(source).getString("generation"), 0)
        val bytes = "Generated quarantined original".toByteArray()
        val pending = queue.prepare(source, { ByteArrayInputStream(bytes) }, { true }, 61000)!!
        store.save(source.copy(excluded = "a.txt")); store.save(source) // No worker runs between these edits.
        val restartedStore = LocalSourceStore(config, cipher, root); val restarted = FileArchiveQueue(root, cipher, restartedStore)
        assertNull(restarted.next(source.id)); assertEquals(1, restarted.pendingSync().count)
        assertArrayEquals(bytes, export(restarted, source, pending))
        assertNull(restarted.prepare(source, { error("A widening does not revive old quarantined input") }, { true }, 62000))
        assertThrows(IllegalStateException::class.java) { restarted.assertCurrent(source, pending, oldLease) }
        restarted.observe(source, item(), restarted.configure(source).getString("generation"), 62000)
        val freshBytes = "Generated new admitted original".toByteArray()
        val fresh = restarted.prepare(source, { ByteArrayInputStream(freshBytes) }, { true }, 123000)!!
        assertNotEquals(pending.getJSONObject("pending").getJSONObject("manifest").getJSONObject("item").getString("revision"), fresh.getJSONObject("pending").getJSONObject("manifest").getJSONObject("item").getString("revision"))
        assertArrayEquals(bytes, export(restarted, source, pending)); assertArrayEquals(freshBytes, export(restarted, source, fresh))
        restarted.acknowledge(source.id, fresh, ack(fresh), "https://generated.invalid")
        assertNull(restarted.next(source.id)); assertEquals(1, restarted.pendingSync().count)
        assertArrayEquals(bytes, export(restarted, source, pending))
        assertEquals("https://generated.invalid", restarted.row(source.id, item().getString("externalId")).getString("archiveOrigin"))
    }

    @Test fun narrowingUnrelatedExtensionsResumesTheExactStillAllowedManifestWithUnchangedPrivacy() {
        val root = folder.newFolder(); val store = LocalSourceStore(folder.newFolder(), cipher, root); val source = source(); store.save(source)
        val queue = FileArchiveQueue(root, cipher, store)
        queue.observe(source, item(), queue.configure(source).getString("generation"), 0)
        val pending = queue.prepare(source, { ByteArrayInputStream("Generated".toByteArray()) }, { true }, 61000)!!
        val allowed = source.copy(extensions = "txt", excluded = "private/*")
        store.save(allowed); queue.configure(allowed)
        assertEquals(pending.getJSONObject("pending").toString(), queue.next(source.id)!!.getJSONObject("pending").toString())
        queue.assertCurrent(allowed, pending)
        queue.acknowledge(source.id, pending, ack(pending)); assertEquals(0, queue.pendingSync().count)
    }

    @Test fun unknownLegacyAdmissionIsHeldAndNeverReconstructedFromTheCurrentSelection() {
        val root = folder.newFolder(); val source = source(); val queue = FileArchiveQueue(root, cipher)
        queue.observe(source, item(), queue.configure(source).getString("generation"), 0)
        val bytes = "Generated legacy pending".toByteArray(); val pending = queue.prepare(source, { ByteArrayInputStream(bytes) }, { true }, 61000)!!
        pending.getJSONObject("pending").remove("sourceScope"); pending.remove("sourceScope"); queue.saveRow(source.id, pending)
        val reopened = FileArchiveQueue(root, cipher); reopened.configure(source); assertNull(reopened.next(source.id))
        reopened.configure(source.copy(extensions = "txt")); reopened.configure(source)
        assertNull(reopened.next(source.id)); assertEquals(1, reopened.pendingSync().count); assertArrayEquals(bytes, export(reopened, source, pending))
    }

    @Test fun indexedScopeRevocationKeepsOldInputAndFreshScanCreatesANewRevisionAndActualAckIdentity() {
        val root = folder.newFolder(); val store = LocalSourceStore(root, cipher)
        val source = source().copy(retention = "snapshot", centralProcessingConsent = true)
        val body = item().put("layer", "snapshot").put("text", "Generated immutable text")
        store.save(source); store.selectTarget(source.id, "target"); store.scan(source, SourceScan(listOf(body), true, at))
        val pending = store.next(source.id, "target")!!
        store.save(source.copy(uri = "content://fixture/another-root")); store.save(source)
        val restarted = LocalSourceStore(root, cipher); assertNull(restarted.next(source.id, "target"))
        assertEquals(0, restarted.requeueRetained("https://generated.invalid")); assertEquals(1, restarted.pendingSync().count)
        assertEquals(pending.toString(), restarted.state(source.id).getJSONArray("quarantine").getJSONObject(0).getJSONObject("item").toString())
        restarted.scan(source, SourceScan(listOf(body), true, at)); val fresh = restarted.next(source.id, "target")!!
        assertNotEquals(pending.getString("revision"), fresh.getString("revision"))
        val identity = ItemUploadIdentity("source-item", "scope", "source", "https://generated.invalid", "device", "target", source.id,
            fresh.getString("externalId"), fresh.getString("revision"), SourceRules.hash(SourceRules.canonical(fresh)))
        val canonical = UUID.randomUUID().toString()
        assertTrue(restarted.acknowledgeExact(identity, canonical)); assertTrue(restarted.acknowledgeExact(identity, canonical))
        assertFalse(restarted.acknowledgeExact(identity, UUID.randomUUID().toString()))
        val archive = restarted.state(source.id).getJSONObject("archiveAcknowledgments").getJSONObject(SourceAdmission.key(fresh))
        assertEquals(identity.origin, archive.getString("origin")); assertEquals(canonical, archive.getString("captureId"))
        restarted.selectTarget(source.id, "new-target"); assertNull(restarted.next(source.id, "new-target")); assertEquals(1, restarted.state(source.id).getJSONObject("current").length())
        assertEquals(1, restarted.pendingSync().count)
    }

    @Test fun actualAckJournalRenameFailureKeepsExactPendingBytesAndNeverDeletesTheSourceOriginal() {
        val root = folder.newFolder(); val sourceFile = folder.newFile().apply { writeText("Generated provider original") }
        val source = source(); val rowFile = File(File(root, source.id), "item-${SourceRules.hash(item().getString("externalId"))}.enc")
        val old = File(rowFile.parentFile, "before-failure.enc"); var fail = false
        val failing = object : ByteCipher {
            override fun open(bytes: ByteArray) = bytes
            override fun seal(bytes: ByteArray): ByteArray {
                if (fail) {
                    val row = JSONObject(String(bytes))
                    if (row.has("captureId") && !row.has("pending")) { check(rowFile.renameTo(old)); check(rowFile.mkdir()) }
                }
                return bytes
            }
        }
        val queue = FileArchiveQueue(root, failing); queue.observe(source, item(), queue.configure(source).getString("generation"), 0)
        val pending = queue.prepare(source, { sourceFile.inputStream() }, { true }, 61000)!!; val before = rowFile.readBytes()
        fail = true
        try { assertThrows(IllegalStateException::class.java) { queue.acknowledge(source.id, pending, ack(pending)) } }
        finally { check(rowFile.delete()); check(old.renameTo(rowFile)); fail = false }
        assertArrayEquals(before, rowFile.readBytes()); val restarted = FileArchiveQueue(root, cipher)
        assertNotNull(restarted.next(source.id)); assertArrayEquals(sourceFile.readBytes(), export(restarted, source, pending))
        assertEquals("Generated provider original", sourceFile.readText())
    }
}
