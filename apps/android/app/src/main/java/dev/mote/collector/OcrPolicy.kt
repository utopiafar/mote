package dev.mote.collector

import org.json.JSONObject

/** Explicit engine selection, never a language/content classifier. Chinese also reads Latin. */
object OcrPolicy {
    val modes = listOf("chinese", "latin", "dual")
    fun validate(mode: String, overrides: String) {
        require(mode in modes) { MoteI18n.text("OCR 模式无效") }
        require(overrides.length <= 32768)
        StrictJson.validate(overrides)
        val entries = JSONObject(overrides)
        require(entries.length() <= 200)
        entries.keys().forEach { require(it.isNotBlank() && it.length <= 255 && entries.getString(it) in modes) }
    }
    fun engines(mode: String, overrides: String, appId: String?): List<String> {
        validate(mode, overrides)
        val selected = appId?.let { JSONObject(overrides).optString(it, mode) } ?: mode
        return if (selected == "dual") listOf("chinese", "latin") else listOf(selected)
    }
}
