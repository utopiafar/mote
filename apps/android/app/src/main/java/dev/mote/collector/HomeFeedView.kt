package dev.mote.collector

import android.graphics.Bitmap
import android.os.SystemClock
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

/** The home middle: existing originals grouped by local day, newest first.
 * Reads only; a row opens the shared original reader. */
internal class HomeFeedView(
    private val activity: MoteActivity,
    private val archiveEmpty: (Boolean) -> Unit = {},
    private val open: (HomeFeed.Original, String) -> Unit,
) : LinearLayout(activity), HomeSection {
    private val task = UiTask(activity)
    private val gate = HomeReadGate()
    private val thumbs = Executors.newSingleThreadExecutor()
    private val thumbnails = object : LruCache<String, Bitmap>(4 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
    }
    @Volatile private var closed = false
    private var active = false
    private var denied = false
    private var rendered = ""
    @Volatile private var thumbGeneration = 0

    init { orientation = VERTICAL; tag = "home-feed" }

    override fun pause() { active = false; gate.wake() }
    override fun close() { closed = true; pause(); task.close(); thumbs.shutdown(); thumbnails.evictAll() }

    override fun refresh() {
        if (closed) return
        active = true
        val access = runCatching { CentralAccess.resolve(activity) }.getOrElse {
            // A resolution failure replaces the content with a plain label, but `denied` survives;
            // when resolution recovers the denied affordance is re-rendered below.
            clear(); failureLabel(); return
        }
        if (gate.adopt(access.generation, access.server)) { denied = false; clear(); archiveEmpty(false) }
        if (access.client == null) { denied = false; clear(); return }
        // A revoked read leaves the gate stopped and its retry the only recovery: never read, keep the affordance.
        if (denied) { if (rendered != "denied") denied(); return }
        val stamp = if (task.busy || !gate.due(SystemClock.elapsedRealtime())) return else gate.begin(SystemClock.elapsedRealtime())
        if (childCount == 0) label(MoteI18n.text("正在读取…"))
        task.start("", {}, {
            val originals = HomeFeed.page(access.client!!::get)
            val after = CentralAccess.resolve(activity)
            check(after.generation == access.generation && after.server == access.server && after.client != null)
            val emptyArchive = gate.archiveEmpty(originals.isEmpty(), stamp, SystemClock.elapsedRealtime()) {
                HomeArchiveProbe.empty(access.client!!::get)
            }
            originals to emptyArchive
        }) { outcome ->
            if (closed || !active || !gate.current(stamp) || activity.isDestroyed || activity.isFinishing) return@start
            val current = runCatching { CentralAccess.resolve(activity) }.getOrNull()
            if (current == null || current.generation != access.generation || current.server != access.server || current.client == null) { clear(); gate.invalidate(); return@start }
            outcome.onSuccess { (originals, emptyArchive) ->
                gate.success(SystemClock.elapsedRealtime())
                denied = false
                archiveEmpty(emptyArchive)
                // An empty page still needs its own signature: the confirmed-empty archive hides
                // behind the first-use guide while an inconclusive probe keeps the honest label.
                val signature = if (originals.isEmpty()) "empty:$emptyArchive" else
                    originals.joinToString("|") { it.id + ":" + it.capturedAt + ":" + it.hasImage + ":" + it.title + ":" + it.kind + ":" + it.deviceId + ":" + it.source }
                if (signature == rendered) return@onSuccess
                clear(); rendered = signature; thumbGeneration++
                if (originals.isEmpty()) {
                    // A confirmed-empty archive is covered by the first-use guide; an inconclusive
                    // probe still owes the owner an honest empty label.
                    if (!emptyArchive) { label(MoteI18n.text("暂无记录。")); visibility = View.VISIBLE }
                    return@onSuccess
                }
                visibility = View.VISIBLE
                for (day in HomeFeed.days(originals, ZoneId.systemDefault(), Instant.now())) {
                    addView(dayLabel(day.label), LayoutParams(-1, -2).apply {
                        leftMargin = activity.moteDp(15); topMargin = activity.moteDp(22); bottomMargin = activity.moteDp(8)
                    })
                    val group = MoteComponents.group(activity)
                    day.items.forEachIndexed { index, original ->
                        if (index > 0) group.addView(MoteComponents.divider(activity))
                        group.addView(row(original, access), LayoutParams(-1, -2))
                    }
                    addView(group, LayoutParams(-1, -2).apply { bottomMargin = activity.moteDp(4) })
                }
                requestThumbs(originals.filter { it.hasImage }, access, stamp)
            }.onFailure { error ->
                val status = (error as? CentralFailure)?.status
                gate.failure(SystemClock.elapsedRealtime(), status)
                // A failed or revoked read is not an empty archive, and must not expose old-target rows.
                archiveEmpty(false)
                if (status == 401 || status == 403) { denied = true; denied() }
                else if (rendered.isEmpty() || rendered == "denied") failureLabel()
                // A transient failure keeps the last confirmed rows, like the calendar block.
            }
        }
    }

    private fun clear() { thumbGeneration++; removeAllViews(); rendered = ""; visibility = View.GONE }

    private fun dayLabel(value: String) = TextView(activity).apply {
        text = value; MoteUi.type(this, NativeFontRole.META, medium = true); MoteUi.textColor(this, NativeColorRole.MUTED)
    }

    private fun row(original: HomeFeed.Original, access: CentralAccess.Selection) = LinearLayout(activity).apply {
        orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        minimumHeight = activity.moteDp(62)
        setPadding(activity.moteDp(14), activity.moteDp(10), activity.moteDp(14), activity.moteDp(10))
        tag = "home-original:" + original.id
        isFocusable = true
        contentDescription = original.title + "，" + HomeFeed.detail(original)
        background = MoteUi.clickable(activity, NativeColorRole.TRANSPARENT, NativeRadiusRole.CONTAINER, false)
        val words = LinearLayout(activity).apply { orientation = VERTICAL }
        words.addView(TextView(activity).apply {
            text = original.title; MoteUi.type(this, NativeFontRole.ROW, medium = true); MoteUi.textColor(this, NativeColorRole.INK)
            maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
        })
        words.addView(TextView(activity).apply {
            text = HomeFeed.detail(original); MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED)
            maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; setPadding(0, activity.moteDp(1), 0, 0)
        })
        addView(words, LayoutParams(0, -2, 1f))
        if (original.hasImage) addView(thumb(original), LayoutParams(activity.moteDp(44), activity.moteDp(44)).apply { marginStart = activity.moteDp(12) })
        setOnClickListener {
            val selected = runCatching { CentralAccess.resolve(activity) }.getOrNull()
            if (selected?.client != null && selected.generation == access.generation && selected.server == access.server) open(original, access.server)
            else { clear(); gate.invalidate(); refresh() }
        }
    }

    /** The 44dp bordered thumb slot; the decoded image arrives asynchronously. */
    private fun thumb(original: HomeFeed.Original): View {
        val image = ImageView(activity).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            tag = "home-original-thumb:" + original.id
        }
        return FrameLayout(activity).apply {
            clipToOutline = true; outlineProvider = ViewOutlineProvider.BACKGROUND
            background = MoteUi.shape(activity, NativeColorRole.SURFACE_RAISED, NativeRadiusRole.THUMB, true, NativeColorRole.HAIR)
            addView(image, LayoutParams(-1, -1))
        }
    }

    private fun requestThumbs(rows: List<HomeFeed.Original>, access: CentralAccess.Selection, stamp: Long) {
        if (rows.isEmpty()) return
        val generation = thumbGeneration
        val client = access.client ?: return
        thumbs.execute {
            for (original in rows) {
                if (closed || generation != thumbGeneration || !gate.current(stamp)) return@execute
                val bitmap = thumbnails.get(original.id) ?: runCatching {
                    CapturePreview.decode(client.image("/api/capture-browser/${original.id}/image?thumbnail=1"), 96)
                }.getOrNull()?.also { thumbnails.put(original.id, it) }
                if (bitmap == null || closed || generation != thumbGeneration) continue
                activity.runOnUiThread {
                    if (closed || !active || generation != thumbGeneration || activity.isDestroyed) { bitmap.recycle(); return@runOnUiThread }
                    val target = findThumb(original.id) ?: return@runOnUiThread
                    target.setImageBitmap(bitmap)
                }
            }
        }
    }

    private fun findThumb(id: String): ImageView? {
        fun scan(view: View): ImageView? {
            if (view.tag == "home-original-thumb:$id" && view is ImageView) return view
            if (view is ViewGroup) for (index in 0 until view.childCount) scan(view.getChildAt(index))?.let { return it }
            return null
        }
        return scan(this)
    }

    /** A revoked read offers an explicit retry that re-arms the gate; transient failures auto-retry. */
    private fun denied() {
        clear(); visibility = View.VISIBLE; rendered = "denied"
        label(MoteI18n.text("暂不可读取"))
        addView(TextView(activity).apply {
            text = MoteI18n.text("重试"); MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.ACCENT)
            setPadding(0, 0, 0, activity.moteDp(16)); isClickable = true; isFocusable = true
            setOnClickListener { if (active && !closed) { denied = false; gate.retry(); refresh() } }
        })
    }

    private fun failureLabel() {
        if (rendered == "failed") return
        clear(); rendered = "failed"; visibility = View.VISIBLE
        label(MoteI18n.text("暂不可读取"))
    }

    private fun label(value: String) {
        addView(TextView(activity).apply {
            text = value; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED)
            setPadding(0, activity.moteDp(16), 0, activity.moteDp(16))
        })
    }
}
