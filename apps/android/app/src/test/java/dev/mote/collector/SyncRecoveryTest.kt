package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.UUID

class SyncRecoveryTest {
    private val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private fun screen() = JSONObject().put("id", UUID.randomUUID().toString()).put("source", "screen")
        .put("capturedAt", "2026-09-15T00:00:00Z").put("imageMime", "image/jpeg").put("ocrText", "")
        .put("ocr", JSONObject().put("status", "completed")).put("privacy", JSONObject().put("excluded", false))

    @Test fun fullSourceReplayDeduplicatesPendingVersionsAndDoesNotEnablePausedSources() {
        val dir = Files.createTempDirectory("mote-source-replay").toFile()
        try {
            var failWrite = false
            val storage = object : ByteCipher {
                override fun open(bytes: ByteArray) = bytes
                override fun seal(bytes: ByteArray): ByteArray { if (failWrite) throw java.io.IOException("Generated actual journal write failure"); return bytes }
            }
            val store = LocalSourceStore(dir, storage); val origin = "https://generated.invalid"
            val active = LocalSource(name="Generated calendar", kind="local-calendar", calendarId=1)
            val paused = active.copy(id="paused", name="Paused generated calendar", enabled=false)
            store.save(active); store.save(paused)
            val body = JSONObject().put("externalId", "fixture-1").put("kind", "calendar").put("layer", "snapshot")
                .put("observedAt", "2026-09-15T00:00:00Z").put("title", "Generated").put("text", "Fixture body")
            store.scan(active, SourceScan(listOf(body), true, "2026-09-15T00:00:00Z"))
            store.selectTarget(active.id, "fixture-target")
            val pending = store.next(active.id, "fixture-target")!!
            store.acknowledge(active.id, "fixture-target", pending.getString("externalId"), pending.getString("revision"), origin, UUID.randomUUID().toString())
            val before = store.state(active.id).toString(); failWrite = true
            assertThrows(java.io.IOException::class.java) { store.requeueRetained(origin) }
            failWrite = false; assertEquals(before, store.state(active.id).toString())
            assertNull(store.next(active.id, "fixture-target"))
            assertEquals(0, store.requeueRetained("https://other-generated.invalid")); assertNull(store.next(active.id, "fixture-target"))
            assertEquals(1, store.requeueRetained(origin)); assertEquals(1, store.requeueRetained(origin))
            assertEquals(pending.toString(), store.next(active.id, "fixture-target")!!.toString())
            assertFalse(store.sources().single { it.id==paused.id }.enabled)
            assertFalse(store.state(active.id).optBoolean("registered"))
        } finally { dir.deleteRecursively() }
    }
}
