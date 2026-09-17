package dev.mote.collector

import java.net.URI
import org.json.JSONObject

data class NsfwConfig(val enabled: Boolean = true, val threads: Int = 2,
    val timeoutMs: Long = 60000, val source: String = "auto", val customUrl: String = "",
    val policy: String = "Reject sexually explicit or pornographic visual content. Allow ordinary non-explicit content.",
    val maxTokens: Int = 256, val reviewMaxSide: Int = 512) {
    fun validate() {
        require(threads in 1..8) { MoteI18n.text("CPU 线程数为 1..8") }
        require(timeoutMs in 5000..180000) { MoteI18n.text("推理超时为 5000..180000 毫秒") }
        require(maxTokens in 32..1024 && reviewMaxSide in 256..1024) { MoteI18n.text("输出上限为 32..1024 token；图片最长边为 256..1024") }
        require(policy.isNotBlank() && policy.length <= 4000) { MoteI18n.text("审查指令须为 1..4000 字符") }
        require(source in setOf("auto", "mirror", "official", "custom")) { MoteI18n.text("未知模型下载来源") }
        if (source == "custom") {
            val uri = validateModelUrl(customUrl)
            require(uri.rawQuery == null) { MoteI18n.text("自定义来源为 HTTPS 目录，不能带查询参数") }
        }
    }
    companion object {
        fun validateModelUrl(value: String): URI = URI(value).also {
            require(it.scheme == "https" && !it.host.isNullOrBlank() && it.rawUserInfo == null && it.rawFragment == null) { MoteI18n.text("模型来源必须是完整 HTTPS URL，不能包含账号或片段") }
        }
    }
}

data class ReviewDecision(val allow: Boolean, val reason: String?, val labels: List<String>) {
    companion object {
        fun parse(value: String): ReviewDecision {
            require(value.trim().startsWith("{") && value.trim().endsWith("}")) { MoteI18n.text("审查必须返回严格 JSON 对象") }
            StrictJson.validate(value)
            val json = JSONObject(value)
            require(json.keys().asSequence().all { it in setOf("allow", "reason", "labels") }) { MoteI18n.text("未知审查字段") }
            require(json.get("allow") is Boolean) { MoteI18n.text("审查缺少 allow 布尔值") }
            val reason = if (json.has("reason")) (json.get("reason") as? String ?: error(MoteI18n.text("reason 类型错误"))).also { require(it.length <= 240) } else null
            val labels = if (json.has("labels")) {
                val items = json.getJSONArray("labels"); require(items.length() <= 12)
                List(items.length()) { (items.get(it) as? String ?: error(MoteI18n.text("label 类型错误"))).also { label -> require(label.length <= 64) } }
            } else emptyList()
            return ReviewDecision(json.getBoolean("allow"), reason, labels)
        }
    }
}
