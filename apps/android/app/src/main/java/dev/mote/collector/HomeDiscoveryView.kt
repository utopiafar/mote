package dev.mote.collector

import android.os.SystemClock
import android.widget.LinearLayout
import org.json.JSONArray

/** An independent Central read cannot block the local notebook or upload status. */
internal class HomeDiscoveryView(private val activity: MoteActivity, private val open: (String?) -> Unit) : LinearLayout(activity) {
    private val task = UiTask(activity)
    private var generation = -1L
    private var origin = ""
    private var nextRead = 0L
    private var epoch = 0L
    private var closed = false
    private var active = false
    private val result = LinearLayout(activity).apply { orientation = VERTICAL }
    init {
        orientation = VERTICAL
        addView(result)
        addView(MoteUi.button(android.widget.Button(activity).apply { text = MoteI18n.text("发现历史"); setOnClickListener { open(null) } }, false))
    }
    fun pause() { active = false; epoch++; result.removeAllViews(); nextRead = 0L }
    fun close() { closed = true; pause(); task.close() }
    fun refresh() {
        if (closed) return
        active = true
        val access = runCatching { CentralAccess.resolve(activity) }.getOrElse { error -> epoch++; generation = -1L; result.removeAllViews(); showError(error); return }
        if (access.generation != generation || access.server != origin) { epoch++; result.removeAllViews(); nextRead = 0L; generation = access.generation; origin = access.server }
        if (access.client == null) { result.removeAllViews(); return }
        if (task.busy || SystemClock.elapsedRealtime() < nextRead) return
        val stamp = epoch
        nextRead = SystemClock.elapsedRealtime() + 5000
        if (result.childCount == 0) { label(MoteI18n.text("正在读取…")); result.getChildAt(0).tag = "discovery-loading" }
        task.start("", {}, {
            val page = access.client.get("/api/insights?limit=30")
            val after = CentralAccess.resolve(activity)
            check(after.generation == access.generation && after.server == access.server && after.client != null) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
            page
        }) { outcome ->
            if (closed || !active || stamp != epoch || activity.isDestroyed || activity.isFinishing) return@start
            val current = runCatching { CentralAccess.resolve(activity) }.getOrNull()
            if (current == null || current.generation != generation || current.server != origin || current.client == null) { result.removeAllViews(); nextRead = 0L; return@start }
            outcome.onSuccess { page ->
                result.removeAllViews()
                val finding = InsightPresentation.featured(page.optJSONArray("items") ?: JSONArray())
                if (finding != null) {
                    val id = InsightPresentation.id(finding)!!
                    val title = InsightPresentation.title(finding)
                    label(title, NativeFontRole.SECTION)
                    label(InsightPresentation.preview(finding))
                    label(finding.optString("createdAt"), NativeFontRole.SUPPORT)
                    result.addView(MoteUi.button(android.widget.Button(activity).apply {
                        text = MoteI18n.text("查看发现"); tag = "home-discovery:$id"; contentDescription = title
                        setOnClickListener { open(id) }
                    }, false))
                }
            }.onFailure(::showError)
        }
    }
    private fun label(value: String, role: NativeFontRole = NativeFontRole.BODY) {
        result.addView(android.widget.TextView(activity).apply { text = value; MoteUi.type(this, role); MoteUi.textColor(this, NativeColorRole.INK); setPadding(0, activity.moteDp(6), 0, activity.moteDp(6)) })
    }
    private fun showError(error: Throwable) {
        result.findViewWithTag<android.widget.TextView>("discovery-loading")?.let(result::removeView)
        if (error is CentralFailure && error.status in setOf(401, 403, 404, 410)) result.removeAllViews()
        result.findViewWithTag<android.widget.TextView>("discovery-error")?.let(result::removeView)
        label(error.message ?: MoteI18n.text("资料暂不可读取，请稍后重试。"), NativeFontRole.SUPPORT)
        result.getChildAt(result.childCount - 1).tag = "discovery-error"
    }
}
