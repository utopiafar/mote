package dev.mote.collector

import android.app.Activity
import android.content.Context
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
object MoteUi {
    val background = Color.rgb(246, 247, 242)
    val ink = Color.rgb(34, 52, 47)
    val muted = Color.rgb(100, 115, 106)
    val accent = Color.rgb(28, 103, 84)
    val tint = Color.rgb(231, 239, 230)
    val border = Color.rgb(220, 227, 217)

    fun shape(context: Context, fill: Int = Color.WHITE, radius: Int = 18, outline: Boolean = false) = GradientDrawable().apply {
        setColor(fill); cornerRadius = context.moteDp(radius).toFloat()
        if (outline) setStroke(context.moteDp(1), border)
    }

    fun clickable(context: Context, fill: Int = Color.WHITE, radius: Int = 18) = RippleDrawable(
        ColorStateList.valueOf(Color.argb(24, 28, 103, 84)), shape(context, fill, radius), shape(context, Color.WHITE, radius)
    )

    fun button(button: Button, primary: Boolean = false) = button.apply {
        isAllCaps = false; textSize = 14f; minHeight = context.moteDp(50)
        setTextColor(ColorStateList(arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()), intArrayOf(muted, if (primary) Color.WHITE else accent)))
        setTag(R.id.mote_primary, primary)
        backgroundTintList = null; background = android.graphics.drawable.StateListDrawable().apply {
            addState(intArrayOf(-android.R.attr.state_enabled), shape(context, MoteUi.background, 24))
            addState(intArrayOf(), clickable(context, if (primary) accent else tint, 24))
        }
        setPadding(context.moteDp(14), context.moteDp(12), context.moteDp(14), context.moteDp(12))
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }

    fun field(field: EditText) = field.apply {
        setTextColor(ink); setHintTextColor(muted); textSize = 15f
        background = shape(context, Color.WHITE, 12, true)
        setPadding(context.moteDp(14), context.moteDp(13), context.moteDp(14), context.moteDp(13))
        minHeight = context.moteDp(52)
    }

    /** Apply the same controls to dynamic native lists and dialog forms. */
    fun styleTree(view: View) {
        when (view) {
            is Button -> if (view !is CompoundButton) {
                button(view, view.getTag(R.id.mote_primary) == true)
                (view.layoutParams as? LinearLayout.LayoutParams)?.let { it.bottomMargin = view.context.moteDp(8) }
            }
            is EditText -> field(view)
            is TextView -> { view.setTextColor(ink); view.setLineSpacing(view.context.moteDp(3).toFloat(), 1f) }
        }
        if (view is CompoundButton) { view.setTextColor(ink); view.textSize = 15f; view.buttonTintList = ColorStateList.valueOf(accent); view.minHeight = view.context.moteDp(48) }
        if (view is ViewGroup) for (index in 0 until view.childCount) styleTree(view.getChildAt(index))
    }
}

fun Context.moteDp(value: Int) = (value * resources.displayMetrics.density).toInt()

/** Small stroke icons keep the navigation legible across system font and emoji versions. */
class MoteNavigationIcon(context: Context, private val kind: String, active: Boolean) : Drawable() {
    private val size = context.moteDp(23)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = if (active) MoteUi.accent else MoteUi.muted
        style = Paint.Style.STROKE; strokeWidth = 1.65f; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    override fun getIntrinsicWidth() = size
    override fun getIntrinsicHeight() = size
    override fun draw(canvas: Canvas) {
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
            "sources", "folder" -> { path(3f, 7f, 3f, 20f, 21f, 20f, 21f, 7f, 3f, 7f, 3f, 4f, 10f, 4f, 13f, 7f) }
            "capture" -> { canvas.drawRoundRect(4f, 3f, 20f, 21f, 3f, 3f, paint); canvas.drawCircle(12f, 12f, 4f, paint); line(10f, 18f, 14f, 18f) }
            "chart" -> { path(4f, 4f, 4f, 20f, 21f, 20f); path(8f, 15f, 12f, 10f, 16f, 13f, 21f, 5f) }
            "shield" -> { path(12f, 2f, 21f, 6f, 20f, 15f, 17f, 19f, 12f, 22f, 7f, 19f, 4f, 15f, 3f, 6f, 12f, 2f); path(8f, 12f, 11f, 15f, 16f, 9f) }
            "sync" -> { canvas.drawArc(4f, 4f, 20f, 20f, 210f, 145f, false, paint); path(16f, 4f, 20f, 8f, 21f, 3f); canvas.drawArc(4f, 4f, 20f, 20f, 30f, 145f, false, paint); path(3f, 21f, 4f, 16f, 8f, 20f) }
            "info" -> { canvas.drawCircle(12f, 12f, 9f, paint); line(12f, 11f, 12f, 17f); canvas.drawPoint(12f, 7f, paint) }
            else -> { line(4f, 6f, 20f, 6f); line(4f, 12f, 20f, 12f); line(4f, 18f, 20f, 18f); line(9f, 3f, 9f, 9f); line(16f, 9f, 16f, 15f); line(10f, 15f, 10f, 21f) }
        }
        canvas.restore()
    }
    override fun setAlpha(alpha: Int) { paint.alpha = alpha }
    override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter }
    @Deprecated("Drawable opacity") override fun getOpacity() = PixelFormat.TRANSLUCENT
}

fun Activity.moteDetailPage(onBack: () -> Unit = { finish() }): LinearLayout {
    val body = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(moteDp(22), moteDp(12), moteDp(22), moteDp(32))
    }
    val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(MoteUi.background); moteInsets() }
    root.addView(TextView(this).apply {
        text = MoteI18n.text("‹  返回"); textSize = 15f; setTextColor(MoteUi.accent)
        gravity = Gravity.CENTER_VERTICAL; minHeight = moteDp(48)
        setPadding(moteDp(22), moteDp(4), moteDp(22), moteDp(4))
        contentDescription = MoteI18n.text("返回上一页"); isFocusable = true; setOnClickListener { onBack() }
    }, LinearLayout.LayoutParams(-1, -2))
    root.addView(ScrollView(this).apply { isFillViewport = true; addView(body) }, LinearLayout.LayoutParams(-1, 0, 1f))
    setContentView(root)
    return body
}

/** Dynamic dialogs use the same fields/buttons and outside-field keyboard dismissal. */
class MoteDialogBuilder(context: Context) : android.app.AlertDialog.Builder(context) {
    override fun create(): android.app.AlertDialog = super.create().also { dialog ->
        val window = dialog.window ?: return@also
        window.decorView.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
        override fun onViewDetachedFromWindow(view: View) = Unit
        override fun onViewAttachedToWindow(view: View) {
        MoteUi.styleTree(window.decorView)
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
}
