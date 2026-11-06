package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.EditText
import android.widget.ImageButton
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/** G11: remaining interface glyphs use the shared Lucide line set, with their original actions. */
@RunWith(AndroidJUnit4::class)
class FixUx01IconsInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun <T> main(block: () -> T): T {
        val result = AtomicReference<Result<T>>(); instrumentation.runOnMainSync { result.set(runCatching(block)) }
        return result.get().getOrThrow()
    }
    private fun views(root: View): List<View> = buildList {
        add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
    }
    private fun overlays(activity: Activity) =
        WindowInspector.getGlobalWindowViews().filter { it !== activity.window.decorView && it.isShown }
    private fun until(label: String, check: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20_000
        while (SystemClock.elapsedRealtime() < deadline) { if (main(check)) return; Thread.sleep(50) }
        fail(label)
    }
    private fun screenshot(activity: Activity, name: String, extras: List<View> = emptyList()) {
        val root = activity.window.decorView
        val image = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        try {
            val canvas = Canvas(image); root.draw(canvas)
            extras.forEach { window ->
                val position = IntArray(2); window.getLocationOnScreen(position)
                canvas.save(); canvas.translate(position[0].toFloat(), position[1].toFloat()); window.draw(canvas); canvas.restore()
            }
            File(context.filesDir, "fix-ux01-icons").apply { mkdirs() }
                .resolve("$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        } finally { image.recycle() }
    }
    private fun captureThemes(scenario: ActivityScenario<out Activity>, name: String, extras: (Activity) -> List<View> = { emptyList() }) {
        for ((theme, suffix) in listOf(AppearancePreference.LIGHT to "light", AppearancePreference.DARK to "dark")) {
            main { MoteAppearance.select(context, theme) }; instrumentation.waitForIdleSync(); Thread.sleep(200)
            scenario.onActivity { screenshot(it, "$name-$suffix", extras(it)) }
        }
    }

    @Test fun startUsingKeepsActionsAndUsesLineIcons() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("fixUx01IconsFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val language = MoteI18n.preference(); val appearance = MoteAppearance.preference()
        try {
            main { MoteI18n.select(context, "zh-CN") }
            ActivityScenario.launch(StartUsingActivity::class.java).use { scenario ->
                until("Install help actions") {
                    var found = false
                    scenario.onActivity { activity -> found = views(activity.window.decorView).any { it.isShown && it.contentDescription == MoteI18n.text("查看安装文档") } }
                    found
                }
                scenario.onActivity { activity ->
                    val visible = views(activity.window.decorView).filter { it.isShown }
                    assertFalse("Install help no longer draws character icons", visible.filterIsInstance<TextView>().any {
                        val text = it.text.toString()
                        text.contains("↗") || text.contains("▸") || text.contains("▾")
                    })
                    val link = visible.single { it.contentDescription == MoteI18n.text("查看安装文档") } as TextView
                    assertTrue("External link keeps its Lucide glyph", link.compoundDrawablesRelative.any { it != null })
                    assertTrue("External link keeps a 48dp touch target", link.minimumHeight >= activity.moteDp(48))
                    val disclosure = visible.single { it.contentDescription == MoteI18n.text("查看安装提示词") } as TextView
                    assertTrue("Disclosure keeps its Lucide glyph", disclosure.compoundDrawablesRelative.any { it != null })
                    assertTrue("Disclosure keeps a 48dp touch target", disclosure.minimumHeight >= activity.moteDp(48))
                }
                captureThemes(scenario, "start-using")
                scenario.onActivity { activity -> views(activity.window.decorView).single { it.contentDescription == MoteI18n.text("查看安装提示词") }.performClick() }
                until("Prompt expands") {
                    var expanded = false
                    scenario.onActivity { activity -> expanded = views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == StartUsingActivity.INSTALL_PROMPT } }
                    expanded
                }
                scenario.onActivity { activity ->
                    val disclosure = views(activity.window.decorView).single { it.contentDescription == MoteI18n.text("查看安装提示词") }
                    assertEquals(MoteI18n.text("已展开"), disclosure.stateDescription)
                }
                captureThemes(scenario, "start-using-expanded")
                scenario.onActivity { activity -> views(activity.window.decorView).single { it.contentDescription == MoteI18n.text("查看安装提示词") }.performClick() }
            }
        } finally {
            main { MoteI18n.select(context, language); MoteAppearance.select(context, appearance) }
        }
    }

    @Test fun settingsRowsKeepTheirLucideChevron() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("fixUx01IconsFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val language = MoteI18n.preference(); val appearance = MoteAppearance.preference()
        try {
            main { MoteI18n.select(context, "zh-CN") }
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "SETTINGS")).use { scenario ->
                until("Settings rows") {
                    var ready = false
                    scenario.onActivity { activity -> ready = views(activity.window.decorView).any { it.isShown && it.tag?.toString()?.startsWith("menu:") == true } }
                    ready
                }
                scenario.onActivity { activity ->
                    val visible = views(activity.window.decorView).filter { it.isShown }
                    assertFalse("Rows no longer draw a text chevron", visible.filterIsInstance<TextView>().any { it.text.toString() == "›" })
                    val rows = visible.filter { it.tag?.toString()?.startsWith("menu:") == true }
                    assertTrue("Settings keeps its real row actions", rows.isNotEmpty())
                    assertTrue("Every settings row keeps a drawn chevron", rows.all { row ->
                        views(row).filterIsInstance<android.widget.ImageView>().any { it.drawable != null && it.width > 0 }
                    })
                }
                captureThemes(scenario, "settings-menu")
            }
        } finally {
            main { MoteI18n.select(context, language); MoteAppearance.select(context, appearance) }
        }
    }

    @Test fun captureContextClosesWithA48dpLineIcon() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("fixUx01IconsFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val language = MoteI18n.preference(); val appearance = MoteAppearance.preference()
        try {
            main { MoteI18n.select(context, "zh-CN") }
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                scenario.onActivity { CaptureContextDialog(it).show() }
                until("Source description fields load") {
                    var ready = false
                    scenario.onActivity { activity -> ready = overlays(activity).flatMap(::views).filterIsInstance<EditText>().count { it.isEnabled } == 4 }
                    ready
                }
                scenario.onActivity { activity ->
                    val close = overlays(activity).flatMap(::views).single { it.contentDescription == MoteI18n.text("关闭") }
                    assertTrue("Close stays an icon button", close is ImageButton)
                    assertTrue("Close keeps a 48dp touch target", close.width >= activity.moteDp(48) && close.height >= activity.moteDp(48))
                    assertTrue("Close keeps its accessible name", close.isFocusable && close.contentDescription.toString().isNotBlank())
                }
                captureThemes(scenario, "capture-context") { overlays(it) }
                scenario.onActivity { activity -> overlays(activity).flatMap(::views).single { it.contentDescription == MoteI18n.text("关闭") }.performClick() }
            }
        } finally {
            main { MoteI18n.select(context, language); MoteAppearance.select(context, appearance) }
        }
    }
}
