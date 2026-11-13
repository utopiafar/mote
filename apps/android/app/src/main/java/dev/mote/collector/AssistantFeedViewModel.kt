package dev.mote.collector

import org.json.JSONObject
import java.util.UUID

/** Page IO runs on UiTask's worker. Persistence is supplied by CentralStateFile
 * (encrypted in the app); no card/result body is an offline disclosure cache. */
internal class AssistantFeedViewModel(
    val api: CentralAssistant,
    private val readState: () -> JSONObject,
    private val writeState: (JSONObject) -> Unit,
) {
    var cards: List<AssistantCard> = emptyList(); private set
    var tasks: Map<String, AssistantTask> = emptyMap(); private set
    var taskErrors: Map<String, String> = emptyMap(); private set
    private var cardScopes: Map<String, AssistantScope> = emptyMap()
    var nextCursor: String? = null; private set
    var error: String? = null; private set
    private val saved: JSONObject = readState().let { previous ->
        if (previous.optString("origin") == api.client.server && previous.optJSONObject("scope")?.let { api.scope.same(AssistantScope(it)) } == true) previous
        else JSONObject().put("origin", api.client.server).put("scope", api.scope.json()).put("tasks", JSONObject())
    }
    private fun persist() = writeState(JSONObject(saved.toString()))
    val canStart get() = api.domain != null
    fun scope(cardId: String) = cardScopes[cardId] ?: api.scope
    fun canStart(cardId: String) = canStart && (cards.single { it.id == cardId }.matterId == null || cardId in cardScopes)
    private fun cardApi(cardId: String) = CentralAssistant(api.client, scope(cardId), api.domain)
    val pendingCardId: String? get() = saved.optJSONObject("pending")?.getJSONObject("card")?.getString("cardId")

    @Synchronized fun refresh(more: Boolean = false) = attempt {
        val prior = if (more) cards else emptyList()
        val cursor = if (more) nextCursor ?: return@attempt else null
        // A failed current read must not leave withdrawn prose in the page.
        clearContent()
        val page = api.page(cursor)
        val incoming = AssistantJson.rows(page, "items", AssistantCard::read)
        cards = (prior + incoming).associateBy { it.id }.values.toList()
        nextCursor = AssistantJson.cursor(page)
        // A feed can browse all material while each matter keeps its saved
        // owner scope. Use that server projection for acceptance and task reads;
        // never reconstruct a scope from a card's evidence or its prose.
        api.domain?.let { domain ->
            val matters = cards.mapNotNull { it.matterId }.distinct().associateWith { id ->
                try { domain.matter(id, api.scope).scope }
                catch (failure: CentralFailure) { if (failure.status !in setOf(404, 409, 410)) throw failure; null }
            }
            cardScopes = cards.mapNotNull { card -> card.matterId?.let { matters[it] }?.let { card.id to it } }.toMap()
        }
        val links = saved.getJSONObject("tasks")
        for (card in cards) if (card.acceptedTaskId == null) links.remove(card.id) else links.put(card.id, card.acceptedTaskId)
        // Reconcile a lost response even when its card is on another page.
        // Withdrawal/staleness also retires the locally frozen owner command.
        val pending = saved.optJSONObject("pending")
        if (pending != null) {
            val reference = pending.getJSONObject("card"); val id = reference.getString("cardId")
            val current = try { cards.find { it.id == id } ?: api.card(id) } catch (failure: CentralFailure) {
                if (failure.status !in setOf(404, 410)) throw failure
                null
            }
            if (current?.acceptedTaskId != null) {
                links.put(id, current.acceptedTaskId); saved.remove("pending")
            } else if (current == null || current.stale || current.state != "open" || current.revision != reference.getLong("expectedRevision")) {
                saved.remove("pending")
                error = MoteI18n.text("操作状态已变化，请重新读取后再确认。")
            }
        }
        persist()
        val visible = mutableMapOf<String, AssistantTask>()
        val unavailable = mutableMapOf<String, String>()
        for (card in cards) card.acceptedTaskId?.let { id ->
            try { visible[card.id] = cardApi(card.id).task(id) }
            catch (failure: CentralFailure) {
                // A task accepted under a different exact scope, or withdrawn
                // independently, must not hide other readable cards.
                if (failure.status !in setOf(404, 409, 410)) throw failure
                unavailable[card.id] = MoteI18n.text("读取任务状态失败，请刷新重试。")
            }
        }
        tasks = visible; taskErrors = unavailable
    }

    /** Persist before sending. A retry after IO loss/process recreation sends
     * the exact original requestId, revision, goal and explicit scope. */
    @Synchronized fun start(cardId: String, expectedRevision: Long, goal: String): String? {
        var accepted: String? = null
        attempt {
            val links = saved.getJSONObject("tasks")
            if (links.has(cardId)) {
                val task = cardApi(cardId).task(AssistantJson.id(links, cardId))
                tasks = tasks + (cardId to task); accepted = task.id; return@attempt
            }
            val domain = requireNotNull(api.domain) { MoteI18n.text("任务服务尚未接通，暂时不能开始。") }
            val pending = saved.optJSONObject("pending") ?: run {
                val current = cards.single { it.id == cardId }
                check(current.revision == expectedRevision && current.startable && canStart(cardId)) { MoteI18n.text("操作状态已变化，请重新读取后再确认。") }
                require(goal.trim().isNotEmpty() && goal.length <= 8000)
                JSONObject().put("request", JSONObject().put("requestId", UUID.randomUUID().toString()).put("goal", goal.trim()).put("scope", scope(cardId).json()))
                    .put("card", JSONObject().put("cardId", cardId).put("expectedRevision", expectedRevision))
                    .also { saved.put("pending", it) }
            }
            check(pending.getJSONObject("card").getString("cardId") == cardId) { MoteI18n.text("结果尚未确认，请检查或重试原请求。") }
            persist()
            // Copies prevent a host adapter mutating the persisted request.
            val id = domain.start(JSONObject(pending.getJSONObject("request").toString()), JSONObject(pending.getJSONObject("card").toString()))
            require(MoteLink.uuidId(id) == id)
            links.put(cardId, id); saved.remove("pending"); persist()
            accepted = id
            // An admission receipt is not a successful/completed task.
            val requestApi = CentralAssistant(api.client, AssistantScope(pending.getJSONObject("request").getJSONObject("scope")), api.domain)
            val task = requestApi.task(id); tasks = tasks + (cardId to task)
        }
        return accepted
    }

    @Synchronized fun feedback(cardId: String, revision: Long, action: String) = attempt {
        require(action in setOf("read", "later", "ignore"))
        val updated = api.feedback(cardId, revision, action)
        require(updated.id == cardId)
        cards = cards.map { if (it.id == cardId) updated else it }
    }

    @Synchronized fun history(cardId: String, cursor: String? = null): JSONObject = api.history(cardId, cursor).also { page ->
        AssistantJson.rows(page, "items") { row ->
            AssistantJson.string(row, "version"); AssistantJson.string(row, "title"); AssistantJson.string(row, "body")
            AssistantJson.state(row, "state", setOf("open", "resolved")); AssistantJson.rows(row, "evidence", AssistantProof::read)
        }
        AssistantJson.cursor(page)
    }

    @Synchronized fun questions(task: AssistantTask): List<AssistantQuestionLink> {
        val work = task.workId ?: return emptyList()
        return AssistantJson.rows(api.questions(work), "items") { AssistantQuestionLink.read(it) }.also { rows -> require(rows.all { it.workId == work }) }
    }

    @Synchronized fun clearContent() { cards = emptyList(); tasks = emptyMap(); taskErrors = emptyMap(); cardScopes = emptyMap(); nextCursor = null }

    private inline fun attempt(work: () -> Unit) {
        error = null
        try { work() } catch (failure: Exception) {
            clearContent()
            error = failure.message ?: MoteI18n.text("操作失败")
            // A rejected stale command must be reviewed against current state;
            // an unknown network result keeps the original durable request.
            if (failure is CentralFailure && failure.status in setOf(400, 401, 403, 404, 409, 410)) {
                saved.remove("pending"); persist()
            }
        }
    }
}

/** A handoff into the existing navigation. The page never starts another
 * router, replies to a question, or authorizes an external Action. */
internal sealed interface AssistantOpen {
    val scope: AssistantScope
    data class Evidence(val ref: String, override val scope: AssistantScope) : AssistantOpen
    data class Matter(val id: String, override val scope: AssistantScope) : AssistantOpen
    data class Task(val id: String, val workId: String?, override val scope: AssistantScope) : AssistantOpen
    data class Question(val id: String, val workId: String, override val scope: AssistantScope) : AssistantOpen
}

internal data class AssistantQuestionLink(val id: String, val workId: String, val title: String, val state: String) {
    companion object {
        fun read(row: JSONObject) = AssistantQuestionLink(AssistantJson.id(row), AssistantJson.string(row, "workId").also { require(MoteLink.runId(it)) },
            AssistantJson.string(row, "title"), AssistantJson.state(row, "state", setOf("open", "deferred", "answered", "closed", "obsolete")))
    }
}
