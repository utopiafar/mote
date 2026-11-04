package dev.mote.collector.plugins

import dev.mote.collector.ConnectionFailure
import dev.mote.collector.ConnectionGuard
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** End-to-end JVM binding facts: a provider absent from the APK registry makes
 * the calendar action `requires-build` and performs no write; wire
 * compatibility and connection changes are checked before any declaration. */
class NativePluginBindingTest {
    private fun provider() = NativePluginProvider(ManagedCalendarPlugin.CAPABILITY, ManagedCalendarPlugin.API_VERSION, buildId = "generated-build")

    @Test fun providerRemovedFromBuildMakesCalendarActionNeedsBuildWithoutPublishing() {
        val registry = NativePluginRegistry()
        val host = NativePluginHost(registry)
        assertEquals(PluginAvailability.REQUIRES_BUILD, ManagedCalendarPlugin.availability(host))

        var writes = 0
        val publisher = NativeCapabilityPublisher("generated-device", { _, _ ->
            writes++
            error("A missing build provider must never publish or execute")
        }, availability = { ManagedCalendarPlugin.availability(host) })
        val publication = publisher.publish(JSONArray().put(JSONObject().put("id", "generated-calendar").put("title", "Generated calendar")))
        assertEquals(CapabilityActionState.REQUIRES_BUILD, publication.state)
        assertEquals("requires-build", publication.state.wire)
        assertEquals(0, writes)

        val denied = host.createScope(PluginInstanceDescriptor(
            PluginInstanceIdentity("dev.fixture.calendar", "test", ManagedCalendarPlugin.INSTANCE_ID),
            setOf(ManagedCalendarPlugin.CAPABILITY),
            requires = listOf(ManagedCalendarPlugin.requirement()),
        ))
        assertTrue(denied is PluginResult.Failed)
        assertEquals("requires_build", (denied as PluginResult.Failed).code)
        assertNull("nothing fake-installed without the build provider", host.scope(ManagedCalendarPlugin.INSTANCE_ID))
    }

    @Test fun registeredProviderAdmitsTheScopeAndPublishesActiveFacts() {
        val registry = NativePluginRegistry().apply { register(provider()) }
        val host = NativePluginHost(registry)
        assertEquals(PluginAvailability.ACTIVE, ManagedCalendarPlugin.availability(host))
        val scope = (host.createScope(PluginInstanceDescriptor(
            PluginInstanceIdentity("dev.fixture.calendar", "test", ManagedCalendarPlugin.INSTANCE_ID),
            setOf(ManagedCalendarPlugin.CAPABILITY),
            requires = listOf(ManagedCalendarPlugin.requirement()),
        )) as PluginResult.Ok).value
        val owner = ManagedCalendarPlugin.open(host, scope)
        var declaration: JSONObject? = null
        fun projection(): JSONObject {
            val current = declaration
            val granted = current?.optBoolean("connectionActive") == true && current.optString("permission") == "granted"
            return JSONObject().put("id", "calendar.manage").put("version", 1).put("installed", false)
                .put("grant", current?.optString("permission")?.takeIf { it.isNotBlank() } ?: "unavailable")
                .put("available", granted).put("authorized", false).put("waitingDevice", false)
                .put("devices", JSONArray().apply { current?.let {
                    put(JSONObject().put("deviceId", "generated-device").put("revision", it.getLong("revision"))
                        .put("connectionActive", it.optBoolean("connectionActive")).put("grant", it.optString("permission"))
                        .put("available", granted).put("authorized", false).put("waitingDevice", false))
                } })
        }
        val publisher = owner.publisher("generated-device") { path, body ->
            when (path) {
                "/api/connections/self" -> JSONObject().put("credential", JSONObject().put("deviceId", "generated-device"))
                "/api/device-action-capabilities" -> if (body == null) {
                    JSONObject().put("connectionId", "generated-connection").put("declaration", declaration ?: JSONObject.NULL).put("projection", projection())
                } else {
                    declaration = JSONObject(body.toString()).put("revision", 1).put("connectionId", "generated-connection").put("connectionActive", true)
                    declaration!!
                }
                else -> error("Unexpected request: $path")
            }
        }
        val publication = publisher.publish(JSONArray().put(JSONObject().put("id", "generated-calendar").put("title", "Generated calendar")))
        assertEquals(CapabilityActionState.ACTIVE, publication.state)
        assertEquals("granted", publication.declaration!!.getString("permission"))
        assertTrue(publication.projection!!.getBoolean("available"))
        assertEquals(1, publication.declaration!!.getLong("revision"))
        assertTrue(owner.active)
    }

    @Test fun incompatibleServerProtocolIsRejectedBeforeAnyCapabilityWrite() {
        var capabilityReads = 0
        val publisher = NativeCapabilityPublisher("generated-device", { path, _ ->
            when (path) {
                "/api/connections/self" -> JSONObject().put("credential", JSONObject().put("deviceId", "generated-device"))
                    .put("node", JSONObject().put("protocol", JSONObject().put("min", 2).put("max", 2)))
                "/api/device-action-capabilities" -> { capabilityReads++; error("Must not declare against an incompatible server") }
                else -> error("Unexpected request: $path")
            }
        })
        val failure = assertThrows(ConnectionFailure::class.java) { publisher.publish(JSONArray()) }
        assertEquals("protocol_incompatible", failure.category)
        assertEquals(0, capabilityReads)
    }

    @Test fun connectionChangeFencesPublicationBeforeAnyWrite() {
        var writes = 0
        val publisher = NativeCapabilityPublisher("generated-device", { _, _ ->
            writes++
            error("A connection change must fence the publisher")
        })
        assertTrue(ConnectionGuard.beginReconfiguration())
        try {
            val publication = publisher.publish(JSONArray())
            assertEquals(CapabilityActionState.BLOCKED, publication.state)
            assertEquals(0, writes)
        } finally {
            ConnectionGuard.endReconfiguration()
        }
    }
}
