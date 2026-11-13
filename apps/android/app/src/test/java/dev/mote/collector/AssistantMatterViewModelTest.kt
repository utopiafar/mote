package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AssistantMatterViewModelTest {
    private val f = AssistantFixtures
    @Test fun `pausing shows the server state while running tasks and enabled rules keep their own receipts`() {
        var matter = f.matter()
        var rule = f.routine()
        val commands = mutableListOf<JSONObject>()
        val domain = object : GeneratedAssistantDomain() {
            override fun matter(id: String, scope: AssistantScope) = AssistantMatterDetail.read(matter)
            override fun matterCommand(command: JSONObject) {
                commands += command
                assertEquals(1L, command.getLong("expectedRevision")); assertEquals("pause", command.getString("type"))
                matter = f.matter("paused", 2)
            }
        }
        val api = CentralAssistant(CentralClient("https://generated.invalid", "generated-only", transport = { method, _, bytes, _, _ ->
            if (method == "POST") {
                val command = JSONObject(String(bytes!!)); assertEquals(1L, command.getLong("expectedRevision"))
                rule = f.routine(command.getBoolean("enabled"), 2)
            }
            200 to rule
        }), f.scope(), domain)
        val model = AssistantMatterViewModel(api, f.matterId, listOf(f.routineId))
        model.refresh(); assertTrue(model.detail!!.partial); assertEquals(listOf(f.evidence), model.detail!!.evidence.map { it.first })
        model.transition(1, "pause")
        assertNull(model.error); assertEquals("paused", model.detail!!.state); assertEquals("running", model.detail!!.tasks.single().second)
        assertTrue(model.routines.single().enabled); assertEquals("2026-11-14T01:00:00Z", model.routines.single().nextDue)
        assertEquals("confirmed", model.commitments.single().status); assertEquals("unknown", model.commitments.single().dueState)
        model.updateRoutine(f.routineId, 1, false)
        assertFalse(model.routines.single().enabled); assertNull(model.routines.single().nextDue)
        assertEquals("paused", model.detail!!.state); assertEquals(1, commands.size)
    }

    @Test fun `stale edit reloads the other client pause without replaying or claiming the edit saved`() {
        var current = f.matter(); val commands = mutableListOf<JSONObject>()
        val domain = object : GeneratedAssistantDomain() {
            override fun matter(id: String, scope: AssistantScope) = AssistantMatterDetail.read(current)
            override fun matterCommand(command: JSONObject) {
                commands += command; current = f.matter("paused", 2)
                throw CentralFailure(409)
            }
        }
        val api = CentralAssistant(CentralClient("https://generated.invalid", "generated-only"), f.scope(), domain)
        val model = AssistantMatterViewModel(api, f.matterId)
        model.refresh(); model.edit(1, "Generated edit from stale screen")
        assertEquals(1, commands.size); assertEquals(1L, commands.single().getLong("expectedRevision"))
        assertEquals("Generated edit from stale screen", commands.single().getString("goal"))
        assertNotNull(model.error); assertEquals(2L, model.detail!!.revision); assertEquals("paused", model.detail!!.state)
        assertEquals("Generated shared matter", model.detail!!.goal)
    }

    @Test fun `rule edit conflict refreshes authoritative schedule and withdrawal clears the detail`() {
        var revoked = false; var rule = f.routine(); var calls = 0
        val domain = object : GeneratedAssistantDomain() {
            override fun matter(id: String, scope: AssistantScope): AssistantMatterDetail {
                if (revoked) throw CentralFailure(404)
                return super.matter(id, scope)
            }
        }
        val api = CentralAssistant(CentralClient("https://generated.invalid", "generated-only", transport = { method, _, _, _, _ ->
            if (method == "POST") { calls++; rule = f.routine(false, 2); 409 to JSONObject() } else 200 to rule
        }), f.scope(), domain)
        val model = AssistantMatterViewModel(api, f.matterId, listOf(f.routineId))
        model.refresh(); model.updateRoutine(f.routineId, 1, true, timeZone = "UTC")
        assertEquals(1, calls); assertNotNull(model.error); assertEquals(2L, model.routines.single().revision)
        assertFalse(model.routines.single().enabled); assertEquals("Asia/Shanghai", model.routines.single().schedule().getString("timeZone"))
        revoked = true; model.refresh()
        assertNull(model.detail); assertTrue(model.commitments.isEmpty()); assertTrue(model.routines.isEmpty())
    }

    @Test fun `unbound and archived matters do not offer edits`() {
        val unbound = AssistantMatterViewModel(CentralAssistant(CentralClient("https://generated.invalid", "generated-only"), f.scope()), f.matterId)
        unbound.refresh(); assertFalse(unbound.canEdit); assertNotNull(unbound.error)
        val domain = object : GeneratedAssistantDomain() { override fun matter(id: String, scope: AssistantScope) = AssistantMatterDetail.read(f.matter("archived")) }
        val archived = AssistantMatterViewModel(CentralAssistant(CentralClient("https://generated.invalid", "generated-only"), f.scope(), domain), f.matterId)
        archived.refresh(); assertFalse(archived.canEdit); assertEquals("archived", archived.detail!!.state)
    }

    @Test fun `a restricted detail never displays a wider rule from the owner configuration route`() {
        val widerRule = f.routine().put("scope", JSONObject().put("kind", "all"))
        val client = CentralClient("https://generated.invalid", "generated-only", transport = { _, _, _, _, _ -> 200 to widerRule })
        val api = CentralAssistant(client, f.scope(), GeneratedAssistantDomain())
        val model = AssistantMatterViewModel(api, f.matterId, listOf(f.routineId))
        model.refresh(); assertNotNull(model.error); assertNull(model.detail); assertTrue(model.routines.isEmpty())
        assertTrue(CentralAssistant(client, AssistantScope(JSONObject().put("kind", "all"))).routine(f.routineId).enabled)
    }
}
