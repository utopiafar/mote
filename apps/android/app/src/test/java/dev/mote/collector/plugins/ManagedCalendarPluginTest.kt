package dev.mote.collector.plugins

import dev.mote.collector.CalendarDeliveryPolicy
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ManagedCalendarPluginTest {
    private fun started(): Pair<NativePluginHost, ManagedCalendarOwner> {
        val registry = NativePluginRegistry().apply { ManagedCalendarPlugin.register(this, "test-build") }
        assertEquals(PluginAvailability.ACTIVE, registry.availability(ManagedCalendarPlugin.requirement()))
        assertEquals(listOf("calendar"), registry.provider(ManagedCalendarPlugin.CAPABILITY, "1")?.osGrants)
        val host = NativePluginHost(registry)
        val scope = (host.createScope(
            PluginInstanceDescriptor(
                PluginInstanceIdentity("dev.fixture.calendar", "test", ManagedCalendarPlugin.INSTANCE_ID),
                setOf(ManagedCalendarPlugin.CAPABILITY),
                requires = listOf(ManagedCalendarPlugin.requirement()),
            ),
        ) as PluginResult.Ok).value
        return host to ManagedCalendarPlugin.open(host, scope)
    }

    @Test fun providerOwnsDeliveryScopeAndStopsWithTheHost() {
        val (host, owner) = started()
        val scope = requireNotNull(host.scope(ManagedCalendarPlugin.INSTANCE_ID))
        assertTrue(owner.active)
        assertEquals(setOf("calendar.actions", "calendar.capability", "calendar.delivery"), scope.services.keys)
        assertTrue(scope.jobs.containsKey("calendar.delivery"))
        host.stopScope(ManagedCalendarPlugin.INSTANCE_ID)
        assertTrue(scope.revoked)
        assertFalse("a stopped plugin offers no calendar action control", owner.active)
    }

    @Test fun revokedPermissionPublishesBlockedCapabilityAndSkipsNewWrites() {
        val (_, owner) = started()
        var declaration: JSONObject? = null
        val writes = mutableListOf<String>()
        val transport: (String, JSONObject?) -> JSONObject = { path, body ->
            writes += path
            when (path) {
                "/api/connections/self" -> JSONObject().put("credential", JSONObject().put("deviceId", "generated-device"))
                "/api/device-action-capabilities" -> if (body == null) JSONObject().put("connectionId", "generated-connection").put("declaration", declaration ?: JSONObject.NULL) else {
                    declaration = JSONObject(body.toString()).put("revision", 1).put("connectionId", "generated-connection").put("connectionActive", true)
                    declaration!!
                }
                else -> error("A blocked capability must not claim or acknowledge an action: $path")
            }
        }
        owner.publisher("generated-device", transport).publish(null)
        assertEquals("the shared declaration vocabulary publishes revoked access as required", "required", declaration!!.getString("permission"))
        assertEquals(0, declaration!!.getJSONArray("calendars").length())
        assertTrue(writes.none { it.endsWith("/claim") || it.endsWith("/receipt") })
        assertFalse(CalendarDeliveryPolicy.mayExecute(permissionGranted = false, retained = null))
        assertFalse(CalendarDeliveryPolicy.mayExecute(permissionGranted = false, retained = "attempting"))
        assertTrue("a retained external id may still reconcile its receipt", CalendarDeliveryPolicy.mayExecute(permissionGranted = false, retained = "generated-event"))
        assertTrue(CalendarDeliveryPolicy.mayExecute(permissionGranted = true, retained = null))
    }

    @Test fun grantedCalendarPublishesOnlyTheDeclaredWritableSet() {
        val (_, owner) = started()
        var declaration: JSONObject? = null
        val calendars = JSONArray().put(JSONObject().put("id", "generated").put("title", "Generated"))
        val transport: (String, JSONObject?) -> JSONObject = { path, body ->
            when (path) {
                "/api/connections/self" -> JSONObject().put("credential", JSONObject().put("deviceId", "generated-device"))
                "/api/device-action-capabilities" -> if (body == null) JSONObject().put("connectionId", "generated-connection").put("declaration", declaration ?: JSONObject.NULL) else {
                    declaration = JSONObject(body.toString()).put("revision", 1).put("connectionId", "generated-connection").put("connectionActive", true)
                    declaration!!
                }
                else -> error("Unexpected request: $path")
            }
        }
        owner.publisher("generated-device", transport).publish(calendars)
        assertEquals("granted", declaration!!.getString("permission"))
        assertEquals("generated", declaration!!.getJSONArray("calendars").getJSONObject(0).getString("id"))
        assertTrue(CalendarDeliveryPolicy.mayExecute(permissionGranted = true, retained = null))
    }
}
