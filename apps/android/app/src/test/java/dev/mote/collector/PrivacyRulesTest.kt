package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

class PrivacyRulesTest {
    @Test fun `explicit exclusions block any matching visible package`() {
        assertNotNull(PrivacyRules.excludedReason(setOf("private.app"), setOf("safe.app", "private.app"), true))
        assertNull(PrivacyRules.excludedReason(setOf("private.app"), setOf("safe.app"), true))
    }
    @Test fun `unknown windows fail closed when filters configured`() {
        assertNotNull(PrivacyRules.excludedReason(setOf("private.app"), emptySet(), true))
        assertNotNull(PrivacyRules.excludedReason(setOf("private.app"), setOf("safe.app"), false))
        assertNotNull(PrivacyRules.excludedReason(setOf("private.app"), setOf(""), true))
    }
    @Test fun `no hidden application or semantic blacklist`() {
        assertNull(PrivacyRules.excludedReason(emptySet(), setOf("bank.todo.password"), false))
        assertNull(PrivacyRules.excludedReason(setOf("private.app"), setOf("private.application"), true))
    }
    @Test fun `masks accept normalized edges`() {
        assertEquals(listOf(Mask(0f, 0f, 1f, .08f)), Mask.parse("0,0,1,0.08\n"))
        assertTrue(Mask.parse("").isEmpty())
    }
    @Test fun `invalid masks cannot silently disable privacy`() {
        listOf("0,0,1", "0,0,2,1", "NaN,0,1,1", "0.8,0,0.2,1", "0,0,1,Infinity").forEach {
            assertThrows(RuntimeException::class.java) { Mask.parse(it) }
        }
    }
    @Test fun `remote TLS mandatory except explicit debug private address`() {
        assertEquals("https://mote.example.com", PrivacyRules.validateEndpoint("https://mote.example.com/", false, false))
        assertEquals("http://192.168.1.10:47832", PrivacyRules.validateEndpoint("http://192.168.1.10:47832", true, true))
        listOf("http://example.com", "http://10.999.1.1", "https://example.com:99999", "https://token@example.com", "https://example.com/path", "https://example.com?token=x").forEach {
            assertThrows(RuntimeException::class.java) { PrivacyRules.validateEndpoint(it, true, true) }
        }
        assertThrows(RuntimeException::class.java) { PrivacyRules.validateEndpoint("http://192.168.1.10", false, true) }
        assertThrows(RuntimeException::class.java) { PrivacyRules.validateEndpoint("http://192.168.1.10", true, false) }
    }
    @Test fun `privacy reviewer cannot silently send screenshots off phone`() {
        PrivacyRules.validateLocalReview("http://127.0.0.1:47833/review")
        PrivacyRules.validateLocalReview("")
        assertThrows(RuntimeException::class.java) { PrivacyRules.validateLocalReview("https://external.example/review") }
        assertThrows(RuntimeException::class.java) { PrivacyRules.validateLocalReview("http://127.0.0.1.evil.example/review") }
    }
}
