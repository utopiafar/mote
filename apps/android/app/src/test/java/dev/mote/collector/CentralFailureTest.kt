package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CentralFailureTest {
    @Test fun pairingConflictsUseExplicitEvidenceInsteadOfAssumingAnExistingDevice() {
        assertEquals("device_conflict", connectionFailureCategory(409, JSONObject().put("error", "device_already_registered")))
        assertEquals("invite_rejected", connectionFailureCategory(403, JSONObject().put("error", "invitation_device_mismatch")))
        assertEquals("response", connectionFailureCategory(409, null))
        assertEquals("protocol_incompatible", connectionFailureCategory(426, null))
        assertEquals("origin_denied", connectionFailureCategory(403, JSONObject().put("error", "origin_denied")))
        assertEquals("permission", connectionFailureCategory(403, JSONObject().put("error", "connection_scope_denied")))
    }

    @Test fun updateAccessDenialRequiresRateMetadataBeforeCallingItThrottling() {
        assertEquals("access_denied", UpdateNetwork.failureCode(403, null, null))
        assertEquals("access_denied", UpdateNetwork.failureCode(401, null, null))
        assertEquals("rate_limit", UpdateNetwork.failureCode(403, "0", null))
        assertEquals("rate_limit", UpdateNetwork.failureCode(403, null, "30"))
        assertEquals("rate_limit", UpdateNetwork.failureCode(429, null, null))
    }

    @Test fun permissionTransportAndProviderFailuresKeepDistinctSafeRecoveryMessages() {
        fun message(status: Int, error: String) = CentralFailure(status, error).message!!
        fun message(status: Int, error: String, detail: String) = CentralFailure(status, error, detail).message!!
        val origin = message(403, "origin_denied", "PRIVATE_SERVER_DETAIL")
        val permission = message(403, "connection_scope_denied")
        val unauthorized = message(401, "unauthorized")
        val incompatible = message(426, "incompatible_protocol")
        val quota = message(503, "provider_quota", "PRIVATE_PROVIDER_DETAIL")
        assertTrue(origin.isNotBlank()); assertTrue(permission.isNotBlank())
        assertEquals("Distinct failures keep distinct recovery messages", 5, setOf(origin, permission, unauthorized, incompatible, quota).size)
        assertFalse(origin.contains("PRIVATE")); assertFalse(quota.contains("PRIVATE"))
        for (status in listOf(403, 413, 429, 502, 503, 504, 524)) {
            val proxy = message(status, "", "PRIVATE_PROXY_BODY")
            assertFalse(proxy.contains("PRIVATE"))
        }
        val unknown = message(503, "generated_unknown", "PRIVATE_PROVIDER_DETAIL")
        assertTrue(unknown.contains("generated_unknown")); assertTrue(unknown.contains("503")); assertFalse(unknown.contains("PRIVATE"))
    }

    @Test fun malformedOptionalReasonsDoNotHideKnownErrorsOrChangeNodeLoginPolicy() {
        assertEquals("unauthorized", centralResponseFailureCode(JSONObject().put("reason", JSONObject()).put("error", JSONObject().put("code", "unauthorized"))))
        var signedOut = 0
        var value = JSONObject().put("error", "google_not_connected")
        val client = CentralClient("https://generated.invalid", "generated-token", { _, _, _, _, _ -> 401 to value }, unauthorized = { signedOut++ })
        val external = assertThrows(CentralFailure::class.java) { client.get("/api/connectors/google/calendars") }
        assertTrue(external.message!!.contains("Google")); assertEquals(0, signedOut)
        value = JSONObject().put("error", "unauthorized")
        assertThrows(CentralFailure::class.java) { client.get("/api/configuration") }; assertEquals(1, signedOut)
    }
}
