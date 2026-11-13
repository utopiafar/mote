package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class AskGenerationPresentationTest {
    private fun running(status: String = "running", adopted: Boolean = false) = JSONObject()
        .put("messageId", UUID.randomUUID().toString()).put("runStatus", status).apply {
            if (!adopted) put("activeRequest", JSONObject().put("clientRequestId", UUID.randomUUID().toString()))
        }

    @Test fun `an answering run offers only stop`() {
        val state = AskGenerationPresentation.read(running(), text = "下一问", imagesPending = false, offline = false)
        assertTrue(state.busy)
        assertTrue(state.stop)
        assertFalse(state.retry)
        assertFalse(state.check)
        assertFalse(state.canSend)
    }

    @Test fun `accepted and queued messages also offer stop without inventing a retry body`() {
        for (status in listOf("accepted", "queued")) {
            val state = AskGenerationPresentation.read(running(status), text = "", imagesPending = false, offline = false)
            assertTrue(status, state.busy)
            assertTrue(status, state.stop)
            assertFalse(status, state.retry)
            assertFalse(status, state.check)
            assertFalse(status, state.canSend)
        }
    }

    @Test fun `an adopted answering message keeps stop and its read-only check`() {
        val state = AskGenerationPresentation.read(running(adopted = true), text = "", imagesPending = false, offline = false)
        assertTrue(state.stop)
        assertTrue(state.check)
        assertFalse(state.canSend)
    }

    @Test fun `an unconfirmed request offers retry and check but never stop`() {
        val state = AskGenerationPresentation.read(
            JSONObject().put("pending", JSONObject().put("clientRequestId", UUID.randomUUID().toString())),
            text = "",
            imagesPending = false,
            offline = false,
        )
        assertFalse(state.stop)
        assertTrue(state.retry)
        assertTrue(state.check)
        assertFalse(state.canSend)
    }

    @Test fun `a terminal message is idle and can send the next draft`() {
        for (status in listOf("completed", "failed", "cancelled")) {
            val state = AskGenerationPresentation.read(running(status), text = "下一问", imagesPending = false, offline = false)
            assertFalse(status, state.busy)
            assertFalse(status, state.stop)
            assertFalse(status, state.retry)
            assertFalse(status, state.check)
            assertTrue(status, state.canSend)
        }
    }

    @Test fun `offline keeps the retry banner and disables the composer`() {
        val state = AskGenerationPresentation.read(JSONObject(), text = "问题", imagesPending = false, offline = true)
        assertTrue(state.offline)
        assertFalse(state.canSend)
        assertFalse(state.stop)
        assertFalse(state.retry)
        assertFalse(state.check)
    }

    @Test fun `an idle composer sends only non-blank text without pending images`() {
        assertFalse(AskGenerationPresentation.read(JSONObject(), "  ", false, false).canSend)
        assertFalse(AskGenerationPresentation.read(JSONObject(), "问题", true, false).canSend)
        assertFalse(AskGenerationPresentation.read(JSONObject(), "问题", false, false, allowed = false).canSend)
        assertTrue(AskGenerationPresentation.read(JSONObject(), "问题", false, false).canSend)
    }
}
