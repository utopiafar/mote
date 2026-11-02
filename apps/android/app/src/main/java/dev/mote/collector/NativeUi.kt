package dev.mote.collector

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*

/** Shared, native presentation for the collector and its detail screens. */
internal object MoteUi {
    val background get() = MoteTheme.background
    val ink get() = MoteTheme.ink
    val muted get() = MoteTheme.muted
    val accent get() = MoteTheme.accent
    val tint get() = MoteTheme.tint
    val border get() = MoteTheme.border
    val controlBorder get() = MoteTheme.controlBorder
    val divider get() = MoteTheme.divider

    val containerRadius get() = MoteTheme.radiusContainer
    val readingRadius get() = MoteTheme.radiusReading
    val actionRadius get() = MoteTheme.radiusControl

    /** Typography and color replay only authored roles; business controls keep identity and listeners. */
    fun type(view: TextView, role: NativeFontRole = NativeFontRole.BODY, medium: Boolean = false) = view.apply {
        NativePresentationStyles.bind(this, "type") { value -> applyType(value as TextView, role.size(), medium, role.isHeading) }
    }
    fun type(view: TextView, size: Int, medium: Boolean = false) = view.apply {
        NativePresentationStyles.bind(this, "type") { value -> applyType(value as TextView, size, medium, false) }
    }
    private fun applyType(view: TextView, size: Int, medium: Boolean, heading: Boolean) = view.apply {
        textSize = size.toFloat()
        typeface = Typeface.create(Typeface.create(MoteTheme.fontFamily(heading), Typeface.NORMAL), if (heading) MoteTheme.titleWeight else if (medium) MoteTheme.sectionWeight else MoteTheme.bodyWeight, false)
        setLineSpacing(0f, MoteTheme.lineBody); letterSpacing = if (heading) MoteTheme.letterTitle else 0f
        setTag(R.id.mote_type, size)
    }
    private fun enabledColors(color: Int) = ColorStateList(arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()), intArrayOf(MoteTheme.muted, color))
    fun textColor(view: TextView, role: NativeColorRole) { NativePresentationStyles.bind(view, "text-color") { (it as TextView).setTextColor(enabledColors(role.color())) } }
    fun backgroundColor(view: View, role: NativeColorRole) { NativePresentationStyles.bind(view, "background-color") { it.setBackgroundColor(role.color()) } }
    fun shape(context: Context, fill: NativeColorRole = NativeColorRole.SURFACE, radius: NativeRadiusRole = NativeRadiusRole.CONTAINER, outline: Boolean? = null, strokeColor: NativeColorRole = NativeColorRole.BORDER): GradientDrawable =
        NativeThemeShape(context.resources.displayMetrics.density, fill, { radius.dp() }, outline, strokeColor)
    fun shape(context: Context, fill: NativeColorRole, radius: Int, outline: Boolean? = null, strokeColor: NativeColorRole = NativeColorRole.BORDER): GradientDrawable =
        NativeThemeShape(context.resources.displayMetrics.density, fill, { radius }, outline, strokeColor)
    fun shape(context: Context, fill: Int, radius: Int = containerRadius, outline: Boolean = true, strokeColor: Int = border) = GradientDrawable().apply {
        setColor(fill); cornerRadius = context.moteDp(radius).toFloat()
        if (outline) setStroke(context.moteDp(MoteTheme.borderWidth), strokeColor)
    }
    fun clickable(context: Context, fill: NativeColorRole = NativeColorRole.SURFACE, radius: NativeRadiusRole = NativeRadiusRole.CONTAINER, outline: Boolean? = null, strokeColor: NativeColorRole = NativeColorRole.BORDER) = RippleDrawable(
        ColorStateList.valueOf(Color.argb(32, Color.red(accent), Color.green(accent), Color.blue(accent))), shape(context, fill, radius, outline, strokeColor), shape(context, NativeColorRole.SURFACE, radius, false)
    )
    fun clickable(context: Context, fill: NativeColorRole, radius: Int, outline: Boolean? = null, strokeColor: NativeColorRole = NativeColorRole.BORDER) = RippleDrawable(
        ColorStateList.valueOf(Color.argb(32, Color.red(accent), Color.green(accent), Color.blue(accent))), shape(context, fill, radius, outline, strokeColor), shape(context, NativeColorRole.SURFACE, radius, false)
    )
    fun clickable(context: Context, fill: Int, radius: Int = containerRadius, outline: Boolean = true, strokeColor: Int = border) = RippleDrawable(
        ColorStateList.valueOf(Color.argb(32, Color.red(accent), Color.green(accent), Color.blue(accent))), shape(context, fill, radius, outline, strokeColor), shape(context, NativeColorRole.SURFACE, radius, false)
    )

    enum class ButtonRole { PRIMARY, SECONDARY, TEXT }

    fun button(button: Button, primary: Boolean = false, radius: Int = actionRadius) = action(button, if (primary) ButtonRole.PRIMARY else ButtonRole.SECONDARY, radius)

    fun action(button: Button, role: ButtonRole = ButtonRole.SECONDARY, radius: Int = actionRadius, applyPadding: Boolean = true): Button = button.apply {
        NativePresentationStyles.remember(this, "action") { action(it as Button, role, MoteTheme.radiusControl, false) }
        val primary = role == ButtonRole.PRIMARY
        isAllCaps = false; type(this, NativeFontRole.ACTION, medium = true); minHeight = context.moteDp(MoteTheme.controlHeight)
        minimumHeight = minHeight
        setTextColor(ColorStateList(arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()), intArrayOf(muted, if (primary) MoteTheme.primaryInk else ink)))
        setTag(R.id.mote_primary, primary)
        setTag(R.id.mote_button_role, role)
        backgroundTintList = null; background = android.graphics.drawable.StateListDrawable().apply {
            addState(intArrayOf(-android.R.attr.state_enabled), shape(context, if (role == ButtonRole.TEXT) Color.TRANSPARENT else MoteUi.background, radius, role != ButtonRole.TEXT, controlBorder))
            addState(intArrayOf(), clickable(context, when (role) { ButtonRole.PRIMARY -> MoteTheme.primaryBackground; ButtonRole.SECONDARY -> MoteTheme.surface; ButtonRole.TEXT -> Color.TRANSPARENT }, radius, role == ButtonRole.SECONDARY, controlBorder))
        }
        if (applyPadding) setPadding(context.moteDp(MoteTheme.spacePanel), context.moteDp(MoteTheme.spaceInline), context.moteDp(MoteTheme.spacePanel), context.moteDp(MoteTheme.spaceInline))
    }

    private fun inputColors(field: EditText) = field.apply {
        highlightColor = MoteTheme.tint; setHintTextColor(MoteTheme.muted)
        // Native text editing drawables are retained by the View; retint them in place.
        listOf(textCursorDrawable, textSelectHandle, textSelectHandleLeft, textSelectHandleRight).filterNotNull().forEach { it.mutate().setTint(MoteTheme.accent) }
    }
    private fun inputBackground(field:EditText) {
        field.backgroundTintList=null
        field.background=android.graphics.drawable.StateListDrawable().apply {
            addState(intArrayOf(-android.R.attr.state_enabled),shape(field.context,NativeColorRole.BACKGROUND,NativeRadiusRole.CONTROL,true,NativeColorRole.CONTROL_BORDER))
            addState(intArrayOf(android.R.attr.state_focused),shape(field.context,NativeColorRole.SURFACE,NativeRadiusRole.CONTROL,true,NativeColorRole.ACCENT))
            addState(intArrayOf(),shape(field.context,NativeColorRole.SURFACE,NativeRadiusRole.CONTROL,true,NativeColorRole.CONTROL_BORDER))
        }
    }
    fun field(field: EditText): EditText = field.apply {
        NativePresentationStyles.remember(this,"field") { value -> (value as EditText).apply {
            MoteUi.textColor(this,NativeColorRole.INK);inputColors(this);inputBackground(this);minimumHeight=context.moteDp(MoteTheme.controlHeight)
        } }
        textColor(this,NativeColorRole.INK);inputColors(this);type(this,NativeFontRole.BODY);inputBackground(this)
        setPadding(context.moteDp(MoteTheme.spacePanel),context.moteDp(MoteTheme.spaceItem),context.moteDp(MoteTheme.spacePanel),context.moteDp(MoteTheme.spaceItem))
        minimumHeight=context.moteDp(MoteTheme.controlHeight)
    }

    fun select(spinner: Spinner): Spinner = spinner.apply {
        NativePresentationStyles.remember(this, "select") { select(it as Spinner) }
        val existing = adapter
        if (existing != null && existing !is NativeSpinnerAdapter) {
            val selected = selectedItemPosition
            adapter = NativeSpinnerAdapter(existing)
            if (selected >= 0) setSelection(selected)
        }
        backgroundTintList = null
        background = android.graphics.drawable.LayerDrawable(arrayOf(
            shape(context, NativeColorRole.SURFACE, NativeRadiusRole.CONTROL, true, NativeColorRole.CONTROL_BORDER),
            MoteNavigationIcon(context, "dropdown", false)
        )).apply {
            setLayerSize(1, context.moteDp(20), context.moteDp(20))
            setLayerGravity(1, Gravity.END or Gravity.CENTER_VERTICAL)
            setLayerInset(1, 0, 0, context.moteDp(MoteTheme.spaceInline), 0)
        }
        setPadding(context.moteDp(MoteTheme.spaceInline), 0, context.moteDp(36), 0)
        minimumHeight = context.moteDp(MoteTheme.controlHeight)
        setPopupBackgroundDrawable(shape(context, NativeColorRole.SURFACE_RAISED))
    }

    fun styleSelects(view: View) {
        if (view is Spinner) select(view)
        else {
            if (view is CompoundButton) compound(view)
            if (view is ProgressBar) progress(view)
            if (view is ViewGroup) for (index in 0 until view.childCount) styleSelects(view.getChildAt(index))
        }
    }
    private fun compound(view: CompoundButton) { NativePresentationStyles.bind(view, "compound") { value -> (value as CompoundButton).apply {
        setTextColor(enabledColors(MoteTheme.ink)); type(this, NativeFontRole.BODY); buttonTintList = enabledColors(MoteTheme.accent); minHeight = context.moteDp(MoteTheme.controlHeight)
    } } }
    private fun progress(view: ProgressBar) { NativePresentationStyles.bind(view, "progress") { value -> (value as ProgressBar).apply {
        indeterminateTintList = ColorStateList.valueOf(MoteTheme.accent); progressTintList = ColorStateList.valueOf(MoteTheme.accent)
    } } }

    /** A selected scope or retention choice must remain fully readable, including at 130%. */
    fun choiceAdapter(context: Context, labels: List<String>) = object : ArrayAdapter<String>(context, android.R.layout.simple_spinner_dropdown_item, labels) {
        private fun present(view: View, popup: Boolean): View = view.apply {
            (this as? TextView)?.let {
                type(it, NativeFontRole.BODY); textColor(it, NativeColorRole.INK)
                if(popup) MoteUi.backgroundColor(it, NativeColorRole.SURFACE_RAISED) else NativePresentationStyles.bind(it,"background-color") { selected -> selected.setBackgroundColor(Color.TRANSPARENT) }
                it.isSingleLine = false; it.maxLines = Int.MAX_VALUE; it.ellipsize = null
                it.gravity = Gravity.CENTER_VERTICAL; it.minHeight = context.moteDp(MoteTheme.controlHeight)
                it.setPadding(context.moteDp(MoteTheme.spaceInline), context.moteDp(MoteTheme.spaceInline), context.moteDp(MoteTheme.spaceInline), context.moteDp(MoteTheme.spaceInline))
            }
        }
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View = present(super.getView(position, convertView, parent),false)
        override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View = present(super.getDropDownView(position, convertView, parent),true)
    }

    /** Set line behavior before inputType: setSingleLine replaces password transformation. */
    fun textInput(field: EditText, type: Int, multiline: Boolean = false) = field.apply {
        setSingleLine(!multiline)
        if (multiline) { minLines = 2; gravity = Gravity.TOP }
        inputType = if (multiline) android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE else type
        // Password input applies a platform monospace face; retain masking and the shared type face.
        typeface = Typeface.create(MoteTheme.fontFamily(false), Typeface.NORMAL)
    }

    /** Apply the same controls to dynamic native lists and dialog forms. */
    fun styleTree(view: View) {
        when (view) {
            is Spinner -> select(view)
            is Button -> if (view !is CompoundButton) {
                action(view, view.getTag(R.id.mote_button_role) as? ButtonRole ?: if (view.getTag(R.id.mote_primary) == true) ButtonRole.PRIMARY else ButtonRole.SECONDARY)
                (view.layoutParams as? LinearLayout.LayoutParams)?.let {
                    // A bottom margin in a vertically centered horizontal row shifts
                    // the child above its parent and clips its top border.
                    it.bottomMargin = if ((view.parent as? LinearLayout)?.orientation == LinearLayout.VERTICAL) view.context.moteDp(8) else 0
                }
                // The native dialog bar bottom-aligns actions. Baseline alignment also
                // subtracts the custom bottom margin, moving their top into its padding.
                if (view.id in setOf(android.R.id.button1, android.R.id.button2, android.R.id.button3))
                    (view.parent as? LinearLayout)?.isBaselineAligned = false
            }
            is EditText -> field(view)
            is ProgressBar -> progress(view)
            is CheckedTextView -> {
                type(view, NativeFontRole.BODY); textColor(view, NativeColorRole.INK)
                NativePresentationStyles.bind(view, "checkmark") { (it as CheckedTextView).checkMarkTintList = ColorStateList.valueOf(MoteTheme.accent) }
            }
            is TextView -> if (view.getTag(R.id.mote_type) == null) {
                val dialogTitle = view.resources.getIdentifier("alertTitle", "id", "android")
                type(view, if (view.id == dialogTitle) NativeFontRole.TITLE_MOBILE else NativeFontRole.BODY, view.id == dialogTitle)
                textColor(view, NativeColorRole.INK)
            }
        }
        if (view is CompoundButton) compound(view)
        if (view is ViewGroup) for (index in 0 until view.childCount) styleTree(view.getChildAt(index))
    }
}

/** Native adapters retain their data and selection semantics while the provider owns presentation. */
private class NativeSpinnerAdapter(private val delegate: SpinnerAdapter) : SpinnerAdapter by delegate {
    private fun present(view: View, popup: Boolean): View = view.apply {
        if (this is TextView) {
            MoteUi.type(this); MoteUi.textColor(this, NativeColorRole.INK)
            if(popup) MoteUi.backgroundColor(this, NativeColorRole.SURFACE_RAISED) else NativePresentationStyles.bind(this,"background-color") { selected -> selected.setBackgroundColor(Color.TRANSPARENT) }
            minHeight = context.moteDp(MoteTheme.controlHeight)
            isSingleLine = false; maxLines = Int.MAX_VALUE; ellipsize = null
        }
    }
    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View = present(delegate.getView(position, convertView, parent),false)
    override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View = present(delegate.getDropDownView(position, convertView, parent),true)
}

fun Context.moteDp(value: Int) = (value * resources.displayMetrics.density).toInt()

/** Small stroke icons keep the navigation legible across system font and emoji versions. */
class MoteNavigationIcon(context: Context, private val kind: String, private val active: Boolean) : Drawable() {
    private val size = context.moteDp(23)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = if (active) MoteUi.accent else MoteUi.muted
        style = Paint.Style.STROKE; strokeWidth = 1.65f; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    override fun getIntrinsicWidth() = size
    override fun getIntrinsicHeight() = size
    override fun draw(canvas: Canvas) {
        paint.color = if (active) MoteTheme.accent else MoteTheme.muted
        canvas.save(); canvas.translate(bounds.left.toFloat(), bounds.top.toFloat()); canvas.scale(bounds.width() / 24f, bounds.height() / 24f)
        fun line(x: Float, y: Float, xx: Float, yy: Float) = canvas.drawLine(x, y, xx, yy, paint)
        fun path(vararg points: Float) {
            val p = Path(); p.moveTo(points[0], points[1]); var i = 2
            while (i < points.size) { p.lineTo(points[i], points[i + 1]); i += 2 }; canvas.drawPath(p, paint)
        }
        when (kind) {
            "dropdown" -> path(6f, 9f, 12f, 15f, 18f, 9f)
            "overview" -> { path(3f, 11f, 12f, 3f, 21f, 11f); path(5f, 10f, 5f, 21f, 19f, 21f, 19f, 10f); path(10f, 21f, 10f, 14f, 14f, 14f, 14f, 21f) }
            "notes", "note" -> { canvas.drawRoundRect(4f, 3f, 20f, 21f, 3f, 3f, paint); line(8f, 8f, 16f, 8f); line(8f, 12f, 16f, 12f); line(8f, 16f, 13f, 16f) }
            "import" -> { path(13f, 3f, 5f, 3f, 5f, 21f, 19f, 21f, 19f, 9f, 13f, 3f, 13f, 9f, 19f, 9f); line(8f, 14f, 16f, 14f); path(13f, 11f, 16f, 14f, 13f, 17f) }
            "folder" -> { path(3f, 7f, 3f, 20f, 21f, 20f, 21f, 7f, 3f, 7f, 3f, 4f, 10f, 4f, 13f, 7f) }
            // Library and sources share glyph roles with Web and Mac: a database and a link.
            "library" -> { canvas.drawOval(4f, 2f, 20f, 8f, paint); line(4f, 5f, 4f, 19f); line(20f, 5f, 20f, 19f); canvas.drawArc(4f, 9f, 20f, 15f, 0f, 180f, false, paint); canvas.drawArc(4f, 16f, 20f, 22f, 0f, 180f, false, paint) }
            "sources" -> { canvas.drawRoundRect(2f, 8f, 13f, 16f, 4f, 4f, paint); canvas.drawRoundRect(11f, 8f, 22f, 16f, 4f, 4f, paint) }
            "ask" -> { canvas.drawRoundRect(3f, 3f, 21f, 18f, 4f, 4f, paint); path(7f, 18f, 7f, 22f, 12f, 18f); line(7f, 8f, 17f, 8f); line(7f, 12f, 14f, 12f) }
            "capture" -> { canvas.drawRoundRect(4f, 3f, 20f, 21f, 3f, 3f, paint); canvas.drawCircle(12f, 12f, 4f, paint); line(10f, 18f, 14f, 18f) }
            "chart" -> { path(4f, 4f, 4f, 20f, 21f, 20f); path(8f, 15f, 12f, 10f, 16f, 13f, 21f, 5f) }
            "activity" -> { line(5f, 20f, 5f, 11f); line(12f, 20f, 12f, 4f); line(19f, 20f, 19f, 13f) }
            "shield" -> { path(12f, 2f, 21f, 6f, 20f, 15f, 17f, 19f, 12f, 22f, 7f, 19f, 4f, 15f, 3f, 6f, 12f, 2f); path(8f, 12f, 11f, 15f, 16f, 9f) }
            "language" -> {
                canvas.drawCircle(12f, 12f, 9f, paint); canvas.drawOval(8f, 3f, 16f, 21f, paint)
                line(4f, 9f, 20f, 9f); line(4f, 15f, 20f, 15f)
            }
            "plugin" -> {
                val p = Path().apply {
                    moveTo(4f, 4f); lineTo(10f, 4f); cubicTo(10f, 1f, 15f, 1f, 15f, 4f)
                    lineTo(20f, 4f); lineTo(20f, 10f); cubicTo(23f, 10f, 23f, 15f, 20f, 15f)
                    lineTo(20f, 20f); lineTo(14f, 20f); cubicTo(14f, 17f, 9f, 17f, 9f, 20f)
                    lineTo(4f, 20f); lineTo(4f, 14f); cubicTo(7f, 14f, 7f, 9f, 4f, 9f); close()
                }; canvas.drawPath(p, paint)
            }
            "code" -> { path(7f, 6f, 2f, 12f, 7f, 18f); path(17f, 6f, 22f, 12f, 17f, 18f); line(14f, 4f, 10f, 20f) }
            "sync" -> { canvas.drawArc(4f, 4f, 20f, 20f, 210f, 145f, false, paint); path(16f, 4f, 20f, 8f, 21f, 3f); canvas.drawArc(4f, 4f, 20f, 20f, 30f, 145f, false, paint); path(3f, 21f, 4f, 16f, 8f, 20f) }
            "info" -> { canvas.drawCircle(12f, 12f, 9f, paint); line(12f, 11f, 12f, 17f); canvas.drawPoint(12f, 7f, paint) }
            "camera" -> { path(3f, 8f, 7f, 8f, 9f, 5f, 15f, 5f, 17f, 8f, 21f, 8f, 21f, 19f, 3f, 19f, 3f, 8f); canvas.drawCircle(12f, 13f, 3.5f, paint) }
            "microphone" -> { canvas.drawRoundRect(9f, 3f, 15f, 14f, 3f, 3f, paint); canvas.drawArc(5f, 4f, 19f, 18f, 0f, 180f, false, paint); line(12f, 18f, 12f, 21f) }
            "search" -> { canvas.drawCircle(11f, 11f, 6.5f, paint); line(16f, 16f, 20f, 20f) }
            "pause" -> { line(9f, 6f, 9f, 18f); line(15f, 6f, 15f, 18f) }
            "warning" -> { path(12f, 4f, 21f, 20f, 3f, 20f, 12f, 4f); line(12f, 10f, 12f, 14f); canvas.drawPoint(12f, 17f, paint) }
            "calendar" -> { canvas.drawRoundRect(4f, 5f, 20f, 20f, 2f, 2f, paint); line(4f, 10f, 20f, 10f); line(9f, 3f, 9f, 7f); line(15f, 3f, 15f, 7f) }
            else -> { line(4f, 6f, 20f, 6f); line(4f, 12f, 20f, 12f); line(4f, 18f, 20f, 18f); line(9f, 3f, 9f, 9f); line(16f, 9f, 16f, 15f); line(10f, 15f, 10f, 21f) }
        }
        canvas.restore()
    }
    override fun setAlpha(alpha: Int) { paint.alpha = alpha }
    override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter }
    @Deprecated("Drawable opacity") override fun getOpacity() = PixelFormat.TRANSLUCENT
}

/** The phone home keeps Ask and the quick records in the thumb zone; management and detail pages have no persistent tabs. */
class MotePrimaryNavigation(private val activity: Activity, private val onSelect: (MotePrimaryTab) -> Unit) : LinearLayout(activity) {
    private var selected = MotePrimaryTab.HOME
    private var hasDraft = false
    private lateinit var record: TextView
    init { setWillNotDraw(false); refreshPresentation() }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val line = Paint().apply { color = NativeColorRole.DIVIDER.color(); strokeWidth = resources.displayMetrics.density }
        canvas.drawLine(0f, 0f, width.toFloat(), 0f, line)
    }
    fun refreshPresentation() {
        removeAllViews()
        orientation = VERTICAL; isBaselineAligned = false
        setPadding(activity.moteDp(16), activity.moteDp(12), activity.moteDp(16), activity.moteDp(16))
        MoteUi.backgroundColor(this, NativeColorRole.BACKGROUND)
        contentDescription = MoteI18n.text("记录与提问")
        val ask = LinearLayout(activity).apply {
            tag = "home-ask-action"; gravity = Gravity.CENTER_VERTICAL; minimumHeight = activity.moteDp(52)
            setPadding(activity.moteDp(16), 0, activity.moteDp(16), 0)
            background = MoteUi.clickable(activity, NativeColorRole.SURFACE, 14, true, NativeColorRole.BORDER)
            contentDescription = MoteI18n.text("问一问"); isFocusable = true
            setOnClickListener { onSelect(MotePrimaryTab.ASK) }
        }
        ask.addView(ImageView(activity).apply { setImageDrawable(MoteNavigationIcon(activity, "ask", true)); importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO },
            LayoutParams(activity.moteDp(20), activity.moteDp(20)).apply { marginEnd = activity.moteDp(10) })
        ask.addView(TextView(activity).apply { text = MoteI18n.text("问一问…"); MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.MUTED) }, LayoutParams(0, -2, 1f))
        addView(ask, LayoutParams(-1, -2))
        // Off-screen moments are recorded by hand; on-screen content is already covered by background capture.
        val actions = LinearLayout(activity).apply { orientation = HORIZONTAL; isBaselineAligned = false }
        record = TextView(activity).apply {
            tag = "home-record-action"; gravity = Gravity.CENTER; minHeight = activity.moteDp(52)
            setPadding(activity.moteDp(12), 0, activity.moteDp(12), 0)
            MoteUi.type(this, NativeFontRole.ACTION, medium = true)
            MoteUi.textColor(this, NativeColorRole.BACKGROUND)
            background = MoteUi.clickable(activity, NativeColorRole.ACCENT, 12, false)
            isFocusable = true; setOnClickListener { activity.openRecordEditor() }
        }
        actions.addView(record, LayoutParams(0, -1, 1f))
        actions.addView(quickRecord("home-photo-action", "camera", MoteQuickEntry.PHOTO), LayoutParams(activity.moteDp(76), -1).apply { marginStart = activity.moteDp(8) })
        actions.addView(quickRecord("home-audio-action", "microphone", MoteQuickEntry.AUDIO), LayoutParams(activity.moteDp(76), -1).apply { marginStart = activity.moteDp(8) })
        addView(actions, LayoutParams(-1, -2).apply { topMargin = activity.moteDp(8) })
        updateDraft(hasDraft); select(selected)
    }
    // The same entry definitions back the launcher shortcuts, notification and widget.
    private fun quickRecord(identity: String, icon: String, entry: MoteQuickEntry) = LinearLayout(activity).apply {
        orientation = VERTICAL; gravity = Gravity.CENTER; tag = identity; minimumHeight = activity.moteDp(52)
        setPadding(0, activity.moteDp(6), 0, activity.moteDp(6))
        background = MoteUi.clickable(activity, NativeColorRole.SIDEBAR, 12, false)
        contentDescription = entry.label; isFocusable = true; setOnClickListener { activity.openRecordEditor(media = entry.media) }
        addView(ImageView(activity).apply { setImageDrawable(MoteNavigationIcon(activity, icon, false)); importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO },
            LayoutParams(activity.moteDp(20), activity.moteDp(20)))
        addView(TextView(activity).apply {
            text = entry.label; gravity = Gravity.CENTER; maxLines = 1; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.INK)
        }, LayoutParams(-2, -2).apply { topMargin = activity.moteDp(2) })
    }
    fun updateDraft(value: Boolean) {
        hasDraft = value
        record.text = "✎  " + MoteI18n.text(if (value) "继续草稿" else "记录")
        record.contentDescription = MoteI18n.text(if (value) "继续草稿" else "记录")
    }
    fun select(tab: MotePrimaryTab) { selected = tab; visibility = if (tab == MotePrimaryTab.HOME) VISIBLE else GONE }
}

/** The selected destination is indicated at its icon; the entire item remains one touch target. */
private class MoteNavigationIndicator(context: Context, kind: String, private val active: Boolean) : Drawable() {
    private val width = context.moteDp(64)
    private val height = context.moteDp(32)
    private val glyphSize = context.moteDp(23)
    private val glyph = MoteNavigationIcon(context, kind, active)
    private val indicator = MoteUi.shape(context, NativeColorRole.TINT, NativeRadiusRole.INDICATOR, false)
    override fun getIntrinsicWidth() = width
    override fun getIntrinsicHeight() = height
    override fun draw(canvas: Canvas) {
        if (active) { indicator.bounds = bounds; indicator.draw(canvas) }
        val left = bounds.centerX() - glyphSize / 2
        val top = bounds.centerY() - glyphSize / 2
        glyph.setBounds(left, top, left + glyphSize, top + glyphSize); glyph.draw(canvas)
    }
    override fun setAlpha(alpha: Int) { indicator.alpha = alpha; glyph.alpha = alpha }
    override fun setColorFilter(colorFilter: ColorFilter?) { glyph.colorFilter = colorFilter }
    @Deprecated("Drawable opacity") override fun getOpacity() = PixelFormat.TRANSLUCENT
}

fun Activity.openMoteLocalPage(page: String) {
    startActivity(Intent(this, MainActivity::class.java).putExtra("page", page)
        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
}

fun Activity.openMotePrimary(tab: MotePrimaryTab) {
    openMoteLocalPage(tab.localPage)
}

private fun Activity.detailTab(): MotePrimaryTab? = when (this) {
    is MainActivity, is CentralActivity -> null
    is CaptureRecordsActivity, is FileContentActivity -> MotePrimaryTab.LIBRARY
    is SourcesActivity, is FileTaskActivity, is ConnectionActivity -> MotePrimaryTab.SOURCES
    else -> MotePrimaryTab.LIBRARY
}

fun Activity.moteDetailPage(primary: MotePrimaryTab? = detailTab(), title: String? = null, headerAction: View? = null, onBack: () -> Unit = { finish() }): LinearLayout =
    moteDetailPageContent(primary,title,headerAction,onBack) { body->ScrollView(this).apply { isFillViewport=true;addView(body) } }

internal fun Activity.moteDetailPageContent(primary: MotePrimaryTab? = detailTab(), title: String? = null, headerAction: View? = null, onBack: () -> Unit = { finish() }, buildContent:(LinearLayout)->View): LinearLayout {
    val body = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(moteDp(MoteTheme.spacePage), moteDp(MoteTheme.spaceItem), moteDp(MoteTheme.spacePage), moteDp(MoteTheme.spaceGroup))
    }
    val root = NativeAppShell(this).apply { moteInsets() }
    val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; minimumHeight = moteDp(66) }
    header.addView(TextView(this).apply {
        text = if (title == null) "‹  " + MoteI18n.text("返回上级") else "‹"
        MoteUi.type(this, NativeFontRole.ACTION); MoteUi.textColor(this, NativeColorRole.MUTED)
        gravity = Gravity.CENTER_VERTICAL; minHeight = moteDp(48)
        setPadding(moteDp(16), moteDp(4), moteDp(16), moteDp(4))
        contentDescription = MoteI18n.text("返回上一页"); isFocusable = true; setOnClickListener { onBack() }
    }, if (title == null) LinearLayout.LayoutParams(0, -2, 1f) else LinearLayout.LayoutParams(moteDp(48), -2))
    if (title != null) header.addView(TextView(this).apply {
        text = title; tag = "detail-title"; MoteUi.type(this, NativeFontRole.APPBAR, medium = true); MoteUi.textColor(this, NativeColorRole.INK)
        setPadding(0, moteDp(MoteTheme.spaceInline), moteDp(MoteTheme.spaceInline), moteDp(MoteTheme.spaceInline))
    }, LinearLayout.LayoutParams(0, -2, 1f))
    headerAction?.let { header.addView(it, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = moteDp(20) }) }
    root.header(header)
    root.header(View(this).apply { MoteUi.backgroundColor(this, NativeColorRole.DIVIDER); layoutParams = LinearLayout.LayoutParams(-1, moteDp(1)) })
    root.content(buildContent(body))
    setContentView(root)
    return body
}

/** Dynamic dialogs use the same fields/buttons and outside-field keyboard dismissal. */
class MoteDialogBuilder(context: Context) : android.app.AlertDialog.Builder(context) {
    override fun create(): android.app.AlertDialog = super.create().also { dialog ->
        dialogs.add(java.lang.ref.WeakReference(dialog))
        val window = dialog.window ?: return@also
        window.decorView.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
        override fun onViewDetachedFromWindow(view: View) = Unit
        override fun onViewAttachedToWindow(view: View) {
        window.setBackgroundDrawable(MoteUi.shape(context, NativeColorRole.SURFACE_RAISED, NativeRadiusRole.READING))
        MoteUi.styleTree(window.decorView)
        // Some platform dialogs wrap stacked actions in a ScrollView whose
        // minimum height reserves only one action. Keep every styled action
        // visible and let the existing message area take the remaining height.
        val actions = listOf(android.content.DialogInterface.BUTTON_POSITIVE, android.content.DialogInterface.BUTTON_NEGATIVE,
            android.content.DialogInterface.BUTTON_NEUTRAL).mapNotNull(dialog::getButton).firstOrNull()?.parent as? View
        val panel = actions?.parent as? ScrollView
        fun reserveActions() {
            if (panel == null || actions == null) return
            val required = actions.measuredHeight + panel.paddingTop + panel.paddingBottom
            if (required > 0 && panel.minimumHeight != required) {
                panel.minimumHeight = required
                // A request raised from the child's layout can be suppressed
                // during the dialog's second layout pass. Queue the real pass.
                panel.post { panel.requestLayout() }
            }
        }
        actions?.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> reserveActions() }
        reserveActions()
        val original = window.callback
        window.callback = object : android.view.Window.Callback by original {
            override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
                if (event.action == android.view.MotionEvent.ACTION_DOWN) {
                    val field = window.currentFocus as? EditText
                    if (field != null) {
                        val bounds = android.graphics.Rect(); field.getGlobalVisibleRect(bounds)
                        if (!bounds.contains(event.rawX.toInt(), event.rawY.toInt())) {
                            field.clearFocus()
                            context.getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(field.windowToken, 0)
                        }
                    }
                }
                return original.dispatchTouchEvent(event)
            }
        }
        }
        })
    }
    companion object {
        private val dialogs = mutableListOf<java.lang.ref.WeakReference<android.app.AlertDialog>>()
        fun refreshOwned(activity: Activity) {
            dialogs.removeAll { it.get() == null }
            dialogs.mapNotNull { it.get() }.filter { it.isShowing }.forEach { dialog ->
                var owner: Context = dialog.context
                while (owner is android.content.ContextWrapper && owner !is Activity && owner.baseContext !== owner) owner = owner.baseContext
                if (owner === activity) dialog.window?.let { window ->
                    window.setBackgroundDrawable(MoteUi.shape(activity, NativeColorRole.SURFACE_RAISED, NativeRadiusRole.READING))
                    NativePresentationStyles.refresh(window.decorView)
                }
            }
        }
    }

}

/** Every Add entry uses this same action set and real native flows. */
enum class MoteAddAction(val titleKey: String, val subtitleKey: String, val icon: String) {
    FOLDER("同步文件夹", "持续收集文件夹里的新内容与修改", "folder"),
    FILE("导入文件", "导入一次，不跟踪后续修改。", "import"),
    SCREEN("记录屏幕", "先选择应用范围，再按需授权", "capture"),
    NOTE("随手记", "离线也能留下想法与片段", "notes"),
    FEISHU("连接飞书文档", "由中央收集文档与活动线索", "library")
}
fun Activity.openMoteAdd(action: MoteAddAction) {
    if (this is MainActivity) { addContent(action); return }
    when (action) {
        MoteAddAction.FOLDER, MoteAddAction.FILE -> startActivity(Intent(this, FileTaskActivity::class.java).putExtra("addAction", action.name))
        MoteAddAction.SCREEN -> openMoteLocalPage("PRIVACY")
        MoteAddAction.NOTE -> openRecordEditor()
        MoteAddAction.FEISHU -> startActivity(Intent(this, CentralActivity::class.java).putExtra("page", "lark"))
    }
}
fun Activity.showMoteAddActions() {
    MoteDialogBuilder(this).setTitle(MoteI18n.text("添加内容"))
        .setItems(MoteAddAction.entries.map { MoteI18n.text(it.titleKey) }.toTypedArray()) { _, index -> openMoteAdd(MoteAddAction.entries[index]) }
        .setNegativeButton(MoteI18n.text("取消"), null).show()
}

// U07: declarative plugin surface — maps a strictly-parsed spec into real
// Views. Only declared command actions can fire; the invoker carries the
// same revision the DOMAIN issued.
fun Context.declarativePluginView(
    spec: dev.mote.collector.plugins.DeclarativeSpec,
    data: org.json.JSONObject,
    label: (String) -> String,
    busy: () -> Boolean,
    onCommand: (String, org.json.JSONObject) -> Unit,
): LinearLayout {
    val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    val tv = { value: String -> TextView(this).apply { MoteUi.textColor(this, NativeColorRole.INK); setText(value) } }
    for (component in spec.components) when (component) {
        is dev.mote.collector.plugins.DeclarativeNode.Status -> body.addView(tv(component.textKey?.let(label) ?: component.state.name.lowercase()))
        is dev.mote.collector.plugins.DeclarativeNode.Listing -> {
            val items = data.optJSONArray(component.itemKey) ?: org.json.JSONArray()
            if (items.length() == 0) body.addView(tv(label("empty")))
            for (i in 0 until items.length()) {
                val row = items.optJSONObject(i) ?: continue
                body.addView(tv(component.fields.joinToString(" · ") { f -> label(f.labelKey ?: f.key) + " " + row.opt(f.key)?.toString() }))
            }
        }
        is dev.mote.collector.plugins.DeclarativeNode.Detail -> for (f in component.fields)
            body.addView(tv(label(f.labelKey ?: f.key) + " " + (data.opt(f.key)?.toString() ?: "—")))
        is dev.mote.collector.plugins.DeclarativeNode.Form -> {
            val inputs = component.fields.map { f ->
                if (f.input == "boolean") CheckBox(this).apply { text = label(f.labelKey ?: f.key); body.addView(this) } to f
                else EditText(this).apply { hint = label(f.labelKey ?: f.key); if (f.input == "number") inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL; body.addView(this) } to f
            }
            component.submitCommand?.let { command ->
                // Serialize per declared input type before submitting —
                // the same contract as the web serializeFormInput.
                body.addView(Button(this).apply { text = label(command); isEnabled = !busy(); setOnClickListener {
                    if (busy()) return@setOnClickListener
                    val input = org.json.JSONObject()
                    for ((view, f) in inputs) when (f.input) {
                        "boolean" -> {
                            // A required checkbox must be affirmed before dispatch.
                            val box = view as CheckBox
                            if (f.required && !box.isChecked) { box.hint = label(f.labelKey ?: f.key); box.requestFocus(); return@setOnClickListener }
                            input.put(f.key, box.isChecked)
                        }
                        "number" -> {
                            val raw = (view as EditText).text.toString()
                            if (raw.isBlank()) { if (f.required) { view.error = label(f.labelKey ?: f.key); view.requestFocus(); return@setOnClickListener } }
                            else raw.toDoubleOrNull()?.let { input.put(f.key, it) } ?: run { view.error = label(f.labelKey ?: f.key); view.requestFocus(); return@setOnClickListener }
                        }
                        else -> {
                            val raw = (view as EditText).text.toString()
                            if (f.required && raw.isBlank()) { view.error = label(f.labelKey ?: f.key); view.requestFocus(); return@setOnClickListener }
                            input.put(f.key, raw)
                        }
                    }
                    onCommand(command, input)
                } })
            }
        }
        is dev.mote.collector.plugins.DeclarativeNode.Action -> body.addView(Button(this).apply {
            text = component.labelKey?.let(label) ?: component.command
            isEnabled = !busy()
            setOnClickListener { if (!busy()) onCommand(component.command, org.json.JSONObject()) }
        })
    }
    return body
}
