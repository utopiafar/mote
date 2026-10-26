package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/** Presentation only: a discovery is an existing saved report, never a local inference. */
internal object InsightPresentation {
    fun id(value: JSONObject): String? = value.optString("runId").takeIf(::validId)
    fun validId(value: String) = value.isNotBlank() && value.length <= 128 && value.none { it.isISOControl() || it == '/' || it == '\\' }
    fun featured(items: JSONArray): JSONObject? = (0 until items.length()).asSequence().mapNotNull(items::optJSONObject)
        .firstOrNull { id(it) != null && it.optString("answer").isNotBlank() && (it.optJSONArray("citations")?.length() ?: 0) > 0 }
    fun preview(value: JSONObject, limit: Int = 125): String {
        var text = value.optString("answer")
        val citations = value.optJSONArray("citations") ?: JSONArray()
        for (i in 0 until citations.length()) citations.optJSONObject(i)?.optString("id")?.takeIf { it.isNotBlank() }?.let { text = text.replace("[$it]", "") }
        text = text.replace(Regex("\\s+"), " ").trim()
        val count = text.codePointCount(0, text.length)
        return if (count <= limit) text else text.substring(0, text.offsetByCodePoints(0, limit)) + "…"
    }
    fun title(value: JSONObject) = value.optJSONObject("artifact")?.optString("title")?.takeIf { it.isNotBlank() } ?: MoteI18n.text("个人回顾")
    fun answer(value: JSONObject): String {
        var text = value.optString("answer"); val citations = value.optJSONArray("citations") ?: JSONArray()
        for (i in 0 until citations.length()) citations.optJSONObject(i)?.optString("id")?.takeIf { it.isNotBlank() }?.let { text = text.replace("[$it]", "（" + MoteI18n.text("来源 {0}", i + 1) + "）") }
        return text
    }
    fun runLabel(status: String) = MoteI18n.text(when (status) { "running" -> "正在回顾…"; "completed" -> "报告已归档"; "cancelled" -> "回顾已取消"; else -> "回顾未完成" })
}
