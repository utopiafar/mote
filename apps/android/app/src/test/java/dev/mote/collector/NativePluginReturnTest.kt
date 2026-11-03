package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** The Activity only hosts views: recreating it keeps the exact instance
 * scope and origin for a return target and never retargets another owner. */
class NativePluginReturnTest {
    private val origin = "https://central.example"
    private val other = "https://other.example"
    private val conversation = "6a1f2b3c-4d5e-46f7-8a9b-0c1d2e3f4a5b"
    private val evidence = "1b2c3d4e-5f6a-47b8-9c0d-1e2f3a4b5c6d"
    private val memory = "2c3d4e5f-6a7b-48c9-9d0e-2f3a4b5c6d7e"

    @Test fun `activity recreation keeps the exact citation scope and origin`() {
        val route = CentralConversationReference.route(conversation, evidence)
        val recreated = requireNotNull(MoteLink.parse(MoteLink.serialize(MoteLink.Scope(origin), route)))
        assertEquals(MoteLink.Scope(origin), recreated.scope)
        assertEquals(origin, recreated.scope.origin)
        assertEquals(route, recreated.route)
        assertEquals(route, CentralConversationReference.route(conversation.uppercase(), "capture:${evidence.uppercase()}"))

        val requests = mutableListOf<String>()
        val client = CentralClient(origin, "generated-token", transport = { _, url, _, _, _ ->
            requests += url
            if (url.endsWith("/references/$evidence")) 200 to JSONObject().put("available", true).put("id", evidence)
            else 404 to JSONObject().put("reason", "not_found")
        })
        assertTrue(CentralConversationReference.available(client, conversation, evidence))
        assertEquals("$origin/api/conversations/$conversation/references/$evidence", requests.single())
    }

    @Test fun `activity recreation keeps the memory return scope and origin`() {
        val state = MemoryTopicNavigation()
        state.choose("auto.one", "review")
        state.next("generated cursor+/=")
        state.selectMemory(memory)
        state.scroll = 120
        val link = requireNotNull(state.link(origin))
        val recreatedLink = requireNotNull(MoteLink.parse(MoteLink.serialize(link.scope, link.route)))
        assertEquals(MoteLink.Scope(origin), recreatedLink.scope)
        assertEquals(origin, recreatedLink.scope.origin)
        assertEquals(MoteLink.Route.Reference("memory:$memory"), recreatedLink.route)

        val saved = JSONObject(state.save().toString())
        val recreated = MemoryTopicNavigation().apply { restore(saved) }
        assertEquals("memory:$memory", saved.getString("memory"))
        assertEquals(memory, recreated.selectedMemory)
        assertEquals(state.path(), recreated.path())
        assertEquals(120, recreated.scroll)
        assertEquals(link, recreated.link(origin))
    }

    @Test fun `a recreated activity never retargets a foreign origin or a bare memory`() {
        val state = MemoryTopicNavigation()
        state.choose("auto.one", "review")
        state.selectMemory(memory)
        val link = requireNotNull(state.link(origin))
        assertEquals(MoteLink.Destination.None, MoteLink.destination(link, other))
        assertEquals(MoteLink.Resolution.ForeignScope, MoteLink.resolve(link, other))

        val legacy = JSONObject().put("tree", "auto.one").put("node", "review").put("memory", memory)
        val restored = MemoryTopicNavigation().apply { restore(legacy) }
        assertNull(restored.selectedMemory)
        assertNull(restored.link(origin))
        assertNull(CentralEvidenceReference.captureId(memory))
        assertThrows(IllegalArgumentException::class.java) { CentralConversationReference.route("not-a-uuid", evidence) }
    }
}
