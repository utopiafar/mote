package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.UUID

class RecordAttachmentIdentityTest {
    private fun fileAck(manifest: JSONObject, id: String): JSONObject {
        val item = manifest.getJSONObject("item")
        val ack = JSONObject().put("id",id).put("captureId",id).put("sourceId",manifest.getString("sourceId")).put("externalId",item.getString("externalId")).put("revision",item.getString("revision")).put("sha256",manifest.getString("sha256")).put("sizeBytes",manifest.getLong("sizeBytes"))
        return ack.put("receipt",JSONObject(ack.toString()).put("version",2).put("kind","file-revision").put("state","received").put("duplicate",false))
    }
    @Test fun mismatchedCanonicalLocatorIsRejectedAtBothFinalAckEntrypoints() {
        val file = folder.newFile().apply { writeBytes(byteArrayOf(1,2,3)) }
        for (begin in listOf(true,false)) {
            var manifest = JSONObject(); var commits = 0
            val client = CentralClient("https://fixture.example","generated-token",transport = { _,url,bytes,_,_ ->
                when {
                    url.endsWith("/api/sources") -> 200 to JSONObject()
                    url.endsWith("/uploads") -> {
                        manifest=JSONObject(String(bytes!!)); val ack=fileAck(manifest,UUID.randomUUID().toString()).put("captureId",UUID.randomUUID().toString())
                        200 to if(begin) JSONObject().put("ack",ack) else JSONObject().put("uploadId",UUID.randomUUID().toString()).put("parts",org.json.JSONArray())
                    }
                    url.contains("/parts/") -> 200 to JSONObject().put("part",0).put("bytes",3).put("hash",FileSnapshotMetadata.hash(bytes!!))
                    else -> { commits++; 200 to fileAck(manifest,UUID.randomUUID().toString()).put("captureId",UUID.randomUUID().toString()) }
                }
            })
            assertThrows(IllegalStateException::class.java) { CentralAttachments.upload(client,file,"generated.txt","text/plain","generated-device",{ 1000 }) }
            assertEquals(if(begin) 0 else 1,commits)
        }
    }
    @Test fun corruptedResumePartCannotSkipOriginalBytesOrCommit() {
        val file=folder.newFile().apply { writeBytes(byteArrayOf(1,2,3)) }; var writes=0
        val client=CentralClient("https://fixture.example","generated-token",transport={ _,url,_,_,_ ->
            when {
                url.endsWith("/api/sources") -> 200 to JSONObject()
                url.endsWith("/uploads") -> 200 to JSONObject().put("uploadId",UUID.randomUUID().toString()).put("parts",org.json.JSONArray().put(JSONObject().put("part",0).put("bytes",3).put("hash","bad")))
                else -> { writes++; 200 to JSONObject() }
            }
        })
        assertThrows(IllegalStateException::class.java) { CentralAttachments.upload(client,file,"generated.txt","text/plain","generated-device",{ 1000 }) }
        assertEquals(0,writes); assertArrayEquals(byteArrayOf(1,2,3),file.readBytes())
    }
    @get:Rule val folder = TemporaryFolder()
    @Test fun `same original in different notes has independent revision identity while lost ACK retries exact manifest`() {
        val file = folder.newFile("generated.txt").apply { writeText("generated same original") }
        val received = mutableMapOf<String, String>(); var loseAck = true
        val client = CentralClient("https://fixture.example", "generated-token", transport = { _, url, bytes, _, _ ->
            when {
                url.endsWith("/api/sources") -> 200 to JSONObject()
                url.endsWith("/api/file-sync/v1/uploads") -> {
                    val manifest = JSONObject(String(bytes!!)); val external = manifest.getJSONObject("item").getString("externalId")
                    val previous = received.putIfAbsent(external, manifest.toString())
                    if (previous != null) assertEquals("Retry must preserve observedAt and the whole manifest", previous, manifest.toString())
                    if (loseAck) { loseAck = false; throw java.io.IOException("Generated lost ACK") }
                    200 to JSONObject().put("ack", fileAck(manifest, UUID.nameUUIDFromBytes(external.toByteArray()).toString()))
                }
                else -> error("Unexpected real transport path")
            }
        })
        val first = UUID.randomUUID().toString(); val second = UUID.randomUUID().toString()
        assertThrows(java.io.IOException::class.java) { CentralAttachments.upload(client, file, "same.txt", "text/plain", "fixture-device", { 1000L }, identityScope = first) }
        val retry = CentralAttachments.upload(client, file, "same.txt", "text/plain", "fixture-device", { 1000L }, identityScope = first)
        val other = CentralAttachments.upload(client, file, "same.txt", "text/plain", "fixture-device", { 2000L }, identityScope = second)
        assertNotEquals(retry, other); assertEquals(2, received.size)
    }
}
