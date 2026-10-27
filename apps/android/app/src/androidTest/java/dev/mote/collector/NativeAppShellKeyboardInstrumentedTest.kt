package dev.mote.collector

import android.graphics.Insets
import android.view.View
import android.view.WindowInsets
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Generated detached shell; never reads the device display or settings. */
@RunWith(AndroidJUnit4::class)
class NativeAppShellKeyboardInstrumentedTest {
    @Test fun bottomNavigationStaysDockedWhileContentYieldsToKeyboard() {
        ActivityScenario.launch(FixtureActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val width = 1080; val height = 2000; val statusBar = 100; val navigationBar = 50; val keyboard = 900
                val shell = NativeAppShell(activity).apply { moteInsets() }
                val content = View(activity)
                val navigation = MotePrimaryNavigation(activity) {}
                shell.header(TextView(activity).apply { text = "Generated header" })
                shell.content(content)
                shell.navigation(navigation)
                assumeTrue("Compact bottom navigation is required", navigation.orientation == LinearLayout.HORIZONTAL)
                fun layout(ime: Int) {
                    shell.dispatchApplyWindowInsets(WindowInsets.Builder()
                        .setInsets(WindowInsets.Type.systemBars(), Insets.of(0, statusBar, 0, navigationBar))
                        .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, ime)).build())
                    repeat(2) {
                        shell.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
                        shell.layout(0, 0, width, height)
                    }
                }
                fun contentBottom() = (content.parent as View).top + content.bottom
                layout(0)
                assertEquals(height - navigationBar, navigation.bottom)
                assertEquals(navigation.top, contentBottom())
                val docked = navigation.top
                layout(keyboard)
                assertEquals("Keyboard does not lift primary navigation", docked, navigation.top)
                assertEquals("Content ends at the keyboard top", height - keyboard, contentBottom())
                layout(0)
                assertEquals(navigation.top, contentBottom())
            }
        }
    }
}
