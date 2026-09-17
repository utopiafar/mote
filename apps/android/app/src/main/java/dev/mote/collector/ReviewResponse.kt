package dev.mote.collector

import org.json.JSONObject

object ReviewResponse {
    fun masks(response: JSONObject): List<Mask> {
        require(response.has("allow") && response.get("allow") is Boolean) { MoteI18n.text("审查 allow 必须是布尔值") }
        if (!response.getBoolean("allow")) return emptyList()
        if (response.has("rectangles")) {
            val values = response.getJSONArray("rectangles")
            require(values.length() <= 256)
            return (0 until values.length()).map { index ->
                val item = values.getJSONObject(index)
                val x = item.getDouble("x").toFloat(); val y = item.getDouble("y").toFloat()
                Mask(x, y, x + item.getDouble("width").toFloat(), y + item.getDouble("height").toFloat())
            }
        }
        require(response.has("masks")) { MoteI18n.text("允许响应必须显式包含 rectangles 数组（无敏感区用空数组）") }
        val values = response.getJSONArray("masks")
        require(values.length() <= 256)
        return (0 until values.length()).map { index ->
            val item = values.getJSONObject(index)
            Mask(item.getDouble("left").toFloat(), item.getDouble("top").toFloat(), item.getDouble("right").toFloat(), item.getDouble("bottom").toFloat())
        }
    }
}
