package dev.mote.collector

import org.json.JSONObject
import java.util.UUID

/** The C2/C6 product message receipt from Central. Android renders the exact
 * server state; it never derives accepted, queued or terminal status itself. */
internal object CentralConversationMessage {
    val active = setOf("accepted", "queued", "running")
    val terminal = setOf("completed", "failed", "cancelled")
    val statuses = active + terminal

    data class Receipt(
        val id: String,
        val conversationId: String,
        val clientRequestId: String,
        val status: String,
        val seq: Int,
        val revision: Int,
        val runId: String?,
    )

    fun read(value: JSONObject): Receipt {
        val id = uuid(value.getString("id"))
        val conversationId = uuid(value.getString("conversationId"))
        val clientRequestId = uuid(value.getString("clientRequestId"))
        val status = value.getString("status")
        require(status in statuses) { MoteI18n.text("中央响应格式无效，请刷新后重试。") }
        require(value.get("seq") is Number && value.getInt("seq") >= 0) { MoteI18n.text("中央响应格式无效，请刷新后重试。") }
        require(value.get("revision") is Number && value.getInt("revision") >= 1) { MoteI18n.text("中央响应格式无效，请刷新后重试。") }
        return Receipt(id, conversationId, clientRequestId, status, value.getInt("seq"), value.getInt("revision"),
            value.optString("runId").takeIf(String::isNotBlank))
    }

    /** A conversation page turn carries the same accepted identity. Revision
     * comes from the turn version; legacy turns without a request id are not
     * eligible to reconcile a local admission. */
    fun fromTurn(turn: JSONObject, conversationId: String): JSONObject? {
        if (turn.optString("clientRequestId").isBlank()) return null
        return JSONObject(turn.toString()).put("conversationId", conversationId)
            .put("revision", turn.optInt("version", 1))
    }

    fun statusLabel(status: String): String? = when (status) {
        "accepted" -> MoteI18n.text("已收到")
        "queued" -> MoteI18n.text("排队中")
        "running" -> MoteI18n.text("中央正在回答…")
        "failed" -> MoteI18n.text("回答未完成")
        "cancelled" -> MoteI18n.text("已停止回答")
        "completed" -> MoteI18n.text("回答已完成")
        else -> null
    }

    private fun uuid(value: String): String {
        require(UUID.fromString(value).toString() == value) { MoteI18n.text("中央响应格式无效，请刷新后重试。") }
        return value
    }
}
