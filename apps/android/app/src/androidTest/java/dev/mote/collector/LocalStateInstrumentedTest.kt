package dev.mote.collector

import android.app.Notification
import android.app.NotificationManager
import android.graphics.Bitmap
import android.os.Build
import android.os.ParcelFileDescriptor
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/** Dedicated emulator only; all records and images below are generated. */
@RunWith(AndroidJUnit4::class)
class LocalStateInstrumentedTest {
    private var previousLanguage = "system"
    @org.junit.Before fun selectFixtureLanguage() {
        previousLanguage = MoteI18n.preference()
        MoteI18n.select(InstrumentationRegistry.getInstrumentation().targetContext, "zh-CN")
    }
    @org.junit.After fun restoreFixtureLanguage() {
        MoteI18n.select(InstrumentationRegistry.getInstrumentation().targetContext, previousLanguage)
    }

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun shell(command: String) = instrumentation.uiAutomation.executeShellCommand(command).use { ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { r -> r.readText() } }
    private fun views(view: View): List<View> = buildList { add(view); if (view is ViewGroup) repeat(view.childCount) { addAll(views(view.getChildAt(it))) } }
    private fun waitFor(label: String, condition: () -> Boolean) {
        val until = System.currentTimeMillis() + 30000
        while (!condition()) { check(System.currentTimeMillis() < until) { "Timed out: $label" }; Thread.sleep(80) }
    }
    private fun <A : android.app.Activity> textAppears(scenario: ActivityScenario<A>, text: String) {
        waitFor("UI $text") { var found = false; scenario.onActivity { a -> found = views(a.window.decorView).filterIsInstance<TextView>().any { it.text.contains(text) } }; found }
    }

}
