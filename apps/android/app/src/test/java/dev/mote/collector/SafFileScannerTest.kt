package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.util.UUID

/** A generated provider drives the production traversal and encrypted journal. */
class SafFileScannerTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 57).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }
    private val source = LocalSource(id = "generated-saf", name = "Generated SAF", kind = "local-files", retention = "reference",
        uri = "content://generated/tree/root", tree = true, extensions = "txt")

    @Test fun opaqueProviderIdsAreNotTreatedAsPathSegmentsOrFilesystemIds() {
        assertEquals("generated" to "document", SafIdentity.document("content://generated/tree/root/document/document"))
        assertEquals("generated" to "a/b+c", SafIdentity.document("content://generated/tree/root/document/a%2Fb+c"))
        assertEquals(SafIdentity.root(source.uri, true), SafIdentity.root("content://generated/tree/root/document/root", true))
        assertNotEquals(SafIdentity.root(source.uri, true), SafIdentity.root("content://other/tree/root", true))
        assertEquals("content://generated/tree/a%2Fb", SafIdentity.selection("content://generated/tree/a%2Fb/document/document", true))
    }

    private class Provider : SafScanProvider {
        override var watcher = "process-1"
        var granted = true
        var loading = false
        var offline = false
        var interruptAfter: Int? = null
        var checks = 0
        var revokeAt: Int? = null
        var opened = 0
        val documents = linkedMapOf<String, SafDocument>()
        val children = mutableMapOf<String, MutableList<String>>()
        private fun uri(id: String) = "content://generated/tree/root/document/$id"
        fun file(id: String, name: String = "$id.txt", parent: String = "root", size: Long = 4): SafDocument {
            val doc = SafDocument(id, uri(id), name, "text/plain", size, 1000, false)
            documents[id] = doc; children.getOrPut(parent) { mutableListOf() }.add(id); return doc
        }
        fun directory(id: String, parent: String = "root") {
            documents[id] = SafDocument(id, uri(id), id, "vnd.android.document/directory", null, null, true)
            children.getOrPut(parent) { mutableListOf() }.add(id)
        }
        override fun checkAccess() { checks++; if (checks == revokeAt) granted = false; if (!granted) throw SecurityException("Generated revoked grant") }
        override fun root() = if (offline) null else SafDocument("root", uri("root"), "root", "vnd.android.document/directory", null, null, true)
        override fun document(uri: String) = documents.values.firstOrNull { it.uri == uri }
        override fun children(parent: String, visit: (SafDocument) -> Boolean): SafChildrenResult {
            var read = 0
            for (id in children[parent].orEmpty()) {
                if (interruptAfter != null && read++ == interruptAfter) throw IllegalStateException("Generated provider interruption")
                if (!visit(documents.getValue(id))) return SafChildrenResult.STOPPED
            }
            return if (loading) SafChildrenResult.INCOMPLETE else SafChildrenResult.COMPLETE
        }
        override fun absent(uri: String) = document(uri) == null
        fun open(bytes: ByteArray): ByteArrayInputStream { opened++; return ByteArrayInputStream(bytes) }
    }
    private fun scanner(queue: FileArchiveQueue, provider: Provider, size: Int = 200) = SafFileScanner(queue, provider, sliceSize = size)
    private fun scanAll(queue: FileArchiveQueue, provider: Provider, source: LocalSource = this.source, size: Int = 200) {
        repeat(20) { if (scanner(queue, provider, size).scan(source)) return }
        fail("Generated scan did not complete")
    }
    private fun ack(queue: FileArchiveQueue, source: LocalSource, row: JSONObject) {
        val m = row.getJSONObject("pending").getJSONObject("manifest"); val i = m.getJSONObject("item"); val id = UUID.randomUUID().toString()
        val receipt = JSONObject().put("version", 2).put("id", id).put("kind", "file-revision").put("state", "received").put("duplicate", false)
            .put("sourceId", source.id).put("externalId", i.getString("externalId")).put("revision", i.getString("revision"))
        queue.acknowledge(source.id, row, JSONObject(receipt.toString()).put("receipt", receipt).put("sha256", m.optString("sha256")).put("sizeBytes", m.getLong("sizeBytes")))
    }
    private fun drainReferences(queue: FileArchiveQueue, provider: Provider) {
        while (true) {
            val row = queue.prepare(source, { provider.open("not authorized".toByteArray()) }, { error("Reference must not inspect content") }) ?: break
            assertFalse(row.getJSONObject("pending").getJSONObject("manifest").has("sha256")); ack(queue, source, row)
        }
    }

    @Test fun movingTheSameDocumentAndReplacingItsIdKeepDistinctOriginsWithoutReadingReferenceBytes() {
        val queue = FileArchiveQueue(folder.newFolder(), cipher); val provider = Provider()
        val original = provider.file("one"); provider.directory("nested")
        scanAll(queue, provider); drainReferences(queue, provider)
        provider.children.getValue("root").remove("one"); provider.children.getOrPut("nested") { mutableListOf() }.add("one")
        queue.providerChanged(source); scanAll(queue, provider)
        val moved = queue.candidate(source.id, original.uri)!!
        assertEquals(original.uri, moved.getString("externalId")); assertEquals("nested/one.txt", moved.getString("_relativePath"))
        drainReferences(queue, provider)
        provider.children.getValue("nested").clear(); provider.documents.remove("one"); val replacement = provider.file("two", "one.txt", "nested")
        queue.providerChanged(source); scanAll(queue, provider)
        assertTrue(queue.candidate(source.id, original.uri)!!.getBoolean("deleted"))
        assertFalse(queue.candidate(source.id, replacement.uri)!!.optBoolean("deleted"))
        assertEquals(2, queue.rows(source.id).size); drainReferences(queue, provider); assertEquals(0, provider.opened)
    }

    @Test fun loadingInterruptionAndRevocationNeverTurnAnIncompleteScanIntoDeletion() {
        val queue = FileArchiveQueue(folder.newFolder(), cipher); val provider = Provider()
        val first = provider.file("first"); provider.file("second")
        scanAll(queue, provider); drainReferences(queue, provider)
        val last = queue.state(source.id).getString("lastScan")
        provider.children.getValue("root").clear(); provider.loading = true
        assertThrows(SafScanIncomplete::class.java) { scanner(queue, provider).scan(source) }
        assertFalse(queue.state(source.id).getBoolean("scanComplete")); assertEquals(last, queue.state(source.id).getString("lastScan"))
        assertFalse(queue.candidate(source.id, first.uri)!!.optBoolean("deleted")); assertEquals(0, queue.pendingCount(source.id))
        provider.loading = false; provider.children.getValue("root").addAll(listOf("first", "second")); provider.interruptAfter = 1
        assertThrows(IllegalStateException::class.java) { scanner(queue, provider).scan(source) }
        assertFalse(queue.state(source.id).getBoolean("scanComplete")); assertEquals(0, queue.pendingCount(source.id))
        provider.interruptAfter = null; provider.checks = 0; provider.revokeAt = 3
        assertThrows(SecurityException::class.java) { scanner(queue, provider).scan(source) }
        assertFalse(queue.state(source.id).getBoolean("scanComplete")); assertEquals(0, queue.pendingCount(source.id))
        provider.granted = true; provider.revokeAt = null; provider.offline = true
        assertThrows(SafScanIncomplete::class.java) { scanner(queue, provider).scan(source) }
        assertEquals(last, queue.state(source.id).getString("lastScan")); assertEquals(0, queue.pendingCount(source.id))
        provider.offline = false; provider.documents.clear(); provider.children.getValue("root").clear()
        scanAll(queue, provider); assertTrue(queue.state(source.id).getBoolean("scanComplete"))
        assertTrue(queue.candidate(source.id, first.uri)!!.getBoolean("deleted")); assertEquals(2, queue.pendingCount(source.id))
    }

    @Test fun changedPageOrderAndProcessRestartRestartTheTraversalWithoutSkippingDocuments() {
        val dir = folder.newFolder(); var queue = FileArchiveQueue(dir, cipher); val provider = Provider()
        provider.file("a"); provider.file("b"); provider.file("c")
        assertFalse(scanner(queue, provider, 1).scan(source))
        provider.children.getValue("root").reverse()
        assertFalse(scanner(queue, provider, 1).scan(source)) // checkpoint prefix no longer matches
        assertFalse(queue.state(source.id).getBoolean("scanComplete"))
        provider.watcher = "process-2"; queue = FileArchiveQueue(dir, cipher)
        scanAll(queue, provider, size = 1)
        assertEquals(setOf("a.txt", "b.txt", "c.txt"), queue.rows(source.id).map { it.getJSONObject("candidate").getString("title") }.toSet())
        assertTrue(queue.state(source.id).getBoolean("scanComplete")); assertEquals(3, queue.pendingCount(source.id))
    }

    @Test fun providerChangeRechecksSameSizeAndTimeWithoutSendingIdenticalBytesAgain() {
        val dir = folder.newFolder(); var queue = FileArchiveQueue(dir, cipher); val provider = Provider()
        val archive = source.copy(retention = "archive"); provider.file("same", size = 4)
        scanAll(queue, provider, archive)
        val first = queue.prepare(archive, { provider.open("aaaa".toByteArray()) }, { true }, now = System.currentTimeMillis() + 61000)!!
        ack(queue, archive, first)
        queue.providerChanged(archive)
        val unverified = queue.rows(archive.id).single()
        assertNull(LocalContentPresentation.currentReceipt(unverified))
        assertEquals(0, queue.progress(archive, System.currentTimeMillis() + 61000).received)
        scanAll(queue, provider, archive)
        queue = FileArchiveQueue(dir, cipher)
        val changed = queue.prepare(archive, { provider.open("bbbb".toByteArray()) }, { true }, now = System.currentTimeMillis() + 61000)!!
        assertNotEquals(first.getJSONObject("pending").getJSONObject("manifest").getString("sha256"), changed.getJSONObject("pending").getJSONObject("manifest").getString("sha256"))
        assertArrayEquals("bbbb".toByteArray(), queue.part(archive.id, 0)); ack(queue, archive, changed)
        queue.providerChanged(archive); scanAll(queue, provider, archive)
        assertNull(queue.prepare(archive, { provider.open("bbbb".toByteArray()) }, { true }, now = System.currentTimeMillis() + 61000))
        assertNotNull(LocalContentPresentation.currentReceipt(queue.rows(archive.id).single()))
        assertEquals(0, queue.pendingCount(archive.id)); assertEquals(3, provider.opened)
    }
    @Test fun workerRechecksTheCurrentGrantBetweenPartsAndPreservesThePendingSpool() {
        val dir = folder.newFolder(); val queue = FileArchiveQueue(dir, cipher); val provider = Provider()
        val archive = source.copy(retention = "archive"); provider.file("upload", size = 4)
        scanAll(queue, provider, archive)
        val pending = queue.prepare(archive, { provider.open("aaaa".toByteArray()) }, { true }, now = System.currentTimeMillis() + 61000)!!
        fun admitted() = SafUploadGate.runnable(true, false) { provider.granted }
        assertTrue(admitted()); provider.granted = false; assertFalse(admitted())
        val restarted = FileArchiveQueue(dir, cipher)
        assertEquals(pending.getJSONObject("pending").toString(), restarted.next(archive.id)!!.getJSONObject("pending").toString())
        assertArrayEquals("aaaa".toByteArray(), restarted.part(archive.id, 0))
        provider.granted = true; assertTrue(admitted())
        ack(restarted, archive, pending); assertEquals(0, restarted.pendingCount(archive.id))
        provider.granted = false
        assertTrue(SafUploadGate.runnable(true, true) { provider.granted })
        assertFalse(SafUploadGate.runnable(false, true) { provider.granted })
    }
    @Test fun changeWhileFirstVersionIsPendingIsNotLostWhenItsReceiptArrives() {
        val queue = FileArchiveQueue(folder.newFolder(), cipher); val provider = Provider()
        val archive = source.copy(retention = "archive"); provider.file("pending", size = 4)
        scanAll(queue, provider, archive)
        val first = queue.prepare(archive, { provider.open("aaaa".toByteArray()) }, { true }, now = System.currentTimeMillis() + 61000)!!
        queue.providerChanged(archive); scanAll(queue, provider, archive)
        ack(queue, archive, first)
        val next = queue.prepare(archive, { provider.open("bbbb".toByteArray()) }, { true }, now = System.currentTimeMillis() + 61000)!!
        assertArrayEquals("bbbb".toByteArray(), queue.part(archive.id, 0))
        assertEquals(first.getJSONObject("pending").getJSONObject("manifest").getJSONObject("item").getString("revision"), next.getJSONObject("pending").getJSONObject("manifest").getString("previousRevision"))
    }
}
