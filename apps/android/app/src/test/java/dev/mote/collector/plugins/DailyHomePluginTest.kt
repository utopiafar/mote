package dev.mote.collector.plugins

import dev.mote.collector.HomeArchiveProbe
import dev.mote.collector.HomeConversationRead
import dev.mote.collector.HomeSection
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** The home plugin owns the mount lifecycle and the local read/signature
 * state: a hidden home never refreshes, and unchanged local content is reused. */
class DailyHomePluginTest {
    private fun started(): Pair<NativePluginHost, DailyHomeOwner> {
        val registry = NativePluginRegistry().apply { DailyHomePlugin.register(this, "generated-build") }
        val host = NativePluginHost(registry)
        val identity = PluginInstanceIdentity(DailyHomePlugin.INSTANCE_ID, "generated-installation", DailyHomePlugin.INSTANCE_ID)
        val descriptor = PluginInstanceDescriptor(
            identity,
            setOf(DailyHomePlugin.CAPABILITY),
            requires = listOf(DailyHomePlugin.requirement()),
        )
        val scope = (host.createScope(descriptor) as PluginResult.Ok).value
        val owner = (host.startPlugin(scope) { DailyHomePlugin.open(host, it) } as PluginResult.Ok).value
        return host to owner
    }

    private class Section : HomeSection {
        var refreshes = 0
        var pauses = 0
        var closes = 0
        override fun refresh() { refreshes++ }
        override fun pause() { pauses++ }
        override fun close() { closes++ }
    }

    @Test fun builtinProviderRegistersAndOwnsTheHomeServices() {
        val registry = NativePluginRegistry().apply { DailyHomePlugin.register(this, "generated-build") }
        assertEquals(PluginAvailability.ACTIVE, registry.availability(DailyHomePlugin.requirement()))
        assertNotNull(registry.provider(DailyHomePlugin.CAPABILITY, DailyHomePlugin.API_VERSION))

        val (host, owner) = started()
        assertTrue(owner.active)
        assertEquals(
            setOf("home.read", "home.local", "home.sections"),
            host.scope(DailyHomePlugin.INSTANCE_ID)!!.services.keys,
        )
    }

    @Test fun aHiddenHomeNeverRefreshesASectionAndReturningReadsAgain() {
        val (_, owner) = started()
        val sections = owner.sections()
        val section = Section()
        sections.add(section)
        assertEquals("mounting below another page does not read", 0, section.refreshes)
        sections.refresh()
        assertEquals("a hidden refresh is refused even if the shell asks", 0, section.refreshes)
        sections.show()
        sections.refresh()
        assertEquals(1, section.refreshes)
        sections.pause()
        sections.refresh()
        assertEquals("leaving the home stops reads", 1, section.refreshes)
        sections.show()
        sections.refresh()
        assertEquals("returning reads once", 2, section.refreshes)
        sections.close()
        assertEquals(1, section.closes)
        assertEquals(0, sections.count)
    }

    @Test fun unchangedLocalSignaturesReuseTheQueueAnswerAndTheMountedRows() {
        val (_, owner) = started()
        var queueReads = 0
        val exists = { queueReads++; true }
        val draft = JSONObject().put("text", "generated draft")
        val receipt = JSONObject().put("id", "r-1").put("capturedAt", "2026-11-04T00:00:00Z")
        val first = owner.captures(7, draft, receipt, { false }, exists)
        val second = owner.captures(7, draft, receipt, { false }, exists)
        assertTrue(first.getBoolean("hasAnyRecords"))
        assertTrue(second.getBoolean("hasAnyRecords"))
        assertEquals("an unchanged records revision never reopens the queue", 1, queueReads)

        val sources = owner.sourceSignature(listOf(Triple("s1", "Photos", "synced")))
        assertTrue("the first content builds its rows", owner.sourcesChanged(sources))
        assertFalse("the same content does not rebuild", owner.sourcesChanged(sources))
        assertTrue("new progress rebuilds", owner.sourcesChanged(owner.sourceSignature(listOf(Triple("s1", "Photos", "13/40")))))

        val card = owner.receiptSignature("r-1", "generated", "2026-11-04T00:00:00Z", connected = true)
        assertTrue(owner.receiptChanged(card))
        assertFalse(owner.receiptChanged(card))
        assertTrue(owner.receiptChanged(owner.receiptSignature("r-1", "generated", "2026-11-04T00:00:00Z", connected = false)))

        // A new mount has no rows yet, so the same content must build again.
        owner.sections()
        assertTrue(owner.sourcesChanged(sources))
    }

    @Test fun theHomeReadValidatesTheExactConversationPageItRenders() {
        val id = UUID.randomUUID().toString()
        val page = JSONObject().put("items", JSONArray().put(JSONObject()
            .put("id", id).put("title", "Generated home conversation").put("updatedAt", "2026-11-04T04:00:00Z").put("turnCount", 1)))
        val rows = HomeConversationRead.page { path ->
            assertEquals("/api/conversations?limit=5", path)
            page
        }
        assertEquals(1, rows.length())
        assertEquals("Generated home conversation", rows.getJSONObject(0).getString("title"))

        val malformed = JSONObject().put("items", JSONArray().put(JSONObject()
            .put("id", "not-a-uuid").put("title", "Generated").put("updatedAt", "2026-11-04T04:00:00Z").put("turnCount", 1)))
        assertThrows(IllegalArgumentException::class.java) { HomeConversationRead.page { malformed } }

        val archive = HomeArchiveProbe.empty { path ->
            when {
                path == "/api/status" -> JSONObject("""{"storage":{"captures":0}}""")
                else -> JSONObject("""{"items":[]}""")
            }
        }
        assertTrue("the same probe remains the archive-empty authority", archive)
    }
}
