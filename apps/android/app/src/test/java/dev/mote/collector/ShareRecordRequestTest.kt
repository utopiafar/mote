package dev.mote.collector

import android.content.Intent
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class ShareRecordRequestTest {
    @Test fun `send link keeps its original and builds a compact preview without a draft mode`() {
        val request = ShareRecordRequest.share(
            Intent.ACTION_SEND, "低温慢烤牛肋排的时间表\nhttps://www.seriouseats.com/generated-recipe", null,
            emptyList(), null, "generated.sender",
        )
        assertEquals("share", request.origin.getString("kind"))
        assertEquals("低温慢烤牛肋排的时间表\nhttps://www.seriouseats.com/generated-recipe", request.origin.getString("text"))
        assertEquals("https://www.seriouseats.com/generated-recipe", request.origin.getString("url"))
        assertEquals("低温慢烤牛肋排的时间表", request.link?.title)
        assertEquals("www.seriouseats.com", request.link?.domain)
        assertEquals("generated.sender", request.origin.getString("app"))
        assertFalse(request.answer)
        assertFalse(request.origin.has("replaceDraft"))
    }

    @Test fun `send and send multiple retain every shared uri without replacement choices`() {
        val single = ShareRecordRequest.share(Intent.ACTION_SEND, "Generated shared text", null, listOf("content://generated/one"), null, null)
        assertEquals(listOf("content://generated/one"), single.streamUris)
        assertNull(single.link)
        val multiple = ShareRecordRequest.share(
            Intent.ACTION_SEND_MULTIPLE, null, null,
            listOf("content://generated/one", "content://generated/two"), null, null,
        )
        assertEquals(listOf("content://generated/one", "content://generated/two"), multiple.streamUris)
        assertEquals("", multiple.origin.getString("text"))
        assertThrows(IllegalArgumentException::class.java) {
            ShareRecordRequest.share(Intent.ACTION_SEND_MULTIPLE, null, null, List(11) { "content://generated/$it" }, null, null)
        }
    }

    @Test fun `answer request keeps exact source and shows only the formatted answer`() {
        val conversation = UUID.randomUUID().toString(); val turn = UUID.randomUUID().toString(); val citation = UUID.randomUUID().toString()
        val question = "Generated question"; val raw = question + "\n\n> **Generated answer** [$citation]"
        val request = ShareRecordRequest.answer(raw, conversation, turn, question, listOf(citation), "https://generated.example")
        assertTrue(request.answer)
        assertEquals(raw, request.origin.getString("text"))
        assertEquals(turn, request.origin.getJSONArray("messageIds").getString(0))
        assertEquals("Generated answer [1]", request.quote())
        assertEquals(request.presentation.toString(), NativeConversationQuote.snapshot(raw, question, listOf(citation), conversation, turn, "https://generated.example").toString())
        assertThrows(IllegalArgumentException::class.java) {
            ShareRecordRequest.answer(raw, conversation, turn, question, listOf(citation), null)
        }
    }

    @Test fun `data uri link can be saved even when the sender supplies no text`() {
        val request = ShareRecordRequest.share(Intent.ACTION_SEND, null, "Generated title", emptyList(), "https://generated.example/path", null)
        assertEquals(JSONObject().put("kind", "share").put("text", "").put("url", "https://generated.example/path").toString(), request.origin.toString())
        assertEquals("Generated title", request.link?.title)
        assertEquals("generated.example", request.link?.domain)
    }
}
