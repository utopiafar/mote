package dev.mote.collector

import android.app.Activity
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.view.Gravity
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/** One home line for capture: quiet while it runs, a resume step after a pause, amber only when the owner can act. */
internal class HomeCaptureRow(private val activity: Activity, private val open: (() -> Unit)?, act: (CaptureOverview.Action) -> Unit) : LinearLayout(activity) {
    private val icon = ImageView(activity).apply { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO; scaleType = ImageView.ScaleType.CENTER_INSIDE }
    private val title = TextView(activity).apply { maxLines = 2 }
    private val detail = TextView(activity).apply { maxLines = 3 }
    private val send = TextView(activity).apply { maxLines = 2; gravity = Gravity.END }
    private val chevron = TextView(activity).apply { text = "›"; textSize = 17f; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
    private val action = MoteUi.action(Button(activity), MoteUi.ButtonRole.PRIMARY)
    private var shown: CaptureOverview.Line? = null
    init {
        orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; visibility = GONE; isBaselineAligned = false
        minimumHeight = activity.moteDp(56); setPadding(activity.moteDp(12), activity.moteDp(8), activity.moteDp(10), activity.moteDp(8))
        // On the home the line opens the panel; inside the panel it is only a summary.
        if (open != null) { isFocusable = true; setOnClickListener { open.invoke() } }
        addView(icon, LayoutParams(activity.moteDp(28), activity.moteDp(28)).apply { marginEnd = activity.moteDp(10) })
        val words = LinearLayout(activity).apply { orientation = VERTICAL }
        words.addView(title); words.addView(detail, LayoutParams(-1, -2).apply { topMargin = activity.moteDp(2) })
        addView(words, LayoutParams(0, -2, 1f))
        addView(send, LayoutParams(-2, -2).apply { marginStart = activity.moteDp(8) })
        addView(chevron, LayoutParams(-2, -2).apply { marginStart = activity.moteDp(6) })
        addView(action, LayoutParams(-2, -2).apply { marginStart = activity.moteDp(8) })
        action.setOnClickListener { shown?.action?.let(act) }
        MoteUi.type(title, NativeFontRole.SUPPORT, medium = true); MoteUi.type(detail, NativeFontRole.META); MoteUi.type(send, NativeFontRole.META)
        NativePresentationStyles.bind(this, "home-capture-kind") { present() }
    }

    fun bind(line: CaptureOverview.Line) {
        if (line == shown) return
        shown = line
        present()
    }

    private fun present() {
        val line = shown ?: return
        // Normal capture and the never-started state stay off the home; only a
        // pause or an actionable interruption is a status the owner can use.
        val visible = HomeFrame.showsCaptureNotice(line.kind)
        visibility = if (visible) VISIBLE else GONE
        if (!visible) return
        val attention = line.kind == CaptureOverview.Kind.ATTENTION
        val paused = line.kind == CaptureOverview.Kind.SCREEN_PAUSED || line.kind == CaptureOverview.Kind.PAUSED
        // Existing interruption checks keep their identity; the quiet and paused states are new, separate tags.
        tag = if (attention) "home-attention" else if (paused) "home-capture-paused" else "home-capture-state"
        background = if (attention) (if (open != null) MoteUi.clickable(activity, NativeColorRole.WARNING_TINT, 12, false) else MoteUi.shape(activity, NativeColorRole.WARNING_TINT, 12, false))
            else if (open != null) MoteUi.clickable(activity, NativeColorRole.SURFACE, 12, true, NativeColorRole.BORDER) else MoteUi.shape(activity, NativeColorRole.SURFACE, 12, true)
        title.text = line.title; detail.text = line.detail; detail.visibility = if (line.detail.isBlank()) GONE else VISIBLE
        MoteUi.textColor(title, if (attention) NativeColorRole.WARNING else NativeColorRole.INK)
        MoteUi.textColor(detail, if (attention) NativeColorRole.INK else NativeColorRole.MUTED)
        send.text = line.send; send.visibility = if (line.kind == CaptureOverview.Kind.ACTIVE && line.send.isNotBlank()) VISIBLE else GONE
        MoteUi.textColor(send, if (line.sendAttention) NativeColorRole.WARNING else NativeColorRole.MUTED)
        MoteUi.textColor(chevron, NativeColorRole.MUTED)
        action.visibility = if (line.action == null) GONE else VISIBLE
        chevron.visibility = if (line.action == null && open != null) VISIBLE else GONE
        line.action?.let { action.text = CaptureOverview.label(it); action.contentDescription = CaptureOverview.label(it) + "，" + line.title }
        icon.background = if (paused) MoteUi.shape(activity, NativeColorRole.SIDEBAR, 14, false) else null
        icon.setImageDrawable(when {
            attention -> MoteNavigationIcon(activity, "warning", false).apply { colorFilter = PorterDuffColorFilter(NativeColorRole.WARNING.color(), PorterDuff.Mode.SRC_IN) }
            paused -> MoteNavigationIcon(activity, "pause", false)
            else -> MoteUi.shape(activity, NativeColorRole.SUCCESS, 4, false).apply { setSize(activity.moteDp(8), activity.moteDp(8)) }
        })
        contentDescription = listOf(line.title, line.detail, if (send.visibility == VISIBLE) line.send else "").filter { it.isNotBlank() }.joinToString("，")
    }
}
