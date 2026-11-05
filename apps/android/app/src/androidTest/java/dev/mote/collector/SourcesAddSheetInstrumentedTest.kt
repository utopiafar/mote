package dev.mote.collector

import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Y02: the add-source bottom panel lists only the five named source kinds. */
@RunWith(AndroidJUnit4::class)
class SourcesAddSheetInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = buildList { add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) } }
    private fun until(label: String, check: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + 15_000
        while (SystemClock.elapsedRealtime() < end) { if (check()) return; Thread.sleep(40) }
        fail(label)
    }

    @Test fun addSourceSheetListsOnlyTheFiveNamedOptions() {
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val settings = Settings(context); val language = MoteI18n.preference(); val appearance = MoteAppearance.preference()
        try {
            MoteI18n.select(context, "zh-CN"); MoteAppearance.select(context, AppearancePreference.LIGHT)
            settings.enabled = false
            ActivityScenario.launch(SourcesActivity::class.java).use { scenario ->
                until("sources-add row") { var ready = false; scenario.onActivity { a -> ready = views(a.window.decorView).any { it.isShown && it.tag == "sources-add" } }; ready }
                scenario.onActivity { a -> assertTrue(views(a.window.decorView).single { it.isShown && it.tag == "sources-add" }.performClick()) }
                until("add-source sheet") { var ready = false; instrumentation.runOnMainSync {
                    ready = WindowInspector.getGlobalWindowViews().any { root -> root.isShown && views(root).any { it.isShown && it.tag == "add-source:CLOUD" } }
                }; ready }
                instrumentation.runOnMainSync {
                    val sheet = WindowInspector.getGlobalWindowViews().single { root -> root.isShown && views(root).any { it.isShown && it.tag == "add-source:CLOUD" } }
                    val names = views(sheet).filterIsInstance<TextView>().filter { it.isShown }.map { it.text.toString() }
                    assertEquals(listOf("导入文件", "同步文件夹", "连接本机日历", "屏幕与应用活动", "云端来源"),
                        names.filter { it in CaptureSyncPresentation.addKinds.map { kind -> MoteI18n.text(kind.titleKey) } })
                    val bitmap = Bitmap.createBitmap(sheet.width, sheet.height, Bitmap.Config.ARGB_8888)
                    try { sheet.draw(Canvas(bitmap)); File(context.filesDir, "ui-final-layout").apply { mkdirs() }.resolve("sources-add-sheet.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) } } finally { bitmap.recycle() }
                    assertFalse(settings.enabled)
                }
            }
        } finally { MoteI18n.select(context, language); MoteAppearance.select(context, appearance) }
    }
}
