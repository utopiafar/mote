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
import java.net.Socket
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

    private fun http(method: String, url: String, credential: String, body: ByteArray? = null): Pair<Int, JSONObject?> {
        val target = URL(url)
        assertEquals("127.0.0.1", target.host)
        return Socket(target.host, target.port).use { socket ->
            socket.soTimeout = 30_000
            val bytes = body ?: byteArrayOf()
            socket.getOutputStream().apply {
                write(("$method ${target.file} HTTP/1.1\r\nHost: ${target.authority}\r\n" +
                    "Authorization: Bearer $credential\r\nContent-Type: application/json\r\n" +
                    "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray())
                write(bytes); flush()
            }
            val response = socket.getInputStream().bufferedReader()
            val status = response.readLine().split(' ')[1].toInt()
            var contentLength: Int? = null
            while (true) {
                val header = response.readLine() ?: error("Incomplete generated HTTP response")
                if (header.isEmpty()) break
                if (header.startsWith("content-length:", ignoreCase = true)) contentLength = header.substringAfter(':').trim().toInt()
            }
            assertNotNull("Generated Central sends a fixed JSON response", contentLength)
            status to response.readText().takeIf(String::isNotBlank)?.let(::JSONObject)
        }
    }

    @Test fun realControlResponseIsConsumedByThePluginCenterClient() {
        val control = PluginControlClient(CentralClient(origin, owner,
            transport = { method, url, body, credential, _ -> http(method, url, credential, body) }))
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
        assertFalse(inventory.catalog.any { it.getString("group") == "memory" })
        assertEquals(4, inventory.catalog.size)
        assertTrue(inventory.catalog.any { it.getString("group") == "connectors" })
        assertTrue(inventory.catalog.all { it.has("repository") && it.has("name") && it.has("description") })
        assertNotNull(inventory.sourceContributions)

        val build = inventory.builds.single { it.id == instanceId }
        assertEquals("worker", build.runtime)
        assertEquals(packageId, build.packageId)
        assertEquals("stopped", build.observed)
        assertEquals("fixture-1", build.version)
        assertFalse(build.retired)

        val gmail = inventory.builds.single { it.id == "bundled:gmail" }
        assertEquals(setOf("enable", "disable"), gmail.allowedActions)
        val disabled = PluginControlProjection.build(control.execute(PluginControlClient.selectBuild(gmail, false)))
        assertEquals("stopped", disabled.observed)
        assertEquals(null, disabled.desired)
        val enabled = PluginControlProjection.build(control.execute(PluginControlClient.selectBuild(disabled, true)))
        assertEquals("active", enabled.observed)
        assertEquals("mote.connector.gmail", enabled.desired!!.getString("packageId"))
    }
}
