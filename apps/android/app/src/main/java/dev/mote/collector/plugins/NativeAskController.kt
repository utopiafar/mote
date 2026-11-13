package dev.mote.collector.plugins

import android.content.ContentResolver
import dev.mote.collector.CentralClient
import dev.mote.collector.CentralConversationMessage
import dev.mote.collector.CentralConversationPresentation
import dev.mote.collector.CentralDraftWrites
import dev.mote.collector.CentralStateFile
import dev.mote.collector.LatestWriter
import dev.mote.collector.NativeAnswerPresentation
import dev.mote.collector.NativeAskEvidenceScope
import dev.mote.collector.NativeAskImages
import dev.mote.collector.NativeAskRunState
import dev.mote.collector.NativeConversationQuote
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

/** Durable Ask owner for one Central origin. The controller owns the exact
 * queue admission, accepted message identity, evidence scope, private image
 * references, conversation presentation and the encrypted draft journal. For
 * Ask, every message/scope/image/conversation transition routes through here;
 * the presentation objects remain pure renderers, and CentralDraftStorage
 * remains the shared encrypted journal primitive whose Ask writer belongs to
 * the plugin. Activities only call these transitions and render the result. */
internal class NativeAskController(
    private val drafts: NativeAskDraftStorage,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    var state: JSONObject = JSONObject(); private set

    /** Read the journal after an Activity recreate. A persisted admission is
     * retryable with its original client request id; an accepted message keeps
     * its conversation and message identity for the next status poll. */
    fun restore(base: JSONObject = readDraft(), requestedConversation: String? = null): JSONObject {
        state = base
        // There is one current wire format. A journal entry that cannot be a
        // queue admission is discarded instead of being sent to another route.
        if (state.optJSONObject("pending")?.has("clientRequestId") == false) state.remove("pending")
        if (state.optJSONObject("activeRequest")?.has("clientRequestId") == false) state.remove("activeRequest")
        val pendingConversation = state.optJSONObject("pending")?.optString("conversationId").orEmpty()
            .ifBlank { state.optJSONObject("activeRequest")?.optString("conversationId").orEmpty() }
        if (pendingConversation.isNotBlank()) state.put("conversationId", pendingConversation)
        else if (state.optString("conversationId").isBlank() && !requestedConversation.isNullOrBlank() && !state.has("pending")) {
            state.put("conversationId", requestedConversation)
        }
        return state
    }

    fun readDraft(): JSONObject = drafts.read().also(NativeAskImages::recover)

    fun replace(value: JSONObject) { state = value }
    fun reset() { state = JSONObject() }
    fun persist() = drafts.submit(state)
    fun persistNow(snapshot: JSONObject = state) = drafts.writeNow(snapshot)

    fun busy(): Boolean = NativeAskRunState.busy(state)
    fun hasPending(): Boolean = state.has("pending")
    fun currentId(): String = NativeAskRunState.currentId(state)
    fun messageId(): String = NativeAskRunState.messageId(state)
    fun status(): String = state.optString("runStatus")
    fun missingRun(): Boolean = NativeAskRunState.missing(state)
    fun hasDraft(): Boolean = state.optString("question").isNotBlank() || NativeAskImages.count(state) > 0
    fun editQuestion(text: String) { state.put("question", text) }

    /** Initial main resolution may attach a conversation without discarding the
     * draft or a scope the owner selected before Ask finished loading. */
    fun attachConversation(id: String) {
        require(UUID.fromString(id).toString() == id)
        state.put("conversationId", id)
    }

    /** Draft state is scoped to exactly one conversation. Selecting another
     * conversation clears the unsent composer and accepted message identity. */
    fun selectConversation(id: String) {
        state.put("conversationId", id).put("question", "").put("attachments", JSONArray())
        clearConversationState()
    }

    fun newConversation() {
        state.remove("conversationId")
        state.put("question", "").put("attachments", JSONArray())
        clearConversationState()
    }

    /** A question sent from the conversation list starts a fresh thread while
     * keeping the images already staged for that outgoing question. */
    fun startConversation(question: String, conversationId: String? = null) {
        val attachments = state.optJSONArray("attachments")?.let { JSONArray(it.toString()) }
        val uploads = state.optJSONObject("imageUploads")?.let { JSONObject(it.toString()) }
        newConversation()
        if (!conversationId.isNullOrBlank()) attachConversation(conversationId)
        if (attachments != null && attachments.length() > 0) state.put("attachments", attachments)
        uploads?.let { state.put("imageUploads", it) }
        editQuestion(question)
    }

    private fun clearConversationState() {
        listOf(
            "runId", "runStatus", "messageId", "activeRequest", "failureDetails", "evidenceIds", "anchorEvidenceIds",
            "anchorMaterialRef", "scopeDirty", "scopeLabel", "imageUploads",
        ).forEach(state::remove)
    }

    fun beginEvidence(id: String, label: String? = null): Boolean {
        if (busy()) return false
        clearConversationState()
        if (!NativeAskEvidenceScope.select(state, id)) return false
        putScopeLabel(label)
        return true
    }

    fun beginMaterial(reference: String, label: String? = null): Boolean {
        if (busy()) return false
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
    fun validate(receipt: JSONObject, admitted: JSONObject? = null) = NativeAskRunState.validate(receipt, admitted)

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

    /** Build the one retryable queue admission for the current draft. An
     * existing uncertain admission keeps its exact identity; accepted or active
     * messages never create a second admission. */
    fun admission(text: String, timeZone: String): JSONObject? {
        state.optJSONObject("pending")?.let { return it }
        if (NativeAskRunState.busy(state)) return null
        val conversationId = state.optString("conversationId")
        if (conversationId.isBlank()) return null
        val question = text.trim()
        if (question.isBlank()) return null
        state.put("question", question)
        val scope = JSONObject().put("kind", "all").put("timeZone", timeZone)
        val body = JSONObject()
            .put("conversationId", conversationId)
            .put("clientRequestId", newId())
            .put("question", question)
            .put("scope", scope)
        val material = material()
        val anchored = state.optJSONArray("anchorEvidenceIds")
        val selected = state.optJSONArray("evidenceIds")
        if (material != null) body.put("anchorMaterialRef", material)
        else if (anchored != null && anchored.length() > 0) body.put("anchorEvidenceIds", JSONArray(anchored.toString()))
        else if (selected != null && selected.length() > 0) {
            scope.put("kind", "selection").put("evidenceIds", JSONArray(selected.toString()))
        }
        val attachments = state.optJSONArray("attachments") ?: JSONArray()
        if (attachments.length() > 0) {
            body.put("attachmentIds", JSONArray((0 until attachments.length()).map { attachments.getJSONObject(it).getString("id") }))
        }
        return body.also { state.put("pending", it) }
    }

    /** A definitive admission rejection keeps the draft editable; only an
     * ambiguous transport failure keeps the exact retry identity. */
    fun rejectedAdmission() {
        state.remove("pending")
        persist()
    }

    data class RunUpdate(val messageId: String, val status: String, val conversationId: String?, val clearDraft: Boolean)

    /** Apply the exact accepted message receipt. Completion clears only the
     * draft that produced this request, never a newer unsent question or image set. */
    fun receive(receipt: JSONObject, admitted: JSONObject? = null): RunUpdate {
        NativeAskRunState.validate(receipt, admitted)
        val value = CentralConversationMessage.read(receipt)
        admitted?.let { state.put("activeRequest", JSONObject(it.toString())) }
        state.remove("failureDetails")
        if (value.status == "failed") receipt.optJSONObject("error")?.let {
            state.put("failureDetails", JSONObject().put("requestId", value.id).put("error", it))
        }
        val clearDraft = value.status == "completed" && NativeAskRunState.completesCurrentDraft(state, value.id)
        state.remove("pending"); state.remove("scopeDirty")
        state.put("messageId", value.id).put("runStatus", value.status)
        value.runId?.let { state.put("runId", it) }
        state.put("conversationId", value.conversationId)
        if (clearDraft) state.put("question", "").put("attachments", JSONArray())
        if (value.status in NativeAskRunState.terminal) state.remove("activeRequest")
        persist()
        return RunUpdate(value.id, value.status, value.conversationId, clearDraft)
    }

    fun readTurn(turn: JSONObject): CentralConversationPresentation.Turn = CentralConversationPresentation.read(turn)
    fun formatAnswer(answer: String, citationIds: List<String>): NativeAnswerPresentation.Display = NativeAnswerPresentation.format(answer, citationIds)

    fun quoteSnapshot(original: String, question: String, citationIds: List<String>, conversationId: String, turnId: String, server: String): JSONObject =
        NativeConversationQuote.snapshot(original, question, citationIds, conversationId, turnId, server)
    fun quoteDisplay(origin: JSONObject, presentation: JSONObject?): String = NativeConversationQuote.display(origin, presentation)
    fun scopedQuote(record: JSONObject?, expectedOrigin: String): JSONObject? = NativeConversationQuote.scoped(record, expectedOrigin)
}
