package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RuntimeStatusReceiptTest {
    // These literals are asserted against the shared schema in
    // apps/android/test-fixtures/agent-runtime-status.ts — keep them in sync.
    private fun receipt(): JSONObject = JSONObject("""{
        "revision": 3,
        "saved": {
            "version": 1, "revision": 3, "source": "file",
            "settings": {"provider": "generated-provider", "protocol": "generated-protocol", "baseUrl": "https://fixture.invalid/v1",
                "model": "generated-model", "reasoningEffort": "generated-effort", "maxTokens": 4096,
                "modelRequestTimeoutMs": 120000, "agentTimeoutMs": 120000, "allowUnauthenticatedLocal": false,
                "apiKeyConfigured": false, "headersConfigured": false, "extraBodyConfigured": false},
            "profiles": [{"id": "env:deployment", "name": "部署配置", "readOnly": true, "source": "file",
                "settings": {"provider": "generated-provider", "protocol": "generated-protocol", "baseUrl": "https://fixture.invalid/v1",
                    "model": "generated-model", "reasoningEffort": "generated-effort", "maxTokens": 4096,
                    "modelRequestTimeoutMs": 120000, "agentTimeoutMs": 120000, "allowUnauthenticatedLocal": false,
                    "apiKeyConfigured": false, "headersConfigured": false, "extraBodyConfigured": false}}],
            "defaults": {"chat": "env:deployment", "memory": "env:deployment", "insight": "env:deployment", "import": "env:deployment", "file": "env:deployment"},
            "defaultModels": {"insight": "generated-insight-model"}
        },
        "features": {
            "chat": {"profileId": "env:deployment", "provider": "generated-provider", "model": "generated-model", "configured": true},
            "memory": {"profileId": "env:deployment", "provider": "generated-provider", "model": "generated-model", "configured": true},
            "transcribe-audio": {"profileId": "env:deployment", "provider": "future-runtime", "model": "generated-model", "configured": false}
        },
        "runtime": {"closed": false, "configured": true, "generation": 2, "activeRuns": 1, "retiringGenerations": 1,
            "releasedGenerations": 1, "preparedGenerations": 0, "closeErrors": 0,
            "preparedAgents": 1, "pendingPreparations": 0, "pendingCleanupFailures": 0, "shuttingDown": false},
        "configuration": {"version": 1, "revision": 3, "configFile": "/private/tmp/mote-fixture/mote.yaml",
            "domains": [{"id": "models", "saved": {"deployment": {"apiKey": true}}, "effective": {"deployment": {"apiKey": true}}, "fields": [], "status": "applied"}],
            "lastError": null,
            "domain": {"id": "models", "saved": {"deployment": {"apiKey": true}}, "effective": {"deployment": {"apiKey": true}}, "fields": [], "status": "applied"}}
    }""")

    @Test fun oneSerializedReceiptParsesWithUnknownCapabilityAndProviderForDisplay() {
        val receipt = RuntimeStatusReceipt.parse(receipt())!!
        assertEquals(3L, receipt.revision)
        assertEquals("future-runtime", receipt.features["transcribe-audio"]!!.provider)
        assertEquals(RuntimeStatusReceipt.FeatureState.UNCONFIGURED, RuntimeStatusReceipt.featureState(receipt, "transcribe-audio"))
        assertEquals(RuntimeStatusReceipt.FeatureState.READY, RuntimeStatusReceipt.featureState(receipt, "chat"))
        assertEquals(RuntimeStatusReceipt.FeatureState.UNKNOWN, RuntimeStatusReceipt.featureState(receipt, "summarize-later"))
        assertEquals(RuntimeStatusReceipt.Readiness.READY, RuntimeStatusReceipt.readiness(receipt))
        val summary = RuntimeStatusReceipt.effectiveSummary(receipt, { it }) { if (it == "env:deployment") "部署配置" else null }
        assertTrue(summary.contains("部署配置 · generated-model"))
        assertTrue(summary.contains("transcribe-audio"))
        assertTrue(summary.contains("尚未生效"))
    }

    @Test fun readinessNeverProjectsReadyWithoutConfiguredAppliedState() {
        val closed = receipt().apply { getJSONObject("runtime").put("closed", true) }
        assertEquals(RuntimeStatusReceipt.Readiness.CLOSED, RuntimeStatusReceipt.readiness(RuntimeStatusReceipt.parse(closed)!!))
        val invalid = receipt().apply { getJSONObject("configuration").getJSONObject("domain").put("status", "invalid") }
        assertEquals(RuntimeStatusReceipt.Readiness.FAILED, RuntimeStatusReceipt.readiness(RuntimeStatusReceipt.parse(invalid)!!))
        val failure = receipt().apply { getJSONObject("configuration").put("lastError", JSONObject().put("code", "config_prepare_failed").put("domain", "models")) }
        assertEquals(RuntimeStatusReceipt.Readiness.FAILED, RuntimeStatusReceipt.readiness(RuntimeStatusReceipt.parse(failure)!!))
        val restart = receipt().apply { getJSONObject("configuration").getJSONObject("domain").put("status", "restart-required") }
        assertEquals(RuntimeStatusReceipt.Readiness.RESTART_PENDING, RuntimeStatusReceipt.readiness(RuntimeStatusReceipt.parse(restart)!!))
        val unconfigured = receipt().apply { getJSONObject("runtime").put("configured", false) }
        assertEquals(RuntimeStatusReceipt.Readiness.UNCONFIGURED, RuntimeStatusReceipt.readiness(RuntimeStatusReceipt.parse(unconfigured)!!))
        val missingDomain = receipt().apply { getJSONObject("configuration").apply { remove("domain"); put("domains", JSONArray()) } }
        assertEquals(RuntimeStatusReceipt.Readiness.FAILED, RuntimeStatusReceipt.readiness(RuntimeStatusReceipt.parse(missingDomain)!!))
    }

    @Test fun secretLaunchAndPathShapedFieldsFailClosed() {
        for (key in listOf("apiKey", "headers", "extraBody", "executable", "home", "packagePath", "secret", "credential")) {
            val injected = receipt().apply { getJSONObject("saved").getJSONObject("settings").put(key, "generated-private-do-not-echo") }
            assertNull(key, RuntimeStatusReceipt.parse(injected))
        }
        val pathProfile = receipt().apply { getJSONObject("features").getJSONObject("chat").put("profileId", "/private/tmp/plugin/generated.mjs") }
        assertNull(RuntimeStatusReceipt.parse(pathProfile))
        val launch = receipt().apply { getJSONObject("features").getJSONObject("chat").put("executable", "/private/tmp/agent") }
        assertNull(RuntimeStatusReceipt.parse(launch))
    }

    @Test fun missingConfiguredStateAndMalformedRevisionsReject() {
        assertNull(RuntimeStatusReceipt.parse(receipt().apply { getJSONObject("features").getJSONObject("chat").remove("configured") }))
        assertNull(RuntimeStatusReceipt.parse(receipt().apply { getJSONObject("features").getJSONObject("chat").put("configured", "yes") }))
        assertNull(RuntimeStatusReceipt.parse(receipt().apply { put("revision", -1) }))
        assertNull(RuntimeStatusReceipt.parse(receipt().apply { put("revision", 1.5) }))
        assertNull(RuntimeStatusReceipt.parse(receipt().apply { put("revision", "3") }))
        assertNull(RuntimeStatusReceipt.parse(receipt().apply { remove("saved") }))
        assertNull(RuntimeStatusReceipt.parse(receipt().apply { remove("configuration") }))
        assertNull(RuntimeStatusReceipt.parse(receipt().apply { getJSONObject("configuration").remove("lastError") }))
    }
}
