package dev.mote.collector

import android.graphics.Bitmap
import android.util.LruCache
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.ui.MoteComponents
import java.time.Instant
import java.time.ZoneId
import java.util.concurrent.Executors

/** The former Home list, using only retained originals from this phone. */
internal class LibraryPhoneFeedView(
    private val activity: MoteActivity,
    private val open: (LibraryPhoneFeed.Original) -> Unit,
) : LinearLayout(activity) {
    private val task = UiTask(activity)
    private val thumbs = Executors.newSingleThreadExecutor()
    private val thumbnails = object : LruCache<String, Bitmap>(4 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
    }
    @Volatile private var closed = false
    private var active = false
    private var generation = 0
    private var refreshPending = false
    private var rendered = ""
    @Volatile private var thumbGeneration = 0

    init { orientation = VERTICAL; tag = "library-phone-feed" }

    fun pause() { active = false; generation++; refreshPending = false }
    fun close() { closed = true; pause(); task.close(); thumbs.shutdown(); thumbnails.evictAll() }

    fun refresh() {
        if (closed) return
        active = true
        refreshPending = true
        load()
    }

    private fun load() {
        if (!refreshPending || task.busy) return
        refreshPending = false
        val stamp = generation
        val app = activity.applicationContext
        if (childCount == 0) addView(MoteComponents.skeleton(activity, MoteI18n.text("正在读取…")))
        task.start("", {}, { LibraryPhoneFeed.localPage { app.withNativeNotePreviews(app.queue().recentPage()) } }) { result ->
            if (closed || !active) return@start
            if (generation == stamp) result.onSuccess(::show).onFailure {
                clear()
                label(MoteI18n.text("读取失败"))
                addView(MoteComponents.smallButton(activity, "重试") { refresh() })
            }
            load()
        }
    }

    fun show(originals: List<LibraryPhoneFeed.Original>, showEmpty: Boolean = true) {
        active = true
        val signature = "false:" + showEmpty + ":" + originals.joinToString("|") {
            it.id + ":" + it.capturedAt + ":" + it.hasImage + ":" + it.title + ":" + it.kind + ":" + it.deviceId + ":" + it.source + ":" + it.remote + ":" + it.saved
        }
        val images = originals.filter { it.hasImage }
        if (signature == rendered) { requestThumbs(images); return }
        clear(); rendered = signature
        if (originals.isEmpty() && showEmpty) label(MoteI18n.text("暂无记录"))
        for (day in LibraryPhoneFeed.days(originals, ZoneId.systemDefault(), Instant.now())) {
            addView(dayLabel(day.label), LayoutParams(-1, -2).apply {
                leftMargin = activity.moteDp(15); topMargin = activity.moteDp(22); bottomMargin = activity.moteDp(8)
            })
            val group = MoteComponents.group(activity)
            day.items.forEachIndexed { index, original ->
                if (index > 0) group.addView(MoteComponents.divider(activity))
                group.addView(row(original), LayoutParams(-1, -2))
            }
            addView(group, LayoutParams(-1, -2).apply { bottomMargin = activity.moteDp(4) })
        }
        requestThumbs(images)
    }

    private fun clear() { thumbGeneration++; removeAllViews(); rendered = "" }

    private fun dayLabel(value: String) = TextView(activity).apply {
        text = value; MoteUi.type(this, NativeFontRole.META, medium = true); MoteUi.textColor(this, NativeColorRole.MUTED)
    }

    private fun row(original: LibraryPhoneFeed.Original) = LinearLayout(activity).apply {
        orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        minimumHeight = activity.moteDp(62)
        setPadding(activity.moteDp(14), activity.moteDp(10), activity.moteDp(14), activity.moteDp(10))
        tag = "library-record:" + original.id
        isFocusable = true
        contentDescription = original.title + "，" + LibraryPhoneFeed.detail(original)
        background = MoteUi.clickable(activity, NativeColorRole.TRANSPARENT, NativeRadiusRole.CONTAINER, false)
        val words = LinearLayout(activity).apply { orientation = VERTICAL }
        words.addView(TextView(activity).apply {
            text = original.title; MoteUi.type(this, NativeFontRole.ROW, medium = true); MoteUi.textColor(this, NativeColorRole.INK)
            maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
        })
        words.addView(TextView(activity).apply {
            text = LibraryPhoneFeed.detail(original); MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED)
            maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; setPadding(0, activity.moteDp(1), 0, 0)
        })
        addView(words, LayoutParams(0, -2, 1f))
        if (original.hasImage) addView(thumb(original), LayoutParams(activity.moteDp(44), activity.moteDp(44)).apply { marginStart = activity.moteDp(12) })
        setOnClickListener { if (active && !closed) open(original) }
    }

    private fun thumbTag(original: LibraryPhoneFeed.Original) = "library-phone-thumb:${original.deviceId}:${original.id}"
    private fun thumbKey(original: LibraryPhoneFeed.Original) = "${original.deviceId}:${original.id}"

    /** The 44dp bordered thumb slot; the decoded image arrives asynchronously. */
    private fun thumb(original: LibraryPhoneFeed.Original): View {
        val image = ImageView(activity).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            tag = thumbTag(original)
        }
        return FrameLayout(activity).apply {
            clipToOutline = true; outlineProvider = ViewOutlineProvider.BACKGROUND
            background = MoteUi.shape(activity, NativeColorRole.SURFACE_RAISED, NativeRadiusRole.THUMB, true, NativeColorRole.HAIR)
            addView(image, LayoutParams(-1, -1))
        }
    }

    private fun requestThumbs(rows: List<LibraryPhoneFeed.Original>) {
        if (rows.isEmpty()) return
        val generation = thumbGeneration
        thumbs.execute {
            for (original in rows) {
                if (closed || generation != thumbGeneration) return@execute
                val key = thumbKey(original)
                val bitmap = thumbnails.get(key) ?: runCatching {
                    val bytes = activity.queue().image(original.id)
                    bytes?.let { CapturePreview.decode(it, 96) }
                }.getOrNull()?.also { thumbnails.put(key, it) }
                if (bitmap == null || closed || generation != thumbGeneration) continue
                activity.runOnUiThread {
                    if (closed || !active || generation != thumbGeneration || activity.isDestroyed) return@runOnUiThread
                    val target = findThumb(original) ?: return@runOnUiThread
                    target.setImageBitmap(bitmap)
                }
            }
        }
    }

    private fun findThumb(original: LibraryPhoneFeed.Original): ImageView? {
        val tag = thumbTag(original)
        fun scan(view: View): ImageView? {
            if (view.tag == tag && view is ImageView) return view
            if (view is ViewGroup) for (index in 0 until view.childCount) scan(view.getChildAt(index))?.let { return it }
            return null
        }
        return scan(this)
    }

    private fun label(value: String) {
        addView(TextView(activity).apply {
            text = value; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED)
            setPadding(0, activity.moteDp(16), 0, activity.moteDp(16))
        })
    }
}
