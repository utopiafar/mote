package dev.mote.collector

import android.content.Context
import android.os.CancellationSignal
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ExtensionPipelineTest {
    private fun source(retention: String = "snapshot") = LocalSource(name = "Generated source", kind = "local-files", uri = "content://fixture/root", retention = retention)
    private fun item(text: String = "generated") = JSONObject().put("externalId", "fixture:1").put("title", "Generated").put("text", text).put("kind", "file").put("layer", "snapshot")
    @Test fun `source registry rejects duplicate adapters and host privacy gate rejects content in references`() {
        val fake = object : SourceAdapter {
            override val kind = "plugin.synthetic"
            override val version = 1
            override val queueKind = SourceQueueKind.INDEXED
            override fun validateConfiguration(source: LocalSource) {}
            override fun available(context: Context, source: LocalSource) = true
            override fun lastScan(context: Context, source: LocalSource) = ""
            override fun scan(context: Context, source: LocalSource, cancellation: CancellationSignal) = SourceEmission.Indexed(SourceScan(listOf(item()), true, "2026-09-24T00:00:00Z"))
        }
        val registry = SourceAdapterRegistry().register(fake)
        assertSame(fake, registry.forKind("plugin.synthetic"))
        assertThrows(IllegalArgumentException::class.java) { registry.register(fake) }
        SourceAdapters.default.register(fake)
        source().copy(kind = "plugin.synthetic").validate()
        assertThrows(IllegalArgumentException::class.java) { SourcePrivacyGate.validate(source("reference"), item()) }
        SourcePrivacyGate.validate(source(), item())
    }
    @Test fun `state aggregation runs through a versioned stage with persisted checkpoint`() {
        val base = JSONObject().put("id", UUID.randomUUID().toString()).put("capturedAt", "2026-09-24T00:00:00Z").put("durationMs", 5000)
            .put("source", "activity").put("appId", "fixture.app").put("appName", "Generated")
            .put("privacy", JSONObject().put("excluded", false).put("collection", "activity"))
        val stages = CaptureStages.default
        assertEquals(listOf("state-series" to 1), stages.versions())
        val first = stages.run(listOf(StageCapture(base, null)), null)
        val second = stages.run(listOf(StageCapture(JSONObject(base.toString()).put("id", UUID.randomUUID().toString()).put("capturedAt", "2026-09-24T00:00:05Z"), null)), first.checkpoint)
        assertEquals(base.getString("id"), second.outputs.single().event.getString("id"))
        assertEquals(2, second.outputs.single().event.getJSONObject("stateSeries").getJSONArray("samples").length())
        assertThrows(IllegalArgumentException::class.java) { CaptureStageRegistry().register(object : CaptureStage {
            override val id = "bad id"
            override val version = 1
            override fun consume(inputs: List<StageCapture>, checkpoint: JSONObject?, held: List<StageCapture>, flush: Boolean,
                                 deriveId: (List<String>, String) -> String) = StageResult(inputs)
        }) }
    }
}
