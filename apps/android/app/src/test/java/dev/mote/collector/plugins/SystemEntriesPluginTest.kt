package dev.mote.collector.plugins

import dev.mote.collector.CentralClient
import dev.mote.collector.MoteQuickEntry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Disabling the native plugin removes every system entry and notification
 * action while the same scope state exposes the read-only reason. */
class SystemEntriesPluginTest {
    private fun started(): Pair<NativePluginHost, SystemEntriesOwner> {
        val registry = NativePluginRegistry().apply { SystemEntriesPlugin.register(this, "generated-build") }
        val host = NativePluginHost(registry)
        val identity = PluginInstanceIdentity(SystemEntriesPlugin.INSTANCE_ID, "generated-installation", SystemEntriesPlugin.INSTANCE_ID)
        val descriptor = PluginInstanceDescriptor(
            identity,
            setOf(SystemEntriesPlugin.CAPABILITY),
            requires = listOf(SystemEntriesPlugin.requirement()),
        )
        val scope = (host.createScope(descriptor) as PluginResult.Ok).value
        val owner = (host.startPlugin(scope) { SystemEntriesPlugin.open(it) } as PluginResult.Ok).value
        return host to owner
    }

    @Test fun builtinProviderRegistersForTheSystemEntryScope() {
        val registry = NativePluginRegistry().apply { SystemEntriesPlugin.register(this, "generated-build") }
        assertEquals(PluginAvailability.ACTIVE, registry.availability(SystemEntriesPlugin.requirement()))
        assertNotNull(registry.provider(SystemEntriesPlugin.CAPABILITY, SystemEntriesPlugin.API_VERSION))
    }

    @Test fun stoppingThePluginWithdrawsQuickEntriesAndNotificationActionsWithAReason() {
        val (host, owner) = started()
        val active = SystemEntriesPlugin.availability(host)
        assertTrue(active.active)
        assertEquals(MoteQuickEntry.entries, SystemEntriesPlugin.quickEntries(active))
        assertEquals(
            listOf(SystemEntriesPlugin.Action.RECORD, SystemEntriesPlugin.Action.PAUSE_SCREEN, SystemEntriesPlugin.Action.STOP_CAPTURE),
            SystemEntriesPlugin.notificationActions(active, screenCapturing = true, screenPaused = false, needsAction = false),
        )
        assertEquals(
            listOf(SystemEntriesPlugin.Action.RECORD, SystemEntriesPlugin.Action.STOP_CAPTURE),
            SystemEntriesPlugin.notificationActions(active, screenCapturing = false, screenPaused = false, needsAction = false),
        )
        assertEquals(
            listOf(SystemEntriesPlugin.Action.RECORD, SystemEntriesPlugin.Action.RESUME_SCREEN, SystemEntriesPlugin.Action.STOP_CAPTURE),
            SystemEntriesPlugin.notificationActions(active, screenCapturing = false, screenPaused = true, needsAction = false),
        )
        assertEquals(
            listOf(SystemEntriesPlugin.Action.ATTENTION, SystemEntriesPlugin.Action.RECORD, SystemEntriesPlugin.Action.STOP_CAPTURE),
            SystemEntriesPlugin.notificationActions(active, screenCapturing = true, screenPaused = false, needsAction = true),
        )
        assertEquals(
            setOf("system-entries.notifications", "system-entries.quick", "system-entries.app-capture"),
            host.scope(SystemEntriesPlugin.INSTANCE_ID)!!.services.keys,
        )

        host.stopScope(SystemEntriesPlugin.INSTANCE_ID)

        val stopped = SystemEntriesPlugin.availability(host)
        assertFalse(stopped.active)
        assertTrue("the disabled plugin must explain itself", stopped.reason.orEmpty().isNotBlank())
        assertTrue(stopped.reason.orEmpty().contains("快捷入口"))
        assertTrue(owner.closed)
        assertTrue(SystemEntriesPlugin.quickEntries(stopped).isEmpty())
        assertTrue(SystemEntriesPlugin.notificationActions(stopped, screenCapturing = true, screenPaused = false, needsAction = false).isEmpty())
        assertTrue(SystemEntriesPlugin.notificationActions(stopped, screenCapturing = false, screenPaused = true, needsAction = true).isEmpty())
        assertEquals("Generated capture status\n" + stopped.reason, SystemEntriesPlugin.surfaceText(stopped, "Generated capture status"))
        assertEquals("Generated capture status", SystemEntriesPlugin.surfaceText(active, "Generated capture status"))
    }

    @Test fun missingProviderOrScopeNeverOffersASystemAction() {
        val missing = SystemEntriesPlugin.availability(NativePluginHost(NativePluginRegistry()))
        assertFalse(missing.active)
        assertTrue(missing.reason.orEmpty().isNotBlank())
        assertTrue(SystemEntriesPlugin.quickEntries(missing).isEmpty())
        assertTrue(SystemEntriesPlugin.notificationActions(missing, screenCapturing = true, screenPaused = false, needsAction = true).isEmpty())

        val unloaded = SystemEntriesPlugin.availability(null)
        assertFalse(unloaded.active)
        assertTrue(unloaded.reason.orEmpty().isNotBlank())
    }

    private fun client(calls: MutableList<String>, response: JSONObject): CentralClient =
        CentralClient("http://127.0.0.1:49003", "generated-owner-token", transport = { method, url, body, _, _ ->
            calls.add(method + " " + url.substringAfter("49003") + (body?.let { " " + String(it) } ?: ""))
            200 to response
        })

    /** AN5-06: the notification page reads and writes the central domain. */
    @Test fun notificationSettingsReadAndWriteTheCentralConfigurationDomain() {
        val config = JSONObject("""
            {"revision":4,"readOnly":false,"domains":[{"id":"notifications",
             "saved":{"enabled":true,"timeZone":"Asia/Shanghai","quietHours":{"start":"22:00","end":"08:00"},"minIntervalMinutes":60},
             "effective":{"enabled":true,"timeZone":"Asia/Shanghai","quietHours":{"start":"22:00","end":"08:00"},"minIntervalMinutes":60}}]}
        """.trimIndent())
        val calls = mutableListOf<String>()
        val active = client(calls, config)
        val value = NotificationSettings.read(active)
        assertTrue(value.enabled)
        assertEquals("Asia/Shanghai", value.timeZone)
        assertEquals(QuietHours("22:00", "08:00"), value.quietHours)
        assertEquals(60, value.minIntervalMinutes)
        assertEquals(4L, value.revision)
        assertFalse(value.readOnly)

        NotificationSettings.save(active, value, enabled = false, quietHours = QuietHours("23:00", "07:00"))
        assertEquals("GET /api/configuration", calls[0])
        assertTrue(calls[1].startsWith("PUT /api/configuration/notifications "))
        val body = JSONObject(calls[1].substringAfter("notifications "))
        assertEquals(4L, body.getLong("revision"))
        val payload = body.getJSONObject("value")
        assertFalse(payload.getBoolean("enabled"))
        assertEquals("Asia/Shanghai", payload.getString("timeZone"))
        assertEquals("23:00", payload.getJSONObject("quietHours").getString("start"))
        assertEquals("07:00", payload.getJSONObject("quietHours").getString("end"))
        assertEquals(60, payload.getInt("minIntervalMinutes"))
        assertTrue(NotificationSettings.request(value, true, null).getJSONObject("value").isNull("quietHours"))
    }

    @Test fun notificationSettingsUseDefaultsAndRejectEqualQuietHours() {
        val defaults = NotificationSettings.parse(JSONObject("""{"revision":1,"domains":[]}"""))
        assertTrue(defaults.enabled)
        assertEquals("UTC", defaults.timeZone)
        assertNull(defaults.quietHours)
        assertEquals(60, defaults.minIntervalMinutes)
        assertFalse(NotificationSettings.validate(QuietHours("22:00", "22:00")))
        assertTrue(NotificationSettings.validate(QuietHours("22:00", "08:00")))
        assertTrue(NotificationSettings.validate(null))
        assertFalse(NotificationSettings.validTime(QuietHours("9:00", "08:00")))
        assertFalse(NotificationSettings.validTime(QuietHours("22:00", "24:00")))
        assertTrue(NotificationSettings.validTime(QuietHours("22:00", "08:00")))
    }
}
