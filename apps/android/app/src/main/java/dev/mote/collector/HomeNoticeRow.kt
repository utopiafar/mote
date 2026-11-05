package dev.mote.collector

import android.app.Activity
import android.content.res.ColorStateList
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph

/**
 * One notice above the home content: neutral for an owner pause, amber only
 * when the owner must act. The row and its single action share a destination.
 */
internal class HomeNoticeRow(
    private val activity: Activity,
    private val open: (HomeNotice) -> Unit,
    private val act: (HomeNotice) -> Unit,
) : LinearLayout(activity) {
    private val icon = ImageView(activity).apply {
        scaleType = ImageView.ScaleType.CENTER_INSIDE
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    private val title = TextView(activity).apply {
        maxLines = 1; ellipsize = TextUtils.TruncateAt.END
        MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK)
    }
    private val detail = TextView(activity).apply {
        maxLines = 1; ellipsize = TextUtils.TruncateAt.END; visibility = GONE
        MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED)
    }
    private val action = MoteComponents.smallButton(activity, "") { shown?.let(act) }
    private val actionLabel = (action as FrameLayout).getChildAt(0) as Button
    private var shown: HomeNotice? = null

    init {
        orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
        visibility = GONE
        minimumHeight = activity.moteDp(MoteTheme.controlHeight)
        setPadding(activity.moteDp(16), 0, activity.moteDp(5), 0)
        isFocusable = true; isClickable = true
        setOnClickListener { shown?.let(open) }
        addView(icon, LayoutParams(activity.moteDp(20), activity.moteDp(20)).apply { marginEnd = activity.moteDp(10) })
        val words = LinearLayout(activity).apply {
            orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
            addView(title, LayoutParams(-2, -2))
            addView(detail, LayoutParams(-2, -2).apply { marginStart = activity.moteDp(8) })
            addView(View(activity), LayoutParams(0, 0, 1f))
        }
        addView(words, LayoutParams(0, -2, 1f))
        addView(action, LayoutParams(-2, -2).apply { marginStart = activity.moteDp(8) })
        NativePresentationStyles.bind(this, "home-notice") { present() }
    }

    fun bind(notice: HomeNotice?) {
        if (notice == shown) return
        shown = notice
        present()
    }

    private fun present() {
        val notice = shown
        if (notice == null) {
            visibility = GONE
            tag = null
            return
        }
        visibility = VISIBLE
        val warning = notice.level == CaptureStatusLevel.NEEDS_ACTION
        tag = when (notice.operation) {
            HomeNotice.Operation.Connect -> "home-notice-connect"
            is HomeNotice.Operation.Capture -> if (warning) "home-notice-needs-action" else "home-notice-reminder"
        }
        background = if (warning) MoteUi.clickable(activity, NativeColorRole.WARNING_TINT, NativeRadiusRole.PILL, false)
            else MoteUi.clickable(activity, NativeColorRole.SURFACE, NativeRadiusRole.PILL, true, NativeColorRole.HAIR)
        val glyph = when {
            notice.operation == HomeNotice.Operation.Connect -> MoteGlyph.LINK
            warning -> MoteGlyph.ALERT
            else -> MoteGlyph.PAUSE
        }
        icon.setImageResource(glyph.drawable)
        icon.imageTintList = ColorStateList.valueOf(if (warning) NativeColorRole.WARNING.color() else NativeColorRole.MUTED.color())
        title.text = MoteI18n.text(notice.titleKey)
        detail.text = notice.detail.orEmpty()
        detail.visibility = if (notice.detail == null) GONE else VISIBLE
        actionLabel.text = MoteI18n.text(notice.actionKey)
        action.contentDescription = MoteI18n.text(notice.actionKey)
        contentDescription = listOf(MoteI18n.text(notice.titleKey), notice.detail.orEmpty(), MoteI18n.text(notice.actionKey)).filter { it.isNotBlank() }.joinToString("，")
    }
}
