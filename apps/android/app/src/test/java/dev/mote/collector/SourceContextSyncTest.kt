package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SourceContextSyncTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private fun source() = LocalSource(id = "generated-source", name = "Generated", kind = "local-files", uri = "content://fixture/file")
    private fun snapshot(version: Int, description: String) = JSONObject().put("sourceId", "generated-source").put("version", version).put("description", description)
        .apply { if (version > 0) put("fingerprint", "a".repeat(64)) }
    @Test fun oldUndeclaredSourcesNeverSendAClearAndDoNotRequireTheNewApi() {
        val store = LocalSourceStore(folder.newFolder(), cipher); val source = source(); store.save(source)
        val result = SourceContextSync.sync(store, source, "http://fixture", "target", UploadSlice(), { true }) { _, _, _ -> error("Legacy no-context must not call the API") }
        assertEquals(source, result)
    }
    @Test fun explicitEmptyFirstDeclarationAcceptsTheCentralVersionZeroNoOp() {
        val store = LocalSourceStore(folder.newFolder(), cipher); val source = source().copy(contextDirty = true); store.save(source)
        val result = SourceContextSync.sync(store, source, "http://fixture", "target", UploadSlice(), { true }) { _, _, _ -> 200 to snapshot(0, "") }!!
        assertEquals(0, result.contextVersion); assertFalse(result.contextDirty)
    }
    @Test fun dirtyContextWaitsForValidatedAckAndSurvivesUnavailableCentralAndRestart() {
        val directory = folder.newFolder(); val store = LocalSourceStore(directory, cipher)
        val source = source().copy(description = "Generated background", contextDirty = true); store.save(source)
        val requests = mutableListOf<String>()
        assertNull(SourceContextSync.sync(store, source, "http://fixture", "target", UploadSlice(), { true }) { method, _, _ -> requests += method; 404 to null })
        assertEquals(listOf("GET"), requests); assertTrue(LocalSourceStore(directory, cipher).sources().single().contextDirty)
        val confirmed = SourceContextSync.sync(store, source, "http://fixture", "target", UploadSlice(), { true }) { method, _, body ->
            requests += method
            if (method == "GET") 200 to snapshot(0, "") else { assertEquals(0, body!!.getInt("expectedVersion")); assertEquals(source.description, body.getString("description")); 200 to snapshot(1, source.description) }
        }!!
        assertEquals(listOf("GET", "GET", "PATCH"), requests); assertFalse(confirmed.contextDirty); assertEquals(1, confirmed.contextVersion)
    }
    @Test fun lostAckRetryUsesSameExpectedVersionAndExplicitClearIsStillVersioned() {
        val store = LocalSourceStore(folder.newFolder(), cipher)
        val source = source().copy(description = "", contextVersion = 4, contextDirty = true, contextTarget = "target"); store.save(source)
        repeat(2) { attempt ->
            var result: LocalSource? = null
            val run = { result = SourceContextSync.sync(store, source, "http://fixture", "target", UploadSlice(), { true }) { method, _, body ->
                assertEquals("PATCH", method); assertEquals(4, body!!.getInt("expectedVersion")); assertEquals("", body.getString("description"))
                if (attempt == 0) throw java.io.IOException("Generated lost ACK") else 200 to snapshot(5, "")
            }
            }
            if (attempt == 0) assertThrows(java.io.IOException::class.java) { run() } else { run(); assertEquals(5, result!!.contextVersion); assertFalse(result!!.contextDirty) }
        }
    }
    @Test fun conflictKeepsLocalDescriptionAndRemoteVersionForAnExplicitChoice() {
        val store = LocalSourceStore(folder.newFolder(), cipher)
        val source = source().copy(description = "Local background", contextVersion = 1, contextDirty = true, contextTarget = "target"); store.save(source)
        val calls = mutableListOf<String>()
        val result = SourceContextSync.sync(store, source, "http://fixture", "target", UploadSlice(), { true }) { method, _, _ -> calls += method; if (method == "PATCH") 409 to null else 200 to snapshot(2, "Remote background") }
        assertNull(result); assertEquals(listOf("PATCH", "GET"), calls); assertEquals(source, store.sources().single())
        assertEquals("context-conflict", store.state(source.id).getString("status")); assertEquals("Remote background", store.state(source.id).getJSONObject("contextConflict").getString("description"))
    }
    @Test fun malformedAckCannotConfirmAnotherSourceOrTruncatedContext() {
        assertThrows(IllegalArgumentException::class.java) { SourceContextSnapshot.from(snapshot(1, "Generated").put("sourceId", "other"), "generated-source") }
        assertThrows(IllegalArgumentException::class.java) { SourceContextSnapshot.from(snapshot(1, "Generated").put("version", 1.5), "generated-source") }
        assertThrows(IllegalArgumentException::class.java) { SourceContextSnapshot.from(snapshot(0, "Must be empty"), "generated-source") }
    }
}
