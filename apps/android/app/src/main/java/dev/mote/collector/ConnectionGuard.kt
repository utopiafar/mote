package dev.mote.collector

import android.content.Context
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantReadWriteLock

/** Serializes explicit connection changes against current upload/scan and capture work. */
object ConnectionGuard {
    private val lock = ReentrantReadWriteLock()
    val processing = AtomicInteger(0)
    fun changing() = lock.isWriteLocked
    fun configurationStamp(context: Context) = SourceRules.hash(Settings(context).read().toString())
    fun startCapture(context: Context, expectedStamp: String, start: () -> Unit): Boolean = sync {
        val settings = Settings(context)
        if (settings.enabled || expectedStamp != configurationStamp(context)) return@sync false
        settings.enabled = true
        try { start(); true } catch (e: Exception) { settings.enabled = false; throw e }
    } ?: false
    fun <T> sync(action: () -> T): T? {
        if (!lock.readLock().tryLock()) return null
        return try { action() } finally { lock.readLock().unlock() }
    }
    fun <T> change(context: Context, nextServer: String, bindLocal: Boolean = false, action: () -> T): T {
        if (!lock.writeLock().tryLock()) throw ConnectionFailure("busy")
        try {
            val settings = Settings(context)
            if (settings.enabled || ProjectionService.running || processing.get() > 0) throw ConnectionFailure("busy")
            val origin = settings.dataOrigin(); val next = nextServer.trim().trimEnd('/')
            val pending = settings.hasPendingData()
            if (pending && next.isNotBlank() && origin.isNotBlank() && origin != next) throw ConnectionFailure("pending")
            if (pending && next.isNotBlank() && origin.isBlank() && !bindLocal) throw ConnectionFailure("local_confirmation")
            // Do not replay already acknowledged snapshots into a different archive.
            if (!pending && origin.isNotBlank() && next != origin) context.localSources().resetSyncedSnapshots()
            return action()
        } finally { lock.writeLock().unlock() }
    }
}
