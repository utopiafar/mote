package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

class CentralEvidenceReferenceTest {
    @Test fun publicCaptureReferencesNeverGuessBareIdsOrOtherNamespaces() {
        val id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
        val reference = CentralEvidenceReference.capture(id)
        assertEquals("capture:" + id.lowercase(), reference)
        assertEquals(id.lowercase(), CentralEvidenceReference.captureId(reference))
        for (value in listOf(id, "memory:$id", "capture:generated", "capture:1-2-3-4-5")) assertNull(CentralEvidenceReference.captureId(value))
        assertThrows(IllegalArgumentException::class.java) { CentralEvidenceReference.capture("capture:$id") }
        assertThrows(IllegalArgumentException::class.java) { CentralEvidenceReference.capture("1-2-3-4-5") }
    }
}
