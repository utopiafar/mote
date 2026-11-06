package dev.mote.collector

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.recording.RecordingPhase
import dev.mote.collector.recording.RecordingService
import dev.mote.collector.recording.RecordingSession
import dev.mote.collector.recording.RecordingSnapshot
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph

/** R11: the home shows a way back to the live recording only while capture is active. */
internal object HomeRecordingBarPolicy {
    fun visible(home: Boolean, snapshot: RecordingSnapshot): Boolean = home && snapshot.active

    fun label(elapsedMs: Long): String {
        val seconds = elapsedMs.coerceAtLeast(0) / 1000
        return "%02d:%02d".format(seconds / 60, seconds % 60)
    }

    const val TICK_MS = 500L
}

/**
 * The bar sits above the home dock, outside the editor. It observes the same
 * process-local recording session as the notification and the editor.
 */
internal class HomeRecordingBar(
    private val activity: Activity,
    private val openEditor: () -> Unit,
) : LinearLayout(activity) {
    private val duration = TextView(activity).apply {
        tag = "home-recording-duration"
        maxLines = 1
        MoteUi.type(this, NativeFontRole.BODY)
        fontFeatureSettings = "tnum"
        MoteUi.textColor(this, NativeColorRole.MUTED)
    }
    private val handler = Handler(Looper.getMainLooper())
    private var home = false
    private var attached = false
    private val observer: () -> Unit = { if (attached) present(RecordingSession.snapshot()) }
    private val tick = object : Runnable {
        override fun run() { if (attached) present(RecordingSession.snapshot()) }
    }

    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        isBaselineAligned = false
        visibility = GONE
        minimumHeight = activity.moteDp(MoteTheme.controlHeight)
        setPadding(activity.moteDp(16), 0, activity.moteDp(4), 0)
        tag = "home-recording-bar"
        isFocusable = true
        isClickable = true
        NativePresentationStyles.bind(this, "home-recording-bar") {
            it.background = MoteUi.clickable(activity, NativeColorRole.SURFACE, NativeRadiusRole.PILL, true, NativeColorRole.HAIR)
        }
        setOnClickListener { openEditor() }
        addView(MoteComponents.icon(activity, MoteGlyph.WAVE, NativeColorRole.ACCENT, 20),
            LayoutParams(activity.moteDp(20), activity.moteDp(20)).apply { marginEnd = activity.moteDp(10) })
        addView(TextView(activity).apply {
            text = MoteI18n.text("录音")
            maxLines = 1
            MoteUi.type(this, NativeFontRole.BODY)
            MoteUi.textColor(this, NativeColorRole.INK)
        }, LayoutParams(-2, -2))
        addView(duration, LayoutParams(-2, -2).apply { marginStart = activity.moteDp(8) })
        addView(View(activity), LayoutParams(0, 0, 1f))
        addView(stopButton(), LayoutParams(activity.moteDp(48), activity.moteDp(48)))
    }

    /** A 48dp touch target around the design's 34dp filled stop control. */
    private fun stopButton(): View = FrameLayout(activity).apply {
        tag = "home-recording-stop"
        contentDescription = MoteI18n.text("停止录音")
        isFocusable = true
        NativePresentationStyles.bind(this, "home-recording-stop") {
            it.background = MoteUi.clickable(activity, NativeColorRole.TRANSPARENT, NativeRadiusRole.PILL, false)
        }
        setOnClickListener { RecordingService.command(activity, RecordingService.ACTION_STOP) }
        addView(ImageView(activity).apply {
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            scaleType = ImageView.ScaleType.CENTER
            setImageResource(MoteGlyph.STOP.drawable)
            NativePresentationStyles.bind(this, "home-recording-stop-glyph") { view ->
                (view as ImageView).apply {
                    imageTintList = android.content.res.ColorStateList.valueOf(NativeColorRole.INK.color())
                    background = MoteUi.shape(activity, NativeColorRole.FILL, NativeRadiusRole.PILL, false, NativeColorRole.FILL)
                }
            }
            setPadding(activity.moteDp(9), activity.moteDp(9), activity.moteDp(9), activity.moteDp(9))
        }, FrameLayout.LayoutParams(activity.moteDp(34), activity.moteDp(34)).apply { gravity = Gravity.CENTER })
    }

    /** The home is the only local page that keeps the dock, so other pages hide the bar. */
    fun setHome(value: Boolean) {
        home = value
        if (attached) present(RecordingSession.snapshot())
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        attached = true
        RecordingSession.observe(observer)
    }

    override fun onDetachedFromWindow() {
        attached = false
        RecordingSession.remove(observer)
        handler.removeCallbacks(tick)
        super.onDetachedFromWindow()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        if (!attached) return
        if (visibility == VISIBLE) present(RecordingSession.snapshot()) else handler.removeCallbacks(tick)
    }

    private fun present(snapshot: RecordingSnapshot) {
        val visible = HomeRecordingBarPolicy.visible(home, snapshot)
        visibility = if (visible) VISIBLE else GONE
        handler.removeCallbacks(tick)
        if (!visible) return
        val label = HomeRecordingBarPolicy.label(snapshot.elapsedMs)
        duration.text = label
        contentDescription = listOf(MoteI18n.text("回到编辑器"), MoteI18n.text("录音"), label).joinToString("，")
        if (snapshot.phase == RecordingPhase.RECORDING) handler.postDelayed(tick, HomeRecordingBarPolicy.TICK_MS)
    }
}
