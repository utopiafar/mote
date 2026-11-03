package dev.mote.collector

import dev.mote.collector.plugins.NativePluginHost
import dev.mote.collector.plugins.NativePluginRegistry
import dev.mote.collector.plugins.NativeRequirement
import dev.mote.collector.plugins.NotesPlugin
import dev.mote.collector.plugins.PluginInstanceDescriptor
import dev.mote.collector.plugins.PluginInstanceIdentity
import dev.mote.collector.plugins.PluginOwnerSession
import dev.mote.collector.plugins.PluginResult
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.concurrent.Executors

class NotesPluginTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }

    private fun scope(): Pair<NativePluginHost, PluginOwnerSession> {
        val registry = NativePluginRegistry().apply { NotesPlugin.register(this, "test-build") }
        val host = NativePluginHost(registry)
        val identity = PluginInstanceIdentity(NotesPlugin.INSTANCE_ID, "generated-installation", NotesPlugin.INSTANCE_ID)
        val descriptor = PluginInstanceDescriptor(identity, setOf(NotesPlugin.CAPABILITY), requires = listOf(NativeRequirement(NotesPlugin.CAPABILITY, NotesPlugin.API_VERSION)))
        return host to (host.createScope(descriptor) as PluginResult.Ok).value
    }

    @Test fun `activity recreation keeps the draft and its attachment original`() {
        val (host, owner) = scope()
        val executor = Executors.newSingleThreadExecutor()
        try {
            val notes = NotesPlugin.open(host, owner, RecordDraftStore(folder.newFolder(), cipher), NoteDraftStore(folder.newFolder(), cipher), executor)
            val first = notes.view()
            val original = "Generated note draft\n保留原文与空格  ".toByteArray()
            val attachment = first.stage(original, "generated-original.jpg", "image/jpeg")
            first.edit("Generated note draft\n保留原文与空格  ", JSONArray().put(attachment), JSONObject().put("kind", "manual"), "Generated independent description")
            assertFalse(first.closed)

            first.close()
            val recreated = notes.view()
            val restored = recreated.draft()
            assertTrue(first.closed)
            assertEquals("Generated note draft\n保留原文与空格  ", restored.getString("text"))
            assertEquals("Generated independent description", restored.getString("description"))
            val restoredAttachment = restored.getJSONArray("attachments").getJSONObject(0)
            assertEquals(attachment.getString("id"), restoredAttachment.getString("id"))
            assertEquals("generated-original.jpg", restoredAttachment.getString("name"))
            assertEquals("image/jpeg", restoredAttachment.getString("mime"))
            assertArrayEquals(original, recreated.bytes(restoredAttachment.getString("id")))
            assertEquals(0, recreated.pendingMedia().length())
            recreated.close()
        } finally {
            executor.shutdownNow()
        }
    }
}
