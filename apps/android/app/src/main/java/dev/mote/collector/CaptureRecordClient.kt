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
    fun page(after: String, before: String, cursor: String?): JSONObject {
        val uri = Uri.parse("${config.server}/api/capture-browser").buildUpon()
            .appendQueryParameter("after", after).appendQueryParameter("before", before)
            .appendQueryParameter("source", "screen").appendQueryParameter("deviceId", deviceId).appendQueryParameter("limit", "20")
        cursor?.let { uri.appendQueryParameter("cursor", it) }
        return JSONObject(String(request(uri.toString(), false), Charsets.UTF_8))
    }
    fun detail(id: String) = JSONObject(String(request("${config.server}/api/capture-browser/${UUID.fromString(id)}", false), Charsets.UTF_8))
    fun image(id: String, thumbnail: Boolean) = request("${config.server}/api/capture-browser/${UUID.fromString(id)}/image${if (thumbnail) "?thumbnail=1" else ""}", true)
    private fun request(url: String, image: Boolean): ByteArray {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 15_000; connection.readTimeout = 30_000
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
