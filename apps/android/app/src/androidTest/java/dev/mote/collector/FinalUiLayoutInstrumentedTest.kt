package dev.mote.collector

import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Prevents clipped connection actions and one-line descriptions on the generated native device. */
@RunWith(AndroidJUnit4::class)
class FinalUiLayoutInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun until(label: String, check: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + 15_000
        while (SystemClock.elapsedRealtime() < end) { if (check()) return; Thread.sleep(40) }
        fail(label)
    }
    private fun <T : android.app.Activity> frames(scenario: ActivityScenario<T>) {
        val latch = java.util.concurrent.CountDownLatch(1)
        scenario.onActivity { it.window.decorView.postOnAnimation { it.window.decorView.postOnAnimation { latch.countDown() } } }
        assertTrue(latch.await(5,java.util.concurrent.TimeUnit.SECONDS))
    }
    @Before fun generatedOnly() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("uiFinalFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        require(!Settings(context).enabled)
        MoteI18n.select(context,"zh-CN")
    }
    @Test fun independentDescriptionKeepsThreeVisibleLinesAfterThemeRefreshAndRecreation() {
        ActivityScenario.launch(RecordEditorActivity::class.java).use { scenario ->
            until("editor ready") { var ready = false; scenario.onActivity { a -> ready = views(a.window.decorView).filterIsInstance<EditText>().any { it.tag == "record-description" && it.isEnabled } }; ready }
            fun open() { scenario.onActivity { a -> views(a.window.decorView).single { it.tag == "record-describe-toggle" }.performClick() } }
            fun verify() {
                frames(scenario); instrumentation.waitForIdleSync()
                scenario.onActivity { a ->
                    val field = views(a.window.decorView).filterIsInstance<EditText>().single { it.tag == "record-description" }
                    field.requestRectangleOnScreen(Rect(0,0,field.width,field.height),true)
                    assertTrue("The whole three-line description can be read: height=${field.height}, minLines=${field.minLines}, lineHeight=${field.lineHeight}, padding=${field.compoundPaddingTop + field.compoundPaddingBottom}",field.height >= field.layout.getLineBottom(0) + 2 * field.lineHeight + field.compoundPaddingTop + field.compoundPaddingBottom)
                    assertTrue("Description is independently editable", field.inputType and android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE != 0)
                    val bounds = Rect(); assertTrue(field.getGlobalVisibleRect(bounds)); assertEquals(field.width,bounds.width())
                    val root = a.window.decorView; val bitmap = android.graphics.Bitmap.createBitmap(root.width,root.height,android.graphics.Bitmap.Config.ARGB_8888)
                    try { root.draw(android.graphics.Canvas(bitmap)); File(context.filesDir,"ui-final-layout").apply { mkdirs() }.resolve("description-${MoteAppearance.preference().name.lowercase()}.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) } } finally { bitmap.recycle() }
                }
            }
            open(); verify()
            MoteAppearance.select(context,AppearancePreference.DARK); instrumentation.waitForIdleSync(); verify()
            scenario.recreate(); until("recreated description ready") { var ready = false; scenario.onActivity { a -> ready = views(a.window.decorView).filterIsInstance<EditText>().any { it.tag == "record-description" && it.isEnabled } }; ready }
            open(); verify(); MoteAppearance.select(context,AppearancePreference.LIGHT)
        }
    }
    @Test fun connectionActionsFitTheNativeContentWidth() {
        ActivityScenario.launch(ConnectionActivity::class.java).use { scenario ->
            until("connection entry ready") { var ready = false; scenario.onActivity { a -> ready = views(a.window.decorView).filterIsInstance<Button>().any { it.text.toString() == "核对连接" && it.isShown } }; ready }
            frames(scenario); instrumentation.waitForIdleSync()
            scenario.onActivity { a ->
                for (label in listOf("扫描二维码","选择邀请文件","核对连接","稍后连接")) {
                    val button = views(a.window.decorView).filterIsInstance<Button>().single { it.isShown && it.text.toString() == label }
                    val bounds = Rect(); assertTrue(button.getGlobalVisibleRect(bounds));
                    val details = StringBuilder()
                    var ancestor: View? = button
                    while (ancestor != null) { val v = ancestor; val location=IntArray(2); v.getLocationOnScreen(location); val visible=Rect(); v.getGlobalVisibleRect(visible); details.append("${v.javaClass.simpleName} ${location.toList()} ${v.width}x${v.height} visible=$visible baseline=${(v as? android.widget.LinearLayout)?.isBaselineAligned} padding=${v.paddingTop}/${v.paddingBottom} params=${v.layoutParams}\n"); ancestor=v.parent as? View }
                    File(context.filesDir,"connection-$label-geometry.txt").writeText(details.toString())
 assertEquals("Action fits: $label",button.width,bounds.width()); assertEquals("Action border fits vertically: $label",button.height,bounds.height())
                    assertEquals("Action text is never truncated: $label",0,button.layout.getEllipsisCount(button.layout.lineCount - 1))
                }
            }
        }
    }
    @Test fun imageMaintenanceAndLibraryFiltersStayReachableWithoutStartingCapture() {
        ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","PROCESSING")).awaitMainUi().use { scenario ->
            scenario.onActivity { a ->
                val labels = views(a.window.decorView).filterIsInstance<TextView>().filter { it.isShown }.map { it.text.toString() }
                for (label in listOf("图片压缩预览","临时保留图片去重对比记录","本机图片批量去重","查看图片去重记录")) assertTrue(label,labels.contains(label))
                assertFalse(Settings(context).enabled)
            }
        }
        ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","LIBRARY")).awaitMainUi().use { scenario ->
            scenario.onActivity { a ->
                val filter = views(a.window.decorView).single { it.tag == "library-filter" }
                assertTrue(filter.isShown)
                filter.performClick()
            }
            until("actual Library filter sheet") { var ready = false; scenario.onActivity {
                ready = android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it.isShown && it.hasWindowFocus() }.flatMap(::views)
                    .filterIsInstance<TextView>().any { it.isShown && it.text.toString() == MoteI18n.text("全部") }
            }; ready }
            scenario.onActivity {
                android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it.isShown && it.hasWindowFocus() }.flatMap(::views)
                    .single { it.isShown && it.contentDescription?.toString() == MoteI18n.text("关闭") }.performClick()
            }
            scenario.recreate(); scenario.awaitMainUi()
            scenario.onActivity { a -> assertTrue(views(a.window.decorView).single { it.tag == "library-filter" }.isShown); assertFalse(Settings(context).enabled) }
        }
    }
    @Test fun sourceAddActionKeepsItsWholeBorderAcrossLanguageAndAppearance() {
        for (language in listOf("zh-CN","en","de")) for (appearance in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)) {
            MoteI18n.select(context,language); MoteAppearance.select(context,appearance)
            ActivityScenario.launch(SourcesActivity::class.java).use { scenario ->
                until("source header ready") { var ready=false; scenario.onActivity { a -> ready=views(a.window.decorView).any { it.tag=="sources-add" && it.isShown } }; ready }
                frames(scenario)
                scenario.onActivity { a ->
                    val button=views(a.window.decorView).filterIsInstance<Button>().single { it.tag=="sources-add" }
                    val bounds=Rect(); assertTrue(button.getGlobalVisibleRect(bounds))
                    assertEquals("Source add width $language/$appearance",button.width,bounds.width())
                    assertEquals("Source add border $language/$appearance",button.height,bounds.height())
                    assertEquals(0,button.layout.getEllipsisCount(button.layout.lineCount-1))
                    val root=a.window.decorView; val bitmap=android.graphics.Bitmap.createBitmap(root.width,root.height,android.graphics.Bitmap.Config.ARGB_8888)
                    try { root.draw(android.graphics.Canvas(bitmap)); File(context.filesDir,"ui-final-layout").apply { mkdirs() }.resolve("sources-$language-${appearance.name.lowercase()}.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) } } finally { bitmap.recycle() }
                }
            }
        }
        MoteI18n.select(context,"zh-CN"); MoteAppearance.select(context,AppearancePreference.LIGHT)
    }
    @Test fun appearanceSelectionsKeepTheirWholeOutlineInLightAndDark() {
        ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","APPEARANCE")).awaitMainUi().use { scenario ->
            try {
                for(preference in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)) {
                    scenario.onActivity { a -> views(a.window.decorView).filterIsInstance<android.widget.Spinner>().first().setSelection(AppearancePreference.entries.indexOf(preference)) }
                    until("Actual appearance choice applies") { MoteAppearance.preference()==preference }; frames(scenario)
                    scenario.onActivity { a ->
                        val root=a.window.decorView; val image=android.graphics.Bitmap.createBitmap(root.width,root.height,android.graphics.Bitmap.Config.ARGB_8888)
                        try {
                            root.draw(android.graphics.Canvas(image)); File(context.filesDir,"ui-final-layout").apply { mkdirs() }.resolve("appearance-outline-${preference.name.lowercase()}.png").outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }
                            val rootAt=IntArray(2); root.getLocationOnScreen(rootAt)
                            val expected=MoteTheme.controlBorder
                            fun near(color:Int)=maxOf(kotlin.math.abs(android.graphics.Color.red(color)-android.graphics.Color.red(expected)),kotlin.math.abs(android.graphics.Color.green(color)-android.graphics.Color.green(expected)),kotlin.math.abs(android.graphics.Color.blue(color)-android.graphics.Color.blue(expected)))<=12
                            for(spinner in views(root).filterIsInstance<android.widget.Spinner>()) {
                                val at=IntArray(2); spinner.getLocationOnScreen(at)
                                for(fraction in listOf(.25,.5,.75)) {
                                    val x=at[0]-rootAt[0]+(spinner.width*fraction).toInt(); val top=at[1]-rootAt[1]
                                    val pixels=(0..a.moteDp(2)).map { image.getPixel(x,top+it) }
                                    assertTrue("The selected value must not paint over the $preference outline at $fraction: ${pixels.map { Integer.toHexString(it) }}",pixels.any(::near))
                                }
                            }
                        } finally { image.recycle() }
                    }
                }
            } finally { MoteAppearance.select(context,AppearancePreference.LIGHT) }
        }
    }
}
