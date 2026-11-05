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

/** Ask is one plugin-owned run ticket and draft journal. The generated store
 * survives view recreate; an in-flight run is adopted, never resubmitted, and
 * a draft never migrates into another conversation. */
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

    private fun run(id: String, conversation: String, status: String = "running") = JSONObject()
        .put("id", id).put("status", status).put("conversationId", conversation)

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

    @Test fun recreatedActivityRestoresTheRunningTicketWithoutAnotherSubmission() = temporary { directory ->
        val conversation = UUID.randomUUID().toString()
        val first = NativeAskController(storage(directory))
        first.restore(JSONArray())
        var submissions = 0
        fun submit(controller: NativeAskController, question: String): String? {
            val admitted = controller.admission(question, "UTC") ?: return null
            submissions++
            controller.receive(run(admitted.getString("id"), conversation), admitted.getString("id"), admitted)
            return admitted.getString("id")
        }
        val id = requireNotNull(submit(first, "Generated admitted question"))
        first.persistNow()
        assertEquals(1, submissions)

        val recreated = NativeAskController(storage(directory))
        val restored = recreated.restore(JSONArray().put(run(id, conversation)))
        assertTrue(recreated.busy())
        assertEquals(id, recreated.currentId())
        assertEquals("running", restored.getString("runStatus"))
        assertFalse("an accepted ticket has no pending retry body", restored.has("pending"))
        assertNull("a running ticket cannot submit a second request", submit(recreated, "Generated later question"))
        assertEquals("the recreated view did not repeat the admission", 1, submissions)
        assertEquals(conversation, restored.getString("conversationId"))
    }

    @Test fun aListQuestionStartsANewThreadWithoutDroppingItsStagedImages() = temporary { directory ->
        val controller = NativeAskController(storage(directory))
        controller.restore(JSONArray())
        controller.replace(JSONObject()
            .put("conversationId", UUID.randomUUID().toString())
            .put("runId", UUID.randomUUID().toString()).put("runStatus", "running")
            .put("question", "Generated prior question")
            .put("attachments", JSONArray().put(JSONObject().put("id", UUID.randomUUID().toString())))
            .put("imageUploads", JSONObject().put("file:///generated-image", JSONObject().put("status", "pending"))))
        controller.startConversation("Generated list question")
        assertEquals("Generated list question", controller.state.getString("question"))
        assertEquals(1, controller.state.getJSONArray("attachments").length())
        assertEquals("pending", controller.state.getJSONObject("imageUploads").getJSONObject("file:///generated-image").getString("status"))
        assertFalse(controller.state.has("conversationId"))
        assertFalse(controller.state.has("runId"))
        assertFalse(controller.state.has("runStatus"))
    }

    @Test fun recreatedActivityRetriesTheExactUnconfirmedAdmissionInsteadOfCreatingANewOne() = temporary { directory ->
        val first = NativeAskController(storage(directory))
        first.restore(JSONArray())
        val request = requireNotNull(first.admission("Generated uncertain question", "UTC"))
        first.persistNow()

        val recreated = NativeAskController(storage(directory))
        val restored = recreated.restore(JSONArray())
        assertTrue(restored.has("pending"))
        assertEquals(request.getString("id"), recreated.currentId())
        assertEquals(request.toString(), requireNotNull(recreated.admission("Generated edited question", "UTC")).toString())
        assertEquals("the retry keeps the original admission identity", request.getString("id"), recreated.currentId())
    }

    @Test fun adoptedRunningRunFromAnotherDeviceIsReadableButNeverResubmitted() = temporary { directory ->
        val id = UUID.randomUUID().toString()
        val conversation = UUID.randomUUID().toString()
        val controller = NativeAskController(storage(directory))
        val restored = controller.restore(JSONArray().put(run(id, conversation)))
        assertEquals(id, restored.getString("runId"))
        assertEquals("running", restored.getString("runStatus"))
        assertEquals(conversation, restored.getString("conversationId"))
        assertFalse(restored.has("pending"))
        assertNull("an adopted run has no local body to retry", controller.admission("Generated unrelated question", "UTC"))
    }

    @Test fun draftsStayInsideTheirConversationAndNeverAdoptAnotherConversationsRun() = temporary { directory ->
        val first = UUID.randomUUID().toString()
        val second = UUID.randomUUID().toString()
        val controller = NativeAskController(storage(directory))
        controller.restore(JSONArray())
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
        val running = UUID.randomUUID().toString()
        controller.adoptRunning(JSONArray().put(run(running, first)), requestedConversation = second)
        assertFalse("another conversation's run is not adopted", controller.state.has("runId"))
        assertEquals("Generated second conversation draft", controller.state.getString("question"))
    }

    @Test fun newConversationClearsOnlyTheUnsentDraftAndRunIdentity() = temporary { directory ->
        val conversation = UUID.randomUUID().toString()
        val controller = NativeAskController(storage(directory))
        controller.restore(JSONArray())
        controller.selectConversation(conversation)
        controller.editQuestion("Generated discarded question")
        controller.state.put("runStatus", "completed").put("runId", UUID.randomUUID().toString())
        controller.newConversation()
        assertFalse(controller.state.has("conversationId"))
        assertFalse(controller.state.has("runId"))
        assertFalse(controller.state.has("runStatus"))
        assertEquals("", controller.state.getString("question"))
    }
}
