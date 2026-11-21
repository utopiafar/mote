package dev.mote.collector

import dev.mote.collector.HomeArchiveProbe
import dev.mote.collector.LibraryPhoneFeed
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** The shared originals read still validates the exact page it renders after
 * the daily home owner moved to the tab shell. */
class HomeFeedReadTest {
    @Test fun theHomeReadValidatesTheExactCapturePageItRenders() {
        val id = UUID.randomUUID().toString()
        val page = JSONObject().put("items", JSONArray().put(JSONObject()
            .put("id", id).put("capturedAt", "2026-11-04T04:00:00Z").put("source", "note")
            .put("deviceId", "generated-device").put("hasImage", false)))
        val rows = LibraryPhoneFeed.page { path ->
            assertEquals("/api/capture-browser?limit=30", path)
            page
        }
        assertEquals(1, rows.size)
        assertEquals(id, rows[0].id)
        assertEquals("note", rows[0].source)

        val malformed = JSONObject().put("items", JSONArray().put(JSONObject()
            .put("id", "not-a-uuid").put("capturedAt", "2026-11-04T04:00:00Z").put("source", "note").put("deviceId", "generated-device")))
        assertThrows(IllegalArgumentException::class.java) { LibraryPhoneFeed.page { malformed } }

        val archive = HomeArchiveProbe.empty { path ->
            when {
                path == "/api/status" -> JSONObject("""{"storage":{"captures":0}}""")
                else -> JSONObject("""{"items":[]}""")
            }
        }
        assertTrue("the same probe remains the archive-empty authority", archive)
    }
}
