package dev.mote.collector.plugins

import dev.mote.collector.CaptureAttemptStore
import dev.mote.collector.CaptureReceiptFinalizer
import dev.mote.collector.CaptureReceiptStore
import dev.mote.collector.CaptureUploadAttempt
import dev.mote.collector.CaptureUploadCompletion
import dev.mote.collector.CaptureUploadReceipt
import dev.mote.collector.DurableQueue
import dev.mote.collector.ByteCipher
import dev.mote.collector.OperationKind
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException
import java.util.UUID

/** The transport plugin's receipt policy before any Android UI or WorkManager. */
class DurableTransportPluginTest {
    @get:Rule val folder = TemporaryFolder()
    private val origin = "https://generated.example"
    private val device = UUID.randomUUID().toString()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 37).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }

    private class Store : CaptureReceiptStore, CaptureAttemptStore {
        val rows = linkedMapOf<String, CaptureUploadReceipt>()
        private val unfinished = linkedMapOf<String, CaptureUploadCompletion>()
        val attempts = mutableListOf<CaptureUploadAttempt>()
        override fun received(receipt: CaptureUploadReceipt): CaptureUploadCompletion {
            val first = rows.getOrPut(receipt.itemKey) { receipt }
            return unfinished.getOrPut(receipt.itemKey) { first.completion() }
        }
        override fun pending(scope: String) = unfinished.values.filter { it.scope == scope }
        override fun completed(itemKey: String) { unfinished.remove(itemKey) }
        override fun saveAttempt(attempt: CaptureUploadAttempt) {
            attempts.removeAll { it.id == attempt.id }
            attempts += attempt
        }
    }

    private fun note() = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", device)
        .put("source", "note").put("capturedAt", "2026-10-26T00:00:00Z").put("durationMs", 0)
        .put("ocrText", "Generated transport note").put("privacy", JSONObject().put("excluded", false))

    private fun receipt(id: String, duplicate: Boolean) = JSONObject().put("id", id).put("duplicate", duplicate)
        .put("receipt", JSONObject().put("version", 2).put("id", id).put("kind", "capture")
            .put("state", "received").put("duplicate", duplicate))

    @Test fun lostAcknowledgementRetriesOnceAndTheSameReceiptNeverUploadsAgain() {
        var acknowledgements = 0
        val queue = DurableQueue(folder.newFolder(), cipher, onChange = { kind, _, _ ->
            if (kind == OperationKind.NOTE_ACK) acknowledgements++
        }).apply { archiveOrigin = origin }
        val event = note(); queue.enqueue(event, null, 100000)
        val store = Store()
        val transport = DurableCaptureTransport(queue, store, store, CaptureUploadReceipt.scope(origin, device),
            origin, device, UUID.randomUUID().toString(), process = "generated", now = { 1000 }, retentionDays = 0)
        var requests = 0

        assertThrows(IOException::class.java) {
            transport.send(listOf(event), individual = true, bytes = 64) {
                requests++
                throw IOException("Generated loss after Central committed the capture")
            }
        }
        assertEquals(1, queue.pendingSync().count)
        assertEquals("unknown", store.attempts.single().state)
        assertTrue(store.rows.isEmpty())

        val outcome = transport.send(listOf(event), individual = true, bytes = 64) {
            requests++
            200 to receipt(event.getString("id"), duplicate = true)
        }
        assertEquals(200, outcome.response.first)
        assertEquals(1, outcome.acknowledged)
        assertEquals(1, store.rows.size)
        assertEquals(1, acknowledgements)
        assertEquals("received", store.attempts.last().state)
        assertEquals(0, queue.pendingSync().count)
        assertNull(queue.peek())

        // A duplicated delivery of the already durable receipt is a no-op: it
        // neither advances the local ACK nor makes the capture selectable again.
        CaptureReceiptFinalizer(store).received(queue, store.rows.values.single())
        assertEquals(1, acknowledgements)
        assertEquals(1, store.rows.size)
        assertNull(queue.peek())
        assertEquals(2, requests)
    }

    @Test fun builtinProviderBelongsToTheDurableTransportPlugin() {
        val registry = NativePluginRegistry().apply { registerDurableTransport("generated-build") }
        assertEquals(PluginAvailability.ACTIVE, registry.availability(NativeRequirement("mote.durable-upload", "1")))
        val provider = registry.provider("mote.durable-upload", "1")
        assertEquals("generated-build", provider?.buildId)
    }
}
