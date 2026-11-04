package dev.mote.collector.plugins

import dev.mote.collector.ConnectionFailure
import dev.mote.collector.ConnectionGuard
import dev.mote.collector.ProtocolCompatibility
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** One device-facing capability result. A declaration describes an
 * implementation and never authorizes execution; `requires-build` is the only
 * state for a provider that this APK did not ship. */
internal enum class CapabilityActionState(val wire: String) {
    ACTIVE("active"),
    BLOCKED("blocked"),
    REQUIRES_BUILD("requires-build"),
}

internal data class CapabilityPublication(
    val state: CapabilityActionState,
    val declaration: JSONObject? = null,
    val projection: JSONObject? = null,
)

internal fun interface CapabilityPublicationGuard {
    fun run(action: () -> CapabilityPublication): CapabilityPublication?
}

/** Publishes build-provided capability facts to Central under the connection
 * guard. The provider must actually be registered in this build; a removed
 * provider reports `requires-build` and performs no network write, so an old
 * declaration cannot be revived. Protocol metadata is checked before the
 * device attests anything, and the server projection is consumed as separate
 * installed/grant/availability/authorization facts instead of inferring one
 * from another. */
internal class NativeCapabilityPublisher(
    private val deviceId: String,
    private val transport: (String, JSONObject?) -> JSONObject,
    private val availability: () -> PluginAvailability = { PluginAvailability.ACTIVE },
    private val guard: CapabilityPublicationGuard = CapabilityPublicationGuard { action -> ConnectionGuard.sync(action) },
) {
    fun publish(available: JSONArray?): CapabilityPublication {
        val provider = availability()
        if (provider != PluginAvailability.ACTIVE) {
            return CapabilityPublication(if (provider == PluginAvailability.REQUIRES_BUILD) CapabilityActionState.REQUIRES_BUILD else CapabilityActionState.BLOCKED)
        }
        return guard.run { publishGuarded(available) } ?: CapabilityPublication(CapabilityActionState.BLOCKED)
    }

    private fun publishGuarded(available: JSONArray?): CapabilityPublication {
        val self = request("/api/connections/self")
        if (self.has("node") && self.optJSONObject("node") == null) throw ConnectionFailure("response")
        // A server outside the supported wire range cannot own a declaration.
        self.optJSONObject("node")?.let { ProtocolCompatibility.requireCompatible(it.opt("protocol")) }
        val identity = self.optJSONObject("credential")
        // An unbound owner session can still review manually, but cannot attest this device.
        if (identity?.optString("deviceId", "").isNullOrEmpty()) return CapabilityPublication(CapabilityActionState.BLOCKED)
        require(identity!!.getString("deviceId") == deviceId) { "Capability declaration belongs to another device" }
        val current = request("/api/device-action-capabilities")
        val declaration = current.optJSONObject("declaration")
        val projection = current.optJSONObject("projection")
        val projected = projection?.optJSONArray("devices")?.let { devices ->
            (0 until devices.length()).map { devices.getJSONObject(it) }.firstOrNull { it.optString("deviceId") == deviceId }
        }
        val permission = if (available == null) "required" else "granted"
        fun canonical(items: JSONArray): String = (0 until items.length()).map { items.getJSONObject(it) }
            .sortedBy { it.getString("id") }.joinToString("|") { JSONObject().put("id", it.getString("id")).put("title", it.getString("title")).toString() }
        val calendars = available ?: JSONArray()
        // Installation, the device grant, live availability and owner authorization
        // are separate server facts. Only this device's projected availability may
        // suppress a needed re-declaration.
        if (declaration != null && projected?.optBoolean("available") == true && projected.optString("grant") == permission && declaration.optJSONObject("capability")?.optString("id") == "calendar.manage" && declaration.optJSONObject("capability")?.optInt("version") == 1 && declaration.optBoolean("connectionActive") && declaration.optString("connectionId") == current.getString("connectionId") &&
            declaration.optString("permission") == permission && canonical(declaration.getJSONArray("calendars")) == canonical(calendars)) {
            return CapabilityPublication(actionState(permission, projection), declaration, projection)
        }
        val body = JSONObject().put("operationId", UUID.randomUUID().toString())
            .put("expectedRevision", declaration?.getLong("revision") ?: 0).put("deviceId", deviceId)
            .put("capability", JSONObject().put("id", "calendar.manage").put("version", 1))
            .put("permission", permission).put("calendars", calendars)
        val published = request("/api/device-action-capabilities", body)
        val next = request("/api/device-action-capabilities")
        return CapabilityPublication(
            actionState(permission, next.optJSONObject("projection")),
            next.optJSONObject("declaration") ?: published,
            next.optJSONObject("projection"),
        )
    }

    private fun request(path: String, body: JSONObject? = null): JSONObject = transport(path, body)

    private fun actionState(permission: String, projection: JSONObject?): CapabilityActionState =
        if (permission == "granted" && projection?.optBoolean("available", true) != false) CapabilityActionState.ACTIVE else CapabilityActionState.BLOCKED
}
