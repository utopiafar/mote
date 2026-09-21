package dev.mote.collector

import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Spinner
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test

/** Synthetic events only; never enables collection or a model. */
class ClientFeedbackInstrumentedTest {
    private var previousLanguage = "system"
    @org.junit.Before fun selectFixtureLanguage() {
        previousLanguage = MoteI18n.preference()
        MoteI18n.select(InstrumentationRegistry.getInstrumentation().targetContext, "zh-CN")
    }
    @org.junit.After fun restoreFixtureLanguage() {
        MoteI18n.select(InstrumentationRegistry.getInstrumentation().targetContext, previousLanguage)
    }

    @Test fun statisticsCanBrowsePastFirstPageWithoutExpandingAllDetails() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val ledger = Operations.ledger(context); ledger.reset()
        repeat(25) { ledger.record(OperationKind.CAPTURE_REQUESTED) }
        ActivityScenario.launch(ActivityStatsActivity::class.java).use { scenario ->
            var ready = false
            val deadline = android.os.SystemClock.elapsedRealtime() + 15000
            while (!ready && android.os.SystemClock.elapsedRealtime() < deadline) {
                scenario.onActivity { activity -> ready = views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.contains("最近固定结果 · 第 1 页") } }
                if (!ready) Thread.sleep(50)
            }
            assertTrue(ready)
            scenario.onActivity { activity ->
                repeat(2) { views(activity.window.decorView).filterIsInstance<android.widget.Button>().last { it.text.toString() == "下一页" }.performClick() }
                assertTrue(views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.contains("最近固定结果 · 第 3 页") })
                assertFalse(views(activity.window.decorView).filterIsInstance<android.widget.Button>().last { it.text.toString() == "下一页" }.isEnabled)
                assertTrue(views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.startsWith("生效设置\n") && it.visibility == View.GONE })
            }
        }
    }
    private fun views(root: View): List<View> = buildList {
        add(root); if (root is ViewGroup) for (i in 0 until root.childCount) addAll(views(root.getChildAt(i)))
    }
    @Test fun captureRecordsCanOpenAndRecreateWithoutMissingBackControl() {
        ActivityScenario.launch(CaptureRecordsActivity::class.java).use { scenario ->
            scenario.recreate()
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            scenario.onActivity { activity ->
                assertNotNull(activity.window.decorView)
                assertFalse(Settings(activity).enabled)
            }
        }
    }
    @Test fun notificationPreservesCurrentMainPageAndDraft() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            var original: MainActivity? = null
            scenario.onActivity { activity ->
                original = activity
                views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.isClickable && it.contentDescription?.toString() == "写一条随手记" }.performClick()
                Notifications.create(activity)
                Notifications.notification(activity, "合成测试通知").contentIntent.send()
            }
            instrumentation.waitForIdleSync()
            scenario.onActivity { activity ->
                assertSame(original, activity)
                assertTrue(views(activity.window.decorView).filterIsInstance<android.widget.EditText>().any { it.isShown && it.isEnabled && it.hint?.toString() == "记下此刻的想法…" })
                assertFalse(Settings(activity).enabled)
            }
        }
    }
    @Test fun notificationPreservesAnOpenDetailActivity() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            scenario.onActivity { it.startActivity(android.content.Intent(it, CaptureRecordsActivity::class.java)) }
            instrumentation.waitForIdleSync()
            var original: android.app.Activity? = null
            val deadline = android.os.SystemClock.elapsedRealtime() + 10000
            while (original == null && android.os.SystemClock.elapsedRealtime() < deadline) {
                instrumentation.runOnMainSync {
                    original = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                        .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).filterIsInstance<CaptureRecordsActivity>().singleOrNull()
                }
                if (original == null) Thread.sleep(50)
            }
            instrumentation.runOnMainSync {
                assertTrue(original is CaptureRecordsActivity)
                Notifications.create(original!!)
                Notifications.notification(original!!, "合成状态通知").contentIntent.send()
            }
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                val current = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                    .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).single()
                assertSame(original, current)
                current.finish()
            }
        }
    }
    @Test fun rawLogsPreserveTextAndAllowSelection() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val journal = SupportEvents.runtime(context)
        repeat(45) { journal.event(EventStage.UPLOAD, if (it == 44) EventCode.AUTH else EventCode.OK, it.toLong()) }
        val expected = journal.readRaw()
        ActivityScenario.launch(LogViewerActivity::class.java).use { scenario ->
            var ready = false
            val deadline = android.os.SystemClock.elapsedRealtime() + 15000
            while (!ready && android.os.SystemClock.elapsedRealtime() < deadline) {
                scenario.onActivity { activity -> ready = views(activity.window.decorView).filterIsInstance<android.widget.EditText>().any { it.text.toString() == expected } }
                if (!ready) Thread.sleep(50)
            }
            assertTrue(ready)
            scenario.onActivity { activity ->
                val output = views(activity.window.decorView).filterIsInstance<android.widget.EditText>().single()
                assertEquals(expected, output.text.toString()); assertNull(output.keyListener)
                views(activity.window.decorView).filterIsInstance<android.widget.Button>().single { it.text.toString() == "全选" }.performClick()
                assertEquals(0, output.selectionStart); assertEquals(expected.length, output.selectionEnd)
            }
            scenario.recreate()
        }
    }
}
