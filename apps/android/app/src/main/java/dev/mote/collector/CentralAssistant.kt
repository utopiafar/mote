package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId

/** Consumer of the current Central domain projections, not a second domain model.
 * Only IDs and pending owner commands are persisted by the page models. */
internal object AssistantJson {
    fun string(row: JSONObject, key: String): String = (row.get(key) as? String ?: error("Invalid $key"))
    fun id(row: JSONObject, key: String = "id"): String = string(row, key).also { require(MoteLink.uuidId(it) == it) }
    fun revision(row: JSONObject, key: String = "revision"): Long {
        val value = row.get(key) as? Number ?: error("Invalid $key")
        return value.toLong().also { require(it in 1..9007199254740991L && value.toDouble() == it.toDouble()) }
    }
    fun nullable(row: JSONObject, key: String): String? = if (row.get(key) === JSONObject.NULL) null else string(row, key)
    fun optional(row: JSONObject, key: String): String? = if (!row.has(key)) null else nullable(row, key)
    fun bool(row: JSONObject, key: String): Boolean = row.get(key) as? Boolean ?: error("Invalid $key")
    fun time(row: JSONObject, key: String): String = string(row, key).also { Instant.parse(it) }
    fun state(row: JSONObject, key: String, allowed: Set<String>): String = string(row, key).also { require(it in allowed) }
    fun <T> rows(row: JSONObject, key: String, read: (JSONObject) -> T): List<T> = row.getJSONArray(key).let { items ->
        (0 until items.length()).map { read(items.getJSONObject(it)) }
    }
    fun cursor(row: JSONObject): String? = nullable(row, "nextCursor")
}

internal class AssistantScope(value: JSONObject) {
    // Own a serialized copy so an edited JSONObject cannot widen a pending request.
    private val encoded: String
    init {
        val kind = AssistantJson.state(value, "kind", setOf("all", "selection"))
        require(value.keys().asSequence().all { it in setOf("kind", "sourceIds", "evidenceIds", "deviceId", "after", "before", "timeZone") })
        require(kind != "all" || !value.has("sourceIds"))
        require(kind != "selection" || value.has("sourceIds") || value.has("evidenceIds"))
        for (key in listOf("sourceIds", "evidenceIds")) if (value.has(key)) {
            val ids = value.getJSONArray(key)
            for (i in 0 until ids.length()) {
                val id = ids.get(i) as? String ?: error("Invalid scope ID")
                require(id.isNotBlank())
                if (key == "evidenceIds") require(MoteLink.uuidId(id) == id)
            }
        }
        for (key in listOf("after", "before")) if (value.has(key)) AssistantJson.time(value, key)
        if (value.has("after") && value.has("before")) require(Instant.parse(value.getString("after")) < Instant.parse(value.getString("before")))
        if (value.has("deviceId")) require(AssistantJson.string(value, "deviceId").isNotBlank())
        if (value.has("timeZone")) ZoneId.of(AssistantJson.string(value, "timeZone"))
        encoded = value.toString()
    }
    fun json() = JSONObject(encoded)
    fun query() = java.net.URLEncoder.encode(encoded, "UTF-8")
    val unfilteredAll get() = json().let { it.getString("kind") == "all" && it.length() == 1 }
    fun same(other: AssistantScope): Boolean {
        val left = json(); val right = other.json()
        val keys = left.keys().asSequence().toSet()
        if (keys != right.keys().asSequence().toSet()) return false
        return keys.all { key ->
            val a = left.get(key); val b = right.get(key)
            if (a is JSONArray && b is JSONArray) a.length() == b.length() && (0 until a.length()).all { a.getString(it) == b.getString(it) }
            else a == b
        }
    }
    fun description(): String {
        val value = json()
        return buildList {
            add(MoteI18n.text(if (value.getString("kind") == "all") "全部资料" else "仅所选资料"))
            for (key in listOf("sourceIds", "evidenceIds")) if (value.has(key))
                add(MoteI18n.text(if (key == "sourceIds") "{0} 个来源" else "{0} 项内容", value.getJSONArray(key).length()))
            for (key in listOf("deviceId", "after", "before", "timeZone")) if (value.has(key)) add(value.getString(key))
        }.joinToString(" · ")
    }
}

internal data class AssistantProof(val id: String, val quote: String, val ref: String) {
    companion object {
        fun read(row: JSONObject): AssistantProof {
            val id = AssistantJson.id(row)
            val ref = AssistantJson.optional(row, "ref")?.let(MoteLink::reference) ?: CentralEvidenceReference.capture(id)
            return AssistantProof(id, AssistantJson.string(row, "quote"), ref)
        }
    }
}

internal data class AssistantCard(
    val id: String, val revision: Long, val version: String, val kind: String, val state: String,
    val title: String, val body: String, val evidence: List<AssistantProof>, val matterId: String?,
    val acceptedTaskId: String?, val readAt: String?, val feedback: List<String>, val updatedAt: String, val stale: Boolean,
) {
    val startable get() = kind == "suggestion" && state == "open" && !stale && acceptedTaskId == null
    companion object {
        fun read(row: JSONObject) = AssistantCard(
            AssistantJson.id(row), AssistantJson.revision(row), AssistantJson.string(row, "version"),
            AssistantJson.state(row, "kind", setOf("activity", "suggestion", "briefing", "artifact", "question")),
            AssistantJson.state(row, "state", setOf("open", "resolved", "stale")),
            AssistantJson.string(row, "title"), AssistantJson.string(row, "body"), AssistantJson.rows(row, "evidence", AssistantProof::read),
            AssistantJson.nullable(row, "matterId")?.also { require(MoteLink.uuidId(it) == it) },
            AssistantJson.nullable(row, "acceptedTaskId")?.also { require(MoteLink.uuidId(it) == it) },
            AssistantJson.nullable(row, "readAt")?.also { Instant.parse(it) },
            AssistantJson.rows(row, "feedback") { AssistantJson.state(it, "action", setOf("later", "ignore", "correct", "never_remind")) },
            AssistantJson.time(row, "updatedAt"), if (row.has("evidenceStale")) AssistantJson.bool(row, "evidenceStale") else false,
        )
    }
}

internal data class AssistantTask(val id: String, val revision: Long, val state: String, val workId: String?, val goal: String?, val answer: String?, val error: String?) {
    companion object {
        val states = setOf("waiting", "running", "needs_input", "completed", "failed", "cancelled", "stale", "excluded")
        fun read(value: JSONObject): AssistantTask {
            val row = value.getJSONObject("task")
            val state = AssistantJson.state(row, "state", states)
            return AssistantTask(AssistantJson.id(row), AssistantJson.revision(row), state,
                AssistantJson.optional(value, "workId")?.also { require(MoteLink.runId(it)) }, AssistantJson.optional(row, "goal"),
                if (state in setOf("stale", "cancelled")) null else value.optJSONObject("result")?.let { AssistantJson.string(it, "answer") },
                AssistantJson.optional(value, "error"))
        }
    }
}

internal data class AssistantMatterDetail(
    val id: String, val revision: Long, val goal: String, val state: String, val scope: AssistantScope,
    val tasks: List<Pair<String, String>>, val evidence: List<Pair<String, String>>, val partial: Boolean,
) {
    companion object {
        fun read(value: JSONObject): AssistantMatterDetail {
            val row = value.getJSONObject("matter"); val coverage = value.getJSONObject("coverage")
            return AssistantMatterDetail(AssistantJson.id(row), AssistantJson.revision(row), AssistantJson.string(row, "goal"),
                AssistantJson.state(row, "state", setOf("active", "paused", "archived")), AssistantScope(row.getJSONObject("scope")),
                AssistantJson.rows(value, "linkedTasks") { AssistantJson.id(it) to AssistantJson.state(it, "state", setOf("waiting", "running", "blocked", "succeeded", "failed", "cancelled", "stale", "skipped")) },
                AssistantJson.rows(value, "linkedEvidence") { AssistantJson.id(it) to AssistantJson.string(it, "title") },
                listOf("tasks", "evidence").map { AssistantJson.state(coverage, it, setOf("complete", "partial")) }.any { it == "partial" })
        }
    }
}

internal data class AssistantCommitmentEvent(val summary: String, val evidence: List<AssistantProof>, val occurredAt: String?, val createdAt: String, val origin: String)

internal data class AssistantCommitment(val id: String, val title: String, val status: String, val deadline: String?, val deadlineAt: String?, val dueState: String, val timeline: List<AssistantCommitmentEvent>) {
    companion object {
        fun read(row: JSONObject): AssistantCommitment {
            val deadline = if (row.get("deadline") === JSONObject.NULL) null else row.getJSONObject("deadline")
            val deadlineAt = deadline?.let { AssistantJson.nullable(it, "at")?.also(Instant::parse) }
            return AssistantCommitment(AssistantJson.id(row), AssistantJson.string(row, "title"),
                AssistantJson.state(row, "status", setOf("pending_confirmation", "confirmed", "completed", "cancelled")),
                deadline?.let { AssistantJson.string(it, "text") },
                deadlineAt,
                AssistantJson.state(row, "dueState", setOf("none", "unknown", "closed", "overdue", "upcoming")),
                AssistantJson.rows(row, "timeline") { AssistantCommitmentEvent(AssistantJson.string(it, "summary"), AssistantJson.rows(it, "evidence", AssistantProof::read),
                    AssistantJson.nullable(it, "occurredAt")?.also(Instant::parse), AssistantJson.time(it, "createdAt"), AssistantJson.state(it, "origin", setOf("proposal", "owner"))) })
        }
    }
}

internal class AssistantRoutine private constructor(val id: String, val revision: Long, val enabled: Boolean, val goal: String, val scope: AssistantScope, val nextDue: String?, private val scheduleText: String) {
    fun schedule() = JSONObject(scheduleText)
    companion object {
        fun read(row: JSONObject): AssistantRoutine {
            val schedule = row.getJSONObject("schedule"); AssistantJson.revision(schedule)
            ZoneId.of(AssistantJson.string(schedule, "timeZone"))
            val trigger = schedule.getJSONObject("trigger")
            when (AssistantJson.state(trigger, "kind", setOf("daily", "weekly", "before-event"))) {
                "before-event" -> require(AssistantJson.revision(trigger, "leadMinutes") <= 525600)
                else -> {
                    require(AssistantJson.string(trigger, "localTime").matches(Regex("([01]\\d|2[0-3]):[0-5]\\d")))
                    if (trigger.getString("kind") == "weekly") require(AssistantJson.revision(trigger, "weekday") <= 7)
                }
            }
            return AssistantRoutine(AssistantJson.id(row), AssistantJson.revision(row), AssistantJson.bool(row, "enabled"), AssistantJson.string(row, "goal"),
                AssistantScope(row.getJSONObject("scope")), AssistantJson.nullable(row, "nextDue")?.also(Instant::parse), schedule.toString())
        }
    }
}

/** The navigation host supplies these bindings when their owner HTTP transports land.
 * Arguments are the existing acceptSuggestion(request, card), matter command,
 * and detail/commitment projections. No guessed URLs or new wire envelope. */
internal interface AssistantDomainBindings {
    fun start(request: JSONObject, card: JSONObject): String
    fun matter(id: String, scope: AssistantScope): AssistantMatterDetail
    fun commitments(matterId: String, scope: AssistantScope): List<AssistantCommitment>
    fun matterCommand(command: JSONObject)
}

internal class CentralAssistant(val client: CentralClient, val scope: AssistantScope, val domain: AssistantDomainBindings? = null) {
    fun page(cursor: String? = null) = client.get("/api/assistant-cards?scope=" + scope.query() + "&limit=30" + (cursor?.let { "&cursor=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: ""))
    fun card(id: String) = AssistantCard.read(client.get("/api/assistant-cards/$id?scope=" + scope.query()))
    fun history(id: String, cursor: String? = null) = client.get("/api/assistant-cards/$id/history?scope=" + scope.query() + "&limit=30" + (cursor?.let { "&cursor=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: ""))
    fun feedback(id: String, revision: Long, action: String) = AssistantCard.read(client.post("/api/assistant-cards/$id/feedback?scope=" + scope.query(), JSONObject().put("expectedRevision", revision).put("action", action)))
    fun task(id: String) = AssistantTask.read(client.get("/api/assistant/tasks/$id?scope=" + scope.query())).also { require(it.id == id) }
    private fun routineProjection(id: String, value: JSONObject) = AssistantRoutine.read(value).also {
        require(it.id == id)
        // Rule reads carry the page scope, and a restricted page must not
        // disclose a saved rule with a wider scope than the page.
        if (!scope.unfilteredAll && !scope.same(it.scope)) throw CentralFailure(404)
    }
    fun routine(id: String) = routineProjection(id, client.get("/api/assistant/routines/$id?scope=" + scope.query()))
    fun updateRoutine(id: String, command: JSONObject) = routineProjection(id, client.post("/api/assistant/routines/$id", command))
    fun questions(workId: String) = client.get("/api/owner-questions?workId=" + java.net.URLEncoder.encode(workId, "UTF-8") + "&limit=30")
}
