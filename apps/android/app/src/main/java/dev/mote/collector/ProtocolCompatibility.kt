package dev.mote.collector

import org.json.JSONObject

data class ProtocolRange(val min: Int, val max: Int)

/** Product version names do not determine wire compatibility or authorization. */
object ProtocolCompatibility {
    const val HEADER = "X-Mote-Protocol-Version"
    const val MIN = 1
    const val MAX = 1
    val headers = mapOf(HEADER to MAX.toString())

    fun requireCompatible(value: Any?): ProtocolRange {
        // A missing field means the pre-negotiation v1 API. Explicit JSON null is invalid.
        if (value == null) return ProtocolRange(MIN, MAX)
        val range = value as? JSONObject ?: throw ConnectionFailure("response")
        if (range.keys().asSequence().toSet() != setOf("min", "max")) throw ConnectionFailure("response")
        fun version(key: String): Int {
            val number = range.opt(key) as? Number ?: throw ConnectionFailure("response")
            val value = number.toDouble()
            if (!value.isFinite() || value < 1 || value > Int.MAX_VALUE || value != value.toInt().toDouble()) throw ConnectionFailure("response")
            return value.toInt()
        }
        val min = version("min"); val max = version("max")
        if (min > max) throw ConnectionFailure("response")
        if (maxOf(min, MIN) > minOf(max, MAX)) throw ConnectionFailure("protocol_incompatible")
        return ProtocolRange(min, max)
    }
}
