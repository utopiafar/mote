package dev.mote.collector

import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph

/** Presentation only: secondary screens keep their existing stores, task owners and callbacks. */
internal object SecondaryUi {
    fun column(parent: LinearLayout, card: Boolean = false): LinearLayout = LinearLayout(parent.context).apply {
        orientation = LinearLayout.VERTICAL
        if (card) {
            background = MoteUi.shape(context, outline = true)
            val inset = context.moteDp(MoteTheme.spacePanel)
            setPadding(inset, inset, inset, inset)
        }
        parent.addView(this, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = context.moteDp(MoteTheme.spaceItem) })
    }

    fun text(parent: LinearLayout, value: String, heading: Boolean = false, muted: Boolean = false): TextView = TextView(parent.context).apply {
        text = value
        MoteUi.type(this, if (heading) NativeFontRole.SECTION else if (muted) NativeFontRole.SUPPORT else NativeFontRole.BODY, medium = heading)
        MoteUi.textColor(this, if (muted) NativeColorRole.MUTED else NativeColorRole.INK)
        parent.addView(this, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = context.moteDp(MoteTheme.spaceInline) })
    }

    fun action(parent: ViewGroup, label: String, primary: Boolean = false, action: () -> Unit): Button = MoteUi.button(Button(parent.context).apply {
        text = label; setOnClickListener { action() }
    }, primary).also { parent.addView(it, ViewGroup.MarginLayoutParams(-2, -2).apply { topMargin = parent.context.moteDp(MoteTheme.spaceInline); marginEnd = parent.context.moteDp(MoteTheme.spaceInline) }) }

    fun actions(parent: LinearLayout): ViewGroup = SecondaryActions(parent.context).also { parent.addView(it, LinearLayout.LayoutParams(-1, -2)) }

    fun row(parent: LinearLayout, label: String, detail: String = "", icon: MoteGlyph? = null, action: () -> Unit): LinearLayout = LinearLayout(parent.context).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        val inset = context.moteDp(MoteTheme.spaceItem)
        setPadding(0, inset, 0, inset); minimumHeight = context.moteDp(64)
        background = MoteUi.clickable(context, NativeColorRole.TRANSPARENT, 0, false); isFocusable = true; isClickable = true
        if (icon != null) addView(android.widget.FrameLayout(context).apply {
            background = MoteUi.shape(context, radius = NativeRadiusRole.CONTROL, outline = true)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            addView(MoteComponents.icon(context, icon), android.widget.FrameLayout.LayoutParams(context.moteDp(20), context.moteDp(20), Gravity.CENTER))
        }, LinearLayout.LayoutParams(context.moteDp(32), context.moteDp(32)).apply { marginEnd = context.moteDp(12); gravity = Gravity.TOP })
        val words = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        addView(words, LinearLayout.LayoutParams(0, -2, 1f))
        text(words, label, heading = true)
        if (detail.isNotBlank()) text(words, detail, muted = true)
        addView(MoteComponents.icon(context, MoteGlyph.CHEV), LinearLayout.LayoutParams(context.moteDp(20), context.moteDp(20)).apply {
            marginStart = context.moteDp(MoteTheme.spaceInline)
        })
        setOnClickListener { action() }
        parent.addView(View(context).apply { MoteUi.backgroundColor(this, NativeColorRole.DIVIDER) }, LinearLayout.LayoutParams(-1, context.moteDp(1)))
        parent.addView(this, LinearLayout.LayoutParams(-1, -2))
    }

    fun disclosure(parent: LinearLayout, label: String, key: String, expanded: Boolean = false): LinearLayout {
        val content = LinearLayout(parent.context).apply { orientation = LinearLayout.VERTICAL; visibility = if (expanded) View.VISIBLE else View.GONE; tag = "$key:content" }
        fun Button.updateDisclosureIcon() {
            val glyph = if (isSelected) MoteGlyph.DOWN else MoteGlyph.CHEV
            val drawable = context.getDrawable(glyph.drawable)?.mutate()
            drawable?.setBounds(0, 0, context.moteDp(20), context.moteDp(20))
            drawable?.setTint(NativeColorRole.MUTED.color())
            setCompoundDrawablesRelative(drawable, null, null, null)
            compoundDrawablePadding = context.moteDp(4)
        }
        val toggle = MoteUi.action(Button(parent.context).apply {
            text = label; tag = key; gravity = Gravity.START or Gravity.CENTER_VERTICAL
            isSelected = expanded; accessibilityState(expanded)
            NativePresentationStyles.bind(this, "secondary-disclosure-icon") { (it as Button).updateDisclosureIcon() }
            setOnClickListener {
                val show = content.visibility != View.VISIBLE
                content.visibility = if (show) View.VISIBLE else View.GONE
                isSelected = show; accessibilityState(show)
                updateDisclosureIcon()
            }
        }, MoteUi.ButtonRole.TEXT)
        parent.addView(toggle, LinearLayout.LayoutParams(-1, -2))
        parent.addView(content, LinearLayout.LayoutParams(-1, -2))
        return content
    }

    private fun View.accessibilityState(expanded: Boolean) {
        if (android.os.Build.VERSION.SDK_INT >= 30) stateDescription = MoteI18n.text(if (expanded) "已展开" else "已收起")
    }

    fun fact(parent: LinearLayout, label: String, value: String) {
        val row = LinearLayout(parent.context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.TOP }
        row.addView(TextView(parent.context).apply { text = label; MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.MUTED) }, LinearLayout.LayoutParams(parent.context.moteDp(108), -2))
        row.addView(TextView(parent.context).apply { text = value; MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK) }, LinearLayout.LayoutParams(0, -2, 1f))
        parent.addView(row, LinearLayout.LayoutParams(-1, -2).apply { topMargin = parent.context.moteDp(MoteTheme.spaceInline); bottomMargin = parent.context.moteDp(MoteTheme.spaceInline) })
    }
}

/** Native equivalent of the prototype's wrapping action row, including larger text settings. */
private class SecondaryActions(context: android.content.Context) : ViewGroup(context) {
    override fun generateDefaultLayoutParams() = MarginLayoutParams(-2, -2)
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight; var x = 0; var y = paddingTop; var line = 0
        for (i in 0 until childCount) {
            val child = getChildAt(i); if (child.visibility == GONE) continue
            measureChildWithMargins(child, widthMeasureSpec, 0, heightMeasureSpec, 0)
            val p = child.layoutParams as MarginLayoutParams
            val w = child.measuredWidth + p.leftMargin + p.rightMargin; val h = child.measuredHeight + p.topMargin + p.bottomMargin
            if (x > 0 && x + w > width) { x = 0; y += line; line = 0 }
            x += w; line = maxOf(line, h)
        }
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), resolveSize(y + line + paddingBottom, heightMeasureSpec))
    }
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        var x = paddingLeft; var y = paddingTop; var line = 0
        for (i in 0 until childCount) {
            val child = getChildAt(i); if (child.visibility == GONE) continue
            val p = child.layoutParams as MarginLayoutParams
            val w = child.measuredWidth + p.leftMargin + p.rightMargin; val h = child.measuredHeight + p.topMargin + p.bottomMargin
            if (x > paddingLeft && x + w > width - paddingRight) { x = paddingLeft; y += line; line = 0 }
            child.layout(x + p.leftMargin, y + p.topMargin, x + p.leftMargin + child.measuredWidth, y + p.topMargin + child.measuredHeight)
            x += w; line = maxOf(line, h)
        }
    }
}
