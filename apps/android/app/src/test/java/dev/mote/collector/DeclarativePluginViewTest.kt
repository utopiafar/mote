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
        assertTrue(reject("""{"components":[{"type":"action","command":"rm"}]}""").contains("undeclared"))
        assertTrue(reject("""{"components":[{"type":"form","fields":[{"key":"a","input":"text"}],"submitCommand":"rm"}]}""").contains("undeclared"))
        val fields = (1..40).joinToString(",") { """{"key":"a"}""" }
        assertTrue(reject("""{"components":[{"type":"list","itemKey":"i","fields":[$fields]}]}""").contains("too large"))
        assertTrue(reject("""{"components":[{"type":"status","state":"weird"}]}""").contains("unknown state"))
        assertTrue("extra keys rejected like the TS decoder", reject("""{"components":[{"type":"status","state":"pending","onClick":"x"}]}""").contains("unknown field"))
        assertTrue("string required is not coerced", reject("""{"components":[{"type":"form","fields":[{"key":"a","input":"text","required":"true"}]}]}""").contains("boolean required"))
        assertTrue(reject("""{"components":[{"type":"action","command":"save","labelKey":{}}]}""").contains("string required"))
        assertTrue("missing input is rejected, not defaulted", reject("""{"components":[{"type":"form","fields":[{"key":"a"}]}]}""").contains("token required"))
        assertTrue("uppercase wire state is rejected", reject("""{"components":[{"type":"status","state":"PENDING"}]}""").contains("unknown state"))
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

    @Test fun `a real parsed instance admits only DOMAIN-allowed command actions`() {
        // A generated payload shaped like the real /api/plugins inventory;
        // PluginControlClient does the real parsing — the spec is adapted
        // from its typed instance, not a hand-made view model.
        val raw = JSONObject("""{"id":"inst:one","packageId":"pkg.x","name":"One","revision":7,"scope":"owner","configuration":{},"configurationSchema":[],"capabilities":[],"desired":true,"observed":"enabled","issues":[],"allowedActions":["enable","disable"],"secretStatus":{}}""")
        val instance = PluginControlProjection.instance(raw)
        val actions = setOf("check", "enable", "disable").filter { it in instance.allowedActions }
        val spec = DeclarativePluginView.parse(JSONObject("""{"components":[
            {"type":"detail","fields":[{"key":"revision","format":"number"}]},
            {"type":"action","command":"enable","labelKey":"enable"},
            {"type":"action","command":"disable","labelKey":"disable"}
        ]}"""), actions.toSet())
        assertEquals(2, actions.size)
        assertEquals(DeclarativeNode.Action::class, spec.components[1]::class)
        assertEquals("disable", (spec.components[2] as DeclarativeNode.Action).command)
        assertTrue(instance.revision == 7L)
        try {
            DeclarativePluginView.parse(JSONObject("""{"components":[{"type":"action","command":"check","labelKey":"check"}]}"""), actions.toSet())
            fail("check is not DOMAIN-allowed for this instance")
        } catch (expected: IllegalArgumentException) { }
    }
}
