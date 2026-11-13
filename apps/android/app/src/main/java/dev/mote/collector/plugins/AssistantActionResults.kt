package dev.mote.collector.plugins

import org.json.JSONArray
import org.json.JSONObject

/** Read-only projection of A11's assistant action drafts plus the live status
 * owned by the existing Todo/Action stores. A draft is never a success; only a
 * linked status can report one, and `uncertain` remains uncertain. */
sealed interface AssistantActionDraft {
    val kind: String
    val title: String
    val description: String

    data class Todo(override val title: String, override val description: String, val dueAt: String?) : AssistantActionDraft {
        override val kind: String get() = "todo.create"
    }
    data class Calendar(override val title: String, override val description: String, val uncertainty: String) : AssistantActionDraft {
        override val kind: String get() = "calendar.create"
    }
    data class Message(val conversationId: String, val conversationName: String?, val text: String) : AssistantActionDraft {
        override val kind: String get() = "message.send"
        override val title: String get() = conversationName ?: conversationId
        override val description: String get() = text
    }
}

data class AssistantActionTarget(val name: String, val target: JSONObject)

data class AssistantActionLink(
    val id: String,
    val kind: String,
    val status: String,
    val operationId: String?,
    val externalId: String?,
    val error: String?,
)

data class AssistantActionItem(
    val index: Int,
    val draft: AssistantActionDraft,
    val targets: List<AssistantActionTarget>,
    val linked: AssistantActionLink?,
)

data class AssistantActionResults(
    val taskId: String,
    val revision: Long,
    val matterId: String?,
    val drafts: List<AssistantActionItem>,
)

object AssistantActionResultsReader {
    private val uuid = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    private val statuses = setOf("proposed", "dismissed", "approved", "executing", "succeeded", "uncertain", "stale", "open", "completed", "cancelled")

    private fun keys(obj: JSONObject, allowed: Set<String>, path: String) {
        for (key in obj.keys()) require(key in allowed) { "$path: unknown field '$key'" }
    }
    private fun string(obj: JSONObject, name: String, path: String): String =
        obj.opt(name) as? String ?: throw IllegalArgumentException("$path.$name: string required")
    private fun optionalString(obj: JSONObject, name: String, path: String): String? =
        if (!obj.has(name) || obj.isNull(name)) null else string(obj, name, path)
    private fun nullableDate(obj: JSONObject, name: String, path: String): String? =
        if (!obj.has(name) || obj.isNull(name)) null else string(obj, name, path)
    private fun uuid(value: String, path: String): String {
        require(uuid.matches(value)) { "$path: invalid" }
        return value.lowercase()
    }
    private fun positive(value: Any?, path: String): Long {
        val raw = value as? Number ?: throw IllegalArgumentException("$path: number required")
        val number = raw.toLong()
        require(raw.toDouble() == number.toDouble() && number > 0 && number <= 9007199254740991L) { "$path: positive integer required" }
        return number
    }
    private fun index(value: Any?, path: String): Int {
        val raw = value as? Number ?: throw IllegalArgumentException("$path: number required")
        val number = raw.toInt()
        require(raw.toDouble() == number.toDouble() && number in 0..7) { "$path: index required" }
        return number
    }
    private fun evidence(value: JSONArray, path: String) {
        require(value.length() in 1..20) { "$path: invalid" }
        for (index in 0 until value.length()) {
            val item = value.opt(index) as? JSONObject ?: throw IllegalArgumentException("$path[$index]: object required")
            keys(item, setOf("id", "quote"), "$path[$index]")
            uuid(string(item, "id", "$path[$index]"), "$path[$index].id")
            require(string(item, "quote", "$path[$index]").isNotBlank()) { "$path[$index].quote: blank" }
        }
    }
    private fun readDraft(value: JSONObject, path: String): AssistantActionDraft {
        keys(value, setOf("kind", "todo", "event", "message", "uncertainty", "evidence"), path)
        return when (val kind = string(value, "kind", path)) {
            "todo.create" -> {
                keys(value, setOf("kind", "todo", "evidence"), path)
                val todo = value.opt("todo") as? JSONObject ?: throw IllegalArgumentException("$path.todo: object required")
                keys(todo, setOf("title", "description", "dueAt"), "$path.todo")
                evidence(value.opt("evidence") as? JSONArray ?: throw IllegalArgumentException("$path.evidence: array required"), "$path.evidence")
                AssistantActionDraft.Todo(
                    string(todo, "title", "$path.todo"),
                    string(todo, "description", "$path.todo"),
                    nullableDate(todo, "dueAt", "$path.todo"),
                )
            }
            "calendar.create" -> {
                keys(value, setOf("kind", "event", "uncertainty", "evidence"), path)
                val event = value.opt("event") as? JSONObject ?: throw IllegalArgumentException("$path.event: object required")
                keys(event, setOf("title", "start", "end", "timeZone", "allDay", "location", "description"), "$path.event")
                require(event.opt("allDay") is Boolean) { "$path.event.allDay: boolean required" }
                evidence(value.opt("evidence") as? JSONArray ?: throw IllegalArgumentException("$path.evidence: array required"), "$path.evidence")
                AssistantActionDraft.Calendar(
                    string(event, "title", "$path.event"),
                    string(event, "description", "$path.event"),
                    string(value, "uncertainty", path),
                )
            }
            "message.send" -> {
                keys(value, setOf("kind", "message", "evidence"), path)
                val message = value.opt("message") as? JSONObject ?: throw IllegalArgumentException("$path.message: object required")
                keys(message, setOf("conversationId", "conversationName", "text"), "$path.message")
                evidence(value.opt("evidence") as? JSONArray ?: throw IllegalArgumentException("$path.evidence: array required"), "$path.evidence")
                AssistantActionDraft.Message(
                    string(message, "conversationId", "$path.message"),
                    optionalString(message, "conversationName", "$path.message"),
                    string(message, "text", "$path.message"),
                )
            }
            else -> throw IllegalArgumentException("$path.kind: unknown draft kind")
        }
    }
    private fun readTarget(value: JSONObject, path: String): AssistantActionTarget {
        keys(value, setOf("name", "target"), path)
        val name = string(value, "name", path)
        val target = value.opt("target") as? JSONObject ?: throw IllegalArgumentException("$path.target: object required")
        if (target.optString("executionLocation") == "central-connector") {
            keys(target, setOf("executionLocation", "packageId", "instanceId", "instanceRevision", "capabilityId", "capabilityVersion", "calendarId"), "$path.target")
            require(string(target, "executionLocation", "$path.target") == "central-connector") { "$path.target.executionLocation: invalid" }
            string(target, "packageId", "$path.target"); string(target, "instanceId", "$path.target")
            string(target, "capabilityId", "$path.target")
            positive(target.opt("instanceRevision"), "$path.target.instanceRevision")
            positive(target.opt("capabilityVersion"), "$path.target.capabilityVersion")
            optionalString(target, "calendarId", "$path.target")
        } else {
            keys(target, setOf("deviceId", "calendarId"), "$path.target")
            string(target, "deviceId", "$path.target"); string(target, "calendarId", "$path.target")
        }
        return AssistantActionTarget(name, target)
    }
    private fun readLink(value: JSONObject, draftKind: String, path: String): AssistantActionLink {
        keys(value, setOf("id", "kind", "status", "operationId", "externalId", "error"), path)
        val kind = string(value, "kind", path)
        require(kind == draftKind) { "$path.kind: does not match its draft" }
        val status = string(value, "status", path)
        require(status in statuses) { "$path.status: unknown status" }
        return AssistantActionLink(
            uuid(string(value, "id", path), "$path.id"),
            kind,
            status,
            optionalString(value, "operationId", path),
            optionalString(value, "externalId", path),
            optionalString(value, "error", path),
        )
    }

    fun read(raw: JSONObject): AssistantActionResults {
        keys(raw, setOf("taskId", "revision", "matterId", "drafts"), "actions")
        val taskId = uuid(string(raw, "taskId", "actions"), "actions.taskId")
        val revision = positive(raw.opt("revision"), "actions.revision")
        val matterId = optionalString(raw, "matterId", "actions")?.let { uuid(it, "actions.matterId") }
        val drafts = raw.opt("drafts") as? JSONArray ?: throw IllegalArgumentException("actions.drafts: array required")
        require(drafts.length() <= 8) { "actions.drafts: too large" }
        val items = (0 until drafts.length()).map { index ->
            val item = drafts.opt(index) as? JSONObject ?: throw IllegalArgumentException("actions.drafts[$index]: object required")
            keys(item, setOf("index", "draft", "targets", "linked"), "actions.drafts[$index]")
            val position = index(item.opt("index"), "actions.drafts[$index].index")
            val draft = readDraft(item.opt("draft") as? JSONObject ?: throw IllegalArgumentException("actions.drafts[$index].draft: object required"), "actions.drafts[$index].draft")
            val targets = item.opt("targets") as? JSONArray ?: throw IllegalArgumentException("actions.drafts[$index].targets: array required")
            require(targets.length() <= 128) { "actions.drafts[$index].targets: too large" }
            val targetItems = (0 until targets.length()).map { targetIndex ->
                readTarget(targets.opt(targetIndex) as? JSONObject ?: throw IllegalArgumentException("actions.drafts[$index].targets[$targetIndex]: object required"), "actions.drafts[$index].targets[$targetIndex]")
            }
            val linked = if (!item.has("linked")) null else readLink(item.opt("linked") as? JSONObject ?: throw IllegalArgumentException("actions.drafts[$index].linked: object required"), draft.kind, "actions.drafts[$index].linked")
            AssistantActionItem(position, draft, targetItems, linked)
        }
        require(items.map { it.index }.toSet().size == items.size) { "actions.drafts: duplicate index" }
        return AssistantActionResults(taskId, revision, matterId, items)
    }

    /** `/api/assistant/matters/:id/actions` returns one result per task tied to
     * the matter; it is not a different action schema. */
    fun readPage(raw: JSONObject): List<AssistantActionResults> {
        keys(raw, setOf("items"), "actions")
        val items = raw.opt("items") as? JSONArray ?: throw IllegalArgumentException("actions.items: array required")
        require(items.length() <= 200) { "actions.items: too large" }
        return (0 until items.length()).map { index ->
            read(items.opt(index) as? JSONObject ?: throw IllegalArgumentException("actions.items[$index]: object required"))
        }
    }

    /** Only an acknowledged external receipt is success. An uncertain result
     * is a separate fact and never falls through to a completed label. */
    fun isSuccess(status: String): Boolean = status == "succeeded" || status == "completed"

    fun statusLabel(status: String): String = when (status) {
        "succeeded", "completed" -> "已完成"
        "uncertain" -> "保存结果待核实"
        "executing" -> "正在写入 / 等待回执"
        "approved" -> "等待客户端写入"
        "stale" -> "原文已更新或删除"
        "dismissed" -> "已忽略"
        "cancelled" -> "已取消"
        "open" -> "未完成"
        else -> "待确认"
    }
}
