package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class LibraryBrowseRulesTest {
    @Test fun `category choices use recorded source and image type`() {
        val note = JSONObject().put("source", "note").put("textPreview", "Generated meeting")
        val screen = JSONObject().put("source", "screen")
        val photo = JSONObject().put("kind", "file").put("localItem", JSONObject().put("mimeType", "image/jpeg"))
        val file = JSONObject().put("kind", "file").put("localItem", JSONObject().put("mimeType", "application/pdf"))
        val notice = JSONObject().put("source", "notification")
        assertTrue(LibraryBrowseRules.matches(note, "records"))
        assertTrue(LibraryBrowseRules.matches(screen, "images")); assertTrue(LibraryBrowseRules.matches(photo, "images"))
        assertFalse(LibraryBrowseRules.matches(photo, "files")); assertTrue(LibraryBrowseRules.matches(file, "files"))
        assertTrue(LibraryBrowseRules.matches(notice, "notifications")); assertFalse(LibraryBrowseRules.matches(notice, "records"))
        val original = JSONObject().put("type", "original").put("kind", "file").put("title", "Generated lease.pdf")
        assertTrue(LibraryBrowseRules.matches(original, "files"))
        assertFalse(LibraryBrowseRules.matches(original, "images"))
    }

    @Test fun `search checks each literal word and dates follow the device timezone`() {
        val row = JSONObject().put("title", "Generated schedule").put("localItem", JSONObject().put("text", "Evening appointment"))
        assertTrue(LibraryBrowseRules.matchesText(row, "schedule EVENING"))
        assertFalse(LibraryBrowseRules.matchesText(row, "schedule missing"))
        assertEquals(LocalDate.parse("2026-01-02"), LibraryBrowseRules.day("2026-01-01T20:00:00Z", ZoneId.of("Asia/Shanghai")))
    }
}
