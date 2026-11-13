package dev.mote.collector

import dev.mote.collector.plugins.NativeAskController
import dev.mote.collector.plugins.NativeAskDraftStorage
import dev.mote.collector.plugins.NativeAskPlugin
import dev.mote.collector.plugins.NativePluginHost
import dev.mote.collector.plugins.NativePluginRegistry
import dev.mote.collector.plugins.PluginAvailability
import dev.mote.collector.plugins.PluginInstanceDescriptor
import dev.mote.collector.plugins.PluginInstanceIdentity
import dev.mote.collector.plugins.PluginResult
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.UUID

/** Ask is one plugin-owned queue admission and draft journal. The generated
 * store survives view recreate; the exact client request id is retried only
 * while the receipt is unconfirmed, and a draft never migrates into another
 * conversation. */
class NativeAskPluginTest {
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 71).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }

    private fun temporary(test: (java.io.File) -> Unit) {
        val directory = Files.createTempDirectory("mote-ask-plugin-").toFile()
        try { test(directory) } finally { directory.deleteRecursively() }
    }

    private fun storage(directory: java.io.File) = NativeAskDraftStorage(CentralStateFile(directory, "ask", cipher))

    private fun receipt(body: JSONObject, status: String = "accepted", id: String = UUID.randomUUID().toString()) = JSONObject()
        .put("id", id).put("conversationId", body.getString("conversationId"))
        .put("clientRequestId", body.getString("clientRequestId")).put("status", status)
        .put("seq", 0).put("revision", 1)

    @Test fun builtinProviderRegistersTheAskScopeAndItsDurableServices() {
        val registry = NativePluginRegistry().apply { NativeAskPlugin.register(this, "generated-build") }
        assertEquals(PluginAvailability.ACTIVE, registry.availability(NativeAskPlugin.requirement()))
        val host = NativePluginHost(registry)
        val identity = PluginInstanceIdentity("dev.mote.ask", "generated-installation", NativeAskPlugin.INSTANCE_ID)
        val scope = (host.createScope(PluginInstanceDescriptor(identity, setOf(NativeAskPlugin.CAPABILITY), requires = listOf(NativeAskPlugin.requirement()))) as PluginResult.Ok).value
        temporary { directory ->
            val owner = NativeAskPlugin.open(scope, storage(directory))
            assertNotNull(owner.controller(directory))
            assertEquals(setOf("ask.draft", "ask.runs"), scope.services.keys)
            assertTrue(scope.jobs.containsKey("ask.draft"))
        }
    }

    @Test fun recreatedActivityRestoresTheAcceptedMessageWithoutAnotherSubmission() = temporary { directory ->
        val conversation = UUID.randomUUID().toString()
        val first = NativeAskController(storage(directory))
        first.restore()
        first.attachConversation(conversation)
        val admitted = requireNotNull(first.admission("Generated admitted question", "UTC"))
        first.receive(receipt(admitted, status = "running"), admitted)
        first.persistNow()

        val recreated = NativeAskController(storage(directory))
        val restored = recreated.restore()
        assertTrue(recreated.busy())
        assertEquals(admitted.getString("conversationId"), restored.getString("conversationId"))
        assertEquals("running", restored.getString("runStatus"))
        assertTrue(recreated.messageId().isNotBlank())
        assertFalse("an accepted message has no pending retry body", restored.has("pending"))
        assertNull("a running message cannot submit a second request", recreated.admission("Generated later question", "UTC"))
        assertEquals("the recreated view did not repeat the admission", conversation, restored.getString("conversationId"))
    }

    @Test fun aListQuestionStartsANewThreadWithoutDroppingItsStagedImages() = temporary { directory ->
        val controller = NativeAskController(storage(directory))
        controller.restore()
        val selected = UUID.randomUUID().toString()
        controller.replace(JSONObject()
            .put("conversationId", UUID.randomUUID().toString())
            .put("messageId", UUID.randomUUID().toString()).put("runStatus", "running")
            .put("question", "Generated prior question")
            .put("attachments", JSONArray().put(JSONObject().put("id", UUID.randomUUID().toString())))
            .put("imageUploads", JSONObject().put("file:///generated-image", JSONObject().put("status", "pending"))))
        controller.startConversation("Generated list question", selected)
        assertEquals("Generated list question", controller.state.getString("question"))
        assertEquals(1, controller.state.getJSONArray("attachments").length())
        assertEquals("pending", controller.state.getJSONObject("imageUploads").getJSONObject("file:///generated-image").getString("status"))
        assertEquals(selected, controller.state.getString("conversationId"))
        assertFalse(controller.state.has("messageId"))
        assertFalse(controller.state.has("runStatus"))
    }

    @Test fun recreatedActivityRetriesTheExactUnconfirmedAdmissionInsteadOfCreatingANewOne() = temporary { directory ->
        val first = NativeAskController(storage(directory))
        first.restore()
        first.attachConversation(UUID.randomUUID().toString())
        val request = requireNotNull(first.admission("Generated uncertain question", "UTC"))
        first.persistNow()

        val recreated = NativeAskController(storage(directory))
        val restored = recreated.restore()
        assertTrue(restored.has("pending"))
        assertEquals(request.getString("clientRequestId"), recreated.currentId())
        assertEquals(request.toString(), requireNotNull(recreated.admission("Generated edited question", "UTC")).toString())
        assertEquals("the retry keeps the original client request id", request.getString("clientRequestId"), recreated.currentId())
    }

    @Test fun aTerminalFailureRetriesAsANewQuestionInsteadOfReplayingTheFailedMessage() = temporary { directory ->
        val controller = NativeAskController(storage(directory))
        controller.restore()
        controller.attachConversation(UUID.randomUUID().toString())
        val failed = requireNotNull(controller.admission("Generated failed question", "UTC"))
        controller.receive(receipt(failed, status = "failed"), failed)
        assertEquals("failed", controller.status())
        assertNull("a failed terminal message is not retryable as the same request", controller.state.optJSONObject("activeRequest"))
        val next = requireNotNull(controller.admission("Generated retry question", "UTC"))
        assertNotEquals(failed.getString("clientRequestId"), next.getString("clientRequestId"))
        assertEquals("Generated retry question", next.getString("question"))
    }

    @Test fun aMissingAcceptedMessageRestoresTheExactUnconfirmedBody() = temporary { directory ->
        val controller = NativeAskController(storage(directory))
        controller.restore()
        controller.attachConversation(UUID.randomUUID().toString())
        val request = requireNotNull(controller.admission("Generated missing question", "UTC"))
        val receipt = receipt(request, status = "running")
        controller.receive(receipt, request)
        assertTrue(controller.missingRun())
        assertEquals("the check action retries the original request id",
            request.getString("clientRequestId"), requireNotNull(controller.admission("Generated later question", "UTC")).getString("clientRequestId"))
    }

    @Test fun aRejectedAdmissionKeepsTheDraftEditableInsteadOfLockingTheExactBody() = temporary { directory ->
        val controller = NativeAskController(storage(directory))
        controller.restore()
        controller.attachConversation(UUID.randomUUID().toString())
        controller.editQuestion("Generated rejected question")
        val rejected = requireNotNull(controller.admission("Generated rejected question", "UTC"))
        controller.rejectedAdmission()
        assertFalse(controller.state.has("pending"))
        assertEquals("Generated rejected question", controller.state.getString("question"))
        val next = requireNotNull(controller.admission("Generated corrected question", "UTC"))
        assertNotEquals(rejected.getString("clientRequestId"), next.getString("clientRequestId"))
        assertEquals("Generated corrected question", next.getString("question"))
    }

    @Test fun anAcceptedMessageFromAnotherDeviceIsReadableButNeverResubmitted() = temporary { directory ->
        val message = UUID.randomUUID().toString()
        val conversation = UUID.randomUUID().toString()
        val controller = NativeAskController(storage(directory))
        controller.replace(JSONObject()
            .put("conversationId", conversation).put("messageId", message).put("runStatus", "running"))
        val restored = controller.state
        assertTrue(controller.busy())
        assertEquals(message, controller.currentId())
        assertEquals(conversation, restored.getString("conversationId"))
        assertFalse(restored.has("pending"))
        assertFalse("an adopted message has no local body to retry", controller.missingRun())
        assertNull("an adopted running message cannot submit a second request", controller.admission("Generated unrelated question", "UTC"))
    }

    @Test fun draftsStayInsideTheirConversationAndNeverAdoptAnotherConversationsMessage() = temporary { directory ->
        val first = UUID.randomUUID().toString()
        val second = UUID.randomUUID().toString()
        val controller = NativeAskController(storage(directory))
        controller.restore()
        controller.selectConversation(first)
        controller.editQuestion("Generated first conversation draft")
        controller.persistNow()
        assertEquals("Generated first conversation draft", storage(directory).read().getString("question"))

        controller.selectConversation(second)
        controller.persistNow()
        val switched = storage(directory).read()
        assertEquals(second, switched.getString("conversationId"))
        assertEquals("", switched.getString("question"))
        assertEquals(0, switched.optJSONArray("attachments")?.length() ?: 0)
        assertFalse(switched.has("imageUploads"))

        controller.editQuestion("Generated second conversation draft")
        controller.replace(JSONObject(controller.state.toString())
            .put("messageId", UUID.randomUUID().toString()).put("runStatus", "running"))
        assertEquals("Generated second conversation draft", controller.state.getString("question"))
    }

    @Test fun newConversationClearsOnlyTheUnsentDraftAndMessageIdentity() = temporary { directory ->
        val conversation = UUID.randomUUID().toString()
        val controller = NativeAskController(storage(directory))
        controller.restore()
        controller.selectConversation(conversation)
        controller.editQuestion("Generated discarded question")
        controller.state.put("runStatus", "completed").put("messageId", UUID.randomUUID().toString())
        controller.newConversation()
        assertFalse(controller.state.has("conversationId"))
        assertFalse(controller.state.has("messageId"))
        assertFalse(controller.state.has("runStatus"))
        assertEquals("", controller.state.getString("question"))
    }
}
