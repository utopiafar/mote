package dev.mote.collector

import org.json.JSONObject

/** A revision-checked editor over Central projections. Pausing a matter never
 * rewrites its task receipts or the enabled state/nextDue of a rule. */
internal class AssistantMatterViewModel(val api: CentralAssistant, val matterId: String, val routineIds: List<String> = emptyList()) {
    init { require(MoteLink.uuidId(matterId) == matterId); require(routineIds.all { MoteLink.uuidId(it) == it }) }
    var detail: AssistantMatterDetail? = null; private set
    var commitments: List<AssistantCommitment> = emptyList(); private set
    var routines: List<AssistantRoutine> = emptyList(); private set
    var error: String? = null; private set
    val canEdit get() = api.domain != null && detail?.let { it.state != "archived" } == true

    private fun read() {
        clearContent()
        val domain = requireNotNull(api.domain) { MoteI18n.text("当前端尚未接入此操作。") }
        val current = domain.matter(matterId, api.scope)
        require(current.id == matterId)
        val timeline = domain.commitments(matterId, current.scope)
        val rules = if (routineIds.isEmpty()) domain.routines(matterId, current.scope) else routineIds.map(api::routine)
        detail = current; commitments = timeline; routines = rules
    }
    @Synchronized fun refresh() { error = null; try { read() } catch (failure: Exception) { clearContent(); error = failure.message ?: MoteI18n.text("操作失败") } }

    @Synchronized fun edit(expectedRevision: Long, goal: String) {
        require(goal.isNotBlank() && goal.length <= 8000)
        command(JSONObject().put("type", "edit").put("matterId", matterId).put("expectedRevision", expectedRevision).put("goal", goal.trim()))
    }
    @Synchronized fun transition(expectedRevision: Long, action: String) {
        require(action in setOf("pause", "resume", "archive"))
        command(JSONObject().put("type", action).put("matterId", matterId).put("expectedRevision", expectedRevision))
    }
    private fun command(value: JSONObject) {
        error = null
        try { requireNotNull(api.domain).matterCommand(value); read() }
        catch (failure: Exception) { recover(failure) }
    }
    /** Owner-supplied schedule edits keep the current server schema. Android
     * displays nextDue returned by Central; it never computes an occurrence. */
    @Synchronized fun updateRoutine(id: String, expectedRevision: Long, enabled: Boolean, goal: String? = null, timeZone: String? = null, trigger: JSONObject? = null) {
        val rule = routines.single { it.id == id }
        val command = JSONObject().put("expectedRevision", expectedRevision).put("enabled", enabled)
        goal?.let { require(it.isNotBlank()); command.put("goal", it.trim()) }
        timeZone?.let { command.put("timeZone", it) }; trigger?.let { command.put("trigger", JSONObject(it.toString())) }
        error = null
        try {
            CentralAssistant(api.client, rule.scope, api.domain).updateRoutine(id, command)
            read()
        } catch (failure: Exception) { recover(failure) }
    }
    private fun recover(failure: Exception) {
        clearContent()
        // Read current revision after conflict, but never replay the rejected edit.
        if (failure is CentralFailure && failure.status == 409) runCatching { read() }.onFailure { clearContent() }
        error = failure.message ?: MoteI18n.text("操作失败")
    }
    @Synchronized fun clearContent() { detail = null; commitments = emptyList(); routines = emptyList() }
}
