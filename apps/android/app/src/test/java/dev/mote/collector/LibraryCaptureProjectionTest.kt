package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LibraryCaptureProjectionTest {
    private fun record(id: String = "same", device: String = "phone", at: String = "2026-10-01T10:00:00Z") = JSONObject()
        .put("id", id).put("deviceId", device).put("capturedAt", at).put("source", "note").put("libraryVersion", "version-a").put("textPreview", "Generated owner comment")
        .put("metadata", JSONObject().put("noteOrigin", JSONObject().put("kind", "share").put("text", "Generated quoted original")))
    @Test fun exactIdentityJoinsLocationsAndRepeatedPagesWithoutChangingEvidence() {
        val projection = LibraryCaptureProjection(); val local = record()
        projection.local(local, "https://central.invalid", "phone")
        projection.central(record(), "https://central.invalid"); projection.central(record(), "https://central.invalid")
        val row = projection.visible("").single()
        assertFalse(row.remoteOnly); assertSame(local, row.local); assertEquals(LibraryCaptureProjection.Remote.READABLE, row.remote)
        assertEquals(1, projection.visible("central").size); assertEquals(1, projection.visible("local").size)
        assertEquals("Generated quoted original", row.item.getJSONObject("metadata").getJSONObject("noteOrigin").getString("text"))
        assertFalse(local.has("uploaded")) // A remote read is never an upload acknowledgement.
    }
    @Test fun sameIdAcrossOriginAndDeviceAndUnboundRecordsNeverMerge() {
        val projection = LibraryCaptureProjection()
        projection.local(record(), "https://old.invalid", "phone"); projection.local(record(), "", "phone")
        projection.central(record(), "https://new.invalid"); projection.central(record(device = "other"), "https://new.invalid")
        assertEquals(4, projection.visible("").size); assertEquals(2, projection.visible("local").size)
        assertTrue(projection.candidates("https://new.invalid").isEmpty())
        assertTrue(projection.visible("local").all { it.remote == LibraryCaptureProjection.Remote.UNKNOWN })
        projection.clear(); assertTrue(projection.visible("").isEmpty())
    }
    @Test fun unavailableAndUnknownRemainDistinctAndSortKeysAreStable() {
        val projection = LibraryCaptureProjection()
        projection.local(record("old"), "central", "phone"); projection.local(record("new", at = "2026-10-02T10:00:00Z"), "central", "phone")
        projection.availability("central", "phone", "old", false)
        assertEquals(listOf("new", "old"), projection.visible("").map { it.identity.id })
        assertEquals(LibraryCaptureProjection.Remote.UNKNOWN, projection.visible("")[0].remote)
        assertEquals(LibraryCaptureProjection.Remote.UNAVAILABLE, projection.visible("")[1].remote)
        assertTrue(projection.visible("central").isEmpty())
    }

    @Test fun sameCaptureWithNewLocalObservationsDoesNotClaimTheCentralVersionIsTheLocalVersion() {
        val projection = LibraryCaptureProjection()
        projection.local(record().put("observationCount", 2).put("libraryVersion", "version-b"), "central", "phone")
        projection.central(record().put("observationCount", 1), "central")
        val row = projection.visible("").single()
        assertEquals(LibraryCaptureProjection.Remote.OTHER_VERSION, row.remote)
        assertEquals(2, LibraryCaptureProjection.observations(row.item))
        assertEquals(1, LibraryCaptureProjection.observations(row.central!!))
        assertEquals(1, projection.visible("central").size)
        projection.clear(); projection.local(record().put("observationCount", 2).put("libraryVersion", "version-b"), "central", "phone")
        projection.availability("central", "phone", "same", true, 1, "version-a")
        assertEquals(LibraryCaptureProjection.Remote.OTHER_VERSION, projection.visible("").single().remote)
        assertEquals(1, LibraryCaptureProjection.observations(projection.visible("").single().central!!))
        projection.availability("central", "phone", "same", true, 2, "version-b")
        assertEquals(LibraryCaptureProjection.Remote.READABLE, projection.visible("").single().remote)
    }

    @Test fun sameObservationCountWithDifferentOriginalMetadataRemainsAnotherVersion() {
        val projection = LibraryCaptureProjection()
        projection.local(record().put("libraryVersion", "metadata-b"), "central", "phone")
        projection.central(record().put("libraryVersion", "metadata-a"), "central")
        assertEquals(LibraryCaptureProjection.Remote.OTHER_VERSION, projection.visible("").single().remote)
    }
    @Test fun accessLossDropsRemoteBodiesAndClaimsWhileKeepingLocalOriginals() {
        val projection = LibraryCaptureProjection(); val original = record()
        projection.local(original, "central", "phone")
        projection.central(record(), "central")
        projection.central(record("remote-only"), "central")
        projection.central(record("other-origin"), "other")
        projection.clearCentral("central")
        val local = projection.visible("local").single()
        assertSame(original, local.item); assertNull(local.central)
        assertEquals(LibraryCaptureProjection.Remote.UNKNOWN, local.remote)
        assertEquals(listOf("other-origin"), projection.visible("central").map { it.identity.id })
        assertFalse(projection.visible("").any { it.identity.id == "remote-only" })
        projection.central(record(), "central")
        assertEquals(LibraryCaptureProjection.Remote.READABLE, projection.visible("local").single().remote)
    }

}
