package dev.mote.collector

import org.json.JSONObject

internal data class ConversationContextPreferences(
    val historyRatio: Double,
    val lowWatermarkRatio: Double,
    val contextWindow: Long?,
    val contextWindowSource: String,
)

internal data class ConversationPreferences(
    val multipleConversations: Boolean,
    val context: ConversationContextPreferences,
    val revision: Long,
)

/** C9 product preferences only. Android shows and saves the owner's choices;
 * the server still computes the actual request window and history target. */
internal object CentralConversationSettings {
    fun defaults() = ConversationPreferences(
        multipleConversations = false,
        context = ConversationContextPreferences(0.5, 0.5, null, "conservative"),
        revision = 0,
    )

    fun read(configuration: JSONObject): ConversationPreferences {
        val domains = configuration.optJSONArray("domains") ?: throw invalid()
        val domain = (0 until domains.length()).mapNotNull(domains::optJSONObject)
            .firstOrNull { it.optString("id") == "conversations" } ?: throw invalid()
        val effective = domain.optJSONObject("effective") ?: throw invalid()
        val revision = configuration.opt("revision") as? Number ?: throw invalid()
        return parse(effective, revision.toLong())
    }

    fun parse(value: JSONObject, revision: Long): ConversationPreferences {
        require(value.get("multipleConversations") is Boolean) { invalidMessage() }
        val context = value.optJSONObject("context") ?: throw invalid()
        val history = context.opt("historyRatio") as? Number ?: throw invalid()
        val low = context.opt("lowWatermarkRatio") as? Number ?: throw invalid()
        val source = context.optString("contextWindowSource")
        require(source == "configured" || source == "conservative") { invalidMessage() }
        val windowValue = context.opt("contextWindow")
        require(windowValue == null || windowValue == JSONObject.NULL || windowValue is Number) { invalidMessage() }
        val window = if (windowValue == null || windowValue == JSONObject.NULL) null else (windowValue as Number).toLong()
        validate(history.toDouble(), low.toDouble(), source, window)
        return ConversationPreferences(value.getBoolean("multipleConversations"),
            ConversationContextPreferences(history.toDouble(), low.toDouble(), window, source), revision)
    }

    fun validate(historyRatio: Double, lowWatermarkRatio: Double, source: String, contextWindow: Long?) {
        require(historyRatio.isFinite() && historyRatio in 0.0..1.0) { invalidMessage() }
        require(lowWatermarkRatio.isFinite() && lowWatermarkRatio >= 0.0 && lowWatermarkRatio < 1.0) { invalidMessage() }
        require(source == "configured" || source == "conservative") { invalidMessage() }
        if (source == "configured") require(contextWindow != null && contextWindow > 0 && contextWindow <= MAX_SAFE_INTEGER) { invalidMessage() }
        else require(contextWindow == null) { invalidMessage() }
    }

    fun payload(
        current: ConversationPreferences,
        multipleConversations: Boolean,
        historyRatio: Double,
        lowWatermarkRatio: Double,
        contextWindowSource: String,
        contextWindow: Long?,
    ): JSONObject {
        validate(historyRatio, lowWatermarkRatio, contextWindowSource, contextWindow)
        val context = JSONObject()
            .put("historyRatio", historyRatio)
            .put("lowWatermarkRatio", lowWatermarkRatio)
            .put("contextWindowSource", contextWindowSource)
            .put("contextWindow", contextWindow ?: JSONObject.NULL)
        return JSONObject().put("revision", current.revision)
            .put("value", JSONObject().put("multipleConversations", multipleConversations).put("context", context))
    }

    private fun invalid() = IllegalArgumentException(invalidMessage())
    private fun invalidMessage() = MoteI18n.text("配置内容无效，请检查必填项和取值范围。")
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
}
