package dev.mote.collector

import android.os.Build
import android.os.SystemClock
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicInteger

/** Explicit fileFixture selection only. Synthetic device facts enter the actual Activity;
 * no selected queue, preferences, capture services or server are modified by this fixture.
 * QA must perform the package's host raw preflight before instrumentation starts Application. */
@RunWith(AndroidJUnit4::class)
class CaptureStatusReadInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private class Control : Executor {
        val work = ConcurrentLinkedQueue<Runnable>()
        val ui = ConcurrentLinkedQueue<Runnable>()
        val reads = AtomicInteger()
        var folders = 2
        var failRead = false
        var duringRead: ((Int) -> Unit)? = null
        override fun execute(command: Runnable) { work.add(command) }
        fun read(): CaptureOverview.Facts {
            duringRead?.invoke(reads.incrementAndGet())
            if (failRead) throw java.io.IOException("Generated status read failure")
            return CaptureOverview.Facts(false, "paused", "Generated status", true,
                false, false, false, null, false, false, false, false,
                false, folders, false, false, "idle", 0, false)
        }
        fun runNext() { requireNotNull(work.poll()).run() }
    }
    private fun waitFor(label: String, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 5000
        while (!condition()) { check(SystemClock.elapsedRealtime() < deadline) { label }; Thread.sleep(20) }
    }
    private fun generatedJourney(run: (ActivityScenario<CaptureStatusActivity>, Control) -> Unit) {
        val context = instrumentation.targetContext
        require(context.packageName == "dev.mote.collector.filefixture" && Build.FINGERPRINT.contains("emu64a"))
        require(InstrumentationRegistry.getArguments().getString("captureStatusReadFixture") == "true")
        val original = CaptureStatusActivity.readHooks
        require(original == null) { "Another status reader fixture owns the hooks" }
        val control = Control()
        try {
            CaptureStatusActivity.readHooks = CaptureStatusActivity.ReadHooks(control, control::read) { control.ui.add(it) }
            ActivityScenario.launch(CaptureStatusActivity::class.java).use { scenario ->
                instrumentation.waitForIdleSync()
                scenario.moveToState(Lifecycle.State.STARTED)
                waitFor("the actual Activity accepts its initial status read") { control.work.isNotEmpty() }
                run(scenario, control)
            }
        } finally { CaptureStatusActivity.readHooks = original }
    }
    private fun deliver(control: Control) = instrumentation.runOnMainSync(requireNotNull(control.ui.poll()))
    private fun folderText(scenario: ActivityScenario<CaptureStatusActivity>): String {
        var text = ""
        scenario.onActivity { text = it.window.decorView.findViewWithTag<TextView>("capture-status-folders-state").text.toString() }
        return text
    }

    @Test fun slowReadBurstUsesOneLatestFollowUpAndFailureKeepsTheLastView() = generatedJourney { scenario, control ->
        control.duringRead = { n -> if (n == 1) scenario.onActivity { activity -> repeat(10) { activity.render() } } }
        control.runNext()
        assertEquals(1, control.reads.get()); assertEquals(1, control.work.size); assertEquals(1, control.ui.size)
        deliver(control)
        assertEquals(MoteI18n.text("{0} 个文件夹", 2), folderText(scenario))
        control.folders = 3; control.runNext(); deliver(control)
        assertEquals(2, control.reads.get()); assertTrue(control.work.isEmpty())
        assertEquals(MoteI18n.text("{0} 个文件夹", 3), folderText(scenario))
        control.failRead = true
        scenario.onActivity { it.render() }; control.runNext(); deliver(control)
        assertEquals("read failure preserves the last actual Activity view", MoteI18n.text("{0} 个文件夹", 3), folderText(scenario))
        assertEquals(3, control.reads.get()); assertTrue(control.work.isEmpty()); assertTrue(control.ui.isEmpty())
    }

    @Test fun destructionDropsAnAlreadyPostedUiResultAndTheQueuedFollowUp() = generatedJourney { scenario, control ->
        control.runNext(); deliver(control)
        var row: TextView? = null; var activity: CaptureStatusActivity? = null
        scenario.onActivity { current -> activity = current; row = current.window.decorView.findViewWithTag("capture-status-folders-state") }
        val previous = requireNotNull(row).text.toString()
        control.folders = 9
        control.duringRead = { n -> if (n == 2) scenario.onActivity { current -> repeat(10) { current.render() } } }
        scenario.onActivity { it.render() }; control.runNext()
        assertEquals(1, control.ui.size); assertEquals(1, control.work.size)
        scenario.close()
        control.runNext()
        assertEquals("queued reads do not start after Activity destruction", 2, control.reads.get())
        deliver(control)
        assertEquals("the actual posted UI callback cannot overwrite the destroyed view", previous, requireNotNull(row).text.toString())
        instrumentation.runOnMainSync { requireNotNull(activity).render() }
        assertTrue(control.work.isEmpty()); assertTrue(control.ui.isEmpty())
    }

    @Test fun destructionDuringTheReadDropsItsResultAndMergedRequests() = generatedJourney { scenario, control ->
        control.duringRead = {
            scenario.onActivity { activity -> repeat(10) { activity.render() } }
            scenario.close() // The read has entered, but has not returned its facts.
        }
        control.runNext()
        assertEquals(1, control.reads.get())
        assertTrue("no result is posted by the read that finishes after destruction", control.ui.isEmpty())
        assertTrue("destruction cancels the merged follow-up", control.work.isEmpty())
    }
}
