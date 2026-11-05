package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class CentralDeletionTest {
    private val id="00000000-0000-4000-8000-000000000001"
    private fun record(kind:Any?="capture",available:Any=true)=JSONObject().put("id",id).put("deletion",JSONObject().put("available",available).put("kind",kind ?: JSONObject.NULL))
    @Test fun `readonly or malformed capabilities never become a deletion route`() {
        assertTrue(CentralCaptureReader.supports("message"));assertFalse(CentralCaptureReader.supports("file"))
        assertNull(CentralDeletion.kind(JSONObject()))
        assertNull(CentralDeletion.kind(record(null,false)))
        assertNull(CentralDeletion.kind(record("capture","true")))
        assertNull(CentralDeletion.kind(record("material")))
        assertEquals("capture",CentralDeletion.kind(record()))
        assertEquals("file",CentralDeletion.kind(record("file")))
    }
    @Test fun `only an explicit numeric positive integer confirms deletion`() {
        for(value in listOf<Any>(0,-1,0.5,1e30,"1",true,JSONObject.NULL)) assertThrows(IllegalStateException::class.java) { CentralDeletion.requireCompleted(JSONObject().put("deleted",value)) }
        assertThrows(IllegalStateException::class.java) { CentralDeletion.requireCompleted(JSONObject()) }
        assertEquals(1,CentralDeletion.requireCompleted(JSONObject().put("deleted",1)).getInt("deleted"))
        assertEquals(2,CentralDeletion.requireCompleted(JSONObject().put("deleted",2.0)).getInt("deleted"))
    }
    @Test fun `fresh host capability preserves the viewed virtual ID on the existing evidence endpoint`() {
        for(kind in listOf("capture","file")) {
            val calls=mutableListOf<String>()
            val client=CentralClient("http://127.0.0.1:49001","generated-owner-token",transport={ method,url,_,_,_ ->
                calls.add(method+" "+url.substringAfter("49001"))
                200 to if(method=="GET") record(kind) else JSONObject().put("deleted",1)
            })
            CentralDeletion.evidence(client,id,kind)
            assertEquals(listOf("GET /api/capture-browser/$id","DELETE /api/captures/$id"),calls)
        }
    }
    @Test fun `withdrawn changed or mismatched read capability cannot send DELETE`() {
        for(row in listOf(record(null,false),record("file"),record().put("id","00000000-0000-4000-8000-000000000002"))) {
            val calls=mutableListOf<String>()
            val client=CentralClient("http://127.0.0.1:49001","generated-owner-token",transport={ method,_,_,_,_ -> calls.add(method);200 to row })
            assertThrows(IllegalStateException::class.java) { CentralDeletion.evidence(client,id,"capture") };assertEquals(listOf("GET"),calls)
        }
    }
    @Test fun `zero lost response and current server rejection never count as successful removal`() {
        for(outcome in listOf("zero","timeout","conflict")) {
            val calls=mutableListOf<String>()
            val client=CentralClient("http://127.0.0.1:49001","generated-owner-token",transport={method,_,_,_,_ ->
                calls.add(method)
                if(method=="GET") 200 to record() else when(outcome) {
                    "timeout" -> throw IOException("generated lost deletion ACK")
                    "conflict" -> 409 to JSONObject().put("error","capture_delete_unavailable")
                    else -> 200 to JSONObject().put("deleted",0)
                }
            })
            assertThrows(Exception::class.java) { CentralDeletion.evidence(client,id,"capture") }
            assertEquals("one capability read and one delete attempt, never an automatic retry",listOf("GET","DELETE"),calls)
        }
    }
    @Test fun `a positive receipt completes and closes only after the one delete response`() {
        val calls=mutableListOf<String>()
        val client=CentralClient("http://127.0.0.1:49001","generated-owner-token",transport={method,_,_,_,_ ->
            calls.add(method)
            if(method=="GET") 200 to record() else 200 to JSONObject().put("deleted",1)
        })
        assertEquals(1,CentralDeletion.evidence(client,id,"capture").getInt("deleted"))
        assertEquals(listOf("GET","DELETE"),calls)
    }
    @Test fun `file deletion with an unconfirmed receipt is never retried`() {
        val calls=mutableListOf<String>()
        val client=CentralClient("http://127.0.0.1:49001","generated-owner-token",transport={method,_,_,_,_ ->
            calls.add(method);200 to JSONObject().put("deleted",0)
        })
        assertThrows(IllegalStateException::class.java) { CentralDeletion.delete(client,"/api/files/"+id) }
        assertEquals(listOf("DELETE"),calls)
    }
    @Test fun `an owner change during capability read prevents any write`() {
        var active=true;val calls=mutableListOf<String>()
        val client=CentralClient("http://127.0.0.1:49001","generated-owner-token",transport={method,_,_,_,_ -> calls.add(method);active=false;200 to record()},active={active})
        assertThrows(IllegalStateException::class.java) { CentralDeletion.evidence(client,id,"capture") };assertEquals(listOf("GET"),calls)
    }
}
