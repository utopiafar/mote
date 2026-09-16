package dev.mote.collector

import android.content.Context
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantReadWriteLock

/** Serializes explicit connection changes against current upload/scan and capture work. */
object ConnectionGuard {
    private val lock = ReentrantReadWriteLock()
    private val updating = AtomicBoolean(false)
    val processing = AtomicInteger(0)
    fun changing() = lock.isWriteLocked || updating.get()
    fun reconfiguring() = updating.get()
    fun beginReconfiguration() = updating.compareAndSet(false, true)
    fun endReconfiguration() { updating.set(false) }
    fun configurationStamp(context: Context) = SourceRules.hash(Settings(context).read().toString())
    fun startCapture(context: Context, expectedStamp: String, start: () -> Unit): Boolean = sync {
        val settings = Settings(context)
        if (settings.enabled || expectedStamp != configurationStamp(context)) return@sync false
        settings.enabled = true
        try { start(); true } catch (e: Exception) { settings.enabled = false; throw e }
    } ?: false
    fun <T> sync(action: () -> T): T? {
        if (updating.get()) return null
        if (!lock.readLock().tryLock()) return null
        return try { if (updating.get()) null else action() } finally { lock.readLock().unlock() }
    }
    fun <T> reconfigure(context: Context, nextServer: String, bindLocal: Boolean = false, expected: CollectorConfig? = null, action: () -> T): T {
        check(updating.get())
        if (!lock.writeLock().tryLock(120, TimeUnit.SECONDS)) throw ConnectionFailure("busy")
        try {
            check(processing.get() == 0) { "采集处理尚未结束" }
            if (expected != null && Settings(context).read() != expected) throw SettingsChangedFailure()
            validateOrigin(context, nextServer, bindLocal)
            return action()
        } finally { lock.writeLock().unlock() }
    }
    private fun validateOrigin(context: Context, nextServer: String, bindLocal: Boolean) {
        val settings = Settings(context); val origin = settings.dataOrigin(); val next = nextServer.trim().trimEnd('/')
        if (next == origin && origin.isNotBlank()) return
        if (next.isBlank() && settings.read().server.isBlank()) return
        val pending = settings.hasPendingData()
        if (pending && next.isNotBlank() && origin.isNotBlank() && origin != next) throw ConnectionFailure("pending")
        if (pending && next.isNotBlank() && origin.isBlank() && !bindLocal) throw ConnectionFailure("local_confirmation")
        if (!pending && origin.isNotBlank() && next != origin) { context.localSources().resetSyncedSnapshots(); context.fileArchives().resetSynced() }
    }
    fun <T> change(context: Context, nextServer: String, bindLocal: Boolean = false, action: () -> T): T {
        if (updating.get() && lock.isWriteLockedByCurrentThread) { validateOrigin(context, nextServer, bindLocal); return action() }
        if (updating.get()) throw ConnectionFailure("busy")
        if (!lock.writeLock().tryLock()) throw ConnectionFailure("busy")
        try {
            val settings = Settings(context)
            if (settings.enabled || ProjectionService.running || processing.get() > 0) throw ConnectionFailure("busy")
            val origin = settings.dataOrigin(); val next = nextServer.trim().trimEnd('/')
            val pending = settings.hasPendingData()
            if (pending && next.isNotBlank() && origin.isNotBlank() && origin != next) throw ConnectionFailure("pending")
            if (pending && next.isNotBlank() && origin.isBlank() && !bindLocal) throw ConnectionFailure("local_confirmation")
            // Do not replay already acknowledged snapshots into a different archive.
            if (!pending && origin.isNotBlank() && next != origin) { context.localSources().resetSyncedSnapshots(); context.fileArchives().resetSynced() }
            return action()
        } finally { lock.writeLock().unlock() }
    }
}
