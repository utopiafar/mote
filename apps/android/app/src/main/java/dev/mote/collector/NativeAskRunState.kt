package dev.mote.collector

import org.json.JSONObject
import java.util.UUID

/** Transport identity and composer ownership; no model or retrieval decisions.
 * The pending body is the exact queue admission, so an ambiguous response can
 * be retried with the same client request id after process recreation. */
internal object NativeAskRunState {
    val active = CentralConversationMessage.active
    val terminal = CentralConversationMessage.terminal
    val statuses = CentralConversationMessage.statuses

    fun busy(state: JSONObject): Boolean =
        state.has("pending") || state.optString("runStatus") in active

    fun messageId(state: JSONObject): String =
        state.optString("messageId").takeIf { it.matches(UUID_PATTERN) }.orEmpty()

    fun currentId(state: JSONObject): String =
        state.optJSONObject("pending")?.optString("clientRequestId").orEmpty()
            .ifBlank { messageId(state) }
            .ifBlank { state.optJSONObject("activeRequest")?.optString("clientRequestId").orEmpty() }
            .ifBlank { state.optString("runId") }

    fun validate(receipt: JSONObject, admitted: JSONObject? = null, expectedClientRequestId: String? = null) {
        val value = CentralConversationMessage.read(receipt)
        if (admitted != null) {
            check(value.clientRequestId == admitted.optString("clientRequestId") &&
                value.conversationId == admitted.optString("conversationId")) {
                MoteI18n.text("请求尚未确认，可重试同一请求。")
            }
        } else if (!expectedClientRequestId.isNullOrBlank()) {
            check(value.clientRequestId == expectedClientRequestId || value.id == expectedClientRequestId) {
                MoteI18n.text("请求尚未确认，可重试同一请求。")
            }
        }
    }

    /** A missing message with a locally owned admission becomes retryable; an
     * adopted message without a local body is only readable, never recreated. */
    fun missing(state: JSONObject): Boolean {
        if (state.has("pending")) return true
        val request = state.optJSONObject("activeRequest") ?: return false
        if (messageId(state).isBlank()) return false
        state.put("pending", JSONObject(request.toString()))
        return true
    }

    fun completesCurrentDraft(state: JSONObject, id: String): Boolean {
        if (messageId(state) != id) return false
        val request = state.optJSONObject("activeRequest") ?: return false
        if (state.optString("question").trim() != request.optString("question")) return false
        val current = state.optJSONArray("attachments")
        val expected = request.optJSONArray("attachmentIds")
        val currentIds = if (current == null) emptyList() else (0 until current.length()).map { current.getJSONObject(it).getString("id") }
        val expectedIds = if (expected == null) emptyList() else (0 until expected.length()).map { expected.getString(it) }
        return currentIds == expectedIds
    }

    private val UUID_PATTERN = Regex("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}")
}
