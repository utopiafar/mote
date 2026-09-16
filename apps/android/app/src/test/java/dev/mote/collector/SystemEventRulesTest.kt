package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.UUID

class SystemEventRulesTest {
    private fun event() = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", "fixture")
        .put("deviceName", "Generated phone").put("platform", "android").put("capturedAt", "2026-09-15T00:00:00Z")
        .put("durationMs", 0).put("source", "notification").put("appId", "fixture.app").put("appName", "Generated app")
        .put("privacy", JSONObject().put("excluded", false).put("collection", "content"))
        .put("metadata", JSONObject().put("version", 1).put("observedAt", "2026-09-15T00:00:00Z")
            .put("collector", JSONObject().put("method", "notification_listener"))
            .put("observation", JSONObject().put("sessionId", UUID.randomUUID().toString()).put("elapsedRealtimeMs", 100))
            .put("notification", JSONObject().put("action", "posted").put("notificationKey", "ab".repeat(32))
                .put("postedAt", "2026-09-15T00:00:00Z").put("ongoing", true).put("groupSummary", false).put("title", "Generated 2048")))
    @Test fun activityRulesAndRemovalNeverAcceptNotificationText() {
        SystemEventRules.validate(event())
        val activity = event().apply { getJSONObject("privacy").put("collection", "activity") }
        assertThrows(IllegalArgumentException::class.java) { SystemEventRules.validate(activity) }
        activity.getJSONObject("metadata").getJSONObject("notification").remove("title")
        SystemEventRules.validate(activity)
        val removal = event().apply { getJSONObject("metadata").getJSONObject("notification").put("action", "removed") }
        assertThrows(IllegalArgumentException::class.java) { SystemEventRules.validate(removal) }
    }
    @Test fun encryptedSystemEventsRoundTripAndAcknowledgeWithoutImages() {
        val dir = Files.createTempDirectory("mote-system-fixture").toFile()
        val cipher = object : ByteCipher {
            override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 0x5a).toByte() }.toByteArray()
            override fun open(bytes: ByteArray) = seal(bytes)
        }
        try {
            val queue = DurableQueue(dir, cipher); val record = event(); val id = record.getString("id")
            queue.enqueue(record, null, 1_000_000); queue.enqueue(record, null, 1_000_000)
            assertEquals(1, queue.depth()); queue.verifyIntegrity()
            assertFalse(dir.listFiles()!!.any { it.readText().contains("Generated 2048") })
            val page = queue.capturePage("2026-09-15T00:00:00Z", "2026-09-16T00:00:00Z", source = "notification")
            assertEquals(1, page.getInt("totalCount")); assertFalse(page.getJSONArray("items").getJSONObject(0).getBoolean("hasImage"))
            assertEquals(id, queue.peek()!!.getString("id")); queue.acknowledge(id); assertEquals(0, queue.depth())
        } finally { dir.deleteRecursively() }
    }
}
