package dev.mote.collector

import java.net.URI

data class Mask(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    init {
        require(listOf(left, top, right, bottom).all { it.isFinite() && it in 0f..1f }) { MoteI18n.text("遮罩坐标必须在 0..1") }
        require(left < right && top < bottom) { MoteI18n.text("遮罩右下坐标必须大于左上坐标") }
    }
    companion object {
        fun parse(value: String): List<Mask> = value.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.map {
            val v = it.split(',').map(String::trim).map(String::toFloat)
            require(v.size == 4) { MoteI18n.text("每行遮罩需要 left,top,right,bottom 四个坐标") }
            Mask(v[0], v[1], v[2], v[3])
        }.toList()
    }
}

object PrivacyRules {
    fun exclusions(value: String): Set<String> = value.split(',', '\n').map(String::trim).filter(String::isNotEmpty).toSet()

    /** Only explicit package rules. No implicit semantic blacklist. Unknown windows fail closed. */
    fun excludedReason(excluded: Set<String>, visiblePackages: Set<String>, trustworthy: Boolean): String? {
        if (excluded.isEmpty()) return null
        if (!trustworthy || visiblePackages.isEmpty() || visiblePackages.any { it.isBlank() }) return MoteI18n.text("无法可靠识别窗口，已暂停：排除规则要求完整应用信息")
        if (visiblePackages.any { it in excluded }) return MoteI18n.text("当前屏幕包含你排除的应用")
        return null
    }

    fun validateEndpoint(value: String, debugHttp: Boolean, isDebug: Boolean): String {
        val uri = URI(value.trim())
        require(!uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) { MoteI18n.text("请输入不含账号、参数或片段的节点 URL") }
        require(uri.path.isNullOrEmpty() || uri.path == "/") { MoteI18n.text("节点 URL 不应含路径") }
        require(uri.port == -1 || uri.port in 1..65535) { MoteI18n.text("端口必须为 1..65535") }
        val privateHost = uri.host.lowercase().let { host ->
            val octets = host.split('.').map { it.toIntOrNull() }
            val ipv4 = octets.size == 4 && octets.all { it != null && it in 0..255 }
            host == "localhost" || host == "::1" || host == "[::1]" || (ipv4 &&
                (octets[0] in setOf(127, 10) || (octets[0] == 192 && octets[1] == 168) || (octets[0] == 172 && octets[1]!! in 16..31)))
        }
        require(uri.scheme == "https" || (uri.scheme == "http" && privateHost && debugHttp && isDebug)) { MoteI18n.text("请使用 HTTPS；仅 debug APK 可显式允许私有 IP 的 HTTP") }
        return value.trim().trimEnd('/')
    }

    fun validateLocalReview(value: String) {
        if (value.isBlank()) return
        val uri = URI(value)
        require(uri.host in setOf("localhost", "127.0.0.1", "::1", "[::1]") && uri.scheme in setOf("http", "https") && uri.rawUserInfo == null && uri.rawFragment == null) {
            MoteI18n.text("本地隐私模型仅允许手机本机 loopback 地址")
        }
    }
}
