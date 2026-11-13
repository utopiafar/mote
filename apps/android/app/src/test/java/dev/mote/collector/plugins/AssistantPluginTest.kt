package dev.mote.collector.plugins

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantPluginTest {
    private fun host() = NativePluginHost(NativePluginRegistry().apply { AssistantPlugin.register(this, "generated-build") })

    private fun scope(host: NativePluginHost): PluginOwnerSession {
        val identity = PluginInstanceIdentity("dev.mote.assistant", "generated-install", AssistantPlugin.INSTANCE_ID)
        return (host.createScope(PluginInstanceDescriptor(identity, setOf(AssistantPlugin.CAPABILITY), requires = listOf(AssistantPlugin.requirement()))) as PluginResult.Ok).value
    }

    @Test fun `feed matters and workbench routes are declared by the assistant package and withdrawn on stop`() {
        val host = host()
        val scope = scope(host)
        val owner = AssistantPlugin.open(host, scope)
        assertTrue(owner.active)
        for (page in AssistantPlugin.PAGE_ROUTES) assertNotNull(host.route("dev.mote.assistant", page))
        assertEquals(setOf("assistant.feed", "assistant.matters", "assistant.workbench"), scope.routes.keys)
        assertEquals(setOf("assistant.workbench"), scope.services.keys)
        host.stopScope(AssistantPlugin.INSTANCE_ID)
        for (page in AssistantPlugin.PAGE_ROUTES) assertNull(host.route("dev.mote.assistant", page))
    }
}
