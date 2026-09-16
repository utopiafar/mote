package dev.mote.collector

import android.os.Build
import android.os.Looper
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Generated fixture Activity only; no real screen collection, model or network call. */
@RunWith(AndroidJUnit4::class)
class UiTaskInstrumentedTest {
    @Test fun slowWorkDoesNotBlockInputPollingStopsOnPauseAndDestroyedViewsReceiveNoResult() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        require(!Settings(context).enabled && !CaptureAccessibilityService.connected && !ProjectionService.running)
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val finishedWork = CountDownLatch(1)
        val progress = AtomicInteger(); val completed = AtomicInteger()
        val scenario = ActivityScenario.launch(FixtureActivity::class.java)
        try {
            scenario.onActivity { activity ->
                val task = UiTask(activity)
                assertTrue(task.start("生成数据后台任务", { progress.incrementAndGet() }, {
                    assertNotEquals(Looper.getMainLooper(), Looper.myLooper())
                    entered.countDown(); check(release.await(10, TimeUnit.SECONDS)); finishedWork.countDown()
                }) { completed.incrementAndGet() })
                assertFalse(task.start("重复操作", {}, {}) {})
            }
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            val heartbeat = CountDownLatch(1)
            scenario.onActivity { heartbeat.countDown() }
            assertTrue(heartbeat.await(1, TimeUnit.SECONDS))
            Thread.sleep(650); assertTrue(progress.get() >= 2)
            scenario.moveToState(Lifecycle.State.CREATED)
            val paused = progress.get(); Thread.sleep(650); assertEquals(paused, progress.get())
            scenario.moveToState(Lifecycle.State.RESUMED)
            Thread.sleep(650); assertTrue(progress.get() > paused)
            scenario.close(); val destroyed = progress.get()
            release.countDown(); assertTrue(finishedWork.await(2, TimeUnit.SECONDS))
            Thread.sleep(650); assertEquals(destroyed, progress.get()); assertEquals(0, completed.get())
        } finally { release.countDown(); scenario.close() }
    }
    @Test fun rejectedExecutorFinishesInsteadOfLeavingTaskBusy() {
        val done = CountDownLatch(1)
        val executor = java.util.concurrent.Executors.newSingleThreadExecutor().apply { shutdown() }
        ActivityScenario.launch(FixtureActivity::class.java).use { scenario ->
            lateinit var task: UiTask
            scenario.onActivity { activity ->
                task = UiTask(activity, executor, false)
                assertTrue(task.start("合成拒绝任务", {}, { error("must not run") }) { result ->
                    assertTrue(result.exceptionOrNull() is java.util.concurrent.RejectedExecutionException)
                    assertFalse(task.busy); done.countDown()
                })
            }
            assertTrue(done.await(3, TimeUnit.SECONDS))
        }
    }
}
