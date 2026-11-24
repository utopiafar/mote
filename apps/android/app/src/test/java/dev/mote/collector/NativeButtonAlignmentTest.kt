package dev.mote.collector

import android.app.Activity
import android.view.Gravity
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import dev.mote.collector.ui.MoteIconButtonStyle
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, sdk = [35])
@LooperMode(LooperMode.Mode.PAUSED)
class NativeButtonAlignmentTest {
    private lateinit var activity: Activity

    @Before fun setUp() {
        val app = RuntimeEnvironment.getApplication()
        MoteI18n.initialize(app)
        if (runCatching { NativeUiPacks.registry.theme() }.isFailure) NativeUiPacks.initialize(app)
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    }

    @Test fun everySharedTextActionCentersItsLabel() {
        val buttons = MoteUi.ButtonRole.entries.map { role ->
            MoteComponents.button(activity, role.name, role).also { MoteUi.styleTree(it) }
        }.toMutableList<Button>()
        buttons += (MoteComponents.smallButton(activity, "继续") as FrameLayout).getChildAt(0) as Button
        buttons += (MoteComponents.toast(activity, "已清空", "撤销") as LinearLayout).getChildAt(1) as Button

        for (button in buttons) assertEquals(Gravity.CENTER, button.gravity)

        val segmented = MoteComponents.MoteSegmented(activity, listOf("one" to "资料", "two" to "记忆")) {}
        for (index in 0 until segmented.childCount) {
            assertEquals(Gravity.CENTER, (segmented.getChildAt(index) as TextView).gravity)
        }
    }

    @Test fun leadingDisclosureKeepsItsIntentionalAlignment() {
        val parent = LinearLayout(activity)
        SecondaryUi.disclosure(parent, "高级设置", "advanced")

        val toggle = parent.getChildAt(0) as Button
        assertEquals(Gravity.START or Gravity.CENTER_VERTICAL, toggle.gravity)
    }

    @Test fun everySharedIconButtonStyleCentersItsGlyph() {
        for (style in MoteIconButtonStyle.entries) {
            val button = MoteComponents.iconButton(activity, MoteGlyph.CHECK, "确定", style)
            assertEquals(ImageView.ScaleType.CENTER, button.scaleType)
        }
    }
}
