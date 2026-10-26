package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class ItemUploadMetadataTest {
    private fun identity() = ItemUploadIdentity("file","scope","source","https://generated.example","device","target","source","external","revision","fingerprint","a".repeat(64),42)
    private fun manifest(i: ItemUploadIdentity) = JSONObject().put("sha256",i.sha256).put("sizeBytes",i.sizeBytes).put("item",JSONObject().put("externalId",i.externalId).put("revision",i.revision))
    @Test fun finalAckRejectsForeignAliasEvenWhenEveryValidatedFieldMatches() {
        val i=identity(); val id=UUID.randomUUID().toString(); val valid=FileUploadConfirmation.envelope(i,id)
        assertEquals(id,FileUploadConfirmation.canonicalId(i.sourceId,manifest(i),valid))
        for (phase in listOf("begin","commit")) {
            val ack=JSONObject(valid.toString()).put("captureId",UUID.randomUUID().toString())
            assertThrows("$phase must not admit another locator",IllegalStateException::class.java) { FileUploadConfirmation.canonicalId(i.sourceId,manifest(i),ack) }
        }
        assertThrows(IllegalStateException::class.java) { FileUploadConfirmation.canonicalId(i.sourceId,manifest(i),JSONObject(valid.toString()).put("sizeBytes",43)) }
    }
    @Test fun resumedAndFreshPartsRequireExactIndexLengthAndHash() {
        val bytes=byteArrayOf(1,2,3); val hash=java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val ack=JSONObject().put("part",2).put("bytes",3).put("hash",hash)
        FileUploadConfirmation.part(ack,2,bytes)
        assertThrows(IllegalStateException::class.java) { FileUploadConfirmation.part(ack,1,bytes) }
        assertThrows(IllegalStateException::class.java) { FileUploadConfirmation.part(ack,2,byteArrayOf(1,2,4)) }
        assertThrows(IllegalStateException::class.java) { FileUploadConfirmation.part(JSONObject().put("part",2),2,bytes) }
    }
    @Test fun exactMetadataRoundTripsWithoutOriginalBodyAndKeepsVersionNamespace() {
        val i=identity(); val a=ItemUploadAttempt(UUID.randomUUID().toString(),UUID.randomUUID().toString(),"process",i,"part",1000,42)
        assertEquals(a,ItemUploadAttempt.parse(a.json()))
        val receipt=ItemUploadReceipt(i,a.batchId,UUID.randomUUID().toString(),1000)
        assertEquals(receipt,ItemUploadReceipt.parse(receipt.json()))
        assertNotEquals(i.key,i.copy(scope="other-node").key)
        assertNotEquals(i.key,i.copy(revision="new").key)
        assertNotEquals(i.key,i.copy(fingerprint="new-body").key)
        assertEquals(i.key,i.copy(target="rotated-credential-target").key)
        assertFalse(receipt.json().has("manifest")); assertFalse(a.json().has("body"))
    }
}
