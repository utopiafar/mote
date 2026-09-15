package dev.mote.collector

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

internal class CaptureRecordClient(private val config: CollectorConfig, private val deviceId: String) {
    init { config.validateConnection() }
    fun page(after: String, before: String, cursor: String?, source: String = "screen"): JSONObject {
        require(source in setOf("screen", "media", "notification", "device_event", "note", "activity"))
        val uri = Uri.parse("${config.server}/api/capture-browser").buildUpon()
            .appendQueryParameter("after", after).appendQueryParameter("before", before)
            .appendQueryParameter("source", source).appendQueryParameter("deviceId", deviceId).appendQueryParameter("limit", "20")
        cursor?.let { uri.appendQueryParameter("cursor", it) }
        return JSONObject(String(request(uri.toString(), false), Charsets.UTF_8))
    }
    fun detail(id: String) = JSONObject(String(request("${config.server}/api/capture-browser/${UUID.fromString(id)}", false), Charsets.UTF_8))
    fun image(id: String, thumbnail: Boolean) = request("${config.server}/api/capture-browser/${UUID.fromString(id)}/image${if (thumbnail) "?thumbnail=1" else ""}", true, thumbnail)
    private fun request(url: String, image: Boolean, thumbnail: Boolean = false): ByteArray {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = if (thumbnail) 5_000 else 15_000; connection.readTimeout = if (thumbnail) 8_000 else 30_000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Authorization", "Bearer ${config.token}")
            val code = connection.responseCode
            check(code == 200) { when (code) { 401, 403 -> "当前连接没有查看此记录的权限，请检查连接凭据"; 404 -> "此记录已不存在，或中央节点版本尚不支持浏览"; else -> "中央记录读取失败（HTTP $code）" } }
            if (image) check(connection.contentType?.startsWith("image/") == true) { "中央节点未返回图片" }
            val limit = if (image) 16 * 1024 * 1024 else 2 * 1024 * 1024
            return connection.inputStream.use { input ->
                val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while (true) { val count = input.read(buffer); if (count < 0) break; check(output.size() + count <= limit) { "记录响应超过大小上限" }; output.write(buffer, 0, count) }
                output.toByteArray()
            }
        } finally { connection.disconnect() }
    }
}

internal object CapturePreview {
    fun hasImage(record: JSONObject): Boolean = record.optString("source", "screen") == "screen" &&
        if (record.has("hasImage")) record.optBoolean("hasImage") else
            (!record.isNull("imagePath") && record.optString("imagePath").isNotBlank() || !record.isNull("imageMime") && record.optString("imageMime").isNotBlank())
    fun mediaLabel(record: JSONObject): String {
        val media = record.optJSONObject("metadata")?.optJSONObject("media") ?: record.optJSONObject("media") ?: return "无媒体状态"
        val status = when (media.optString("status")) {
            "available" -> "媒体会话"; "disabled" -> "媒体采集未启用"; "permission_required" -> "媒体等待授权"; else -> "媒体暂不可用"
        }
        val sessions = media.optJSONArray("sessions") ?: return status
        if (sessions.length() == 0) return if (media.optString("status") == "available") "未观察到媒体会话" else status
        return (0 until sessions.length()).joinToString("\n") { index ->
            val session = sessions.getJSONObject(index)
            val playback = when (session.optString("playbackState")) {
                "playing" -> "播放中"; "paused" -> "已暂停"; "stopped" -> "已停止"; "buffering" -> "缓冲中"
                "connecting" -> "连接中"; "seeking" -> "调整进度"; "skipping" -> "切换内容"; "error" -> "播放出错"; else -> "状态未知"
            }
            val visibility = when (session.optString("appVisibility")) { "foreground" -> "前台"; "background" -> "后台"; else -> "前后台未知" }
            val type = when (session.optString("playbackType")) { "remote" -> "远程播放"; "local" -> "本机播放"; else -> "输出未知" }
            buildString {
                append("${session.optString("appName").ifBlank { session.optString("appId") }} · $playback · $visibility · $type")
                listOf("title", "artist", "album", "displaySubtitle").map { session.optString(it) }.filter(String::isNotBlank).distinct()
                    .takeIf(List<String>::isNotEmpty)?.let { append("\n${it.joinToString(" · ")}") }
            }
        }
    }
    fun ocrLabel(record: JSONObject): String = when (record.optJSONObject("ocr")?.optString("status", "unknown") ?: "unknown") {
        "pending" -> "OCR 待处理${if (record.optJSONObject("ocr")?.optString("reason") == "charging") " · 等待充电" else ""}"
        "completed" -> "OCR 已完成"
        "disabled" -> "OCR 已关闭"
        "failed" -> "OCR 失败"
        else -> "OCR 状态未知（历史记录）"
    }
    fun decode(bytes: ByteArray, maxSide: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth.toLong() * bounds.outHeight > 100_000_000) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > maxSide * 2) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }
}
