package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PluginControlClientTest {
    @Test fun installedPackageConfigurationIsAvailableBeforeAnyInstanceExists() {
        val field = JSONObject().put("id", "endpoint").put("label", "Generated endpoint").put("type", "text").put("required", true)
        val adapter = JSONObject().put("id", "generated-package").put("name", "Generated adapter").put("version", "fixture-1")
            .put("source", JSONObject()).put("runtime", "worker").put("state", "installed").put("observed", "installed")
            .put("issues", JSONArray()).put("allowedActions", JSONArray().put("configure")).put("configurationSchema", JSONArray().put(field))
        val inventory = JSONObject().put("revision", 1).put("installation", JSONObject()).put("packages", JSONArray().put(adapter))
            .put("instances", JSONArray()).put("catalog", JSONArray())
        val parsed = PluginControlProjection.inventory(inventory)
        assertTrue(parsed.instances.isEmpty()); assertEquals("endpoint", parsed.packages.single().fields.single().id)
        assertFalse(PluginControlProjection.configured(parsed.packages.single().fields, JSONObject()))
        assertTrue(PluginControlProjection.configured(parsed.packages.single().fields, JSONObject().put("endpoint", "generated-reference")))
    }

    @Test fun pinnedPreviewInstallHasNoSourceOverrideAndRetriesAnIdenticalOwnerIntent() {
        val calls = mutableListOf<Triple<String, String, JSONObject>>()
        var fail = true
        val central = CentralClient("http://127.0.0.1:47999", "generated-test-token", transport = { method, url, bytes, credential, _ ->
            assertEquals("generated-test-token", credential)
            calls.add(Triple(method, url, JSONObject(String(bytes!!))))
            if (fail) { fail = false; throw java.io.IOException("Generated lost response") }
            200 to JSONObject().put("revision", 2)
        })
        val control = PluginControlClient(central)
        val preview = JSONObject().put("id", "generated-private-preview").put("source", JSONObject().put("repository", "https://github.com/generated-fixture/not-a-real-package"))
        val intent = PluginControlClient.install(preview, 1)
        assertTrue(runCatching { control.execute(intent) }.isFailure)
        control.execute(intent)
        assertEquals(2, calls.size)
        assertEquals("http://127.0.0.1:47999/api/plugins/install", calls[0].second)
        assertEquals(calls[0].third.toString(), calls[1].third.toString())
        assertEquals("generated-private-preview", calls[0].third.getString("previewId"))
        assertFalse(calls[0].third.has("source"))
        assertFalse(calls[0].third.has("repository"))
        assertEquals(1, calls[0].third.getLong("expectedRevision"))
    }

    @Test fun instanceConfigurationAndEnableUseTheInstanceRevisionAndNeverBindImplicitly() {
        val configuration = JSONObject().put("serviceReference", "generated-service-reference")
        val create = PluginControlClient.configure("generated-package", null, 3, "Generated instance", "default", configuration)
        assertEquals("/api/plugin-instances", create.path); assertEquals("POST", create.method)
        assertEquals("generated-package", create.payload().getString("packageId")); assertEquals(3, create.payload().getLong("expectedRevision"))
        val edit = PluginControlClient.configure("generated-package", "generated-instance", 9, "Generated instance", "default", configuration)
        assertEquals("PATCH", edit.method); assertEquals(9, edit.payload().getLong("expectedRevision")); assertFalse(edit.payload().has("packageId"))
        val enable = PluginControlClient.instanceAction("generated-instance", "enable", 10)
        assertEquals("/api/plugin-instances/generated-instance/enable", enable.path)
        assertEquals(10, enable.payload().getLong("expectedRevision")); assertFalse(enable.payload().has("targetPlanId"))
        assertTrue(runCatching { PluginControlClient.instanceAction("generated-instance", "activate", 10) }.isFailure)
    }

    @Test fun pauseResumeStopAndPreparedActivationCarryDifferentOwnerIntentsWithoutHistoryReplay() {
        val pause = PluginControlClient.memoryAction("pause", 4)
        val resume = PluginControlClient.memoryAction("resume", 5)
        val stop = PluginControlClient.memoryAction("stop", 6)
        assertEquals(3, setOf(pause.payload().getString("operationId"), resume.payload().getString("operationId"), stop.payload().getString("operationId")).size)
        assertFalse(resume.payload().has("scope")); assertFalse(resume.payload().has("generation"))
        assertTrue(runCatching { PluginControlClient.prepare("generated-plan", "default", 7, false) }.isFailure)
        val prepare = PluginControlClient.prepare("generated-plan", "default", 7, true)
        assertEquals("generated-plan", prepare.payload().getString("targetPlanId")); assertTrue(prepare.payload().getBoolean("feeAcknowledged"))
        val activate = PluginControlClient.memoryAction("activate", 8, "generated-preparation")
        assertEquals("generated-preparation", activate.payload().getString("preparationId"))
        assertNotEquals("generated-preparation", activate.payload().getString("operationId"))
        assertEquals(PluginControlClient.BINDING + "/activate", activate.path)
    }

    @Test fun projectionKeepsRequestedStateSeparateFromObservedStateAndDoesNotInferEngineCompatibility() {
        val instance = JSONObject().put("id", "generated-instance").put("packageId", "generated-package").put("name", "Generated instance")
            .put("revision", 2).put("scope", "default").put("configuration", JSONObject()).put("secretStatus", JSONObject())
            .put("configurationSchema", JSONArray()).put("capabilities", JSONArray().put(JSONObject().put("id", "memory.engine").put("state", "unknown").put("reason", "Generated isolation proof is missing")))
            .put("desired", true).put("observed", "unconfigured").put("issues", JSONArray().put("Generated instance cannot run yet")).put("allowedActions", JSONArray().put("configure"))
        val parsed = PluginControlProjection.instance(instance)
        assertTrue(parsed.desired); assertEquals("unconfigured", parsed.observed); assertEquals("unknown", parsed.capabilities.single().state)
        assertEquals(setOf("configure"), parsed.allowedActions); assertFalse("enable" in parsed.allowedActions)
        val plan = JSONObject().put("id", "hindsight-name-is-not-proof").put("name", "Generated engine")
            .put("mode", "engine").put("available", false).put("reason", "Generated adapter has not passed its contract")
            .put("modules", JSONArray()).put("capabilities", instance.getJSONArray("capabilities")).put("allowedActions", JSONArray())
        assertFalse(PluginControlProjection.plan(plan).available)
    }

    @Test fun declarativeConfigurationRejectsMissingRequiredFieldsInvalidNumbersAndUnknownSelections() {
        val required = PluginField("service", "Generated service", "text", true, emptyList(), "")
        assertFalse(PluginControlProjection.configured(listOf(required), JSONObject()))
        assertTrue(PluginControlProjection.configured(listOf(required), JSONObject().put("service", "generated-reference")))
        val number = PluginField("count", "Generated count", "number", false, emptyList(), "")
        assertFalse(PluginControlProjection.configured(listOf(number), JSONObject().put("count", "not-a-number")))
        val select = PluginField("choice", "Generated choice", "select", true, listOf("allowed" to "Allowed"), "")
        assertFalse(PluginControlProjection.configured(listOf(select), JSONObject().put("choice", "unsupported")))
        assertTrue(PluginControlProjection.configured(listOf(select), JSONObject().put("choice", "allowed")))
    }

    @Test fun changedOwnerSessionCannotSendOrPublishAnOldCommand() {
        var active = true; var sends = 0
        val central = CentralClient("http://127.0.0.1:47999", "generated-test-token", transport = { _, _, _, _, _ -> sends++; active = false; 200 to JSONObject() }, active = { active })
        val control = PluginControlClient(central)
        val intent = PluginControlClient.memoryAction("pause", 1)
        assertTrue(runCatching { control.execute(intent) }.isFailure)
        assertEquals(1, sends)
        assertTrue(runCatching { control.execute(intent) }.isFailure)
        assertEquals(1, sends)
    }
}
