package dev.mote.collector

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Real SQLite, authenticated local encryption and durable outbox, generated fixtures only. */
@RunWith(AndroidJUnit4::class)
class CaptureUploadHistoryInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val now = 1_800_000_000_000L
    private val origin = "https://generated-history.example"
    private val device = UUID.randomUUID().toString()
    private fun guard() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("uploadHistoryFixture") == "true")
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
    }
    private fun note() = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", device).put("source", "note")
        .put("capturedAt", "2026-10-26T00:00:00Z").put("durationMs", 0).put("ocrText", "Generated private original, never upload history content")
        .put("privacy", JSONObject().put("excluded", false))
    private fun receipt(event: JSONObject = note(), at: Long = now, days: Int = 365) =
        CaptureUploadReceipt.create(origin, device, event, event, UUID.randomUUID().toString(), at, days)
    private fun directory() = File(context.cacheDir, "generated-history-${UUID.randomUUID()}").apply { check(mkdirs()) }

    @Test fun sqliteReopenDeduplicatesAndPagesWithoutExposingPrivateLocators() {
        guard(); val directory = directory()
        try {
            val file = File(directory, "received.sqlite"); val cipher = context.secretBox()
            val store = CaptureUploadHistory(file, cipher); val rows = (0 until 123).map { receipt(at = now - it % 3) }
            rows.forEach { store.received(it); store.completed(it.itemKey) }
            val first = rows.first()
            val duplicate = first.copy(batchId = UUID.randomUUID().toString(), receivedAt = now + 1000)
            assertEquals(first.receivedAt, store.received(duplicate).receivedAt); store.completed(first.itemKey)
            val other = receipt().copy(scope = CaptureUploadReceipt.scope(origin, "another-device"), itemKey = SourceRules.hash("other-scope"))
            store.received(other); store.completed(other.itemKey)
            val reopened = CaptureUploadHistory(file, cipher); val loaded = mutableListOf<CaptureUploadReceipt>(); var cursor: Pair<Long, String>? = null
            do {
                val page = reopened.page(first.scope, cursor, limit = 50, now = now + 2000)
                loaded.addAll(page); cursor = page.lastOrNull()?.let { it.receivedAt to it.itemKey }
            } while (page.size == 50)
            assertEquals(123, loaded.size); assertEquals(123, loaded.map { it.itemKey }.toSet().size)
            assertEquals(rows.map { it.itemKey }.toSet(), loaded.map { it.itemKey }.toSet())
            assertEquals(first.receivedAt, loaded.single { it.itemKey == first.itemKey }.receivedAt)
            assertTrue(reopened.pending(first.scope).isEmpty())
            val raw = file.readBytes().toString(Charsets.ISO_8859_1)
            assertFalse(raw.contains(origin)); assertFalse(raw.contains(device)); assertFalse(raw.contains(first.captureId))
            assertFalse(raw.contains("Generated private original"))
        } finally { directory.deleteRecursively() }
    }

    @Test fun failedTransactionLeavesBothHistoryAndOutboxRecoverable() {
        guard(); val directory = directory()
        try {
            val cipher = context.secretBox(); val event = note()
            val queue = DurableQueue(File(directory, "queue"), cipher).apply { archiveOrigin = origin }; queue.enqueue(event, null, 100000)
            val file = File(directory, "received.sqlite"); var seals = 0
            val failing = object : ByteCipher {
                override fun seal(bytes: ByteArray): ByteArray { if (++seals == 2) throw java.io.IOException("Generated interrupted metadata write"); return cipher.seal(bytes) }
                override fun open(bytes: ByteArray) = cipher.open(bytes)
            }
            val row = receipt(event)
            val failure = assertThrows(UploadHistoryUnavailable::class.java) { CaptureReceiptFinalizer(CaptureUploadHistory(file, failing)).received(queue, row) }
            assertTrue(failure.cause is java.io.IOException)
            val reopened = CaptureUploadHistory(file, cipher)
            assertTrue(reopened.page(row.scope, now = now).isEmpty()); assertTrue(reopened.pending(row.scope).isEmpty())
            assertEquals(event.getString("ocrText"), queue.peek()!!.getString("ocrText"))
            CaptureReceiptFinalizer(reopened).received(queue, row)
            assertEquals(0, queue.pendingSync().count); assertEquals(1, reopened.page(row.scope, now = now).size)
        } finally { directory.deleteRecursively() }
    }

    @Test fun expiredHistoryDoesNotErasePendingTransportOrOriginalAndDoesNotResurrectOnRetry() {
        guard(); val directory = directory()
        try {
            val cipher = context.secretBox(); val event = note()
            val queue = DurableQueue(File(directory, "queue"), cipher).apply { archiveOrigin = origin }; queue.enqueue(event, null, 100000)
            val file = File(directory, "received.sqlite"); val store = CaptureUploadHistory(file, cipher)
            val first = receipt(event, now - 31 * 86_400_000L)
            store.received(first) // Simulated stop immediately after SQLite commit, before queue completion.
            assertEquals(1, store.prune(30, now)); assertTrue(store.page(first.scope, now = now).isEmpty())
            assertNotNull(queue.peek()); assertEquals(1, store.pending(first.scope).size)
            assertEquals(first.receivedAt, store.received(first.copy(receivedAt = now)).receivedAt)
            assertTrue("A duplicate ACK must not bring expired history back", store.page(first.scope, now = now).isEmpty())
            val reopened = CaptureUploadHistory(file, cipher)
            CaptureReceiptFinalizer(reopened).recover(queue, first.scope)
            assertTrue(reopened.pending(first.scope).isEmpty()); assertEquals(0, queue.pendingSync().count)
            assertEquals("Original retention is independent of upload history", event.getString("ocrText"), queue.capture(event.getString("id"))!!.getString("ocrText"))
            assertEquals(first.receivedAt + 365 * 86_400_000L, queue.capture(event.getString("id"))!!.getLong("retainedUntil"))
        } finally { directory.deleteRecursively() }
    }

    @Test fun changingHistoryDurationOnlyPrunesHistoryAndCannotRestoreExpiredRows() {
        guard(); val directory = directory()
        try {
            val cipher = context.secretBox(); val store = CaptureUploadHistory(File(directory, "received.sqlite"), cipher)
            val rows = listOf(receipt(at = now - 8 * 86_400_000L), receipt(at = now - 29 * 86_400_000L), receipt(at = now - 89 * 86_400_000L))
            rows.forEach { store.received(it); store.completed(it.itemKey) }
            assertEquals(3, store.page(rows[0].scope, days = 90, now = now).size)
            assertEquals(1, store.prune(30, now)); assertEquals(2, store.page(rows[0].scope, days = 30, now = now).size)
            assertEquals(2, store.prune(7, now)); assertTrue(store.page(rows[0].scope, days = 7, now = now).isEmpty())
            assertEquals(0, store.prune(365, now)); assertTrue(store.page(rows[0].scope, days = 365, now = now).isEmpty())
        } finally { directory.deleteRecursively() }
    }

    @Test fun interruptedSendingBecomesUnknownOnNewProcessAndExpiresWithHistory() {
        guard(); val directory = directory()
        try {
            val file = File(directory, "received.sqlite"); val cipher = context.secretBox(); val store = CaptureUploadHistory(file, cipher)
            val scope = CaptureUploadReceipt.scope(origin, device)
            val old = CaptureUploadAttempt.create(UUID.randomUUID().toString(), scope, "previous-process", listOf(note()), 56, now - 8 * 86_400_000L)
            val active = CaptureUploadAttempt.create(UUID.randomUUID().toString(), scope, "current-process", listOf(note()), 23, now)
            store.saveAttempt(old); store.saveAttempt(active)
            val reopened = CaptureUploadHistory(file, cipher); reopened.recoverInterrupted(scope, "current-process")
            val attempts = reopened.attempts(scope, now = now)
            assertEquals("unknown", attempts.single { it.id == old.id }.state)
            assertEquals(0, attempts.single { it.id == old.id }.acknowledged)
            assertEquals("sending", attempts.single { it.id == active.id }.state)
            reopened.recoverInterrupted(scope, "current-process", includeCurrentProcess = true)
            assertEquals("unknown", reopened.attempts(scope, now = now).single { it.id == active.id }.state)
            assertEquals(1, reopened.prune(7, now)); assertEquals(listOf(active.id), reopened.attempts(scope, now = now).map { it.id })
        } finally { directory.deleteRecursively() }
    }

    @Test fun centralCommitThen503RemainsUnknownAndReplayHasOneConfirmation() {
        guard()
        assumeTrue(InstrumentationRegistry.getArguments().getString("uploadReplayFixture") == "true")
        val directory = directory()
        try {
            val endpoint = "http://127.0.0.1:47888"
            val event = note().put("ocrText", "Generated replay original").put("platform", "android").put("deviceName", "Generated replay")
            val cipher = context.secretBox()
            val queue = DurableQueue(File(directory, "queue"), cipher).apply { archiveOrigin = endpoint }
            queue.enqueue(event, null, 100000)
            val file = File(directory, "history.sqlite")
            val history = CaptureUploadHistory(file, cipher)
            val batch = UUID.randomUUID().toString(); val scope = CaptureUploadReceipt.scope(endpoint, device)
            val sender = CaptureUploadAttempts(history, batch, scope, "generated-replay")
            fun send() = sender.send(listOf(event), event.toString().toByteArray().size.toLong(), true) {
                val connection = java.net.URL("$endpoint/api/captures").openConnection() as java.net.HttpURLConnection
                try {
                    connection.requestMethod = "POST"; connection.doOutput = true
                    connection.connectTimeout = 10000; connection.readTimeout = 10000
                    connection.setRequestProperty("content-type", "application/json")
                    connection.setRequestProperty("authorization", "Bearer generated-upload-history-fixture-token")
                    connection.outputStream.use { it.write(event.toString().toByteArray()) }
                    val status = connection.responseCode
                    val stream = if (status >= 400) connection.errorStream else connection.inputStream
                    status to JSONObject(stream.bufferedReader().use { it.readText() })
                } finally { connection.disconnect() }
            }
            assertEquals(503, send().first)
            val reopened = CaptureUploadHistory(file, cipher)
            assertEquals("unknown", reopened.attempts(scope).single().state)
            assertEquals(0, reopened.attempts(scope).single().acknowledged)
            assertEquals(1, queue.pendingSync().count)
            assertTrue(reopened.page(scope).isEmpty())
            val replay = send()
            assertTrue(replay.first in setOf(200, 201))
            assertTrue(replay.second!!.getJSONObject("receipt").getBoolean("duplicate"))
            val confirmation = CaptureUploadReceipt.create(endpoint, device, event, event, batch, System.currentTimeMillis(), 30)
            CaptureReceiptFinalizer(reopened).received(queue, confirmation)
            CaptureReceiptFinalizer(reopened).received(queue, confirmation)
            assertEquals(0, queue.pendingSync().count)
            assertEquals(1, reopened.page(scope).size)
            assertEquals(setOf("unknown", "received"), reopened.attempts(scope).map { it.state }.toSet())
            assertEquals(2, reopened.attempts(scope).size)
            assertEquals(replay.first, reopened.attempts(scope).single { it.state == "received" }.results.getInt(event.getString("id")))
            assertEquals("Generated replay original", queue.capture(event.getString("id"))!!.getString("ocrText"))
        } finally { directory.deleteRecursively() }
    }

    @Test fun unavailableHistoryReportsRecoverableFailureWithoutChangingPendingOriginal() {
        guard(); val directory = directory()
        val prefix = "generated-history-" + UUID.randomUUID()
        val preferences = mutableSetOf<String>()
        val isolated = object : android.content.ContextWrapper(context) {
            override fun getApplicationContext(): android.content.Context = this
            override fun getNoBackupFilesDir() = File(directory, "private").apply { mkdirs() }
            override fun getFilesDir() = File(directory, "files").apply { mkdirs() }
            override fun getSharedPreferences(name: String, mode: Int): android.content.SharedPreferences {
                val key = "$prefix-$name"; preferences.add(key)
                return context.getSharedPreferences(key, mode)
            }
        }
        try {
            LocalDataFormat.requireCurrent(isolated)
            val event = note(); val settings = Settings(isolated)
            val queue = DurableQueue(File(directory, "queue"), isolated.secretBox())
            queue.enqueue(event, null, 100000)
            val blocked = File(isolated.noBackupFilesDir, "upload-history")
            blocked.writeText("Generated storage fault")
            assertFalse(UploadHistoryRecovery.restore(isolated, queue, settings))
            assertTrue(UploadHistoryRecovery.unavailable)
            assertEquals("error", settings.syncState())
            assertTrue(settings.uploadStatus().contains(MoteI18n.text("上传历史")))
            assertEquals(1, queue.pendingSync().count)
            assertEquals(event.getString("ocrText"), queue.peek()!!.getString("ocrText"))
            check(blocked.delete())
            assertTrue(UploadHistoryRecovery.restore(isolated, queue, settings))
            assertFalse(UploadHistoryRecovery.unavailable)
            assertEquals(1, queue.pendingSync().count)
            assertEquals(event.getString("ocrText"), queue.peek()!!.getString("ocrText"))
            assertTrue(isolated.captureUploadHistory().page(CaptureUploadReceipt.scope(origin, device)).isEmpty())
        } finally {
            UploadHistoryRecovery.available()
            preferences.forEach { context.deleteSharedPreferences(it) }
            directory.deleteRecursively()
        }
    }

    /** Run after the real native FirstDeviceData journey, against that exact generated upload. */
    @Test fun nativeUploadCreatedOnePersistentConfirmationForTheSameOriginal() {
        guard()
        val result = JSONObject(File(context.filesDir, "first-data-result.json").readText()); val settings = Settings(context)
        val history = context.captureUploadHistory(); val scope = CaptureUploadReceipt.scope(settings.read().server, settings.deviceId)
        val rows = history.page(scope)
        val row = rows.single { it.captureId == result.getString("id") }
        assertEquals(1, rows.size); assertEquals(result.getString("deviceId"), row.deviceId)
        assertEquals(result.getString("text"), context.queue().capture(row.captureId)!!.getString("ocrText"))
        assertTrue(history.pending(scope).isEmpty()); assertFalse(row.json().has("ocrText"))
        assertEquals(row.itemKey, context.captureUploadHistory().page(scope).single().itemKey)
        val attempts = history.attempts(scope)
        assertEquals(1, attempts.size); assertEquals("received", attempts.single().state); assertEquals(1, attempts.single().acknowledged)
        assertEquals(row.batchId, attempts.single().batchId)
    }
}
