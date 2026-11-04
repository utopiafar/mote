package dev.mote.collector.plugins

import dev.mote.collector.ByteCipher
import dev.mote.collector.FileArchiveQueue
import dev.mote.collector.LocalSource
import dev.mote.collector.LocalSourceStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** The source provider owns configuration, scheduling and SAF revocation
 * without Android Activities, WorkManager or a real user grant. */
class SourceProviderPluginTest {
    @get:Rule val folder = TemporaryFolder()

    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 41).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }

    private class Scheduler : SourceScheduler {
        var schedules = 0
        var uploads = 0
        var cancelsAll = 0
        val cancelled = mutableListOf<String>()
        override fun schedule(manual: Boolean, syncExplicit: Boolean) { schedules++ }
        override fun upload(explicit: Boolean) { uploads++ }
        override fun cancel(sourceId: String) { cancelled += sourceId }
        override fun cancelAll() { cancelsAll++ }
    }

    private fun source(id: String = "generated-source", uri: String = "content://generated/tree/root") =
        LocalSource(id = id, name = "Generated source", kind = "local-files", retention = "archive", uri = uri, tree = true)

    private fun started(grants: MutableMap<String, Boolean>): Triple<NativePluginHost, SourceOwner, Scheduler> {
        val store = LocalSourceStore(folder.newFolder(), cipher)
        val queue = FileArchiveQueue(folder.newFolder(), cipher, store)
        val host = NativePluginHost(NativePluginRegistry())
        val identity = PluginInstanceIdentity(SourceProviderPlugin.INSTANCE_ID, "generated-installation", SourceProviderPlugin.INSTANCE_ID)
        val scope = (host.createScope(PluginInstanceDescriptor(identity, setOf("sources"))) as PluginResult.Ok).value
        val scheduler = Scheduler()
        val owner = (host.startPlugin(scope) {
            SourceProviderPlugin.open(host, scope, store, queue, scheduler, authorization = { grants[it.id] != false }, cipher = cipher)
        } as PluginResult.Ok).value
        return Triple(host, owner, scheduler)
    }

    @Test fun builtinProviderRegistersForTheSourceScope() {
        val registry = NativePluginRegistry().apply { SourceProviderPlugin.register(this, "generated-build") }
        assertEquals(PluginAvailability.ACTIVE, registry.availability(SourceProviderPlugin.requirement()))
        assertNotNull(registry.provider(SourceProviderPlugin.CAPABILITY, SourceProviderPlugin.API_VERSION))
    }

    @Test fun revokedSafGrantStopsThatSourceAndCancelsItsWorkWhileSiblingsContinue() {
        val grants = mutableMapOf("revoked" to false, "kept" to true)
        val (_, owner, scheduler) = started(grants)
        owner.save(source("revoked", "content://generated/tree/revoked"))
        owner.save(source("kept", "content://generated/tree/kept"))
        val revoked = owner.reconcileAuthorization()
        assertEquals(listOf("revoked"), revoked.map { it.sourceId })
        assertEquals("permission", owner.state(owner.source("revoked")!!).getString("status"))
        assertTrue("permission", owner.snapshots("revoked", 0, 20).single().state.getString("status") == "permission")
        assertEquals(listOf("revoked"), scheduler.cancelled)
        assertEquals("the sibling source keeps its schedule", 0, scheduler.cancelsAll)
        assertNull(owner.snapshots("kept", 0, 20).single().state.optString("status").takeIf { it == "permission" })
    }

    @Test fun lastRevokedSourceCancelsTheGlobalWorkManagerChains() {
        val (_, owner, scheduler) = started(mutableMapOf("only" to false))
        owner.save(source("only"))
        assertEquals(listOf("only"), owner.reconcileAuthorization().map { it.sourceId })
        assertTrue(scheduler.cancelsAll > 0)
    }

    @Test fun removeCannotResurrectTheSourceAndCancelsOnlyItsOwnChain() {
        val (_, owner, scheduler) = started(mutableMapOf("one" to true, "two" to true))
        owner.save(source("one"))
        owner.save(source("two"))
        val removed = owner.source("one")!!
        owner.remove(removed.id)
        assertNull(owner.source(removed.id))
        assertEquals(listOf("one"), scheduler.cancelled)
        assertTrue(scheduler.schedules > 0)
        assertEquals(1, owner.sources().size)
    }

    @Test fun savingASourceSchedulesTheOwnedWorkAndKeepsTheExactConfiguration() {
        val (_, owner, scheduler) = started(mutableMapOf("saved" to true))
        val saved = source("saved")
        owner.save(saved)
        assertEquals(saved, owner.source("saved"))
        assertEquals(1, scheduler.schedules)
    }

    @Test fun stoppingTheScopeDisposesTheOwnerAndRejectsFurtherSourceWork() {
        val (host, owner, _) = started(mutableMapOf("saved" to true))
        owner.save(source("saved"))
        assertTrue(owner.active)
        host.stopScope(SourceProviderPlugin.INSTANCE_ID)
        assertFalse(owner.active)
        assertThrows(IllegalStateException::class.java) { owner.schedule() }
        assertThrows(IllegalStateException::class.java) { owner.save(source("saved")) }
    }
}
