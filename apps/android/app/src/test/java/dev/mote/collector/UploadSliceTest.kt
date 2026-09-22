package dev.mote.collector
import org.junit.Assert.*
import org.junit.Test
class UploadSliceTest {
    @Test fun oneLargePartYieldsBeforeCommitAndLetsTheSmallSourceRun() {
        val events = mutableListOf<String>()
        var largeParts = 6; var smallRecords = 400; var after: String? = null
        repeat(20) {
            val dispatch = UploadSlice(maxBytes = 8L * 1024 * 1024)
            for (source in rotateUploadSources(listOf("large", "small"), after) { it }) {
                if (dispatch.exhausted) break
                after = source
                val slice = UploadSlice()
                if (source == "large" && largeParts > 0) {
                    assertTrue(slice.admit(500))
                    assertTrue(slice.admit(4 * 1024 * 1024)); largeParts--; events.add("large-part")
                    assertFalse(slice.admit(2))
                } else if (source == "small") {
                    var submitted = 0
                    while (smallRecords > 0 && submitted < 20 && slice.admit(1024)) { smallRecords--; submitted++; events.add("small") }
                }
                dispatch.record(slice.bytes, slice.requests)
                // Independent capture workers have their own bounded turns.
                val capture = UploadSlice(); assertTrue(capture.admit(512)); events.add("capture")
            }
        }
        assertEquals(0,largeParts);assertEquals(0,smallRecords)
        assertTrue(events.indexOf("small") < events.indexOfLast { it == "large-part" })
        assertTrue(events.indexOf("capture") < events.indexOfLast { it == "large-part" })
    }
    @Test fun metadataRequestsAndElapsedTimeAreBoundedEvenWithoutLargeBodies() {
        var time = 0L; val count = UploadSlice(maxRequests = 3, now = { time })
        repeat(3) { assertTrue(count.admit(0)) }; assertFalse(count.admit(0))
        val duration = UploadSlice(now = { time }); assertTrue(duration.admit(10)); time = 15000; assertFalse(duration.admit(1))
        assertEquals(1,duration.requests);assertEquals(10L,duration.bytes)
    }
    @Test fun rotationResumesAfterTheLastServedSourceAcrossDispatches() {
        assertEquals(listOf("b","c","a"),rotateUploadSources(listOf("a","b","c"),"a") { it })
        assertEquals(listOf("a","c"),rotateUploadSources(listOf("a","c"),"removed") { it })
        assertTrue(rotateUploadSources(emptyList<String>(),"a") { it }.isEmpty())
    }
}
