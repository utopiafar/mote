package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.UUID

class CaptureStageDurabilityTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }
    private fun note(text: String, redacted: Boolean = false) = JSONObject().put("id", UUID.randomUUID().toString())
        .put("capturedAt", "2026-09-24T00:00:00Z").put("platform", "android").put("durationMs", 0)
        .put("source", "note").put("ocrText", text)
        .put("privacy", JSONObject().put("excluded", false).put("redacted", redacted).put("mode", "none"))

    private class SplitStage(private val configKey: String = "default") : CaptureStage {
        override val id = "split-fixture"
        override val version = 1
        override val configuration = JSONObject().put("configKey", configKey)
        override fun consume(inputs: List<StageCapture>, checkpoint: JSONObject?, held: List<StageCapture>, flush: Boolean,
                             deriveId: (List<String>, String) -> String): StageResult = StageResult(inputs.flatMap { input ->
            listOf("a", "b").map { key -> StageCapture(JSONObject(input.event.toString())
                .put("id", deriveId(listOf(input.event.getString("id")), key))
                .put("ocrText", input.event.getString("ocrText") + key), null) }
        })
    }

    private class PairStage(override val version: Int = 1) : CaptureStage {
        override val id = "pair-fixture"
        override fun consume(inputs: List<StageCapture>, checkpoint: JSONObject?, held: List<StageCapture>, flush: Boolean,
                             deriveId: (List<String>, String) -> String): StageResult {
            val pending = (held + inputs).toMutableList()
            val output = mutableListOf<StageCapture>()
            while (pending.size >= 2) {
                val a = pending.removeAt(0); val b = pending.removeAt(0)
                val privacy = JSONObject(b.event.getJSONObject("privacy").toString())
                if (a.event.getJSONObject("privacy").optBoolean("redacted")) privacy.put("redacted", true)
                output += StageCapture(JSONObject(b.event.toString()).put("id", deriveId(listOf(a.event.getString("id"), b.event.getString("id")), "pair"))
                    .put("ocrText", a.event.getString("ocrText") + "+" + b.event.getString("ocrText")).put("privacy", privacy), null)
            }
            if (flush && pending.isNotEmpty()) output += pending.removeAt(0)
            return StageResult(output, held = pending)
        }
    }

    @Test fun `one capture can commit two deterministic output records`() {
        val dir = folder.newFolder(); val stages = CaptureStageRegistry(listOf(SplitStage()))
        val original = note("generated-")
        val first = DurableQueue(dir, cipher, captureStages = stages)
        first.enqueue(original, null, 1_000_000)
        assertEquals(2, first.depth())
        val ids = first.syncIds().toSet()
        assertTrue(ids.all { it != original.getString("id") })
        assertEquals(setOf("generated-a", "generated-b"), first.peekBatch().map { it.getString("ocrText") }.toSet())
        val restarted = DurableQueue(dir, cipher, captureStages = stages)
        restarted.enqueue(original, null, 1_000_000)
        assertEquals(ids, restarted.syncIds().toSet())
    }

    @Test fun `changing stage configuration changes derived output IDs`() {
        val input = StageCapture(note("generated config"), null)
        val first = CaptureStageRegistry(listOf(SplitStage("a"))).run(listOf(input), null)
        val second = CaptureStageRegistry(listOf(SplitStage("b"))).run(listOf(input), null)
        assertTrue(first.outputs.map { it.event.getString("id") }.toSet().intersect(
            second.outputs.map { it.event.getString("id") }.toSet()).isEmpty())
    }

    @Test fun `held input survives restart and flush releases it`() {
        val dir = folder.newFolder(); val stages = CaptureStageRegistry(listOf(PairStage()))
        val queue = DurableQueue(dir, cipher, captureStages = stages)
        val first = note("generated first")
        queue.enqueue(first, null, 1_000_000)
        assertEquals(0, queue.depth())
        assertFalse(File(dir, ".capture-stages.checkpoint").readText().contains("generated first"))
        val restarted = DurableQueue(dir, cipher, captureStages = stages)
        val ids = restarted.flushStages(1_000_000)
        assertEquals(listOf(first.getString("id")), ids)
        assertEquals("generated first", restarted.peek()!!.getString("ocrText"))
    }

    @Test fun `raw inbox replays after a stage crash before journal commit`() {
        val dir = folder.newFolder(); var crash = true
        val stage = object : CaptureStage {
            override val id = "crash-fixture"
            override val version = 1
            override fun consume(inputs: List<StageCapture>, checkpoint: JSONObject?, held: List<StageCapture>, flush: Boolean,
                                 deriveId: (List<String>, String) -> String): StageResult {
                if (crash) { crash = false; error("generated stage crash") }
                return StageResult(inputs)
            }
        }
        val registry = CaptureStageRegistry(listOf(stage))
        val queue = DurableQueue(dir, cipher, captureStages = registry)
        val input = note("generated inbox")
        assertThrows(IllegalStateException::class.java) { queue.enqueue(input, null, 1_000_000) }
        assertEquals(0, queue.depth())
        assertTrue(File(dir, ".capture-stages.inbox").exists())
        val restarted = DurableQueue(dir, cipher, captureStages = registry)
        assertEquals(input.getString("id"), restarted.peek()!!.getString("id"))
        assertFalse(File(dir, ".capture-stages.inbox").exists())
    }

    @Test fun `journal replays every output and checkpoint after a mid-commit crash`() {
        val dir = folder.newFolder(); val stages = CaptureStageRegistry(listOf(SplitStage()))
        val queue = DurableQueue(dir, cipher, captureStages = stages)
        queue.afterStageJournal = { error("generated commit crash") }
        val input = note("generated journal")
        assertThrows(IllegalStateException::class.java) { queue.enqueue(input, null, 1_000_000) }
        assertTrue(File(dir, ".capture-stages.journal").exists())
        val restarted = DurableQueue(dir, cipher, captureStages = stages)
        assertEquals(2, restarted.depth())
        val ids = restarted.syncIds().toSet()
        restarted.enqueue(input, null, 1_000_000)
        assertEquals(ids, restarted.syncIds().toSet())
        assertFalse(File(dir, ".capture-stages.journal").exists())
    }

    @Test fun `stage preserves redaction across a held pair`() {
        val dir = folder.newFolder()
        val stages = CaptureStageRegistry(listOf(PairStage()))
        DurableQueue(dir, cipher, captureStages = stages).enqueue(note("generated redacted", redacted = true), null, 1_000_000)
        val restarted = DurableQueue(dir, cipher, captureStages = stages)
        restarted.enqueue(note("generated second"), null, 1_000_000)
        assertEquals(1, restarted.depth())
        assertTrue(restarted.peek()!!.getJSONObject("privacy").getBoolean("redacted"))
    }

    @Test fun `failed pending stage does not hide committed history or discard its input`() {
        val dir = folder.newFolder()
        var broken = false
        val stages = CaptureStageRegistry(listOf(object : CaptureStage {
            override val id = "failing-fixture"
            override val version = 1
            override fun consume(inputs: List<StageCapture>, checkpoint: JSONObject?, held: List<StageCapture>, flush: Boolean,
                                 deriveId: (List<String>, String) -> String): StageResult {
                check(!broken) { "generated processing failure" }
                return StageResult(inputs)
            }
        }))
        val first = note("generated committed")
        val next = note("generated pending")
        val queue = DurableQueue(dir, cipher, captureStages = stages)
        queue.enqueue(first, null, 1_000_000)
        broken = true
        assertThrows(IllegalStateException::class.java) { queue.enqueue(next, null, 1_000_000) }
        val restarted = DurableQueue(dir, cipher, captureStages = stages)
        assertNotNull(restarted.pendingStageFailure)
        assertEquals(first.getString("id"), restarted.peek()!!.getString("id"))
        assertEquals(1, restarted.inventory().records)
        assertTrue(File(dir, ".capture-stages.inbox").exists())
        assertThrows(IllegalStateException::class.java) { restarted.enqueue(note("generated later"), null, 1_000_000) }
        broken = false
        val recovered = DurableQueue(dir, cipher, captureStages = stages)
        assertEquals(setOf(first.getString("id"), next.getString("id")), recovered.syncIds().toSet())
        assertNull(recovered.pendingStageFailure)
        assertFalse(File(dir, ".capture-stages.inbox").exists())
    }

    @Test fun `stage upgrade cannot drop a held capture`() {
        val dir = folder.newFolder()
        DurableQueue(dir, cipher, captureStages = CaptureStageRegistry(listOf(PairStage()))).enqueue(note("generated held"), null, 1_000_000)
        val upgraded = DurableQueue(dir, cipher, captureStages = CaptureStageRegistry(listOf(PairStage(version = 2))) )
        assertThrows(IllegalStateException::class.java) { upgraded.enqueue(note("generated next"), null, 1_000_000) }
        assertEquals(0, upgraded.depth())
        assertTrue(File(dir, ".capture-stages.inbox").exists())
    }

    @Test fun `acknowledged state-series head is not reused`() {
        val dir = folder.newFolder(); val queue = DurableQueue(dir, cipher)
        fun activity(at: String) = JSONObject().put("id", UUID.randomUUID().toString()).put("capturedAt", at)
            .put("durationMs", 5000).put("platform", "android").put("source", "activity")
            .put("appId", "generated.app").put("appName", "Generated")
            .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none").put("collection", "activity"))
        val first = activity("2026-09-24T00:00:00Z")
        queue.enqueue(first, null, 1_000_000)
        queue.acknowledge(first.getString("id"))
        val second = activity("2026-09-24T00:00:05Z")
        queue.enqueue(second, null, 1_000_000)
        assertEquals(second.getString("id"), queue.peek()!!.getString("id"))
    }

    @Test fun `blocked state-series head is not rewritten by the next sample`() {
        val dir = folder.newFolder(); val queue = DurableQueue(dir, cipher)
        fun activity(at: String) = JSONObject().put("id", UUID.randomUUID().toString()).put("capturedAt", at)
            .put("durationMs", 5000).put("platform", "android").put("source", "activity")
            .put("appId", "generated.app").put("appName", "Generated")
            .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none").put("collection", "activity"))
        val first = activity("2026-09-24T00:00:00Z")
        queue.enqueue(first, null, 1_000_000)
        queue.uploadConflict(first.getString("id"))
        val second = activity("2026-09-24T00:00:05Z")
        queue.enqueue(second, null, 1_000_000)
        assertEquals(2, queue.depth())
        assertEquals(second.getString("id"), queue.peek()!!.getString("id"))
        assertEquals(1, queue.syncIssues().size)
    }

    @Test fun `full pending inbox does not prevent restart and can use a raised quota`() {
        val dir = folder.newFolder(); val stages = CaptureStageRegistry(listOf(SplitStage()))
        val input = note("generated limited")
        val first = DurableQueue(dir, cipher, captureStages = stages)
        assertThrows(QueueFull::class.java) { first.enqueue(input, null, 4_000) }
        assertTrue(File(dir, ".capture-stages.inbox").exists())
        val restarted = DurableQueue(dir, cipher, captureStages = stages)
        assertEquals(0, restarted.depth())
        restarted.enqueue(input, null, 1_000_000)
        assertEquals(2, restarted.depth())
    }
}
