package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** U7: the Android surface submits the existing A6 command, keeps its request
 * identity across retries and never widens an explicit material selection. */
class AssistantOnboardingPresentationTest {
    private val requestId = "00000000-0000-4000-8000-000000000001"
    private val taskId = "00000000-0000-4000-8000-000000000002"
    private fun ref(letter: String) = "material:mat_" + letter.repeat(64) + "@" + letter.repeat(64)
    private fun material(letter: String, source: String = "source-" + letter, state: String = "complete") = JSONObject()
        .put("ref", ref(letter)).put("title", "Generated material " + letter)
        .put("origin", JSONObject().put("sourceId", source)).put("coverage", JSONObject().put("state", state))

    private fun page(vararg rows: JSONObject) = JSONObject().put("items", JSONArray(rows.toList())).put("nextCursor", JSONObject.NULL)

    private fun coverage(completed: Int, total: Int, pending: Int = 0, partial: Int = 0, failed: Int = 0) = JSONObject()
        .put("completed", completed).put("total", total).put("pending", pending).put("partial", partial).put("failed", failed)

    private fun progress(state: String = "pending", revision: Long = 2, extraction: JSONObject = coverage(1, 2, pending = 1)) = JSONObject()
        .put("id", taskId).put("revision", revision).put("state", state)
        .put("coverage", JSONObject().put("sync", JSONObject().put("completed", 2).put("total", 2).put("reason", "selected_synced_materials_only"))
            .put("extraction", extraction).put("semantic", coverage(0, 2, pending = 2)))
        .put("completed", 1).put("pending", 1).put("failed", 0).put("cancelled", 0)
        .put("items", JSONArray(listOf(JSONObject().put("material", JSONObject().put("ref", ref("a")).put("title", "Generated material a").put("sourceId", "source-a"))
            .put("state", "pending").put("coverage", JSONObject().put("extraction", JSONObject().put("status", "pending"))))))

    @Test fun materialPageKeepsOnlyExactMaterialReferences() {
        val parsed = AssistantOnboardingPresentation.materials(page(material("a"), JSONObject().put("ref", "capture:not-a-material")))
        assertEquals(1, parsed.size)
        assertEquals(ref("a"), parsed.single().ref)
        assertEquals("source-a", parsed.single().sourceId)
        assertEquals("complete", parsed.single().state)
    }

    @Test fun selectionDerivesOnlyTheChosenSourceIdsAndAnEmptySelectionIsRejected() {
        val a = AssistantOnboardingPresentation.materials(page(material("a", source = "source-b"), material("b", source = "source-a"))).first()
        val b = AssistantOnboardingPresentation.materials(page(material("b", source = "source-a"))).single()
        val scope = AssistantOnboardingPresentation.scope(listOf(a, b, a))
        assertEquals("selection", scope.getString("kind"))
        assertEquals(listOf("source-a", "source-b"), (0 until scope.getJSONArray("sourceIds").length()).map { scope.getJSONArray("sourceIds").getString(it) })
        assertThrows(IllegalArgumentException::class.java) { AssistantOnboardingPresentation.scope(emptyList()) }
        assertThrows(IllegalArgumentException::class.java) { AssistantOnboardingPresentation.request(requestId, emptyList(), scope) }
    }

    @Test fun startRequestCarriesTheStableRequestIdAndDistinctRefs() {
        val chosen = AssistantOnboardingPresentation.materials(page(material("a"), material("a"), material("b")))
        val request = AssistantOnboardingPresentation.startRequest(requestId, chosen)
        assertEquals(requestId, request.getString("requestId"))
        assertEquals(2, request.getJSONArray("materialRefs").length())
        assertEquals("selection", request.getJSONObject("scope").getString("kind"))
    }

    @Test fun malformedOrReusedRequestIdsAreRejectedBeforeAnHttpCall() {
        val scope = AssistantOnboardingPresentation.scope(AssistantOnboardingPresentation.materials(page(material("a"))))
        assertThrows(IllegalArgumentException::class.java) { AssistantOnboardingPresentation.request("not-a-uuid", listOf(ref("a")), scope) }
        assertThrows(IllegalArgumentException::class.java) { AssistantOnboardingPresentation.startRequest(requestId, listOf(
            AssistantOnboardingPresentation.Material("material:wrong", "Generated", "source-a", "complete"),
        )) }
    }

    @Test fun progressDecodesIndependentCoverageAndCounts() {
        val value = AssistantOnboardingPresentation.progress(progress(extraction = coverage(1, 2, pending = 1)))
        assertEquals(taskId, value.id)
        assertEquals(1, value.extraction.completed)
        assertEquals(1, value.pending)
        assertFalse(value.terminal)
        assertEquals("进行中", AssistantOnboardingPresentation.stateLabel("running"))
        assertEquals("进行中", AssistantOnboardingPresentation.progressStateLabel("pending"))
        assertTrue(AssistantOnboardingPresentation.progress(progress(state = "completed")).terminal)
    }

    @Test fun inconsistentProgressIsNeverPublishedAsCurrent() {
        assertThrows(IllegalArgumentException::class.java) { AssistantOnboardingPresentation.progress(progress(extraction = coverage(3, 2))) }
        assertThrows(IllegalArgumentException::class.java) { AssistantOnboardingPresentation.progress(JSONObject().put("id", "not-a-uuid").put("revision", 1).put("state", "pending")) }
        assertThrows(IllegalArgumentException::class.java) { AssistantOnboardingPresentation.progress(progress().put("state", "invented")) }
    }

    @Test fun aLateResponseForAnotherCommandOrOlderRevisionNeverReplacesTheSession() {
        val session = AssistantOnboardingPresentation.Session(requestId, listOf(ref("a")), AssistantOnboardingPresentation.scope(
            AssistantOnboardingPresentation.materials(page(material("a")))).toString(), id = taskId, revision = 5, state = "pending")
        val older = AssistantOnboardingPresentation.progress(progress("pending", revision = 4))
        assertNull(session.accepted(older))
        val other = progress().put("id", "00000000-0000-4000-8000-000000000003")
        assertNull(session.accepted(AssistantOnboardingPresentation.progress(other)))
        val newer = session.accepted(AssistantOnboardingPresentation.progress(progress("completed", revision = 6)))
        assertEquals(6L, newer!!.revision)
        assertEquals("completed", newer.state)
    }

    @Test fun savedSessionSurvivesRecreationAndARequestThatLostItsResponse() {
        val scope = AssistantOnboardingPresentation.scope(AssistantOnboardingPresentation.materials(page(material("a"))))
        val session = AssistantOnboardingPresentation.Session(requestId, listOf(ref("a")), scope.toString(), id = taskId, revision = 3, state = "pending")
        val restored = AssistantOnboardingPresentation.restore(AssistantOnboardingPresentation.save(session))!!
        assertEquals(requestId, restored.requestId); assertEquals(listOf(ref("a")), restored.refs)
        assertEquals(taskId, restored.id); assertEquals(3L, restored.revision); assertEquals("pending", restored.state)
        assertEquals("selection", AssistantOnboardingPresentation.scopeOf(restored).getString("kind"))
        val lost = AssistantOnboardingPresentation.restore(AssistantOnboardingPresentation.save(
            AssistantOnboardingPresentation.Session(requestId, listOf(ref("a")), scope.toString())))
        assertTrue(lost!!.canRetryStart)
        assertEquals(requestId, lost.requestId)
        assertNull(AssistantOnboardingPresentation.restore(JSONObject().put("requestId", "invalid")))
        assertNull(AssistantOnboardingPresentation.restore(JSONObject().put("requestId", requestId).put("refs", JSONArray())
            .put("scope", scope).put("id", taskId)))
    }

    @Test fun cancellationCarriesTheObservedRevisionAndExactScope() {
        val scope = AssistantOnboardingPresentation.scope(AssistantOnboardingPresentation.materials(page(material("a"))))
        val progress = AssistantOnboardingPresentation.progress(progress())
        val cancel = AssistantOnboardingPresentation.cancelRequest(progress, scope)
        assertEquals(2L, cancel.getLong("expectedRevision"))
        assertEquals("selection", cancel.getJSONObject("scope").getString("kind"))
        assertNotNull(AssistantOnboardingPresentation.cancelRequest(taskId, 2, scope).getLong("expectedRevision"))
    }

    @Test fun theSurfaceUsesTheExistingStartReadAndCancelRoutes() {
        val calls = mutableListOf<String>()
        val client = CentralClient("https://central.invalid", "generated-token", transport = { method, url, body, _, _ ->
            val path = url.substringAfter("central.invalid")
            calls += method + " " + path + (body?.let { " " + String(it) } ?: "")
            when (method) {
                "POST" -> if (path.endsWith("/cancel")) 200 to progress("cancelled", revision = 3) else 202 to progress()
                else -> 200 to progress()
            }
        })
        val scope = AssistantOnboardingPresentation.scope(AssistantOnboardingPresentation.materials(page(material("a"))))
        val request = AssistantOnboardingPresentation.request(requestId, listOf(ref("a")), scope)
        val started = AssistantOnboardingPresentation.progress(client.post("/api/assistant/onboarding", request))
        val read = AssistantOnboardingPresentation.progress(client.get("/api/assistant/onboarding/" + started.id + "?scope=" + CentralScreens.encode(scope.toString())))
        client.post("/api/assistant/onboarding/" + read.id + "/cancel", AssistantOnboardingPresentation.cancelRequest(read, scope))
        assertEquals("POST /api/assistant/onboarding " + request.toString(), calls[0])
        assertTrue(calls[1].startsWith("GET /api/assistant/onboarding/" + taskId + "?scope="))
        assertEquals("POST /api/assistant/onboarding/" + taskId + "/cancel", calls[2].substringBefore(" {"))
    }

    @Test fun labelsSeparateExtractionSemanticAndTerminalStates() {
        assertEquals("已完成 1/2 · 待补 1", AssistantOnboardingPresentation.coverageLabel(AssistantOnboardingPresentation.Coverage(1, 2, 0, 1, 0)))
        assertEquals("没有可认识的资料", AssistantOnboardingPresentation.coverageLabel(AssistantOnboardingPresentation.Coverage(0, 0, 0, 0, 0)))
        assertEquals("已完成", AssistantOnboardingPresentation.stateLabel("completed"))
        assertEquals("已取消", AssistantOnboardingPresentation.stateLabel("cancelled"))
        assertEquals("有失败项", AssistantOnboardingPresentation.stateLabel("failed"))
    }
}
