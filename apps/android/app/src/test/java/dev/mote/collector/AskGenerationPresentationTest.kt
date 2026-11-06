package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AskGenerationPresentationTest {
    private fun running(adopted: Boolean = false) = JSONObject().put("runId", "run-1").put("runStatus", "running").apply {
        if (!adopted) put("activeRequest", JSONObject().put("id", "run-1"))
    }

    @Test fun `an answering run offers only stop`() {
        val state = AskGenerationPresentation.read(running(), text = "下一问", imagesPending = false, offline = false)
        assertTrue(state.busy)
        assertTrue(state.stop)
        assertFalse(state.retry)
        assertFalse(state.check)
        assertFalse(state.canSend)
    }

    @Test fun `an adopted answering run also offers only stop`() {
        val state = AskGenerationPresentation.read(running(adopted = true), text = "", imagesPending = false, offline = false)
        assertTrue(state.stop)
        assertFalse(state.check)
        assertFalse(state.canSend)
    }

    @Test fun `an unconfirmed request offers retry and check but never stop`() {
        val state = AskGenerationPresentation.read(
            JSONObject().put("pending", JSONObject().put("id", "request-1")),
            text = "",
            imagesPending = false,
            offline = false,
        )
        assertFalse(state.stop)
        assertTrue(state.retry)
        assertTrue(state.check)
        assertFalse(state.canSend)
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
