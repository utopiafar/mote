package dev.mote.collector

import org.json.JSONObject
import java.util.UUID

/** Durable receipt recovery never grants another native mutation. The caller serializes execution. */
internal class ManagedCalendarJournal(
    private val deviceId: String,
    private val request: (String, JSONObject?) -> JSONObject,
    private val read: (String) -> String?,
    private val write: (String, String) -> Unit,
) {
    fun claim(id: String, operation: String, beforeClaim: () -> Unit): JSONObject? {
        UUID.fromString(id); UUID.fromString(operation)
        val cached = read("managed-$operation")?.let { JSONObject(it) }
        val retained = read(operation)
        if (cached != null) validate(cached, id, operation)
        if (cached != null && retained != null && retained != "attempting") {
            request("/api/managed-calendar/$id/receipt", JSONObject().put("deviceId", deviceId).put("operationId", operation).put("status", "succeeded").put("externalId", retained))
            return null
        }
        beforeClaim()
        val action = try { request("/api/managed-calendar/$id/claim", JSONObject().put("deviceId", deviceId)) } catch (error: Exception) {
            if (cached == null || retained != "attempting") throw error
            JSONObject(cached.toString()).put("status", "uncertain").put("mutationAllowed", false)
        }
        validate(action, id, operation)
        return action
    }
    fun remember(action: JSONObject) {
        validate(action, action.getString("id"), action.getString("operationId"))
        write("managed-${action.getString("operationId")}", action.toString())
    }
    private fun validate(action: JSONObject, id: String, operation: String) {
        require(action.getString("id") == id && action.getString("operationId") == operation && action.getString("kind") in listOf("calendar.create", "calendar.update", "calendar.cancel") && action.getJSONObject("target").getString("deviceId") == deviceId)
    }
}
