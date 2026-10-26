package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CaptureLibraryVersionTest {
    @Test fun agreesWithServerGoldenWithoutMutatingRawMetadataOrIncludingDerivedUiFields() {
        val value = JSONObject("""{"id":"11111111-1111-4111-8111-111111111111","deviceId":"phone","deviceName":"Generated","platform":"android","capturedAt":"2026-10-01T00:00:00Z","durationMs":0,"source":"note","ocrText":"Generated </ original 🐾\n","metadata":{"version":1,"observedAt":"2026-10-01T00:00:00Z","state":{"batteryPercent":50.5}}}""")
        val before = value.toString()
        assertEquals("c62a6b39ace357a1adadb71c8e271ae69b935b84c4ad56e6f063c0571131b53b", CaptureLibraryVersion.of(value))
        assertEquals(before, value.toString())
        value.put("uploaded", true).put("_archiveOrigin", "private-origin").put("textPreview", "Derived UI")
        assertEquals("c62a6b39ace357a1adadb71c8e271ae69b935b84c4ad56e6f063c0571131b53b", CaptureLibraryVersion.of(value))
        value.getJSONObject("metadata").put("observedAt", "2026-10-01T00:00:01Z")
        assertNotEquals("c62a6b39ace357a1adadb71c8e271ae69b935b84c4ad56e6f063c0571131b53b", CaptureLibraryVersion.of(value))
    }
}
