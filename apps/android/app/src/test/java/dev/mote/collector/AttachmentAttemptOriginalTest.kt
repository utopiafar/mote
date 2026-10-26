package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.UUID

class AttachmentAttemptOriginalTest {
    @get:Rule val folder=TemporaryFolder()
    @Test fun failedAndLostAckAttachmentNotesOpenRetainedQueueVersion() {
        val cipher=object:ByteCipher { override fun seal(bytes:ByteArray)=bytes; override fun open(bytes:ByteArray)=bytes }
        val queue=DurableQueue(folder.newFolder(),cipher).apply { archiveOrigin="https://generated.example" }
        val original=JSONObject().put("id",UUID.randomUUID().toString()).put("source","note").put("deviceId","generated-device").put("capturedAt","2026-10-26T00:00:00Z").put("durationMs",0).put("ocrText","Generated retained note").put("privacy",JSONObject().put("excluded",false))
        queue.enqueue(original,null,100000)
        val outgoing=JSONObject(original.toString()).put("metadata",JSONObject().put("attachments",org.json.JSONArray().put(UUID.randomUUID().toString())))
        assertNotEquals(CaptureUploadVersion.of(original),CaptureUploadVersion.of(outgoing))
        val attempts=mutableListOf<CaptureUploadAttempt>()
        val sender=CaptureUploadAttempts(object:CaptureAttemptStore { override fun saveAttempt(attempt:CaptureUploadAttempt) { attempts.add(attempt) } },UUID.randomUUID().toString(),"scope","process")
        sender.send(listOf(outgoing),100,true,listOf(original)) { 503 to JSONObject() }
        assertThrows(java.io.IOException::class.java) { sender.send(listOf(outgoing),100,true,listOf(original)) { throw java.io.IOException("Generated lost ACK") } }
        for(attempt in attempts.filter { it.state=="unknown" }) {
            val item=UploadHistoryModel.batches(listOf(attempt),emptyList()).single().items.single()
            assertFalse(item.received); assertEquals(CaptureUploadVersion.of(original),item.originalVersion)
            assertEquals("Generated retained note",queue.captureExactVersion(item.captureId,item.originalVersion)!!.first.getString("ocrText"))
            assertTrue(item.key.endsWith(CaptureUploadVersion.of(outgoing)))
        }
    }
}
