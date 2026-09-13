package dev.mote.collector

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView

/** Debug-only, generated content. No capture is enabled by opening this activity. */
class FixtureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(TextView(this).apply {
            text = "MOTE FIXTURE 2048\n\nGenerated test content only\n\n测试资料：项目笔记\n\nNo personal data"
            textSize = 26f; setTextColor(Color.BLACK); setBackgroundColor(Color.WHITE)
            gravity = Gravity.CENTER; setPadding(24, 24, 24, 24)
        })
    }
}
