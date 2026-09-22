package dev.mote.collector
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class CalendarActionRulesTest {
    private fun event() = JSONObject().put("title", "合成评审").put("start", "2099-09-18T15:00:00+08:00").put("end", "2099-09-18T16:00:00+08:00").put("timeZone", "Asia/Shanghai").put("allDay", false).put("description", "生成的测试资料")
    @Test fun aMissingLedgerCannotAuthorizeASecondNativeMutation() {
        assertTrue(CalendarActionRules.mutationAllowed(JSONObject().put("mutationAllowed", true), null))
        assertFalse(CalendarActionRules.mutationAllowed(JSONObject().put("mutationAllowed", true), "attempting"))
        assertFalse(CalendarActionRules.mutationAllowed(JSONObject().put("mutationAllowed", false), null))
        assertFalse(CalendarActionRules.mutationAllowed(JSONObject(), null))
    }
    @Test fun timedAndAllDayUseCorrectProviderTimes() {
        val (start, end) = CalendarActionRules.times(event()); assertEquals(3600000L, end - start)
        val (day, next) = CalendarActionRules.times(event().put("allDay", true).put("start", "2099-09-18").put("end", "2099-09-19")); assertEquals(0L, day % 86400000); assertEquals(86400000L, next - day)
    }
    @Test fun invalidAndAmbiguousDatesAreNeverWritten() {
        assertThrows(Exception::class.java) { CalendarActionRules.times(event().put("start", JSONObject.NULL)) }
        assertThrows(Exception::class.java) { CalendarActionRules.times(event().put("end", "2099-09-18T14:00:00+08:00")) }
        assertThrows(Exception::class.java) { CalendarActionRules.times(event().put("timeZone", "Mars/City")) }
        assertThrows(Exception::class.java) { CalendarActionRules.times(event().put("allDay", true).put("start", "2099-02-31")) }
    }
    @Test fun originTagIsStableAndContainsNoExecutableAction() {
        val id = "11111111-1111-4111-8111-111111111111"; assertTrue(CalendarActionRules.description(id, event()).contains("[Mote:$id]")); assertTrue(CalendarActionRules.description(id, event()).contains("#Mote"))
        assertThrows(Exception::class.java) { CalendarActionRules.marker("not-an-id") }
    }
    @Test fun originalMarkerSurvivesUpdatesWhileOperationMarkerChanges() {
        val original = "11111111-1111-4111-8111-111111111111"; val operation = "22222222-2222-4222-8222-222222222222"
        val description = CalendarActionRules.description(original, event(), operation)
        assertTrue(description.contains("[Mote:$original]")); assertTrue(description.contains("[Mote-operation:$operation]"))
        assertFalse(CalendarActionRules.description(original, event()).contains("Mote-operation"))
        assertThrows(Exception::class.java) { CalendarActionRules.description(original, event(), "invalid") }
    }
}
