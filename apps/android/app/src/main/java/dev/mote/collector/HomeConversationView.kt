package dev.mote.collector

import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

/** A read of existing conversation summaries; it never submits a question or starts capture. */
internal class HomeConversationView(private val activity: MoteActivity, private val archiveEmpty: (Boolean) -> Unit = {}, private val open: (String) -> Unit) : LinearLayout(activity), HomeSection {
    private val task = UiTask(activity)
    private val gate = HomeReadGate()
    private var closed = false
    private var active = false
    private var denied = false
    private var rendered = ""

    init { orientation = VERTICAL; tag = "home-recent-conversations" }

    override fun pause() { active = false; gate.wake() }
    override fun close() { closed = true; pause(); task.close() }

    override fun refresh() {
        if (closed) return
        active = true
        val access = runCatching { CentralAccess.resolve(activity) }.getOrElse {
            // A resolution failure replaces the retry with a plain label, but `denied` survives;
            // when resolution recovers the denied affordance is re-rendered below.
            clear(); label(MoteI18n.text("对话暂不可读取，请稍后重试。")); return
        }
        if (gate.adopt(access.generation, access.server)) { denied = false; clear(); archiveEmpty(false) }
        if (access.client == null) {
            denied = false
            message(if (access.server.isBlank()) MoteI18n.text("连接中央后查看对话。") else MoteI18n.text("登录中央后查看对话。"))
            return
        }
        // A revoked read leaves the gate stopped and its retry the only recovery: never read, keep the affordance.
        if (denied) { retryMessage(MoteI18n.text("对话暂不可读取，请稍后重试。")); return }
        val stamp = if (task.busy || !gate.due(SystemClock.elapsedRealtime())) return else gate.begin(SystemClock.elapsedRealtime())
        if (childCount == 0) label(MoteI18n.text("正在读取对话…"))
        task.start("", {}, {
            val page = access.client.get("/api/conversations?limit=5")
            val after = CentralAccess.resolve(activity)
            check(after.generation == access.generation && after.server == access.server && after.client != null)
            val rows = page.getJSONArray("items")
            for (index in 0 until rows.length()) {
                val item = rows.getJSONObject(index)
                val id = item.getString("id")
                require(java.util.UUID.fromString(id).toString() == id)
                require(item.get("title") is String && item.get("updatedAt") is String)
                java.time.Instant.parse(item.getString("updatedAt"))
                require(item.get("turnCount") is Number && item.getInt("turnCount") >= 0)
            }
            val emptyArchive = gate.archiveEmpty(rows.length() == 0, stamp, SystemClock.elapsedRealtime()) {
                val storage = access.client.get("/api/status").getJSONObject("storage")
                storage.has("captures") && storage.get("captures") is Number && storage.getLong("captures") == 0L &&
                    access.client.get("/api/library/catalog?limit=1").getJSONArray("items").length() == 0 &&
                    access.client.get("/api/files?limit=1").getJSONArray("items").length() == 0
            }
            rows to emptyArchive
        }) { outcome ->
            if (closed || !active || !gate.current(stamp) || activity.isDestroyed || activity.isFinishing) return@start
            val current = runCatching { CentralAccess.resolve(activity) }.getOrNull()
            if (current == null || current.generation != access.generation || current.server != access.server || current.client == null) { clear(); gate.invalidate(); return@start }
            outcome.onSuccess { (rows, emptyArchive) ->
                gate.success(SystemClock.elapsedRealtime())
                denied = false
                archiveEmpty(emptyArchive)
                if (rendered == rows.toString()) return@onSuccess
                clear(); rendered = rows.toString()
                if (rows.length() == 0) label(MoteI18n.text("还没有对话。"))
                for (index in 0 until rows.length()) {
                    val item = rows.getJSONObject(index)
                    val id = item.optString("id")
                    val title = item.optString("title").ifBlank { MoteI18n.text("问一问") }
                    val date = runCatching {
                        java.time.Instant.parse(item.optString("updatedAt")).atZone(java.time.ZoneId.systemDefault())
                            .format(if (MoteI18n.locale().language == "zh") java.time.format.DateTimeFormatter.ofPattern("M 月 d 日 HH:mm", MoteI18n.locale()) else java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.SHORT).withLocale(MoteI18n.locale()))
                    }.getOrDefault(item.optString("updatedAt"))
                    val detail = MoteI18n.text("{0} 轮对话", item.optInt("turnCount")) + " · " + date
                    val row = LinearLayout(activity).apply {
                        gravity = Gravity.CENTER_VERTICAL; tag = "home-conversation:$id"
                        minimumHeight = activity.moteDp(78); setPadding(0, activity.moteDp(18), 0, activity.moteDp(18))
                        background = MoteUi.clickable(activity, NativeColorRole.BACKGROUND, 0, false)
                        isFocusable = true; contentDescription = "$title，$detail"
                        setOnClickListener {
                            val selected = runCatching { CentralAccess.resolve(activity) }.getOrNull()
                            if (selected?.client != null && selected.generation == access.generation && selected.server == access.server) open(id)
                            else { clear(); gate.invalidate(); refresh() }
                        }
                    }
                    row.addView(TextView(activity).apply { text = "◌"; textSize = 23f; MoteUi.textColor(this, NativeColorRole.ACCENT) }, LayoutParams(activity.moteDp(24), -2).apply { marginEnd = activity.moteDp(13) })
                    val text = LinearLayout(activity).apply {
                        orientation = VERTICAL
                        addView(TextView(activity).apply { this.text = title; MoteUi.type(this, NativeFontRole.ACTION, medium = true); MoteUi.textColor(this, NativeColorRole.INK) })
                        addView(TextView(activity).apply { this.text = detail; MoteUi.type(this, NativeFontRole.META); NativePresentationStyles.bind(this, "home-date") { (it as TextView).textSize = 10f }; MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(0, activity.moteDp(6), 0, 0) })
                    }
                    row.addView(text, LayoutParams(0, -2, 1f))
                    row.addView(TextView(activity).apply { this.text = "›"; textSize = 17f; MoteUi.textColor(this, NativeColorRole.MUTED) })
                    addView(row); divider()
                }
            }.onFailure { error ->
                val status = (error as? CentralFailure)?.status
                gate.failure(SystemClock.elapsedRealtime(), status)
                // A failed or revoked read is not an empty history, and must not expose old-target rows.
                archiveEmpty(false)
                if (status == 401 || status == 403) { denied = true; retryMessage(MoteI18n.text("对话暂不可读取，请稍后重试。")) }
                else message(MoteI18n.text("对话暂不可读取，请稍后重试。"))
            }
        }
    }
    private fun clear() { removeAllViews(); rendered = "" }
    private fun message(value: String) { if (rendered == value) return; clear(); rendered = value; label(value) }
    /** A revoked read offers an explicit retry that re-arms the gate; transient failures keep auto-retrying. */
    private fun retryMessage(value: String) {
        if (rendered == "$value\u0000retry") return
        clear(); rendered = "$value\u0000retry"
        label(value)
        addView(TextView(activity).apply {
            text = MoteI18n.text("重试"); MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.ACCENT)
            setPadding(0, 0, 0, activity.moteDp(16)); isClickable = true; isFocusable = true
            setOnClickListener { if (active && !closed) { gate.retry(); refresh() } }
        })
    }
    private fun label(value: String) { addView(TextView(activity).apply { text = value; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(0, activity.moteDp(16), 0, activity.moteDp(16)) }) }
    private fun divider() { addView(View(activity).apply { MoteUi.backgroundColor(this, NativeColorRole.DIVIDER) }, LayoutParams(-1, activity.moteDp(1))) }
}
