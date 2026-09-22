package dev.mote.collector

/** Test APK only: known generated pixels outside Mote's protected settings window. */
class ExternalFixtureActivity : android.app.Activity() {
    override fun onCreate(state: android.os.Bundle?) {
        super.onCreate(state)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val content = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(32, 64, 32, 32)
            setBackgroundColor(android.graphics.Color.WHITE)
        }
        repeat(10) { index -> content.addView(android.widget.TextView(this).apply {
            text = "MOTE GENERATED FIXTURE $index\nOnly synthetic content. No personal data."
            textSize = 20f
            setTextColor(android.graphics.Color.BLACK)
        }) }
        setContentView(content)
    }
}
