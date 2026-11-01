package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

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
        assertEquals(setOf(LibraryCaptureProjection.Identity("https://new.invalid", "phone", "same"), LibraryCaptureProjection.Identity("https://new.invalid", "other", "same")), projection.candidates("https://new.invalid").toSet())
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
    @Test fun firstPageUpsertKeepsDeeperRowsAndStaysIdempotent() {
        val projection = LibraryCaptureProjection()
        val pageOne = record("p1", at = "2026-10-01T10:00:00Z"); val pageTwo = record("p2", at = "2026-09-30T10:00:00Z")
        projection.local(pageOne, "", "phone"); projection.local(pageTwo, "", "phone")
        val fresh = record("n1", at = "2026-10-02T10:00:00Z")
        projection.local(fresh, "", "phone")
        assertEquals(listOf("n1", "p1", "p2"), projection.visible("local").map { it.identity.id })
        projection.local(record("n1", at = "2026-10-02T10:00:00Z"), "", "phone")
        projection.local(record("p1", at = "2026-10-01T10:00:00Z"), "", "phone")
        assertEquals("Re-reading the first page never duplicates identities", listOf("n1", "p1", "p2"), projection.visible("local").map { it.identity.id })
        assertSame(pageTwo, projection.visible("local").single { it.identity.id == "p2" }.local)
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
    @Test fun freshMatchesWithdrawRemoteOnlyDeepRowsWithoutLosingLocalOriginals() {
        val projection = LibraryCaptureProjection()
        projection.central(record("deleted-deep"), "central")
        projection.local(record("retained-local"), "central", "phone")
        projection.central(record("other-origin"), "other")
        assertEquals(setOf("deleted-deep", "retained-local"), projection.candidates("central").map { it.id }.toSet())
        assertEquals("version-a", projection.remoteVersions("central")["phone" to "deleted-deep"])
        projection.availability("central", "phone", "deleted-deep", false)
        projection.availability("central", "phone", "retained-local", false)
        assertEquals(setOf("retained-local", "other-origin"), projection.visible("").map { it.identity.id }.toSet())
        assertEquals(LibraryCaptureProjection.Remote.UNAVAILABLE, projection.visible("local").single().remote)
    }

    @Test fun laterLocalPageGetsItsFirstAvailabilityOnlyOnTheNextMatchResponse() {
        val projection = LibraryCaptureProjection()
        val locals = (0 until 60).map { record("local-$it", at = Instant.ofEpochSecond(1_000_000L - it).toString()) }
        repeat(25) { projection.central(record("remote-$it", device = "other"), "central") }
        // Central's two pages end before local page three. The earlier local
        // pages receive missing matches; page three has no remote read yet.
        locals.take(40).forEach { projection.local(it, "central", "phone"); projection.availability("central", "phone", it.getString("id"), false) }
        locals.drop(40).forEach { projection.local(it, "central", "phone") }
        val before = projection.visible("local").single { it.identity.id == "local-50" }
        assertEquals(LibraryCaptureProjection.Remote.UNKNOWN, before.remote)
        val original = SourceRules.canonical(before.item)

        projection.candidates("central").filter { it.deviceId == "phone" }.forEach { projection.availability("central", it.deviceId, it.id, false) }
        val after = projection.visible("local").single { it.identity.id == "local-50" }
        assertSame(before.item, after.item)
        assertEquals(original, SourceRules.canonical(after.item))
        assertEquals("the first real missing match legitimately changes the row's displayed availability", LibraryCaptureProjection.Remote.UNAVAILABLE, after.remote)
        assertEquals(25, projection.visible("central").size)
    }

}
