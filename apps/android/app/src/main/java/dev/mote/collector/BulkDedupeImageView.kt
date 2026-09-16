package dev.mote.collector

import android.content.Context
import android.graphics.Matrix
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.widget.ImageView

/** Memory-only preview: pinch to zoom, drag to inspect, double tap to reset. */
// The host uses a platform Activity/theme; preview bitmaps need no AppCompat tinting.
@android.annotation.SuppressLint("AppCompatCustomView")
class BulkDedupeImageView(context: Context) : ImageView(context) {
    private val transform = Matrix()
    private var lastX = 0f
    private var lastY = 0f
    private var lastTap = 0L
    private var zoom = 1f
    private val scale = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            val next = (zoom * detector.scaleFactor).coerceIn(1f, 8f)
            transform.postScale(next / zoom, next / zoom, detector.focusX, detector.focusY)
            zoom = next; imageMatrix = transform
            return true
        }
    })
    init { scaleType = ScaleType.MATRIX }
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { super.onSizeChanged(w, h, oldw, oldh); reset() }
    private fun reset() {
        val image = drawable ?: return
        val fit = minOf(width.toFloat() / image.intrinsicWidth, height.toFloat() / image.intrinsicHeight)
        transform.setScale(fit, fit)
        transform.postTranslate((width - image.intrinsicWidth * fit) / 2, (height - image.intrinsicHeight * fit) / 2)
        zoom = 1f; imageMatrix = transform
    }
    override fun performClick(): Boolean { super.performClick(); return true }
    override fun onTouchEvent(event: MotionEvent): Boolean {
        scale.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                parent.requestDisallowInterceptTouchEvent(true)
                if (event.eventTime - lastTap < 300) reset()
                lastTap = event.eventTime; lastX = event.x; lastY = event.y
            }
            MotionEvent.ACTION_MOVE -> {
                if (!scale.isInProgress && zoom > 1) { transform.postTranslate(event.x - lastX, event.y - lastY); imageMatrix = transform }
                lastX = event.x; lastY = event.y
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { parent.requestDisallowInterceptTouchEvent(false); if (event.actionMasked == MotionEvent.ACTION_UP) performClick() }
        }
        return true
    }
}
