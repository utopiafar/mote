package dev.mote.collector
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class CaptureSessionsTest {
    private fun sample(id: Int, ms: Long, app: String = "a") = JSONObject().put("id", "%08d-1111-4111-8111-111111111111".format(id))
        .put("source", "screen").put("appId", app).put("appName", app).put("capturedAt", Instant.parse("2026-09-16T00:00:00Z").plusMillis(ms).toString()).put("hasImage", id != 1)
    @Test fun sessionsCrossClockBucketsButSplitAppReturnsAndGaps() {
        val rows = listOf(sample(1,899000), sample(2,900000), sample(3,1200000), sample(4,1500001), sample(5,1500002,"b"), sample(6,1500003))
        val page = CaptureSessions.page(rows.reversed(), null)
        assertEquals(4, page.getInt("sessionCount")); assertEquals(6, page.getInt("totalCount"))
        val earliest = page.getJSONArray("items").getJSONObject(3)
        assertEquals(3, earliest.getInt("count")); assertEquals(2, earliest.getInt("imageCount"))
        val images = CaptureSessions.images(rows, earliest.getString("id"), null, 2)
        assertEquals(2, images.getJSONArray("items").length())
        val next = CaptureSessions.images(rows, earliest.getString("id"), images.getString("nextCursor"), 2)
        assertEquals(rows[0].getString("id"), next.getJSONArray("items").getJSONObject(0).getString("id"))
        assertFalse(images.toString().contains("blob"))
        val first = CaptureSessions.page(rows, null, 2); val second = CaptureSessions.page(rows, first.getString("nextCursor"), 2)
        assertEquals(2, second.getJSONArray("items").length()); assertTrue(second.isNull("nextCursor"))
    }
    @Test fun deletingSessionAnchorSignalsARefreshInsteadOfReturningStaleMembers() {
        val first = sample(1, 0); val remaining = sample(2, 1000)
        assertThrows(CaptureSessionChangedException::class.java) { CaptureSessions.images(listOf(remaining), first.getString("id"), null) }
        assertEquals(remaining.getString("id"), CaptureSessions.page(listOf(remaining), null).getJSONArray("items").getJSONObject(0).getString("id"))
    }
    @Test fun switchesAtIdenticalTimestampsDoNotLeakOtherSessionsIntoGrid() {
        val rows = listOf(sample(1,0),sample(2,0,"b"),sample(3,0))
        assertEquals(3, CaptureSessions.page(rows, null).getInt("sessionCount"))
        for (row in rows) assertEquals(1, CaptureSessions.images(rows, row.getString("id"), null).getInt("totalCount"))
        assertEquals(2, CaptureSessions.page(listOf(sample(1,0,""),sample(2,1,"")),null).getInt("sessionCount"))
    }
}
