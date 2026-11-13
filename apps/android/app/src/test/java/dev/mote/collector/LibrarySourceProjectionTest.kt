package dev.mote.collector

import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

class LibrarySourceProjectionTest {
    private fun original(revision: String = "v1", source: String = "source", external: String = "external", device: String = "phone") = JSONObject().put("type", "original").put("sourceId", source).put("externalId", external).put("deviceId", device).put("revision", revision).put("title", "Same generated title").put("sortAt", "2026-10-01T00:00:00Z").put("captureId", "capture").put("libraryVersion", "digest")
    @Test fun exactOriginalVersionJoinsAndDuplicatePagesStaySingleWithoutChangingLocalBody() {
        val projection = LibrarySourceProjection(); val local = original().put("localItem", JSONObject().put("text", "Retained original"))
        val before = local.toString(); projection.local("central", local)
        repeat(3) { projection.central("central", original()) }
        assertEquals(1, projection.visible("").size); assertEquals(1, projection.visible("local").size); assertEquals(1, projection.visible("central").size)
        assertEquals(before, local.toString())
    }
    @Test fun identitiesVersionsAndNamespacesNeverJoinByTitleOrTime() {
        val projection = LibrarySourceProjection(); projection.local("central", original())
        listOf(original("v2"),original(source="other"),original(external="other"),original(device="other"),original("candidate:unprepared")).forEach { projection.central("central", it) }
        projection.central("other", original())
        projection.central("central", JSONObject().put("type", "material").put("id", "source").put("revision", "v1").put("sortAt", "2026-10-01T00:00:00Z"))
        assertEquals(8, projection.visible("").size)
    }
    @Test fun provisionalCandidateIsNotAFormalSourceRevisionEvenWithEqualTextKey() {
        val projection = LibrarySourceProjection()
        projection.local("central", original("candidate:key").put("provisional", true))
        projection.central("central", original("candidate:key"))
        assertEquals(2, projection.visible("").size)
    }
    @Test fun denialOrOfflineDropsAllRemoteBodiesAndRelationsButKeepsLocalOriginal() {
        val projection = LibrarySourceProjection(); val local = original().put("localItem", JSONObject().put("text", "Retained original"))
        projection.local("central", local); projection.central("central", original().put("materialRef", "remote-ref")); projection.central("central", original("v2"))
        projection.clearCentral()
        assertEquals(1, projection.visible("").size); assertTrue(projection.visible("central").isEmpty()); assertNull(projection.visible("").single().central)
        assertEquals("Retained original", projection.visible("").single().item.getJSONObject("localItem").getString("text"))
    }
    @Test fun captureDedupRequiresActualOriginDeviceIdAndDigest() {
        val projection = LibrarySourceProjection(); projection.central("central", original())
        val capture = JSONObject().put("id", "capture").put("deviceId", "phone").put("libraryVersion", "digest")
        assertTrue(projection.containsCapture("central", capture)); assertFalse(projection.containsCapture("other", capture))
        assertFalse(projection.containsCapture("central", JSONObject(capture.toString()).put("deviceId", "other")))
        assertFalse(projection.containsCapture("central", JSONObject(capture.toString()).put("libraryVersion", "other")))
    }
    @Test fun fileMetadataAndPendingExtractionNeverClaimThatCentralBodyIsReadable() {
        val projection = LibrarySourceProjection(); val id = "35b8fadb-8f0a-4769-8545-cdad61c4041d"
        val row = original().put("captureId", id).put("fileArchive", JSONObject().put("captureId", id))
        projection.central("central", row); assertFalse(projection.visible("").single().centralReadable)
        fun view(status: String) = JSONObject().put("captureId", id).put("sourceId", "source").put("retention", "snapshot")
            .put("item", JSONObject().put("kind", "file").put("externalId", "external").put("revision", "v1"))
            .put("hasOriginal", false).put("originMissing", false).put("canOpenOriginal", false)
            .put("coverage", JSONObject().put("extraction", JSONObject().put("status", status)).put("semantic", JSONObject().put("status", "pending")).put("embedding", JSONObject().put("status", "pending")))
        row.put("_fileView", view("pending")); projection.central("central", row)
        assertFalse(projection.visible("").single().centralReadable)
        row.put("_fileView", view("ready")); projection.central("central", row)
        assertTrue(projection.visible("").single().centralReadable)
        row.getJSONObject("_fileView").getJSONObject("item").put("revision", "other-version")
        projection.central("central", row); assertFalse(projection.visible("").single().centralReadable)
        row.put("_fileView", view("ready").put("retention", "reference")); projection.central("central", row)
        assertFalse(projection.visible("").single().centralReadable)
        val malformed = view("ready"); malformed.getJSONObject("coverage").getJSONObject("extraction").put("completed", "1").put("total", 1)
        row.put("_fileView", malformed); projection.central("central", row); assertFalse(projection.visible("").single().centralReadable)
    }
    @Test fun fileCapabilitiesAndRetentionComeFromTheVerifiedExactView() {
        val projection = LibrarySourceProjection(); val id = "35b8fadb-8f0a-4769-8545-cdad61c4041d"
        val row = original().put("captureId", id).put("fileArchive", JSONObject().put("captureId", id))
        fun view(retention: String, hasOriginal: Boolean, canOpen: Boolean, status: String) = JSONObject().put("captureId", id)
            .put("sourceId", "source").put("retention", retention)
            .put("item", JSONObject().put("kind", "file").put("externalId", "external").put("revision", "v1"))
            .put("hasOriginal", hasOriginal).put("originMissing", false).put("canOpenOriginal", canOpen)
            .put("coverage", JSONObject().put("extraction", JSONObject().put("status", status))
                .put("semantic", JSONObject().put("status", "pending")).put("embedding", JSONObject().put("status", "pending")))
        row.put("_fileView", view("archive", true, false, "ready")); projection.central("central", row)
        val closed = projection.visible("").single()
        assertNotNull(closed.fileView); assertTrue(closed.centralReadable); assertFalse(closed.canOpenOriginal)
        row.put("_fileView", view("archive", true, true, "ready")); projection.central("central", row)
        assertTrue(projection.visible("").single().canOpenOriginal)
        row.put("_fileView", view("reference", false, false, "ready")); projection.central("central", row)
        val reference = projection.visible("").single()
        assertFalse(reference.centralReadable); assertFalse(reference.canOpenOriginal)
        row.put("_fileView", JSONObject().put("captureId", id)); projection.central("central", row)
        val malformed = projection.visible("").single()
        assertNull(malformed.fileView); assertFalse(malformed.centralReadable); assertFalse(malformed.canOpenOriginal)
    }

    @Test fun anOfflinePreparedLocalFileStaysReadableButAReferenceRowDoesNot() {
        val projection = LibrarySourceProjection()
        val pending = JSONObject().put("type", "original").put("sourceId", "source").put("externalId", "external")
            .put("deviceId", "phone").put("revision", "v1").put("title", "Generated local").put("sortAt", "2026-10-01T00:00:00Z")
            .put("localFile", true).put("layer", "snapshot").put("pending", JSONObject().put("manifest", JSONObject().put("sha256", "hash")))
        projection.local("central", pending)
        assertTrue(projection.visible("").single().localReadable)
        projection.clear(); projection.local("central", JSONObject(pending.toString()).put("layer", "reference"))
        assertFalse(projection.visible("").single().localReadable)
    }

    @Test fun aRevokedFileStopsTheWholeRemotePageBeforePublishingItsMetadata() {
        val projection = LibrarySourceProjection()
        val first = original().put("captureId", "first").put("fileArchive", JSONObject())
        val second = original(external = "other").put("captureId", "second").put("fileArchive", JSONObject())
        val page = JSONObject().put("items", JSONArray(listOf(first, second))).put("matches", JSONArray())
        assertThrows(CentralFailure::class.java) {
            CentralFileView.enrichOriginals(page) { id -> if (id == "second") throw CentralFailure(403) else JSONObject() }
            repeat(page.getJSONArray("items").length()) { projection.central("central", page.getJSONArray("items").getJSONObject(it)) }
        }
        assertTrue(projection.visible("").isEmpty())
    }
}
