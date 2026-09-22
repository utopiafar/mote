package dev.mote.collector
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class NativeStatusTest {
    private fun value(input: Any?): Any? = when(input) {
        is JSONObject -> input.keys().asSequence().associateWith { value(input.get(it)) }
        is JSONArray -> (0 until input.length()).map { value(input.get(it)) }
        is Number -> input.toDouble()
        JSONObject.NULL -> null
        else -> input
    }
    @Test fun sharedArchiveProcessingAndSourceContract() {
        val rows = JSONArray(javaClass.classLoader!!.getResource("native-status.json")!!.readText())
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i)
            assertEquals(row.getString("name"), value(row.getJSONObject("expected")), value(NativeStatus.project(row.getJSONObject("facts"))))
        }
    }
}
