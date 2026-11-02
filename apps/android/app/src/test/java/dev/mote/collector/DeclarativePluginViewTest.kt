package dev.mote.collector

import dev.mote.collector.plugins.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DeclarativePluginViewTest {
    private fun reject(spec: String): String {
        try { DeclarativePluginView.parse(JSONObject(spec), setOf("save")); fail("expected rejection") }
        catch (expected: IllegalArgumentException) { return expected.message!! }
        throw AssertionError("unreachable")
    }

    @Test fun `strict parsing rejects unknown components oversized arrays and undeclared commands`() {
        assertTrue(reject("""{"components":[{"type":"script"}]}""").contains("unknown component"))
        assertTrue(reject("""{"components":[{"type":"action","command":"rm"}]}""").contains("undeclared action"))
        assertTrue(reject("""{"components":[{"type":"form","fields":[{"key":"a","input":"text"}],"submitCommand":"rm"}]}""").contains("undeclared submitCommand"))
        val fields = (1..40).joinToString(",") { """{"key":"a"}""" }
        assertTrue(reject("""{"components":[{"type":"list","itemKey":"i","fields":[$fields]}]}""").contains("too large"))
        assertTrue(reject("""{"components":[{"type":"status","state":"weird"}]}""").contains("unknown state"))
    }

    @Test fun `a valid spec mirrors the declared node model`() {
        val spec = DeclarativePluginView.parse(JSONObject("""{"components":[
            {"type":"status","state":"pending","textKey":"loading"},
            {"type":"list","itemKey":"items","fields":[{"key":"name"},{"key":"count","format":"number"}]},
            {"type":"action","command":"save","labelKey":"save"}
        ]}"""), setOf("save"))
        assertEquals(3, spec.components.size)
        assertEquals(DeclarativeState.PENDING, (spec.components[0] as DeclarativeNode.Status).state)
        assertEquals("save", (spec.components[2] as DeclarativeNode.Action).command)
    }
}
