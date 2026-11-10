package dev.mote.collector.plugins

import dev.mote.collector.CentralClient
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL

/** Run by test-fixtures/plugin-control-native.ts against private generated Central data. */
class PluginCenterNativeContractTest {
    private val origin = System.getenv("MOTE_PLUGIN_CONTROL_ORIGIN").orEmpty()
    private val owner = System.getenv("MOTE_PLUGIN_CONTROL_TOKEN").orEmpty()
    private val packageId = System.getenv("MOTE_PLUGIN_CONTROL_PACKAGE_ID").orEmpty()
    private val instanceId = System.getenv("MOTE_PLUGIN_CONTROL_INSTANCE_ID").orEmpty()

    @Before fun requireRealControlPlane() {
        assumeTrue("Use the plugin control native contract runner", origin.isNotEmpty())
        assertEquals("127.0.0.1", URL(origin).host)
        assertTrue(owner.isNotEmpty() && packageId.isNotEmpty() && instanceId.isNotEmpty())
    }

    private fun http(method: String, url: String, credential: String): Pair<Int, JSONObject?> {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15000
            connection.readTimeout = 30000
            connection.setRequestProperty("Authorization", "Bearer $credential")
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
            return status to text?.takeIf(String::isNotBlank)?.let(::JSONObject)
        } finally { connection.disconnect() }
    }

    @Test fun realControlResponseIsConsumedByThePluginCenterClient() {
        val control = PluginControlClient(CentralClient(origin, owner,
            transport = { method, url, _, credential, _ -> http(method, url, credential) }))
        val inventory = control.inventory()
        assertTrue(inventory.revision > 0)
        assertTrue(inventory.installation.getBoolean("supported"))
        assertEquals("worker", inventory.installation.getString("runtime"))

        val pkg = inventory.packages.single()
        assertEquals(packageId, pkg.id)
        assertEquals("Generated control package", pkg.name)
        assertEquals("fixture-1", pkg.version)
        assertEquals("installed", pkg.state)
        assertEquals("generated-fixture/plugin-control", pkg.source.getString("repository"))
        assertEquals("v1", pkg.source.getString("tag"))
        assertEquals("a".repeat(40), pkg.source.getString("commit"))
        assertTrue(pkg.source.getString("digest").matches(Regex("[a-f0-9]{64}")))
        assertEquals("endpoint", pkg.fields.single().id)

        val instance = inventory.instances.single()
        assertEquals(instanceId, instance.id)
        assertEquals(packageId, instance.packageId)
        assertEquals("Generated control instance", instance.name)
        assertEquals("default", instance.scope)
        assertEquals("generated-reference", instance.configuration.getString("endpoint"))
        assertEquals("configured", instance.observed)
        assertFalse(instance.desired)
        assertEquals("unknown", instance.capabilities.single().state)
        assertTrue(inventory.catalog.any { it.getString("group") == "memory" })
        assertTrue(inventory.catalog.any { it.getString("group") == "connectors" })
        assertTrue(inventory.catalog.all { it.has("repository") && it.has("name") && it.has("description") })
        assertNotNull(inventory.sourceContributions)

        val build = inventory.builds.single { it.id == instanceId }
        assertEquals("worker", build.runtime)
        assertEquals(packageId, build.packageId)
        assertEquals("stopped", build.observed)
        assertEquals("fixture-1", build.version)
        assertFalse(build.retired)
    }
}
