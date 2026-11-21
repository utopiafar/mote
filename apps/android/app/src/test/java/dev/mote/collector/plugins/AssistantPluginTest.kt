package dev.mote.collector.plugins

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantPluginTest {
    private fun host() = NativePluginHost(NativePluginRegistry().apply { AssistantPlugin.register(this, "generated-build") })

    private fun scope(host: NativePluginHost): PluginOwnerSession {
        val identity = PluginInstanceIdentity("dev.mote.assistant", "generated-install", AssistantPlugin.INSTANCE_ID)
        return (host.createScope(PluginInstanceDescriptor(identity, setOf(AssistantPlugin.CAPABILITY), requires = listOf(AssistantPlugin.requirement()))) as PluginResult.Ok).value
    }

    @Test fun `assistant routes are declared by the assistant package and withdrawn on stop`() {
        val host = host()
        val scope = scope(host)
        val owner = AssistantPlugin.open(host, scope)
        assertTrue(owner.active)
        for (page in AssistantPlugin.PAGE_ROUTES) assertNotNull(host.route("dev.mote.assistant", page))
        assertEquals(setOf("assistant.feed", "assistant.matters", "assistant.workbench", "assistant.goals"), scope.routes.keys)
        assertEquals(setOf("assistant.workbench"), scope.services.keys)
        host.stopScope(AssistantPlugin.INSTANCE_ID)
        for (page in AssistantPlugin.PAGE_ROUTES) assertNull(host.route("dev.mote.assistant", page))
    }

    private val goalId = "10000000-0000-4000-8000-000000000001"
    private val matterId = "20000000-0000-4000-8000-000000000002"

    private fun goals(vararg actions: String, template: String? = null): JSONObject {
        val row = JSONObject().put("id", goalId).put("kind", "commitment").put("title", "Generated inferred goal")
            .put("direction", "theirs").put("revision", 17).put("actions", JSONArray(actions.toList()))
            .put("inferred", true).put("followup", JSONObject().put("followed", false))
        val key = JSONObject().put("kind", "matter").put("id", matterId).put("title", "Generated matter")
        template?.let { key.put("template", it) }
        val group = JSONObject().put("key", key).put("theirs", JSONArray()).put("mine", JSONArray()).put("unconfirmed", JSONArray().put(row))
        return JSONObject().put("revision", "generated-page-revision").put("groups", JSONArray().put(group))
    }

    @Test fun rejectingAnInferredGoalRemovesItAfterTheRevisionedReply() {
        val api = AssistantGoals({ goals("reject", "follow", template = "travel") }) { path, body ->
            assertEquals("/api/assistant/goals/$goalId/action", path)
            assertEquals("reject", body.getString("action"))
            assertEquals("commitment", body.getString("kind"))
            assertEquals(17L, body.getLong("expectedRevision"))
            JSONObject().put("id", goalId).put("kind", "commitment").put("revision", 18).put("status", "cancelled")
        }
        val snapshot = api.read(GoalGrouping.MATTER)
        val group = snapshot.groups.single()
        assertEquals(matterId, group.matterId)
        assertEquals(WorkspaceTemplate.TRAVEL, group.template)
        val inferred = group.sections[2].single()
        assertTrue(inferred.inferred)
        assertThrows(IllegalArgumentException::class.java) { api.run(inferred, GoalAction.COMPLETE) }
        val changed = snapshot.apply(inferred, api.run(inferred, GoalAction.REJECT))
        assertTrue(changed.groups.single().sections.all { it.isEmpty() })
    }

    @Test fun followingAGoalShowsTheConfirmedHandoffAndWithdrawsTheAction() {
        val api = AssistantGoals({ path -> assertTrue(path.contains("group=person")); goals("follow") }) { path, body ->
            assertEquals("/api/assistant/goals/$goalId/follow", path)
            assertEquals(setOf("expectedRevision"), body.keys().asSequence().toSet())
            assertEquals(17L, body.getLong("expectedRevision"))
            JSONObject().put("followed", true).put("routineId", "30000000-0000-4000-8000-000000000003")
        }
        val snapshot = api.read(GoalGrouping.PERSON)
        val row = snapshot.groups.single().sections[2].single()
        assertFalse(row.followed)
        val followed = snapshot.apply(row, api.run(row, GoalAction.FOLLOW)).groups.single().sections[2].single()
        assertTrue(followed.followed)
        assertFalse(GoalAction.FOLLOW in followed.actions)
        assertEquals(WorkspaceTemplate.PROJECT, snapshot.groups.single().template)
    }
}
