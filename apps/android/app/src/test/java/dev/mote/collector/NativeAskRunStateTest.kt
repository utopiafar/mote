package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class NativeAskRunStateTest {
    private fun request(id:String, conversation:String=UUID.randomUUID().toString())=JSONObject()
        .put("conversationId",conversation).put("clientRequestId",id).put("question","Generated admitted question")
        .put("scope",JSONObject().put("kind","all").put("timeZone","UTC"))
        .put("attachmentIds",JSONArray().put(UUID.randomUUID().toString()))
    private fun receipt(id:String, client:String, status:String, conversation:String=UUID.randomUUID().toString())=JSONObject()
        .put("id",id).put("conversationId",conversation).put("clientRequestId",client)
        .put("status",status).put("seq",0).put("revision",1)

    @Test fun `an unresolved admission keeps its exact client request id over a prior message`() {
        val old=UUID.randomUUID().toString();val next=UUID.randomUUID().toString()
        val state=JSONObject().put("messageId",old).put("runStatus","completed").put("pending",request(next))
        assertEquals(next,NativeAskRunState.currentId(state))
        assertThrows(IllegalStateException::class.java) {
            NativeAskRunState.validate(receipt(UUID.randomUUID().toString(),old,"completed"),request(next))
        }
        assertEquals(next,state.getJSONObject("pending").getString("clientRequestId"))
    }
    @Test fun `missing accepted receipt retains exact body and adopted messages never invent one`() {
        val id=UUID.randomUUID().toString();val message=UUID.randomUUID().toString();val body=request(id);val conversation=body.getString("conversationId")
        val state=JSONObject().put("conversationId",conversation).put("messageId",message).put("runStatus","running").put("activeRequest",body).put("question","Generated later draft")
        assertTrue(NativeAskRunState.missing(state));assertEquals(body.toString(),state.getJSONObject("pending").toString());assertEquals("running",state.getString("runStatus"));assertEquals("Generated later draft",state.getString("question"))
        val adopted=JSONObject().put("conversationId",conversation).put("messageId",message).put("runStatus","running");val before=adopted.toString()
        assertFalse(NativeAskRunState.missing(adopted));assertEquals(before,adopted.toString())
    }
    @Test fun `accepted queued and terminal server states validate but unknown states cannot release the admission`() {
        val id=UUID.randomUUID().toString();val client=UUID.randomUUID().toString();val conversation=UUID.randomUUID().toString()
        for(status in NativeAskRunState.statuses)NativeAskRunState.validate(receipt(id,client,status,conversation),request(client,conversation))
        for(status in listOf("missing","unknown","","stopped"))assertThrows(IllegalArgumentException::class.java) {
            NativeAskRunState.validate(receipt(id,client,status,conversation),request(client,conversation))
        }
        assertThrows(IllegalStateException::class.java) {
            NativeAskRunState.validate(receipt(id,UUID.randomUUID().toString(),"running",conversation),request(client,conversation))
        }
    }
    @Test fun `completion clears only its own unchanged composer draft and images`() {
        val id=UUID.randomUUID().toString();val message=UUID.randomUUID().toString();val image=UUID.randomUUID().toString()
        val body=request(id).put("attachmentIds",JSONArray().put(image))
        val state=JSONObject().put("messageId",message).put("activeRequest",body).put("question","Generated admitted question").put("attachments",JSONArray().put(JSONObject().put("id",image)))
        assertTrue(NativeAskRunState.completesCurrentDraft(state,message))
        state.put("question","Generated later draft");assertFalse(NativeAskRunState.completesCurrentDraft(state,message))
        state.put("question","Generated admitted question").put("attachments",JSONArray().put(JSONObject().put("id",UUID.randomUUID().toString())));assertFalse(NativeAskRunState.completesCurrentDraft(state,message))
        state.remove("activeRequest");assertFalse(NativeAskRunState.completesCurrentDraft(state,message))
        assertFalse(NativeAskRunState.completesCurrentDraft(state,UUID.randomUUID().toString()))
    }
    @Test fun `busy covers pending and every accepted server state`() {
        val pending=JSONObject().put("pending",request(UUID.randomUUID().toString()));assertTrue(NativeAskRunState.busy(pending))
        for(status in NativeAskRunState.active)assertTrue(NativeAskRunState.busy(JSONObject().put("runStatus",status)))
        for(status in NativeAskRunState.terminal)assertFalse(NativeAskRunState.busy(JSONObject().put("runStatus",status)))
    }
}
