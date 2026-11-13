package dev.mote.collector.plugins

import org.json.JSONArray
import org.json.JSONObject

/** Strict Android view of the existing owner-question contract. Replies carry
 * the exact revision and a retry-stable request ID; the host remains the one
 * authority for resuming the original task and for accepting that answer. */
data class OwnerQuestionChoice(val id: String, val label: String, val answer: String)

data class OwnerQuestionEvidence(val id: String, val quote: String, val ref: String?)

data class OwnerQuestionMessage(val role: String, val text: String)

data class OwnerQuestion(
    val id: String,
    val workId: String,
    val materialRef: String?,
    val title: String,
    val prompt: String,
    val reason: String?,
    val evidence: List<OwnerQuestionEvidence>,
    val choices: List<OwnerQuestionChoice>,
    val state: String,
    val revision: Long,
    val messages: List<OwnerQuestionMessage>,
    val outcome: String?,
)

object OwnerQuestionModel {
    private val uuid = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    private val states = setOf("open", "deferred", "answered", "closed", "obsolete")

    private fun keys(obj: JSONObject, allowed: Set<String>, path: String) {
        for (key in obj.keys()) require(key in allowed) { "$path: unknown field '$key'" }
    }
    private fun string(obj: JSONObject, name: String, path: String): String =
        obj.opt(name) as? String ?: throw IllegalArgumentException("$path.$name: string required")
    private fun optionalString(obj: JSONObject, name: String, path: String): String? =
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

    fun parse(raw: JSONObject): OwnerQuestion {
        keys(raw, setOf("id", "provider", "operationId", "workId", "materialId", "materialRef", "title", "prompt", "reason",
            "evidence", "choices", "state", "revision", "createdAt", "updatedAt", "messages", "continuationId", "outcome"), "question")
        val id = uuid(string(raw, "id", "question"), "question.id")
        val provider = raw.opt("provider") as? JSONObject ?: throw IllegalArgumentException("question.provider: object required")
        keys(provider, setOf("id", "version"), "question.provider")
        string(provider, "id", "question.provider"); string(provider, "version", "question.provider")
        string(raw, "operationId", "question")
        val workId = string(raw, "workId", "question")
        require(workId.isNotBlank() && workId.length <= 512) { "question.workId: invalid" }
        optionalString(raw, "materialId", "question")
        val materialRef = optionalString(raw, "materialRef", "question")?.also { require(it.length <= 512) { "question.materialRef: too long" } }
        val title = string(raw, "title", "question")
        require(title.length <= 500) { "question.title: too long" }
        val prompt = string(raw, "prompt", "question")
        require(prompt.length <= 6000) { "question.prompt: too long" }
        val reason = optionalString(raw, "reason", "question")?.also { require(it.length <= 2000) { "question.reason: too long" } }
        val evidenceJson = raw.opt("evidence") as? JSONArray ?: throw IllegalArgumentException("question.evidence: array required")
        require(evidenceJson.length() <= 20) { "question.evidence: too large" }
        val evidence = (0 until evidenceJson.length()).map { index ->
            val item = evidenceJson.opt(index) as? JSONObject ?: throw IllegalArgumentException("question.evidence[$index]: object required")
            keys(item, setOf("id", "quote", "offset", "ref"), "question.evidence[$index]")
            val quote = string(item, "quote", "question.evidence[$index]")
            require(quote.isNotBlank() && quote.length <= 2000) { "question.evidence[$index].quote: invalid" }
            item.opt("offset")?.let { offset ->
                val value = (offset as? Number)?.toInt() ?: throw IllegalArgumentException("question.evidence[$index].offset: number required")
                require(value >= 0) { "question.evidence[$index].offset: invalid" }
            }
            OwnerQuestionEvidence(string(item, "id", "question.evidence[$index]"), quote, optionalString(item, "ref", "question.evidence[$index]"))
        }
        val choicesJson = raw.opt("choices") as? JSONArray ?: throw IllegalArgumentException("question.choices: array required")
        require(choicesJson.length() <= 8) { "question.choices: too large" }
        val choices = (0 until choicesJson.length()).map { index ->
            val item = choicesJson.opt(index) as? JSONObject ?: throw IllegalArgumentException("question.choices[$index]: object required")
            keys(item, setOf("id", "label", "answer"), "question.choices[$index]")
            OwnerQuestionChoice(
                string(item, "id", "question.choices[$index]"),
                string(item, "label", "question.choices[$index]"),
                string(item, "answer", "question.choices[$index]"),
            )
        }
        require(choices.map { it.id }.toSet().size == choices.size) { "question.choices: duplicate id" }
        val state = string(raw, "state", "question")
        require(state in states) { "question.state: unknown" }
        val revision = positive(raw.opt("revision"), "question.revision")
        for (field in listOf("createdAt", "updatedAt")) java.time.OffsetDateTime.parse(string(raw, field, "question"))
        val messagesJson = raw.opt("messages") as? JSONArray ?: throw IllegalArgumentException("question.messages: array required")
        val messages = (0 until messagesJson.length()).map { index ->
            val item = messagesJson.opt(index) as? JSONObject ?: throw IllegalArgumentException("question.messages[$index]: object required")
            keys(item, setOf("role", "text", "createdAt"), "question.messages[$index]")
            val role = string(item, "role", "question.messages[$index]")
            require(role == "assistant" || role == "user") { "question.messages[$index].role: invalid" }
            val text = string(item, "text", "question.messages[$index]")
            require(text.length <= 6000) { "question.messages[$index].text: too long" }
            java.time.OffsetDateTime.parse(string(item, "createdAt", "question.messages[$index]"))
            OwnerQuestionMessage(role, text)
        }
        optionalString(raw, "continuationId", "question")?.also { require(it.isNotBlank() && it.length <= 512) { "question.continuationId: invalid" } }
        val outcome = optionalString(raw, "outcome", "question")?.also { require(it.length <= 6000) { "question.outcome: too long" } }
        return OwnerQuestion(id, workId, materialRef, title, prompt, reason, evidence, choices, state, revision, messages, outcome)
    }

    fun page(raw: JSONObject): Pair<List<OwnerQuestion>, String?> {
        keys(raw, setOf("items", "nextCursor"), "questions")
        val items = raw.opt("items") as? JSONArray ?: throw IllegalArgumentException("questions.items: array required")
        require(items.length() <= 100) { "questions.items: too large" }
        val next = optionalString(raw, "nextCursor", "questions")?.also { require(it.length <= 1000) { "questions.nextCursor: too long" } }
        return (0 until items.length()).map { parse(items.opt(it) as? JSONObject ?: throw IllegalArgumentException("questions.items[$it]: object required")) } to next
    }

    fun reply(requestId: String, question: OwnerQuestion, action: String, answer: String? = null, choiceId: String? = null): JSONObject {
        uuid(requestId, "reply.requestId")
        require(action in setOf("answer", "unknown", "defer")) { "reply.action: invalid" }
        if (action == "answer") {
            require((answer != null) xor (choiceId != null)) { "reply: an answer requires text or one choice" }
            answer?.let { require(it.length in 1..6000 && it.trim().isNotEmpty()) { "reply.answer: invalid" } }
            choiceId?.let { id ->
                require(question.choices.any { it.id == id }) { "reply.choiceId: no longer available" }
            }
        } else {
            require(answer == null && choiceId == null) { "reply: this action does not accept answer text or a choice" }
        }
        return JSONObject().put("requestId", requestId).put("expectedRevision", question.revision).put("action", action).also { body ->
            answer?.let { body.put("answer", it) }
            choiceId?.let { body.put("choiceId", it) }
        }
    }

    fun canReply(state: String): Boolean = state == "open" || state == "deferred"

    /** A returned state is never treated as success for the original task.
     * Only an answered/closed question stops the composer; the task still
     * resumes asynchronously and remains the source of its own result. */
    fun resolved(state: String): Boolean = state == "answered" || state == "closed"

    fun stateLabel(state: String): String = when (state) {
        "open" -> "待回答"
        "deferred" -> "稍后处理"
        "answered" -> "已回答"
        "closed" -> "已结束"
        "obsolete" -> "已失效"
        else -> state
    }
}
