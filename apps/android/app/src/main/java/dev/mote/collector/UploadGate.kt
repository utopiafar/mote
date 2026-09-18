package dev.mote.collector

/** Owner-configured literal privacy rules. No topic/intent classification. */
data class UploadGateConfig(val enabled: Boolean = true, val blockedText: String = "", val failureAction: String = "hold") {
    fun rules() = blockedText.lines().map(String::trim).filter(String::isNotEmpty)
    fun validate() { require(failureAction in setOf("drop", "hold", "allow")); require(rules().size <= 100 && rules().all { it.length <= 256 }) }
}
interface VisualReviewProvider { fun review(image: ByteArray): String }
object UploadGate {
    // Reserved VLM interface; no visual model runs in this version.
    fun review(config: UploadGateConfig, recognize: () -> String): String {
        config.validate()
        if (!config.enabled || config.rules().isEmpty()) return "allow"
        return try { val text = recognize(); if (config.rules().any(text::contains)) "drop" else "allow" }
        catch (_: Exception) { config.failureAction }
    }
}
