package dev.mote.collector.plugins

import dev.mote.collector.CentralConversationPresentation
import dev.mote.collector.CentralClient
import dev.mote.collector.CentralDraftWrites
import dev.mote.collector.CentralStateFile
import dev.mote.collector.LatestWriter
import dev.mote.collector.NativeAnswerPresentation
import dev.mote.collector.NativeAskEvidenceScope
import dev.mote.collector.NativeAskImages
import dev.mote.collector.NativeAskRunState
import dev.mote.collector.NativeConversationQuote
import android.content.ContentResolver
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/** One encrypted journal per Central origin. The plugin owns the serialized
 * writer; screens only submit the state they just changed. */
internal class NativeAskDraftStorage(private val store: CentralStateFile) {
    private val failure = AtomicReference<Throwable?>(null)
    private val writer = LatestWriter<JSONObject>(CentralDraftWrites.executor) {
        runCatching { store.write(it) }.onSuccess { failure.set(null) }.onFailure(failure::set)
    }

    fun read(): JSONObject = CentralDraftWrites.barrier { readDirect() }
    internal fun readDirect(): JSONObject = failure.get()?.let { throw it } ?: store.read()
    fun submit(state: JSONObject) = writer.submit(JSONObject(state.toString()))
    fun writeNow(snapshot: JSONObject) = CentralDraftWrites.barrier { writeDirect(snapshot) }
    internal fun writeDirect(snapshot: JSONObject) {
        store.write(JSONObject(snapshot.toString()))
        failure.set(null)
    }
}

/** Durable Ask owner for one Central origin. The controller owns the run
 * ticket, evidence scope, private image references, conversation presentation
 * and the encrypted draft journal. For Ask, every run/scope/image/conversation
 * transition routes through here; the three presentation objects remain pure
 * shared renderers for non-Ask readers, and CentralDraftStorage remains the
 * shared encrypted journal primitive whose Ask writer belongs to the plugin.
 * Activities only call these transitions and render the result. */
internal class NativeAskController(
    private val drafts: NativeAskDraftStorage,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    var state: JSONObject = JSONObject(); private set

    /** Read the journal after an Activity recreate, fence late image uploads and
     * adopt the one running task for this conversation. An adopted task has no
     * local request body, so it is never re-submitted. */
    fun restore(remoteRuns: JSONArray?, requestedConversation: String? = null, base: JSONObject = readDraft()): JSONObject {
        state = base
        adoptRunning(remoteRuns ?: JSONArray(), requestedConversation)
        return state
    }

    fun adoptRunning(remoteRuns: JSONArray, requestedConversation: String? = null, target: JSONObject = state) {
        if (target.has("runId") || target.has("pending")) return
        val selected = requestedConversation ?: target.optString("conversationId").takeIf { it.isNotBlank() }
        val recent = (0 until remoteRuns.length()).mapNotNull(remoteRuns::optJSONObject)
            .firstOrNull { it.optString("status") == "running" && (selected == null || it.optString("conversationId") == selected) }
        recent?.let {
            target.put("runId", it.getString("id")).put("runStatus", "running")
            it.optString("conversationId").takeIf(String::isNotBlank)?.let { id -> target.put("conversationId", id) }
        }
    }

    fun readDraft(): JSONObject = drafts.read().also(NativeAskImages::recover)

    fun replace(value: JSONObject) { state = value }
    fun reset() { state = JSONObject() }
    fun persist() = drafts.submit(state)
    fun persistNow(snapshot: JSONObject = state) = drafts.writeNow(snapshot)

    fun busy(): Boolean = state.has("pending") || state.optString("runStatus") == "running"
    fun hasPending(): Boolean = state.has("pending")
    fun currentId(): String = NativeAskRunState.currentId(state)
    fun missingRun(): Boolean = NativeAskRunState.missing(state)
    fun hasDraft(): Boolean = state.optString("question").isNotBlank() || NativeAskImages.count(state) > 0
    fun editQuestion(text: String) { state.put("question", text) }

    /** Draft state is scoped to exactly one conversation. Selecting another
     * conversation clears the unsent composer and accepted run identity instead
     * of carrying either into the new conversation. */
    fun selectConversation(id: String) {
        state.put("conversationId", id).put("question", "").put("attachments", JSONArray())
        clearConversationState()
    }

    fun newConversation() {
        state.remove("conversationId")
        state.put("question", "").put("attachments", JSONArray())
        clearConversationState()
    }

    private fun clearConversationState() {
        listOf(
            "runId", "runStatus", "activeRequest", "failureDetails", "evidenceIds", "anchorEvidenceIds",
            "anchorMaterialRef", "scopeDirty", "scopeLabel", "imageUploads",
        ).forEach(state::remove)
    }

    fun beginEvidence(id: String, label: String? = null): Boolean {
        if (busy()) return false
        state.remove("conversationId")
        clearConversationState()
        if (!NativeAskEvidenceScope.select(state, id)) return false
        putScopeLabel(label)
        return true
    }

    fun beginMaterial(reference: String, label: String? = null): Boolean {
        if (busy()) return false
        state.remove("conversationId")
        clearConversationState()
        if (!NativeAskEvidenceScope.selectMaterial(state, reference)) return false
        putScopeLabel(label)
        return true
    }

    fun selectEvidence(id: String, only: Boolean = false, label: String? = null): Boolean {
        val accepted = if (only) NativeAskEvidenceScope.selectOnly(state, id) else NativeAskEvidenceScope.select(state, id)
        if (accepted) putScopeLabel(label) else return false
        return true
    }

    fun selectMaterial(reference: String, label: String? = null): Boolean {
        if (!NativeAskEvidenceScope.selectMaterial(state, reference)) return false
        putScopeLabel(label)
        return true
    }

    fun clearScope(): Boolean = NativeAskEvidenceScope.clear(state)
    fun scopeLabel(): String? = state.optString("scopeLabel").takeIf(String::isNotBlank)
    /** Restored material scopes carry only the immutable ref; the screen resolves
     * its readable title from the same Central origin before showing the chip. */
    fun scopeLabel(value: String?) {
        if (material() != null) putScopeLabel(value)
    }
    private fun putScopeLabel(label: String?) {
        if (label.isNullOrBlank()) state.remove("scopeLabel") else state.put("scopeLabel", label)
    }
    fun material(): String? = NativeAskEvidenceScope.material(state)
    fun material(value: JSONObject): String? = NativeAskEvidenceScope.material(value)
    fun writeScope(input: JSONObject) = NativeAskEvidenceScope.writeInput(state, input)
    fun restoreScope(conversation: JSONObject) = NativeAskEvidenceScope.restore(state, conversation)
    fun validate(run: JSONObject, expected: String) = NativeAskRunState.validate(run, expected)

    fun pendingImages(): JSONArray = NativeAskImages.pending(state)
    fun imageCount(): Int = NativeAskImages.count(state)
    fun stageImageReferences(references: List<String>): List<JSONObject> = NativeAskImages.stageReferences(state, references)
    fun removeImage(id: String) = NativeAskImages.remove(state, id)
    fun mergeImage(result: JSONObject) = NativeAskImages.merge(state, result)
    fun uploadImage(
        resolver: ContentResolver,
        selection: JSONObject,
        client: CentralClient,
        directory: File,
        deviceId: String,
        resolveTime: (String) -> Long,
        progress: (Int, Int) -> Unit,
    ): JSONObject = NativeAskImages.upload(resolver, selection, client, directory, deviceId, resolveTime, progress)

    fun removeAttachment(id: String) {
        val attachments = state.optJSONArray("attachments") ?: JSONArray()
        state.put("attachments", JSONArray((0 until attachments.length()).map(attachments::getJSONObject).filter { it.getString("id") != id }))
    }

    fun clearImageReferences() {
        CentralDraftWrites.executor.execute {
            runCatching {
                val saved = drafts.readDirect()
                NativeAskImages.clearReferences(saved)
                drafts.writeDirect(saved)
            }
        }
    }

    /** Build the one retryable admission body for the current draft. An
     * existing uncertain admission keeps its exact identity. */
    fun admission(text: String, timeZone: String): JSONObject? {
        state.optJSONObject("pending")?.let { return it }
        if (state.optString("runStatus") == "running") return null
        val question = text.trim()
        if (question.isBlank()) return null
        state.put("question", question)
        val input = JSONObject().put("question", question).put("timeZone", timeZone)
        NativeAskEvidenceScope.writeInput(state, input)
        state.optString("modelProfileId").takeIf { it.isNotBlank() }?.let { input.put("modelProfileId", it) }
        state.optString("modelOverride").trim().takeIf { it.isNotBlank() }?.let { input.put("modelOverride", it) }
        state.optString("conversationId").takeIf { it.isNotBlank() }?.let { input.put("conversationId", it) }
        val attachments = state.optJSONArray("attachments") ?: JSONArray()
        if (attachments.length() > 0) input.put("attachmentIds", JSONArray((0 until attachments.length()).map { attachments.getJSONObject(it).getString("id") }))
        return JSONObject().put("id", newId()).put("input", input).also { state.put("pending", it) }
    }

    fun materialRejected() {
        state.remove("pending")
        persist()
    }

    data class RunUpdate(val runId: String, val status: String, val conversationId: String?, val clearDraft: Boolean)

    /** Apply the exact accepted run receipt. Completion clears only the draft
     * that produced this request, never a newer unsent question or image set. */
    fun receive(run: JSONObject, expected: String = currentId(), admitted: JSONObject? = null): RunUpdate {
        NativeAskRunState.validate(run, expected)
        admitted?.let { state.put("activeRequest", JSONObject(it.toString())) }
        state.remove("failureDetails")
        if (run.optString("status") == "failed") run.optJSONObject("error")?.let {
            state.put("failureDetails", JSONObject().put("requestId", run.getString("id")).put("error", it))
        }
        val clearDraft = run.optString("status") == "completed" && NativeAskRunState.completesCurrentDraft(state, run.getString("id"))
        state.remove("pending"); state.remove("scopeDirty")
        state.put("runId", run.getString("id")).put("runStatus", run.getString("status"))
        val conversationId = run.optString("conversationId").takeIf(String::isNotBlank)
        conversationId?.let { state.put("conversationId", it) }
        if (clearDraft) state.put("question", "").put("attachments", JSONArray())
        if (run.getString("status") in NativeAskRunState.terminal) state.remove("activeRequest")
        persist()
        return RunUpdate(run.getString("id"), run.getString("status"), conversationId, clearDraft)
    }

    fun readTurn(turn: JSONObject): CentralConversationPresentation.Turn = CentralConversationPresentation.read(turn)
    fun formatAnswer(answer: String, citationIds: List<String>): NativeAnswerPresentation.Display = NativeAnswerPresentation.format(answer, citationIds)

    fun quoteSnapshot(original: String, question: String, citationIds: List<String>, conversationId: String, turnId: String, server: String): JSONObject =
        NativeConversationQuote.snapshot(original, question, citationIds, conversationId, turnId, server)
    fun quoteDisplay(origin: JSONObject, presentation: JSONObject?): String = NativeConversationQuote.display(origin, presentation)
    fun scopedQuote(record: JSONObject?, expectedOrigin: String): JSONObject? = NativeConversationQuote.scoped(record, expectedOrigin)
}
