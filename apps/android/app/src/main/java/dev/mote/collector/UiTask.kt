package dev.mote.collector

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/** Work never calls a View. The foreground polls a small in-memory snapshot every 500 ms. */
internal class UiTask(
    private val activity: Activity,
    private val executor: ExecutorService = Executors.newSingleThreadExecutor(),
    private val ownsExecutor: Boolean = true,
) : Application.ActivityLifecycleCallbacks {
    class Progress internal constructor(label: String) {
        @Volatile var message: String = label
        internal val started = SystemClock.elapsedRealtime()
    }
    private val handler = Handler(Looper.getMainLooper())
    private var poll: (() -> Unit)? = null
    private var visible = true
    private var closed = false
    val busy get() = poll != null
    private val tick = object : Runnable {
        override fun run() {
            if (closed || !visible) return
            val current = poll
            current?.invoke()
            if (busy && poll === current) handler.postDelayed(this, 500)
        }
    }
    init { activity.application.registerActivityLifecycleCallbacks(this) }

    fun <T> start(label: String, progress: (String) -> Unit, work: (Progress) -> T, finished: (Result<T>) -> Unit): Boolean {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (closed || busy) return false
        val state = Progress(label)
        val result = AtomicReference<Result<T>?>(null)
        poll = {
            val completed = result.get()
            if (completed == null) progress("${state.message} · 已用 ${(SystemClock.elapsedRealtime() - state.started) / 1000} 秒")
            else { poll = null; finished(completed) }
        }
        progress(label)
        try {
            executor.execute {
                SupportEvents.record(activity.applicationContext, EventStage.UI, EventCode.STARTED)
                val outcome = runCatching { work(state) }
                SupportEvents.record(activity.applicationContext, EventStage.UI, outcome.exceptionOrNull()?.let { EventJournal.failure(it, EventStage.UI) } ?: EventCode.OK, SystemClock.elapsedRealtime() - state.started)
                result.set(outcome)
            }
        } catch (error: java.util.concurrent.RejectedExecutionException) {
            // A rejected submission still completes through the normal UI result path.
            result.set(Result.failure(error))
        }
        handler.removeCallbacks(tick); handler.post(tick)
        return true
    }
    override fun onActivityResumed(value: Activity) { if (value === activity) { visible = true; handler.removeCallbacks(tick); handler.post(tick) } }
    override fun onActivityPaused(value: Activity) { if (value === activity) { visible = false; handler.removeCallbacks(tick) } }
    override fun onActivityDestroyed(value: Activity) {
        if (value !== activity) return
        closed = true; poll = null; handler.removeCallbacks(tick)
        // Already accepted writes finish. Destruction never waits for storage or interrupts a commit.
        if (ownsExecutor) executor.shutdown()
        activity.application.unregisterActivityLifecycleCallbacks(this)
    }
    override fun onActivityCreated(value: Activity, state: Bundle?) = Unit
    override fun onActivityStarted(value: Activity) = Unit
    override fun onActivityStopped(value: Activity) = Unit
    override fun onActivitySaveInstanceState(value: Activity, state: Bundle) = Unit
}
