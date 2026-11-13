package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CentralConversationSettingsTest {
    private fun configuration(effective: JSONObject, revision: Int = 7) = JSONObject()
        .put("revision", revision)
        .put("domains", JSONArray().put(JSONObject().put("id", "conversations").put("effective", effective)))

    private fun effective(multiple: Boolean = false, history: Double = 0.5, low: Double = 0.5, source: String = "conservative", window: Any? = null) = JSONObject()
        .put("multipleConversations", multiple)
        .put("context", JSONObject().put("historyRatio", history).put("lowWatermarkRatio", low)
            .put("contextWindowSource", source).put("contextWindow", window ?: JSONObject.NULL))

    @Test fun `the C9 domain is read from the real configuration view`() {
        val value = CentralConversationSettings.read(configuration(effective(multiple = true, history = 0.4, low = 0.3, source = "configured", window = 32000)))
        assertTrue(value.multipleConversations)
        assertEquals(7, value.revision)
        assertEquals(ConversationContextPreferences(0.4, 0.3, 32000, "configured"), value.context)
    }

    @Test fun `invalid ratios and window sources are rejected before saving`() {
        for (bad in listOf(
            effective(history = -0.1),
            effective(history = 1.1),
            effective(low = 1.0),
            effective(source = "unknown"),
            effective(source = "configured", window = null),
            effective(source = "conservative", window = 8000),
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                CentralConversationSettings.read(configuration(bad))
            }
        }
    }

    @Test fun `the saved payload keeps the current revision and exact owner choices`() {
        val current = CentralConversationSettings.read(configuration(effective()))
        val payload = CentralConversationSettings.payload(current, true, 0.25, 0.4, "configured", 16000)
        assertEquals(7, payload.getInt("revision"))
        val value = payload.getJSONObject("value")
        assertTrue(value.getBoolean("multipleConversations"))
        assertEquals(0.25, value.getJSONObject("context").getDouble("historyRatio"), 0.0)
        assertEquals(0.4, value.getJSONObject("context").getDouble("lowWatermarkRatio"), 0.0)
        assertEquals("configured", value.getJSONObject("context").getString("contextWindowSource"))
        assertEquals(16000, value.getJSONObject("context").getLong("contextWindow"))
    }

    @Test fun `a conservative payload sends an explicit null window`() {
        val value = CentralConversationSettings.payload(CentralConversationSettings.defaults(), false, 0.5, 0.5, "conservative", null)
        assertTrue(value.getJSONObject("value").getJSONObject("context").isNull("contextWindow"))
    }
}
