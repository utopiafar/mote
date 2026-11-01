package dev.mote.collector

import android.graphics.Color
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.StateListDrawable
import android.view.View
import android.view.ViewGroup

internal enum class NativeColorRole(val key: String?) {
    BACKGROUND("background"), SURFACE("surface"), SIDEBAR("sidebar"), INK("ink"), MUTED("muted"), ACCENT("accent"), TINT("tint"),
    BORDER("border"), CONTROL_BORDER("control-border"), DIVIDER("divider"), SUCCESS("success"), WARNING("warning"), DANGER("danger"),
    SUCCESS_TINT("success-tint"), WARNING_TINT("warning-tint"), DANGER_TINT("danger-tint"), PRIMARY_BACKGROUND("primary-background"), PRIMARY_INK("primary-ink"), SURFACE_RAISED("surface-raised"), TRANSPARENT(null);
    fun color(): Int = key?.let { Color.parseColor(NativeUiPacks.registry.theme().value(it)) } ?: Color.TRANSPARENT
}
internal enum class NativeFontRole(val key: String) {
    TITLE("font-title"), TITLE_MOBILE("font-title-mobile"), APPBAR("font-appbar"), SECTION("font-section"), ROW("font-row"), BODY("font-body"), SUPPORT("font-support"), META("font-meta"), ACTION("font-action");
    fun size() = NativeUiPacks.registry.theme().dimension(key)
    val isHeading get() = this == TITLE || this == TITLE_MOBILE
}
internal enum class NativeRadiusRole(val key: String) {
    CONTAINER("radius-container"), CONTROL("radius-control"), READING("radius-reading"), INDICATOR("radius-indicator");
    fun dp() = NativeUiPacks.registry.theme().dimension(key)
}

/** A View keeps its business listeners and values. Only explicitly registered style roles are replayed. */
internal object NativePresentationStyles {
    @Suppress("UNCHECKED_CAST")
    private fun roles(view: View) = view.getTag(R.id.mote_presentation_styles) as? MutableMap<String, (View) -> Unit>
    fun remember(view: View, role: String, apply: (View) -> Unit) {
        // The View owns callbacks that may themselves capture the View or its Activity.
        val registered = roles(view) ?: linkedMapOf<String, (View) -> Unit>().also { view.setTag(R.id.mote_presentation_styles, it) }
        registered[role] = apply
    }
    fun bind(view: View, role: String, apply: (View) -> Unit) { remember(view, role, apply); apply(view) }
    fun refresh(root: View) {
        fun collect(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { collect(view.getChildAt(it)) } else emptyList()
        val tree = collect(root)
        tree.forEach { view ->
            roles(view)?.values?.toList()?.forEach { it(view) }
            refreshDrawable(view.background)
            if (view is android.widget.TextView) view.compoundDrawables.filterNotNull().forEach(::refreshDrawable)
            view.invalidate()
        }
        tree.filterIsInstance<NativeAppShell>().forEach { it.refreshLayout() }
    }
    /** Spinner menus and other app-owned popups are separate Windows from Activity decor. */
    fun refreshOwnedWindows(activity: android.app.Activity) {
        // DecorView can carry a DecorContext whose base is not the Activity.
        // The Activity owns this window directly, so refresh it before resolving popups.
        val decor = activity.window.decorView
        refresh(decor)
        android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it !== decor }.forEach { root ->
            var owner: android.content.Context = root.context
            while (owner is android.content.ContextWrapper && owner !is android.app.Activity && owner.baseContext !== owner) owner = owner.baseContext
            if (owner === activity) refresh(root)
        }
    }
    private fun refreshDrawable(drawable: Drawable?) {
        when (drawable) {
            is NativeThemeShape -> drawable.refresh()
            is android.graphics.drawable.RippleDrawable -> {
                val accent = MoteTheme.accent
                drawable.setColor(android.content.res.ColorStateList.valueOf(Color.argb(32, Color.red(accent), Color.green(accent), Color.blue(accent))))
                repeat(drawable.numberOfLayers) { refreshDrawable(drawable.getDrawable(it)) }
            }
            is LayerDrawable -> repeat(drawable.numberOfLayers) { refreshDrawable(drawable.getDrawable(it)) }
            is StateListDrawable -> repeat(drawable.stateCount) { refreshDrawable(drawable.getStateDrawable(it)) }
        }
    }
}

/** Theme roles are recorded at creation; no text, old-color or content matching is used on refresh. */
internal class NativeThemeShape(
    private val density: Float,
    private val fill: NativeColorRole,
    private val radiusDp: () -> Int,
    private val outline: Boolean?,
    private val stroke: NativeColorRole,
) : GradientDrawable() {
    init { refresh() }
    fun refresh() {
        setColor(fill.color()); cornerRadius = density * radiusDp()
        setStroke(if (outline ?: (MoteTheme.panelBorderWidth > 0)) (density * MoteTheme.borderWidth).toInt() else 0, stroke.color())
    }
}
