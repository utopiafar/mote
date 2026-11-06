package dev.mote.collector

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView

/** Debug-only, generated content. No capture is enabled by opening this activity. */
class FixtureActivity : Activity() {
    private var visualScrim: android.app.Dialog? = null

    /** Empty test window reproduces the system's dim over generated background pixels. */
    fun showVisualScrim(amount: Float) {
        check(intent.getBooleanExtra("visualShareBackdrop", false))
        visualScrim = android.app.Dialog(this).apply {
            setContentView(android.view.View(context))
            window!!.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
            window!!.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            window!!.attributes = window!!.attributes.apply { dimAmount = amount; gravity = Gravity.BOTTOM }
            show()
            window!!.setLayout(1, 1)
        }
    }

    fun dismissVisualScrim() { visualScrim?.dismiss(); visualScrim = null }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (intent.getBooleanExtra("visualShareBackdrop", false)) {
            check(packageName.endsWith(".dev") && android.os.Build.FINGERPRINT.contains("emu64a"))
            setContentView(android.widget.FrameLayout(this).apply {
                setBackgroundColor(NativeColorRole.SURFACE_SUNKEN.color())
            })
            return
        }
        setContentView(TextView(this).apply {
            text = "MOTE FIXTURE 2048\n\nGenerated test content only\n\n测试资料：项目笔记\n\nNo personal data"
            textSize = 26f; setTextColor(Color.BLACK); setBackgroundColor(Color.WHITE)
            gravity = Gravity.CENTER; setPadding(24, 24, 24, 24)
        })
    }
}
