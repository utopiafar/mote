package dev.mote.collector

import org.json.JSONObject
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
}
