package dev.mote.collector

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.google.zxing.qrcode.QRCodeWriter
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.Instant
import java.util.Base64
import java.util.UUID

class ConnectionAndOperationsTest {
    private val now = Instant.parse("2026-09-14T00:00:00Z")
    private fun invitation() = JSONObject().put("format", "mote.connection").put("version", 1).put("serverUrl", "https://mote.example")
        .put("code", "A".repeat(43)).put("expiresAt", "2026-09-14T00:10:00Z")
    @Test fun invitationAndGeneratedQrDecodeWithoutPlayServices() {
        val json = invitation().toString()
        val uri = "mote://connect?data=" + Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray())
        assertEquals(ConnectionInvitation.parse(json, false, false, now), ConnectionInvitation.parse(uri, false, false, now))
        val matrix = QRCodeWriter().encode(uri, BarcodeFormat.QR_CODE, 640, 640)
        val pixels = IntArray(640 * 640) { if (matrix[it % 640, it / 640]) -0x1000000 else -1 }
        val decoded = QRCodeReader().decode(BinaryBitmap(HybridBinarizer(RGBLuminanceSource(640, 640, pixels)))).text
        assertEquals(uri, decoded)
        assertEquals("https://mote.example", ConnectionInvitation.parse(decoded, false, false, now).serverUrl)
        assertFalse(ConnectionInvitation.parse(json, false, false, now).toString().contains("A".repeat(43)))
    }
    @Test fun invalidExpiredAndUnsafeInvitationsAreRejectedBeforeNetwork() {
        for (server in listOf("http://mote.example", "http://192.168.1.2:4000", "https://user:pass@mote.example", "https://mote.example/path", "https://mote.example?token=a", " https://mote.example")) {
            assertThrows(ConnectionFailure::class.java) { ConnectionInvitation.parse(invitation().put("serverUrl", server).toString(), true, true, now) }
        }
        val local = invitation().put("serverUrl", "http://127.0.0.1:4000").toString()
        assertEquals("http://127.0.0.1:4000", ConnectionInvitation.parse(local, true, true, now).serverUrl)
        assertThrows(ConnectionFailure::class.java) { ConnectionInvitation.parse(local, true, false, now) }
        assertEquals("expired", assertThrows(ConnectionFailure::class.java) { ConnectionInvitation.parse(invitation().toString(), false, false, now.plusSeconds(601)) }.category)
        for (raw in listOf(invitation().put("token", "secret").toString(), invitation().put("code", "A".repeat(42)).toString(), "{\"format\":\"mote.connection\",\"format\":\"other\"}", "x".repeat(8193), "mote://connect?data=e30&redirect=https://bad.example")) {
            assertThrows(ConnectionFailure::class.java) { ConnectionInvitation.parse(raw, false, false, now) }
        }
    }
    @Test fun ledgerSurvivesReopenBoundsEventsAndResetsHonestEpoch() {
        val directory = Files.createTempDirectory("mote-ledger").toFile()
        try {
            val file = File(directory, "ledger.json"); val ledger = OperationLedger(file, 3) { 1234 }
            val id = UUID.randomUUID().toString()
            repeat(7) { ledger.record(OperationKind.UPLOAD_RETRY, OperationReason.AUTH, httpStatus = 401, recordId = id) }
            val restored = OperationLedger(file, 3) { 1234 }.read()
            assertEquals(7, restored.getJSONObject("counts").getInt("UPLOAD_RETRY")); assertEquals(3, restored.getJSONArray("events").length())
            assertEquals(id, restored.getJSONArray("events").getJSONObject(0).getString("recordId"))
            assertThrows(IllegalArgumentException::class.java) { ledger.record(OperationKind.UPLOAD_RETRY, recordId = "private note") }
            val previous = restored.getString("epochId"); ledger.reset(); assertNotEquals(previous, ledger.read().getString("epochId")); assertEquals("user_reset", ledger.read().getString("epochReason"))
            file.writeText("corrupt"); assertEquals("recovered", ledger.read().getString("epochReason"))
        } finally { directory.deleteRecursively() }
    }
    @Test fun duplicateQueueWritesAndAcksCountOnceWithSameRecordId() {
        val directory = Files.createTempDirectory("mote-queue-ledger").toFile()
        val cipher = object : ByteCipher { override fun seal(value: ByteArray) = value; override fun open(value: ByteArray) = value }
        try {
            val ledger = OperationLedger(File(directory, "ledger.json"))
            val queue = DurableQueue(File(directory, "queue"), cipher) { kind, bytes, id -> ledger.record(kind, bytes = bytes, recordId = id) }
            val id = UUID.randomUUID().toString()
            val note = JSONObject().put("id", id).put("source", "note").put("capturedAt", now.toString()).put("ocrText", "GENERATED_PRIVATE_BODY")
                .put("privacy", JSONObject().put("excluded", false))
            queue.enqueue(note, null, 1024 * 1024); queue.enqueue(note, null, 1024 * 1024)
            val pending = queue.summary(); assertEquals(1, pending.getInt("notes")); assertFalse(pending.toString().contains("GENERATED_PRIVATE_BODY"))
            ledger.record(OperationKind.UPLOAD_RETRY, OperationReason.NETWORK, recordId = id)
            queue.acknowledge(id, 123); queue.acknowledge(id, 123)
            val state = ledger.read(); assertEquals(1, state.getJSONObject("counts").getInt("NOTE_QUEUED")); assertEquals(1, state.getJSONObject("counts").getInt("NOTE_ACK"))
            assertEquals(123, state.getLong("confirmedUploadBytes")); assertEquals(0, queue.depth())
            assertEquals(id, state.getJSONArray("events").getJSONObject(2).getString("recordId")); assertFalse(state.toString().contains("GENERATED_PRIVATE_BODY"))
        } finally { directory.deleteRecursively() }
    }
}
