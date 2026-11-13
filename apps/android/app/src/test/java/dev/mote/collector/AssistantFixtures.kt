package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/** Generated work/life records. No device or personal profile is a fixture. */
internal object AssistantFixtures {
    const val work = "10000000-0000-4000-8000-000000000001"
    const val life = "10000000-0000-4000-8000-000000000002"
    const val evidence = "20000000-0000-4000-8000-000000000001"
    const val taskId = "30000000-0000-4000-8000-000000000001"
    const val matterId = "40000000-0000-4000-8000-000000000001"
    const val routineId = "50000000-0000-4000-8000-000000000001"
    const val time = "2026-11-13T01:00:00Z"
    fun scope() = AssistantScope(JSONObject().put("kind", "selection").put("evidenceIds", JSONArray().put(evidence)))
    fun proof() = JSONObject().put("id", evidence).put("quote", "Generated source quote").put("offset", 0)
    fun card(id: String = work, revision: Long = 1) = JSONObject().put("id", id).put("revision", revision).put("version", "v$revision")
        .put("kind", "suggestion").put("state", "open").put("title", if (id == work) "Generated project preparation" else "Generated family trip preparation")
        .put("body", "Generated observation, relevance and offered help").put("evidence", JSONArray().put(proof()))
        .put("matterId", matterId).put("acceptedTaskId", JSONObject.NULL).put("readAt", JSONObject.NULL)
        .put("feedback", JSONArray()).put("createdAt", time).put("updatedAt", time)
    fun page(vararg cards: JSONObject) = JSONObject().put("items", JSONArray(cards.toList())).put("nextCursor", JSONObject.NULL)
    fun task(state: String = "waiting") = JSONObject().put("task", JSONObject().put("id", taskId).put("revision", 1).put("state", state)
        .put("goal", "Generated goal").put("scope", scope().json())).put("workId", "assistant.task:generated")
    fun matter(state: String = "active", revision: Long = 1) = JSONObject()
        .put("matter", JSONObject().put("id", matterId).put("revision", revision).put("goal", "Generated shared matter").put("state", state)
            .put("scope", scope().json()).put("evidenceIds", JSONArray().put(evidence).put(life)).put("taskIds", JSONArray().put(taskId)))
        .put("linkedTasks", JSONArray().put(JSONObject().put("id", taskId).put("state", "running").put("revision", 1).put("updatedAt", time)))
        .put("linkedEvidence", JSONArray().put(JSONObject().put("id", evidence).put("title", "Generated current source")))
        .put("coverage", JSONObject().put("tasks", "complete").put("evidence", "partial"))
    fun routine(enabled: Boolean = true, revision: Long = 1) = JSONObject().put("id", routineId).put("revision", revision).put("enabled", enabled)
        .put("goal", "Generated daily review").put("scope", scope().json()).put("matterId", matterId).put("event", JSONObject.NULL)
        .put("nextDue", if (enabled) "2026-11-14T01:00:00Z" else JSONObject.NULL)
        .put("schedule", JSONObject().put("revision", revision).put("timeZone", "Asia/Shanghai").put("trigger", JSONObject().put("kind", "daily").put("localTime", "09:00")))
    fun commitment() = JSONObject().put("id", life).put("revision", 1).put("title", "Generated trip confirmation").put("status", "confirmed")
        .put("deadline", JSONObject().put("text", "Generated vague deadline").put("at", JSONObject.NULL)).put("dueState", "unknown")
        .put("timeline", JSONArray().put(JSONObject().put("summary", "Generated promise").put("occurredAt", JSONObject.NULL).put("createdAt", time).put("origin", "proposal").put("evidence", JSONArray().put(proof()))))
}

internal open class GeneratedAssistantDomain : AssistantDomainBindings {
    override fun start(request: JSONObject, card: JSONObject): String = error("Unexpected start")
    override fun matter(id: String, scope: AssistantScope) = AssistantMatterDetail.read(AssistantFixtures.matter())
    override fun commitments(matterId: String, scope: AssistantScope) = listOf(AssistantCommitment.read(AssistantFixtures.commitment()))
    override fun routines(matterId: String, scope: AssistantScope) = emptyList<AssistantRoutine>()
    override fun matterCommand(command: JSONObject) { error("Unexpected matter command") }
}
