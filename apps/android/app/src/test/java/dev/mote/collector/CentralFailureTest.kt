package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CentralFailureTest {
    @Test fun pairingConflictsUseTheReasonInsteadOfAssumingAnExistingDevice() {
        assertEquals("device_conflict", connectionFailureCategory(409, JSONObject().put("error", "device_already_registered")))
        assertEquals("invite_rejected", connectionFailureCategory(409, JSONObject().put("error", "invitation_claim_changed")))
        assertEquals("response", connectionFailureCategory(409, null))
        assertEquals("protocol_incompatible", connectionFailureCategory(426, null))
        assertEquals("origin_denied", connectionFailureCategory(403, JSONObject().put("error", "origin_denied")))
    }
    @Test fun updateAccessDenialIsNotAssumedToBeThrottling() {
        assertEquals("access_denied", UpdateNetwork.failureCode(403, null, null))
        assertEquals("rate_limit", UpdateNetwork.failureCode(403, "0", null))
        assertEquals("rate_limit", UpdateNetwork.failureCode(403, null, "30"))
        assertEquals("rate_limit", UpdateNetwork.failureCode(429, null, null))
    }
    @Test fun permissionDoesNotClaimAnUpgradeAndServerDetailStaysPrivate() {
        val origin = CentralFailure(403, "origin_denied", "PRIVATE_SERVER_DETAIL").message!!
        assertTrue(origin.contains("公开地址")); assertFalse(origin.contains("升级")); assertFalse(origin.contains("PRIVATE"))
        assertTrue(CentralFailure(401, "invalid_login").message!!.contains("用户名或密码"))
        assertTrue(CentralFailure(429, "login_throttled").message!!.contains("登录尝试"))
        assertTrue(CentralFailure(426, "incompatible_protocol").message!!.contains("协议版本"))
        val unknown = CentralFailure(503, "generated_unknown", "PRIVATE_PROVIDER_DETAIL").message!!
        assertTrue(unknown.contains("generated_unknown")); assertTrue(unknown.contains("503")); assertFalse(unknown.contains("PRIVATE"))
    }
    @Test fun structuredReasonsSurviveMalformedOptionalFieldsAndOnlyExpiredCentralIdentitySignsOut() {
        assertEquals("invalid_login", centralResponseFailureCode(JSONObject().put("reason", JSONObject()).put("error", JSONObject().put("code", "invalid_login"))))
        var signedOut = 0
        var value = JSONObject().put("error", "google_not_connected")
        val client = CentralClient("https://generated.invalid", "generated-token", { _, _, _, _, _ -> 401 to value }, unauthorized = { signedOut++ })
        runCatching { client.get("/api/connectors/google/calendars") }; assertEquals(0, signedOut)
        value = JSONObject().put("error", "invalid_identity")
        runCatching { client.get("/api/auth/self") }; assertEquals(1, signedOut)
    }
}
