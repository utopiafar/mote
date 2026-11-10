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

/** The home middle: retained local and selected-Central originals grouped by local day, newest first.
 * Reads only; a row opens the shared original reader. */
internal class HomeFeedView(
    private val activity: MoteActivity,
    private val archiveEmpty: (Boolean) -> Unit = {},
    private val open: (HomeFeed.Original, String) -> Unit,
) : LinearLayout(activity), HomeSection {
    private data class Read(val localPage: org.json.JSONObject, val central: Result<Pair<List<HomeFeed.Original>, Boolean>>? = null)

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
    private var centralRows: List<HomeFeed.Original> = emptyList()
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
        if (gate.adopt(access.generation, access.server)) {
            denied = false
            centralRows = emptyList()
            clear()
            archiveEmpty(false)
        }
        if (task.busy) return
        val readCentral = access.client != null && !denied && gate.due(SystemClock.elapsedRealtime())
        val stamp = if (readCentral) gate.begin(SystemClock.elapsedRealtime()) else null
        if (childCount == 0 && readCentral) { visibility = View.VISIBLE; addView(MoteComponents.skeleton(activity, MoteI18n.text("正在读取…"))) }
        task.start("", {}, {
            val localPage = activity.withNativeNotePreviews(activity.queue().recentPage())
            val central = if (readCentral) runCatching {
                val originals = HomeFeed.page(access.client!!::get)
                val after = CentralAccess.resolve(activity)
                check(after.generation == access.generation && after.server == access.server && after.client != null)
                val emptyArchive = gate.archiveEmpty(originals.isEmpty(), stamp!!, SystemClock.elapsedRealtime()) {
                    HomeArchiveProbe.empty(access.client!!::get)
                }
                originals to emptyArchive
            } else null
            Read(localPage, central)
        }) { outcome ->
            if (closed || !active || (stamp != null && !gate.current(stamp)) || activity.isDestroyed || activity.isFinishing) return@start
            val current = runCatching { CentralAccess.resolve(activity) }.getOrNull()
            if (current == null || current.generation != access.generation || current.server != access.server ||
                (current.client != null) != (access.client != null)) {
                centralRows = emptyList(); clear(); gate.invalidate(); return@start
            }
            outcome.onSuccess { read ->
                val central = read.central
                if (central == null) {
                    render(read.localPage, centralRows, access, emptyLabel = false)
                    return@onSuccess
                }
                central.onSuccess { (originals, emptyArchive) ->
                    gate.success(SystemClock.elapsedRealtime())
                    denied = false
                    centralRows = originals
                    archiveEmpty(emptyArchive)
                    render(read.localPage, originals, access, emptyLabel = !emptyArchive)
                }.onFailure { error ->
                    val status = (error as? CentralFailure)?.status
                    gate.failure(SystemClock.elapsedRealtime(), status)
                    archiveEmpty(false)
                    if (status == 401 || status == 403) {
                        denied = true
                        centralRows = emptyList()
                        render(read.localPage, emptyList(), access, emptyLabel = false)
                    } else if (read.localPage.getJSONArray("items").length() == 0 && centralRows.isEmpty()) {
                        failureLabel()
                    } else {
                        // A transient failure keeps the last confirmed Central rows and current local originals.
                        render(read.localPage, centralRows, access, emptyLabel = false)
                    }
                }
            }.onFailure {
                archiveEmpty(false)
                failureLabel()
            }
        }
    }

    private fun render(localPage: org.json.JSONObject, central: List<HomeFeed.Original>, access: CentralAccess.Selection, emptyLabel: Boolean) {
        val items = localPage.getJSONArray("items")
        val bindings = localPage.getJSONObject("bindings")
        val local = HomeFeed.localPage { localPage }
        val localBindings = (0 until items.length()).associate { index ->
            val id = items.getJSONObject(index).getString("id")
            id to bindings.optString(id)
        }
        val originals = HomeFeed.merge(local, localBindings, central, access.server)
        val signature = denied.toString() + ":" + emptyLabel + ":" + originals.joinToString("|") {
            it.id + ":" + it.capturedAt + ":" + it.hasImage + ":" + it.title + ":" + it.kind + ":" + it.deviceId + ":" + it.source + ":" + it.remote + ":" + it.saved
        }
        if (signature == rendered) return
        clear(); rendered = signature
        if (originals.isNotEmpty()) {
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
            requestThumbs(originals.filter { it.hasImage }, access)
        } else if (emptyLabel) {
            label(MoteI18n.text("暂无记录。"))
        }
        if (denied) deniedAffordance()
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
            if (!original.remote) { open(original, ""); return@setOnClickListener }
            val selected = runCatching { CentralAccess.resolve(activity) }.getOrNull()
            if (selected?.client != null && selected.generation == access.generation && selected.server == access.server) open(original, access.server)
            else { centralRows = emptyList(); clear(); gate.invalidate(); refresh() }
        }
    }

    private fun thumbTag(original: HomeFeed.Original) = if (original.remote)
        "home-original-thumb:" + original.id else "home-local-thumb:${original.deviceId}:" + original.id
    private fun thumbKey(original: HomeFeed.Original) = "${original.remote}:${original.deviceId}:${original.id}"

    /** The 44dp bordered thumb slot; the decoded image arrives asynchronously. */
    private fun thumb(original: HomeFeed.Original): View {
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

    private fun requestThumbs(rows: List<HomeFeed.Original>, access: CentralAccess.Selection) {
        if (rows.isEmpty()) return
        val generation = thumbGeneration
        thumbs.execute {
            for (original in rows) {
                if (closed || generation != thumbGeneration) return@execute
                val key = thumbKey(original)
                val bitmap = thumbnails.get(key) ?: runCatching {
                    val bytes = if (original.remote) access.client?.image("/api/capture-browser/${original.id}/image?thumbnail=1")
                        else activity.queue().image(original.id)
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

    private fun findThumb(original: HomeFeed.Original): ImageView? {
        val tag = thumbTag(original)
        fun scan(view: View): ImageView? {
            if (view.tag == tag && view is ImageView) return view
            if (view is ViewGroup) for (index in 0 until view.childCount) scan(view.getChildAt(index))?.let { return it }
            return null
        }
        return scan(this)
    }

    /** A revoked read leaves local rows visible and offers an explicit retry for Central. */
    private fun deniedAffordance() {
        visibility = View.VISIBLE
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
        visibility = View.VISIBLE
        addView(TextView(activity).apply {
            text = value; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED)
            setPadding(0, activity.moteDp(16), 0, activity.moteDp(16))
        })
    }
}
