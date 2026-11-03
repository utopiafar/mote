package dev.mote.collector.plugins

import org.junit.Assert.*
import org.junit.Test

/** The storage plugin owns one accepted backup operation: an Activity recreate
 * only swaps the observer, accepted work keeps running and its result is
 * published exactly once. */
class StorageBackupPluginTest {
    private class Watcher : BackupObserver {
        val progress = mutableListOf<BackupSnapshot>()
        val results = mutableListOf<BackupCompletion>()
        override fun onBackupProgress(snapshot: BackupSnapshot) { progress += snapshot }
        override fun onBackupResult(completion: BackupCompletion) { results += completion }
    }

    private fun scope(): Pair<NativePluginHost, PluginOwnerSession> {
        val host = NativePluginHost(NativePluginRegistry())
        val identity = PluginInstanceIdentity("dev.mote.storage-backup", "generated-installation", StorageBackupPlugin.INSTANCE_ID)
        val admitted = host.createScope(PluginInstanceDescriptor(identity, setOf(StorageBackupPlugin.CAPABILITY)))
        return host to (admitted as PluginResult.Ok).value
    }

    private fun snapshot(kind: BackupKind = BackupKind.EXPORT) =
        BackupSnapshot(kind, "Generated backup", "Generated state", "Generated heading", "Generated progress", request = 12)

    @Test fun builtinProviderBelongsToTheStorageBackupPlugin() {
        val registry = NativePluginRegistry().apply { registerBuiltinPlugins("generated-build") }
        assertEquals(PluginAvailability.ACTIVE, registry.availability(StorageBackupPlugin.requirement()))
        assertEquals("generated-build", registry.provider(StorageBackupPlugin.CAPABILITY, StorageBackupPlugin.API_VERSION)?.buildId)
    }

    @Test fun acceptedBackupOperationSurvivesRecreateAndPublishesOneResult() {
        val (host, ownerScope) = scope()
        val queued = ArrayDeque<Runnable>()
        val owner = StorageBackupPlugin.open(host, ownerScope, execute = { queued.addLast(it) }, post = { it.run() })
        var runs = 0
        val first = Watcher()
        assertNull(owner.attach(first))
        assertTrue(owner.operationEngine.start(snapshot()) {
            runs++
            it.message("Generated accepted write")
            BackupOutcome.Exported(12, includeToken = false)
        })
        assertEquals("accepted work is dispatched once", 1, queued.size)
        assertEquals(1, first.progress.size)

        // Activity recreate: the old observer leaves before the write completes.
        owner.detach(first)
        queued.removeFirst().run()
        assertEquals("accepted write completes while the view is gone", 1, runs)
        assertTrue(first.results.isEmpty())

        val second = Watcher()
        assertNull("a ready result is claimed by the recreated view", owner.attach(second))
        assertEquals(1, second.results.size)
        assertTrue(second.results.single().outcome.getOrThrow() is BackupOutcome.Exported)
        assertNull(owner.attach(second))
        assertEquals("the one result is never published twice", 1, second.results.size)
        assertFalse(owner.busy)
        assertTrue("the plugin still owns its scope", owner.active)
        assertEquals(setOf("storage.locations", "storage.statistics", "storage.backup"), ownerScope.services.keys)
    }

    @Test fun attachedObserverReceivesProgressAndTheResultOnlyOnce() {
        val (host, ownerScope) = scope()
        val queued = ArrayDeque<Runnable>()
        val owner = StorageBackupPlugin.open(host, ownerScope, execute = { queued.addLast(it) }, post = { it.run() })
        val watcher = Watcher()
        assertTrue(owner.operationEngine.start(snapshot()) {
            it.message("Generated progress one")
            it.message("Generated progress two")
            BackupOutcome.Exported(12, includeToken = true)
        })
        owner.attach(watcher)
        queued.removeFirst().run()
        assertEquals(1, watcher.results.size)
        assertEquals("Generated progress two", watcher.progress.last().message)
        assertTrue((watcher.results.single().outcome.getOrThrow() as BackupOutcome.Exported).includeToken)
        assertNull(owner.operationEngine.attach(watcher))
        assertEquals(1, watcher.results.size)
    }

    @Test fun leavingThePageDropsTheUnclaimedResultButAcceptedWorkFinishesOnce() {
        val (host, ownerScope) = scope()
        val queued = ArrayDeque<Runnable>()
        val owner = StorageBackupPlugin.open(host, ownerScope, execute = { queued.addLast(it) }, post = { it.run() })
        var runs = 0
        assertTrue(owner.operationEngine.start(snapshot()) { runs++; BackupOutcome.Exported(12, includeToken = false) })
        owner.abandonSurface()
        queued.removeFirst().run()
        assertEquals(1, runs)
        val later = Watcher()
        assertNull(owner.attach(later))
        assertTrue(later.results.isEmpty())
        assertFalse(owner.busy)
    }

    @Test fun onlyOneStorageBackupOperationIsAcceptedAndAStoppedScopeRefusesMore() {
        val (host, ownerScope) = scope()
        val queued = ArrayDeque<Runnable>()
        val owner = StorageBackupPlugin.open(host, ownerScope, execute = { queued.addLast(it) }, post = { it.run() })
        assertTrue(owner.operationEngine.start(snapshot()) { BackupOutcome.Exported(12, includeToken = false) })
        assertFalse("a second accepted operation would duplicate the one result", owner.operationEngine.start(snapshot(BackupKind.RESTORE_PREPARE)) {
            BackupOutcome.RestorePrepared("generated.zip", 1, "generated-origin")
        })
        assertEquals(1, queued.size)
        host.stopScope(StorageBackupPlugin.INSTANCE_ID)
        assertFalse(owner.active)
        assertFalse("a stopped scope accepts no new storage or backup work", owner.export("content://generated/archive.zip", 12, false, null))
    }
}
