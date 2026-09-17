package dev.mote.collector

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import kotlin.math.abs

/** A schematic canvas only. Never reads or renders the user's screen. */
class MaskEditorView(context: Context, private val changed: (List<Mask>) -> Unit) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val area = RectF()
    private var masks = emptyList<Mask>()
    private var startX = 0f; private var startY = 0f
    private var drag: Mask? = null
    var selectedIndex = -1; private set
    init {
        contentDescription = MoteI18n.text("固定遮罩示意图。在图上拖动添加矩形，点按矩形选中。也可用下方按钮添加和调整。")
        isFocusable = true; isClickable = true; background = MoteUi.shape(context)
    }
    fun value() = masks.toList()
    fun setMasks(value: List<Mask>) { if (masks != value) { masks = value.toList(); selectedIndex = selectedIndex.coerceAtMost(masks.lastIndex); invalidate() } }
    fun add(mask: Mask) { if (masks.size >= 200) return; masks = masks + mask; selectedIndex = masks.lastIndex; changed(masks); invalidate() }
    fun removeSelected() { if (selectedIndex !in masks.indices) return; masks = masks.filterIndexed { i, _ -> i != selectedIndex }; selectedIndex = -1; changed(masks); invalidate() }
    fun updateSelected(mask: Mask) { if (selectedIndex !in masks.indices) return; masks = masks.mapIndexed { i, old -> if (i == selectedIndex) mask else old }; changed(masks); invalidate() }
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val pad = context.moteDp(16).toFloat(); val ratio = resources.displayMetrics.widthPixels.toFloat() / resources.displayMetrics.heightPixels
        val phoneWidth = minOf(w - pad * 2, (h - pad * 2) * ratio)
        area.set((w - phoneWidth) / 2, pad, (w + phoneWidth) / 2, h - pad)
    }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        paint.style = Paint.Style.FILL; paint.color = MoteUi.background
        canvas.drawRoundRect(area, 14f, 14f, paint)
        paint.color = MoteUi.border; paint.style = Paint.Style.STROKE; paint.strokeWidth = 2f
        canvas.drawRoundRect(area, 14f, 14f, paint)
        for (row in 1..7) canvas.drawLine(area.left + 10, area.top + area.height() * row / 8, area.right - 10, area.top + area.height() * row / 8, paint)
        fun draw(mask: Mask, selected: Boolean) {
            val rect = RectF(area.left + mask.left * area.width(), area.top + mask.top * area.height(), area.left + mask.right * area.width(), area.top + mask.bottom * area.height())
            paint.style = Paint.Style.FILL; paint.color = Color.argb(if (selected) 150 else 95, 28, 103, 84); canvas.drawRect(rect, paint)
            paint.style = Paint.Style.STROKE; paint.strokeWidth = if (selected) 4f else 2f; paint.color = MoteUi.accent; canvas.drawRect(rect, paint)
        }
        masks.forEachIndexed { index, mask -> draw(mask, selectedIndex == index) }
        drag?.let { draw(it, true) }
    }
    override fun onTouchEvent(event: MotionEvent): Boolean {
        val x = ((event.x - area.left) / area.width()).coerceIn(0f, 1f)
        val y = ((event.y - area.top) / area.height()).coerceIn(0f, 1f)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                if (!area.contains(event.x, event.y)) return false
                parent.requestDisallowInterceptTouchEvent(true); startX = x; startY = y; drag = null
                selectedIndex = masks.indexOfLast { x in it.left..it.right && y in it.top..it.bottom }; invalidate(); return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (abs(x - startX) > .02f && abs(y - startY) > .02f) drag = Mask(minOf(x, startX), minOf(y, startY), maxOf(x, startX), maxOf(y, startY))
                invalidate(); return true
            }
            MotionEvent.ACTION_UP -> { parent.requestDisallowInterceptTouchEvent(false); drag?.let(::add); drag = null; performClick(); invalidate(); return true }
            MotionEvent.ACTION_CANCEL -> { parent.requestDisallowInterceptTouchEvent(false); drag = null; invalidate(); return true }
        }
        return super.onTouchEvent(event)
    }
    override fun performClick(): Boolean { super.performClick(); return true }
}
