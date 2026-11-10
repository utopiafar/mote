package dev.mote.collector.plugins

import dev.mote.collector.MoteI18n
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A real /api/plugins response recorded from generated Central data; the
 * controller consumes the same typed projection as production. */
class PluginCenterPluginTest {
    private fun fixture(): JSONObject = javaClass.classLoader!!.getResourceAsStream("plugin-control-response.json")!!
        .bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }

    @Test fun `real control response fixture parses packages instances and source identity`() {
        val inventory = PluginControlProjection.inventory(fixture())
        assertEquals(4, inventory.revision)
        assertTrue(inventory.installation.getBoolean("supported"))
        assertEquals("worker", inventory.installation.getString("runtime"))
        assertFalse(inventory.installation.getBoolean("restartRequired"))

        val pkg = inventory.packages.single()
        assertEquals("Generated control package", pkg.name)
        assertEquals("fixture-1", pkg.version)
        assertEquals("installed", pkg.state)
        assertEquals("installed", pkg.observed)
        assertEquals("generated-fixture/plugin-control", pkg.source.getString("repository"))
        assertEquals("v1", pkg.source.getString("tag"))
        assertEquals("a".repeat(40), pkg.source.getString("commit"))
        assertEquals(setOf("configure", "uninstall"), pkg.allowedActions)
        assertEquals("endpoint", pkg.fields.single().id)
        assertTrue(pkg.fields.single().required)

        val instance = inventory.instances.single()
        assertEquals(pkg.id, instance.packageId)
        assertEquals("Generated control instance", instance.name)
        assertEquals("generated-reference", instance.configuration.getString("endpoint"))
        assertEquals("configured", instance.observed)
        assertFalse(instance.desired)
        assertEquals("unknown", instance.capabilities.single().state)
        assertEquals(setOf("configure", "check"), instance.allowedActions)
        assertEquals(emptyList<String>(), inventory.catalog.map { it.getString("repository") })
        assertEquals(emptyList<String>(), inventory.sourceContributions.map { it.optString("contributionId") })

        val packageBuild = inventory.builds[0]
        val worker = inventory.builds[1]
        assertEquals("worker", packageBuild.runtime)
        assertEquals("worker", worker.runtime)
        assertEquals(pkg.id, packageBuild.id)
        assertEquals("Generated control package", packageBuild.name)
        assertEquals(worker.packageId, instance.packageId)
        assertEquals("stopped", packageBuild.observed)
        assertEquals("stopped", worker.observed)
        assertEquals("generated-reference", worker.configuration.getString("endpoint"))
        assertEquals(emptyList<String>(), packageBuild.blockers)
        assertEquals(emptyList<String>(), worker.blockers)
        assertEquals("fixture-1", packageBuild.version)
        assertEquals("fixture-1", worker.version)
    }

    @Test fun `missing native provider displays requires-build while a registered build is active`() {
        val missing = NativePluginRegistry()
        assertEquals(PluginAvailability.REQUIRES_BUILD, PluginCenterPlugin.availability(missing))
        assertEquals(MoteI18n.text("需要构建"), PluginCenterPresentation.availability(PluginCenterPlugin.availability(missing)))
        assertEquals(MoteI18n.text("需要构建"), PluginCenterPresentation.packageState("requires-build"))

        val registered = NativePluginRegistry().apply { registerPluginCenter("generated-build") }
        assertEquals(PluginAvailability.ACTIVE, PluginCenterPlugin.availability(registered))
        assertEquals("active", PluginCenterPresentation.availability(PluginCenterPlugin.availability(registered)))
    }
}
