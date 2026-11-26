package dev.mote.collector

import android.graphics.Insets
import android.view.View
import android.view.WindowInsets
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Generated detached shell; never reads the device display or settings. */
@RunWith(AndroidJUnit4::class)
class NativeAppShellKeyboardInstrumentedTest {
    @Test fun badgesAndSelectionUpdateExistingTabControls() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val bar = MoteTabBar(activity) {}
                val ideas = MoteNavItem("ideas", "点子", "daily", 30, "lightbulb", "mote.assistant", "ideas")
                val library = MoteNavItem("library", "资料库", "daily", 50, "layout-grid", "mote.library")
                bar.render(listOf(ideas, library), NavBadges(ideas = 6), "library")
                val ideasControl = bar.findViewWithTag<View>("local-tab:ideas")
                val libraryControl = bar.findViewWithTag<View>("local-tab:library")
                bar.setBadges(NavBadges(ideas = 7, library = true))
                bar.select("ideas")
                assertTrue(ideasControl === bar.findViewWithTag<View>("local-tab:ideas"))
                assertTrue(libraryControl === bar.findViewWithTag<View>("local-tab:library"))
                assertTrue(ideasControl.isSelected)
                assertEquals("7", bar.findViewWithTag<TextView>("local-tab-badge:ideas").text.toString())
                assertEquals(View.VISIBLE, bar.findViewWithTag<View>("local-tab-dot:library").visibility)
            }
        }
    }

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
                assertEquals("The dock surface reaches the bottom edge behind the navigation bar", height, navigation.bottom)
                assertEquals("The navigation bar is inner dock padding", activity.moteDp(24) + navigationBar, navigation.paddingBottom)
                assertEquals(0, shell.paddingBottom)
                assertEquals(navigation.top, contentBottom())
                val docked = navigation.top
                layout(keyboard)
                assertEquals("Keyboard does not lift primary navigation", docked, navigation.top)
                assertEquals("Content ends at the keyboard top", height - keyboard, contentBottom())
                layout(0)
                assertEquals(navigation.top, contentBottom())
                navigation.visibility = View.GONE
                layout(0)
                assertEquals("Pages without the dock pad the navigation bar themselves", navigationBar, shell.paddingBottom)
                navigation.visibility = View.VISIBLE
                layout(0)
                assertEquals("The visible dock owns the navigation bar inset again", 0, shell.paddingBottom)
            }
        }
    }
}
