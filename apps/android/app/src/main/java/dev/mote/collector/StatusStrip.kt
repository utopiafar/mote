package dev.mote.collector

import android.app.Activity
import android.content.res.ColorStateList
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
import org.json.JSONObject

/** The one row above the tab bar: a live recording wins over a retained draft. */
internal enum class StatusStripMode { HIDDEN, RECORDING, DRAFT }

internal object StatusStripPolicy {
    /** The strip belongs to the five authored tabs; manage and detail pages keep the bar only. */
    fun mode(tabId: String?, snapshot: RecordingSnapshot, hasDraft: Boolean): StatusStripMode = when {
        tabId == null -> StatusStripMode.HIDDEN
        snapshot.active -> StatusStripMode.RECORDING
        hasDraft -> StatusStripMode.DRAFT
        else -> StatusStripMode.HIDDEN
    }

    /** The same draft test the record editor and the tab inventory use. */
    fun hasDraft(draft: JSONObject): Boolean =
        draft.optString("text").isNotBlank() || draft.optString("description").isNotBlank() ||
            (draft.optJSONArray("attachments")?.length() ?: 0) > 0 ||
            draft.optJSONObject("origin")?.optString("text").orEmpty().isNotBlank()

    fun label(elapsedMs: Long): String {
        val seconds = elapsedMs.coerceAtLeast(0) / 1000
        return "%02d:%02d".format(seconds / 60, seconds % 60)
    }

    const val TICK_MS = 500L
    const val DRAFT_TITLE = "草稿"
    const val DRAFT_ACTION = "继续"
    const val RECORDING_TITLE = "录音"
}

/**
 * The bar sits above the tab bar and outside the editor. It observes the same
 * process-local recording session as the notification and the editor, and the
 * draft flag MainActivity reads from the record store.
 */
internal class StatusStrip(
    private val activity: Activity,
    private val openEditor: () -> Unit,
) : LinearLayout(activity) {
    private val icon = MoteComponents.icon(activity, MoteGlyph.WAVE, NativeColorRole.ACCENT, 20)
    private val title = TextView(activity).apply {
        maxLines = 1
        MoteUi.type(this, NativeFontRole.BODY)
        MoteUi.textColor(this, NativeColorRole.INK)
    }
    private val duration = TextView(activity).apply {
        tag = "status-strip-duration"
        maxLines = 1
        MoteUi.type(this, NativeFontRole.BODY)
        fontFeatureSettings = "tnum"
        MoteUi.textColor(this, NativeColorRole.MUTED)
    }
    private val stop = stopButton()
    private val draftAction = MoteComponents.smallButton(activity, StatusStripPolicy.DRAFT_ACTION) { openEditor() }.apply {
        tag = "status-strip-draft-action"
    }
    private val handler = Handler(Looper.getMainLooper())
    private var tabId: String? = null
    private var hasDraft = false
    private var attached = false
    private var mode = StatusStripMode.HIDDEN
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
        tag = "status-strip-hidden"
        isFocusable = true
        isClickable = true
        NativePresentationStyles.bind(this, "status-strip") {
            it.background = MoteUi.clickable(activity, NativeColorRole.SURFACE, NativeRadiusRole.PILL, true, NativeColorRole.HAIR)
        }
        setOnClickListener { openEditor() }
        addView(icon, LayoutParams(activity.moteDp(20), activity.moteDp(20)).apply { marginEnd = activity.moteDp(10) })
        addView(title, LayoutParams(-2, -2))
        addView(duration, LayoutParams(-2, -2).apply { marginStart = activity.moteDp(8) })
        addView(View(activity), LayoutParams(0, 0, 1f))
        addView(draftAction, LayoutParams(-2, -2).apply { marginStart = activity.moteDp(8) })
        addView(stop, LayoutParams(activity.moteDp(48), activity.moteDp(48)))
    }

    /** A 48dp touch target around the design's 34dp filled stop control. */
    private fun stopButton(): View = FrameLayout(activity).apply {
        tag = "status-strip-stop"
        contentDescription = MoteI18n.text("停止录音")
        isFocusable = true
        NativePresentationStyles.bind(this, "status-strip-stop") {
            it.background = MoteUi.clickable(activity, NativeColorRole.TRANSPARENT, NativeRadiusRole.PILL, false)
        }
        setOnClickListener { RecordingService.command(activity, RecordingService.ACTION_STOP) }
        addView(ImageView(activity).apply {
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            scaleType = ImageView.ScaleType.CENTER
            setImageResource(MoteGlyph.STOP.drawable)
            NativePresentationStyles.bind(this, "status-strip-stop-glyph") { view ->
                (view as ImageView).apply {
                    imageTintList = ColorStateList.valueOf(NativeColorRole.INK.color())
                    background = MoteUi.shape(activity, NativeColorRole.FILL, NativeRadiusRole.PILL, false, NativeColorRole.FILL)
                }
            }
            setPadding(activity.moteDp(9), activity.moteDp(9), activity.moteDp(9), activity.moteDp(9))
        }, FrameLayout.LayoutParams(activity.moteDp(34), activity.moteDp(34)).apply { gravity = Gravity.CENTER })
    }

    /** The authored tab whose page is on screen; null on manage and detail pages. */
    fun setTab(value: String?) {
        if (tabId == value) return
        tabId = value
        if (attached) present(RecordingSession.snapshot())
    }

    fun setDraft(value: Boolean) {
        if (hasDraft == value) return
        hasDraft = value
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
        handler.removeCallbacks(tick)
        val next = StatusStripPolicy.mode(tabId, snapshot, hasDraft)
        if (mode != next) {
            mode = next
            presentMode(next)
        }
        if (mode != StatusStripMode.RECORDING) return
        val label = StatusStripPolicy.label(snapshot.elapsedMs)
        if (duration.text != label || contentDescription == null) {
            duration.text = label
            contentDescription = listOf(MoteI18n.text("回到编辑器"), MoteI18n.text(StatusStripPolicy.RECORDING_TITLE), label).joinToString("，")
        }
        if (snapshot.phase == RecordingPhase.RECORDING && windowVisibility == VISIBLE) {
            handler.postDelayed(tick, StatusStripPolicy.TICK_MS)
        }
    }

    private fun presentMode(next: StatusStripMode) {
        visibility = if (next == StatusStripMode.HIDDEN) GONE else VISIBLE
        when (next) {
            StatusStripMode.HIDDEN -> {
                tag = "status-strip-hidden"
                contentDescription = null
            }
            StatusStripMode.RECORDING -> {
                tag = "status-strip-recording"
                icon.setImageResource(MoteGlyph.WAVE.drawable)
                contentDescription = null
                title.text = MoteI18n.text(StatusStripPolicy.RECORDING_TITLE)
                duration.visibility = VISIBLE
                stop.visibility = VISIBLE
                draftAction.visibility = GONE
            }
            StatusStripMode.DRAFT -> {
                tag = "status-strip-draft"
                icon.setImageResource(MoteGlyph.COMPOSE.drawable)
                title.text = MoteI18n.text(StatusStripPolicy.DRAFT_TITLE)
                duration.visibility = GONE
                stop.visibility = GONE
                draftAction.visibility = VISIBLE
                contentDescription = MoteI18n.text("继续草稿")
            }
        }
    }
}
