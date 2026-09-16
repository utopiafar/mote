package dev.mote.collector

import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.ImageView
import android.widget.Spinner
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Only the app-generated image is rendered. No system screenshot/capture APIs. */
@RunWith(AndroidJUnit4::class)
class CompressionPreviewInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private fun views(root: View): List<View> = buildList { add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) } }
    @Test fun generatedPreviewShowsSizesZoomAndNeverSavesSettingsAutomatically() {
        val context = instrumentation.targetContext
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(!Settings(context).enabled && !CaptureAccessibilityService.connected && !ProjectionService.running)
        val original = Settings(context).read()
        ActivityScenario.launch(CompressionPreviewActivity::class.java).use { scenario ->
            fun ready(): Boolean { var ok = false; scenario.onActivity { activity -> ok = views(activity.window.decorView).filterIsInstance<Button>().any { it.text == "将参数带回采集设置" && it.isEnabled } }; return ok }
            fun waitReady() { val end = System.currentTimeMillis() + 20000; while (!ready()) { check(System.currentTimeMillis() < end); Thread.sleep(50) } }
            waitReady()
            scenario.onActivity { activity ->
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                val all = views(activity.window.decorView)
                assertTrue(all.filterIsInstance<TextView>().any { it.text.contains("文件大小为原图的") })
                assertEquals(2, all.filterIsInstance<ImageView>().count { it.drawable != null && it.contentDescription in listOf("原始示例", "压缩结果") })
                all.filterIsInstance<Spinner>().single().setSelection(0)
            }
            Thread.sleep(150); waitReady()
            scenario.onActivity { activity ->
                assertTrue(views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.contains("360 × 640") })
                val root = activity.window.decorView
                val image = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
                root.draw(Canvas(image)); File(context.filesDir, "compression-preview-fixture.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG,100,it) }; image.recycle()
                views(root).filterIsInstance<ImageView>().single { it.contentDescription == "压缩结果" }.performClick()
            }
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                val all = android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views)
                assertTrue(all.any { it is BulkDedupeImageView && it.drawable != null && it.width > 0 })
                all.filterIsInstance<TextView>().first { it.isShown && it.text == "关闭" }.performClick()
            }
        }
        assertEquals(original, Settings(context).read())
    }
}
