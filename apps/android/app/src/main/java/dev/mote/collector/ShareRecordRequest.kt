package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

internal data class ShareLinkPreview(val title: String, val domain: String)

internal data class ShareRecordRequest(
    val origin: JSONObject,
    val presentation: JSONObject? = null,
    val streamUris: List<String> = emptyList(),
    val link: ShareLinkPreview? = null,
) {
    val answer get() = origin.optString("kind") == "conversation"

    fun quote(): String {
        val display = NativeConversationQuote.display(origin, presentation)
        return if (answer) display.substringAfter("\n\n") else display
    }

    companion object {
        private val urlPattern = Regex("https?://[^\\s]+")

        fun share(action: String, text: String?, title: String?, streamUris: List<String>, data: String?, app: String?): ShareRecordRequest {
            require(action in setOf(android.content.Intent.ACTION_SEND, android.content.Intent.ACTION_SEND_MULTIPLE))
            require(streamUris.size <= 10) { MoteI18n.text("最多 10 个附件") }
            val original = text.orEmpty().take(100000)
            val url = listOfNotNull(data, urlPattern.find(original)?.value).firstOrNull { candidate ->
                runCatching { URI(candidate).let { it.scheme in setOf("http", "https") && !it.host.isNullOrBlank() } }.getOrDefault(false)
            }?.take(4000)
            val origin = JSONObject().put("kind", "share").put("text", original)
            app?.let { origin.put("app", it.take(300)) }
            url?.let { origin.put("url", it) }
            val link = if (streamUris.isEmpty() && url != null) {
                val domain = URI(url).host
                val label = title?.trim().takeUnless { it.isNullOrEmpty() }
                    ?: original.replace(url, "").trim().takeIf(String::isNotEmpty)
                    ?: domain
                ShareLinkPreview(label.take(300), domain)
            } else null
            return ShareRecordRequest(origin, streamUris = streamUris, link = link)
        }

        fun answer(text: String, conversationId: String?, turnId: String?, question: String?, citations: List<String>?, quoteOrigin: String?): ShareRecordRequest {
            require(text.length <= 100000) { MoteI18n.text("文字目前最多 100000 字符。") }
            require(!conversationId.isNullOrBlank() && conversationId.length <= 200 && !turnId.isNullOrBlank() && turnId.length <= 200) {
                MoteI18n.text("请求的资源不存在或已删除。")
            }
            require(!quoteOrigin.isNullOrBlank() && question != null && citations != null && text.startsWith(question + "\n\n")) {
                MoteI18n.text("请求的资源不存在或已删除。")
            }
            val origin = JSONObject().put("kind", "conversation").put("text", text).put("conversationId", conversationId)
                .put("messageIds", JSONArray().put(turnId))
            val presentation = NativeConversationQuote.snapshot(text, question, citations, conversationId, turnId, quoteOrigin)
            return ShareRecordRequest(origin, presentation)
        }
    }
}
