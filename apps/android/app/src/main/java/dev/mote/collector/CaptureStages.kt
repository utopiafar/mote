package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64
import java.util.UUID

/** Images travel beside events so stages cannot accidentally put their bytes in event JSON. */
data class StageCapture(val event: JSONObject, val image: ByteArray?) {
    fun copy() = StageCapture(JSONObject(event.toString()), image?.copyOf())
}

data class StageResult(
    val outputs: List<StageCapture>,
    val checkpoint: JSONObject? = null,
    /** Captures owned by this stage until a later input or explicit flush releases them. */
    val held: List<StageCapture> = emptyList()
)

interface CaptureStage {
    // Stages own the semantics of their transformations, including preservation of
    // privacy metadata. The queue validates each output's source-specific wire shape;
    // it must not apply one input's collection level to unrelated outputs in a batch.
    val id: String
    val version: Int
    /** Canonical configuration is part of the durable stage identity. */
    val configuration: JSONObject get() = JSONObject()
    fun consume(
        inputs: List<StageCapture>,
        checkpoint: JSONObject?,
        held: List<StageCapture>,
        flush: Boolean,
        deriveId: (memberIds: List<String>, key: String) -> String
    ): StageResult
}

data class CapturePipelineResult(val outputs: List<StageCapture>, val checkpoint: JSONObject, val heldCount: Int)

/** The host persists opaque stage state in the same transaction as resulting outbox entries. */
class CaptureStageRegistry(stages: List<CaptureStage> = emptyList()) {
    private val steps = mutableListOf<CaptureStage>()
    init { stages.forEach(::register) }
    fun register(stage: CaptureStage): CaptureStageRegistry {
        require(stage.id.matches(Regex("[a-z][a-z0-9-]{0,63}")) && stage.version > 0 && steps.none { it.id == stage.id }) { "Invalid or duplicate capture stage" }
        steps += stage
        return this
    }
    fun versions(): List<Pair<String, Int>> = steps.map { it.id to it.version }

    /** A changed pipeline may reset only when no stage still owns unsent captures. */
    fun run(inputs: List<StageCapture>, committed: JSONObject?, flush: Boolean = false): CapturePipelineResult {
        val configured = steps.map { it to SourceRules.hash(SourceRules.canonical(it.configuration)) }
        val currentOrder = JSONArray(configured.map { (stage, configurationHash) -> "${stage.id}@${stage.version}:$configurationHash" })
        val oldOrder = committed?.optJSONArray("order")
        val sameOrder = oldOrder != null && oldOrder.toString() == currentOrder.toString()
        if (committed != null && !sameOrder) {
            check((committed.optJSONArray("stages") ?: JSONArray()).let { rows ->
                (0 until rows.length()).all { rows.getJSONObject(it).optJSONArray("held")?.length() == 0 }
            }) { "Capture stage version or order changed while captures are held" }
        }
        val previousStages = if (sameOrder) committed!!.optJSONArray("stages") ?: JSONArray() else JSONArray()
        var values = inputs.map(StageCapture::copy)
        val nextStages = JSONArray()
        var heldCount = 0
        for ((index, configuredStage) in configured.withIndex()) {
            val (stage, configurationHash) = configuredStage
            val previous = previousStages.optJSONObject(index)
            val held = decodeHeld(previous?.optJSONArray("held"))
            val result = stage.consume(values, previous?.optJSONObject("value")?.let { JSONObject(it.toString()) }, held, flush) { memberIds, key ->
                require(memberIds.isNotEmpty() && key.isNotBlank() && key.length <= 200)
                memberIds.forEach { UUID.fromString(it) }
                UUID.nameUUIDFromBytes("${stage.id}@${stage.version}:$configurationHash\u0000$key\u0000${memberIds.joinToString("\u0000")}".toByteArray(Charsets.UTF_8)).toString()
            }
            require(result.outputs.size <= 500 && result.held.size <= 500) { "Capture stage output limit exceeded" }
            heldCount += result.held.size
            values = result.outputs.map(StageCapture::copy)
            nextStages.put(JSONObject().put("id", stage.id).put("version", stage.version)
                .put("value", result.checkpoint ?: JSONObject.NULL).put("held", encodeHeld(result.held)))
        }
        val next = JSONObject().put("order", currentOrder).put("stages", nextStages)
        return CapturePipelineResult(values, next, heldCount)
    }

    private fun encodeHeld(captures: List<StageCapture>) = JSONArray(captures.map { capture ->
        JSONObject().put("event", capture.event).put("image", capture.image?.let { Base64.getEncoder().encodeToString(it) } ?: JSONObject.NULL)
    })
    private fun decodeHeld(value: JSONArray?): List<StageCapture> = if (value == null) emptyList() else (0 until value.length()).map { index ->
        val row = value.getJSONObject(index)
        StageCapture(JSONObject(row.getJSONObject("event").toString()), if (row.isNull("image")) null else Base64.getDecoder().decode(row.getString("image")))
    }
}

object CaptureStages {
    val default = CaptureStageRegistry().register(object : CaptureStage {
        override val id = "state-series"
        override val version = 1
        override fun consume(inputs: List<StageCapture>, checkpoint: JSONObject?, held: List<StageCapture>, flush: Boolean,
                             deriveId: (List<String>, String) -> String): StageResult {
            check(held.isEmpty())
            var previous = checkpoint?.optJSONObject("previous")
            val outputs = inputs.map { input ->
                val next = StateSeries.extend(previous, input.event)
                previous = next
                StageCapture(next, input.image)
            }
            return StageResult(outputs, previous?.let { JSONObject().put("previous", it) })
        }
    })
}
