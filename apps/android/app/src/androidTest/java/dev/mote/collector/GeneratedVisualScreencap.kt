package dev.mote.collector

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.view.PixelCopy
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Raw system captures and in-process GPU renders, only for the generated Dev emulator. */
internal object GeneratedVisualScreencap {
    data class WindowImage(val bitmap: Bitmap, val x: Int, val y: Int)

    fun save(context: Context, directory: File, name: String) {
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        directory.mkdirs()
        ParcelFileDescriptor.AutoCloseInputStream(
            InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand("screencap -p")
        ).use { input -> File(directory, "raw-$name.png").outputStream().use { input.copyTo(it) } }
    }

    /** PixelCopy reads the app's own window buffer without changing FLAG_SECURE. */
    fun window(scenario: ActivityScenario<out Activity>): WindowImage {
        val completed = CountDownLatch(1)
        lateinit var result: WindowImage
        var status = -1
        scenario.onActivity { activity ->
            require(activity.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
            check(activity.window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_SECURE != 0) { "Generated visual window must remain secure" }
            val root = activity.window.decorView
            val position = IntArray(2); root.getLocationOnScreen(position)
            val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
            result = WindowImage(bitmap, position[0], position[1])
            PixelCopy.request(activity.window, bitmap, { status = it; completed.countDown() }, Handler(Looper.getMainLooper()))
        }
        check(completed.await(5, TimeUnit.SECONDS) && status == PixelCopy.SUCCESS) { "Cannot read generated app window: $status" }
        return result
    }

    fun capture(context: Context, scenario: ActivityScenario<out Activity>, directory: File, name: String) {
        save(context, directory, name)
        val image = window(scenario).bitmap
        try { File(directory, "$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) } }
        finally { image.recycle() }
    }
}
