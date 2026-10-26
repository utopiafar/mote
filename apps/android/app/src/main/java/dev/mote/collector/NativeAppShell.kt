package dev.mote.collector

import android.app.Activity
import android.view.View
import android.widget.LinearLayout

/** Stable presentation slots: the host still owns routes, drafts, permissions and lifecycle. */
internal class NativeAppShell(activity: Activity) : LinearLayout(activity) {
    private val layout get() = NativeUiPacks.registry.layout()
    private val rail get() = layout.navigation == "adaptive" && resources.configuration.screenWidthDp >= 600
    private var renderedRail = rail
    private val column = LinearLayout(activity).apply { orientation = VERTICAL }
    private var navigationView: MotePrimaryNavigation? = null
    private var keyboardInset = 0
    private val presentationNotice = android.widget.TextView(activity).apply {
        visibility = GONE; tag = "native-presentation-notice"; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED)
        setPadding(context.moteDp(MoteTheme.spacePage), context.moteDp(MoteTheme.spaceInline), context.moteDp(MoteTheme.spacePage), context.moteDp(MoteTheme.spaceInline))
        accessibilityLiveRegion = ACCESSIBILITY_LIVE_REGION_POLITE
    }
    init {
        orientation = if (rail) HORIZONTAL else VERTICAL
        MoteUi.backgroundColor(this, NativeColorRole.BACKGROUND)
        tag = "native-shell:${layout.identity.id}@${layout.identity.version}"
        addView(column, if (rail) LayoutParams(0, -1, 1f) else LayoutParams(-1, 0, 1f))
        column.addView(presentationNotice)
    }
    fun header(view: View) { column.addView(view) }
    fun content(view: View) { column.addView(view, LayoutParams(-1, 0, 1f)) }
    fun footer(view: View) { column.addView(view) }
    fun navigation(view: MotePrimaryNavigation) {
        if (navigationView !== view) view.addOnLayoutChangeListener { _, _, top, _, bottom, _, oldTop, _, oldBottom -> if (bottom - top != oldBottom - oldTop) applyKeyboard() }
        navigationView = view
        if (rail) addView(view, 0, LayoutParams(-2, -1)) else addView(view)
        applyKeyboard()
    }
    fun keyboard(inset: Int) { keyboardInset = inset; applyKeyboard() }
    private fun applyKeyboard() {
        // The bottom navigation stays docked under the keyboard; only the page column yields space.
        val docked = navigationView?.takeIf { !renderedRail && it.parent === this && it.visibility != GONE }?.height ?: 0
        val bottom = maxOf(0, keyboardInset - docked)
        if (column.paddingBottom != bottom) column.setPadding(0, 0, 0, bottom)
    }
    fun refreshLayout() {
        // Reparent only stable shell slots. Existing page Views, editors and listeners stay alive.
        val focused = findFocus()
        val editor = focused as? android.widget.EditText
        val selection = editor?.let { it.selectionStart to it.selectionEnd }
        if (renderedRail != rail) {
            removeAllViews(); orientation = if (rail) HORIZONTAL else VERTICAL
            addView(column, if (rail) LayoutParams(0, -1, 1f) else LayoutParams(-1, 0, 1f))
            navigationView?.let(::navigation)
            renderedRail = rail
            applyKeyboard()
            focused?.requestFocus()
            if (selection != null && selection.first >= 0 && selection.second >= 0) editor.setSelection(selection.first, selection.second)
        }
        navigationView?.refreshPresentation()
        tag = "native-shell:${layout.identity.id}@${layout.identity.version}"
        presentationNotice.text = if (NativeUiPacks.registry.fallbackReason() != null) MoteI18n.text("界面扩展已移除，已恢复内置方案。") else ""
        presentationNotice.visibility = if (presentationNotice.text.isEmpty()) GONE else VISIBLE
        requestLayout()
    }
}
