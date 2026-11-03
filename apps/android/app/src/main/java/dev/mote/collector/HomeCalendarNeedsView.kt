package dev.mote.collector

import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/** Calendar suggestions only the owner can complete. Calendar items otherwise take effect without per-item review. */
internal object CalendarNeeds {
    /** The home shows at most this many; the calendar page keeps the complete history. */
    const val SHOWN = 2
    /** Suggestions arrive newest first; the home looks this many pages back and leaves older ones to the calendar page. */
    const val PAGES = 5
    fun missingTime(items: JSONArray): List<JSONObject> = (0 until items.length()).map(items::getJSONObject).filter { action ->
        val event = action.optJSONObject("event")
        action.optString("status") == "proposed" && !action.has("resolution") && action.optString("kind") in setOf("calendar.create", "calendar.update") &&
            event != null && listOf("start", "end").any { event.isNull(it) || event.optString(it).isBlank() }
    }
    /** Follows the actions cursor until the home has its rows, the history ends or the bounded scan is used up. */
    fun scan(read: (cursor: Long) -> JSONObject): List<JSONObject> {
        val found = mutableListOf<JSONObject>()
        var cursor = 0L
        repeat(PAGES) {
            val page = read(cursor)
            found += missingTime(page.getJSONArray("items"))
            if (found.size >= SHOWN || page.isNull("nextCursor")) return found.take(SHOWN)
            cursor = page.getLong("nextCursor")
        }
        return found.take(SHOWN)
    }
}

/** Reads existing suggestions only; it never confirms, dismisses or writes a calendar event. */
internal class HomeCalendarNeedsView(private val activity: MoteActivity, private val open: () -> Unit, private val available: () -> Boolean = { true }) : LinearLayout(activity), HomeSection {
    private val task = UiTask(activity)
    private val gate = HomeReadGate()
    private var closed = false
    private var active = false
    private var denied = false
    private var rendered = ""
    init { orientation = VERTICAL; visibility = View.GONE; tag = "home-calendar-needs" }
    private fun clear() { removeAllViews(); rendered = ""; visibility = View.GONE }
    override fun pause() { active = false; gate.wake() }
    override fun close() { closed = true; pause(); clear(); task.close() }
    override fun refresh() {
        if (closed) return
        // A stopped plugin publishes no calendar-needs block, including while the home stays open.
        if (!available()) { active = false; gate.invalidate(); clear(); return }
        active = true
        val access = runCatching { CentralAccess.resolve(activity) }.getOrNull()
        // A resolution failure hides the section without dropping `denied`; the next resolved
        // refresh re-renders the retry instead of stranding the stopped gate without it.
        if (access == null) { gate.invalidate(); clear(); return }
        if (gate.adopt(access.generation, access.server)) { denied = false; clear() }
        if (access.client == null) { denied = false; clear(); return }
        // A revoked read leaves the gate stopped and its retry the only recovery: never read, keep the affordance.
        if (denied) { if (rendered != "denied") denied(); return }
        val stamp = if (task.busy || !gate.due(SystemClock.elapsedRealtime())) return else gate.begin(SystemClock.elapsedRealtime())
        task.start("", {}, {
            CalendarNeeds.scan { cursor ->
                access.client.get("/api/actions?cursor=$cursor").also {
                    val after = CentralAccess.resolve(activity)
                    check(after.generation == access.generation && after.server == access.server && after.client != null)
                }
            }
        }) { outcome ->
            if (closed || !active || !gate.current(stamp) || activity.isDestroyed || activity.isFinishing) return@start
            // A transient failure keeps the last confirmed rows; a revoked read withdraws them and offers an explicit retry.
            val needs = outcome.getOrNull()
            if (needs == null) {
                val status = (outcome.exceptionOrNull() as? CentralFailure)?.status
                gate.failure(SystemClock.elapsedRealtime(), status)
                if (status == 401 || status == 403) { denied = true; denied() }
                return@start
            }
            gate.success(SystemClock.elapsedRealtime())
            denied = false
            val signature = needs.joinToString("|") { it.optString("id") + ":" + it.optInt("version") }
            if (signature == rendered) return@start
            clear(); rendered = signature
            if (needs.isEmpty()) return@start
            addView(TextView(activity).apply { text = MoteI18n.text("等你补充"); MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(0, 0, 0, activity.moteDp(8)) })
            needs.forEach { action -> addView(row(action), LayoutParams(-1, -2).apply { bottomMargin = activity.moteDp(8) }) }
            visibility = View.VISIBLE
        }
    }
    /** The revoked-read affordance; a resolved refresh re-renders it once instead of reading. */
    private fun denied() {
        clear(); visibility = View.VISIBLE; rendered = "denied"
        addView(TextView(activity).apply { text = MoteI18n.text("重试"); MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.ACCENT); setPadding(0, activity.moteDp(8), 0, activity.moteDp(8)); isClickable = true; isFocusable = true; setOnClickListener { if (active && !closed) { denied = false; gate.retry(); refresh() } } })
    }
    private fun row(action: JSONObject) = LinearLayout(activity).apply {
        gravity = Gravity.CENTER_VERTICAL; tag = "home-calendar-need:" + action.optString("id")
        setPadding(activity.moteDp(14), activity.moteDp(8), activity.moteDp(8), activity.moteDp(8))
        background = MoteUi.shape(activity, NativeColorRole.SURFACE, 12, true)
        addView(ImageView(activity).apply { setImageDrawable(MoteNavigationIcon(activity, "calendar", true)); importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO },
            LayoutParams(activity.moteDp(20), activity.moteDp(20)).apply { marginEnd = activity.moteDp(12) })
        val words = LinearLayout(activity).apply { orientation = VERTICAL }
        val title = action.optJSONObject("event")?.optString("title").orEmpty()
        words.addView(TextView(activity).apply { text = title; maxLines = 2; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.INK) })
        words.addView(TextView(activity).apply { text = MoteI18n.text("时间待补充"); MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED) })
        addView(words, LayoutParams(0, -2, 1f))
        addView(MoteUi.action(Button(activity).apply {
            text = MoteI18n.text("补充时间"); contentDescription = MoteI18n.text("补充时间") + "，" + title
            setOnClickListener { if (active && !closed) open() }
        }, MoteUi.ButtonRole.SECONDARY), LayoutParams(-2, -2).apply { marginStart = activity.moteDp(8) })
    }
}
