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
        val origin = CentralFailure(403, "origin_denied", "PRIVATE_SERVER_DETAIL").message!!
        assertTrue("Origin denial identifies the web address", origin.contains("网页地址"))
        assertFalse("Origin denial must not request an upgrade", origin.contains("升级"))
        assertFalse(origin.contains("PRIVATE"))

        val permission = CentralFailure(403, "connection_scope_denied").message!!
        assertTrue("Scope denial identifies the connection permission", permission.contains("连接权限"))
        assertFalse("Scope denial must not report expired credentials", permission.contains("失效"))

        val unauthorized = CentralFailure(401, "unauthorized").message!!
        assertTrue(unauthorized.contains("凭据已失效"))
        assertTrue(unauthorized.contains("重新连接"))
        assertTrue(CentralFailure(426, "incompatible_protocol").message!!.contains("协议版本"))

        val quota = CentralFailure(503, "provider_quota", "PRIVATE_PROVIDER_DETAIL").message!!
        assertTrue(quota.contains("额度不足"))
        assertFalse(quota.contains("PRIVATE"))

        for (status in listOf(403, 413, 429, 502, 503, 504, 524)) {
            val proxy = CentralFailure(status, "", "PRIVATE_PROXY_BODY").message!!
            assertFalse("HTTP $status must not expose the proxy body", proxy.contains("PRIVATE"))
            assertFalse("HTTP $status must not report expired credentials", proxy.contains("失效"))
            assertFalse("HTTP $status must not request an upgrade", proxy.contains("升级"))
        }
        val unknown = CentralFailure(503, "generated_unknown", "PRIVATE_PROVIDER_DETAIL").message!!
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
