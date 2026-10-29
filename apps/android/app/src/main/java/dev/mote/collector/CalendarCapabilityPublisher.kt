package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Publishes device facts only; never grants or executes an action. */
class CalendarCapabilityPublisher(private val deviceId: String, private val transport: (String, JSONObject?) -> JSONObject) {
    private fun request(path: String, body: JSONObject? = null): JSONObject = transport(path, body)
    fun publish(available: JSONArray?) {
        val identity = request("/api/connections/self").optJSONObject("credential")
        // An unbound owner session can still review manually, but cannot attest this device.
        if (identity?.optString("deviceId", "").isNullOrEmpty()) return
        require(identity!!.getString("deviceId") == deviceId)
        val current = request("/api/device-action-capabilities")
        val declaration = current.optJSONObject("declaration")
        val permission = if (available == null) "required" else "granted"
        fun canonical(items: JSONArray): String = (0 until items.length()).map { items.getJSONObject(it) }
            .sortedBy { it.getString("id") }.joinToString("|") { JSONObject().put("id", it.getString("id")).put("title", it.getString("title")).toString() }
        val calendars = available ?: JSONArray()
        if (declaration != null && declaration.optJSONObject("capability")?.optString("id") == "calendar.manage" && declaration.optJSONObject("capability")?.optInt("version") == 1 && declaration.optBoolean("connectionActive") && declaration.optString("connectionId") == current.getString("connectionId") &&
            declaration.optString("permission") == permission && canonical(declaration.getJSONArray("calendars")) == canonical(calendars)) return
        request("/api/device-action-capabilities", JSONObject().put("operationId", UUID.randomUUID().toString())
            .put("expectedRevision", declaration?.getLong("revision") ?: 0).put("deviceId", deviceId)
            .put("capability", JSONObject().put("id", "calendar.manage").put("version", 1))
            .put("permission", permission).put("calendars", calendars))
    }
}
