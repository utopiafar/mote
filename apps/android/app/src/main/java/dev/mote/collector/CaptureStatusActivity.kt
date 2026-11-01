package dev.mote.collector

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.time.Instant
import java.time.ZoneId
import java.util.concurrent.Executors

/**
 * Capture and sending behind the home status line, the notification and the tile. Screen, other sources and sending
 * keep separate pauses; resuming or restarting goes back to the app's preview and system consent.
 */
class CaptureStatusActivity : MoteActivity() {
    internal data class ReadHooks(val execute: java.util.concurrent.Executor, val read: () -> CaptureOverview.Facts, val post: (Runnable) -> Unit)
    internal companion object { @Volatile var readHooks: ReadHooks? = null }
    private val instanceReadHooks = readHooks
    private val worker = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var line: HomeCaptureRow
    private lateinit var screen: Pair<TextView, Button>
    private lateinit var system: TextView
    private lateinit var folders: TextView
    private lateinit var send: Pair<TextView, Button>
    private lateinit var all: Button
    private var facts: CaptureOverview.Facts? = null
    private var working = false
    private var closed = false
    // One in-flight read and one merged follow-up; close() is the hard delivery boundary for destruction.
    private val reader = CoalescingRead<CaptureOverview.Facts>(instanceReadHooks?.execute ?: worker, { result ->
        val callback = Runnable { if (!closed && !isDestroyed) result.onSuccess(::present) }
        instanceReadHooks?.post?.invoke(callback) ?: runOnUiThread(callback)
    }) {
        instanceReadHooks?.read?.invoke() ?: run {
            val settings = Settings(applicationContext); val config = settings.read()
            CaptureOverview.facts(applicationContext, settings, config, LocalStateRepository.get(applicationContext).state.value)
        }
    }
    private val refresh = object : Runnable { override fun run() { render(); handler.postDelayed(this, 2500) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val content = moteDetailPage(primary = null, title = MoteI18n.text("采集状态"), onBack = ::leave)
        line = HomeCaptureRow(this, open = null, act = ::forward)
        content.addView(line, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(MoteTheme.spaceItem) })
        heading(content, MoteI18n.text("来源"))
        screen = control(content, MoteI18n.text("屏幕采集"), "capture-status-screen") { forwardPage("PRIVACY") }
        system = control(content, MoteI18n.text("通知与设备信息"), "capture-status-system") { forwardPage("OBSERVATIONS") }.first
        folders = control(content, MoteI18n.text("同步文件夹"), "capture-status-folders") { startActivity(Intent(this, SourcesActivity::class.java)) }.first
        all = SecondaryUi.action(content, "") { toggleAll() }.apply { tag = "capture-status-all"; visibility = View.GONE }
        heading(content, MoteI18n.text("发送"))
        send = control(content, MoteI18n.text("发送中的内容"), "capture-status-send") { startActivity(Intent(this, SyncQueueActivity::class.java)) }
        heading(content, MoteI18n.text("更多"))
        SecondaryUi.row(content, MoteI18n.text("采集范围")) { forwardPage("PRIVACY") }
        SecondaryUi.row(content, MoteI18n.text("采集与同步")) { startActivity(Intent(this, SourcesActivity::class.java)) }
        SecondaryUi.row(content, MoteI18n.text("采集与存储详情")) { startActivity(Intent(this, ActivityStatsActivity::class.java)) }
        MoteUi.styleTree(content)
        if (android.os.Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { leave() }
    }
    override fun onResume() { super.onResume(); handler.post(refresh) }
    override fun onPause() { handler.removeCallbacks(refresh); super.onPause() }
    override fun onDestroy() { closed = true; handler.removeCallbacks(refresh); reader.close(); worker.shutdown(); super.onDestroy() }
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Deprecated("Native back navigation") override fun onBackPressed() = leave()

    /** Opened from the notification or tile, this may be the only screen in its task; back then lands on the home. */
    private fun leave() {
        if (isTaskRoot) startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun heading(parent: LinearLayout, label: String) = parent.addView(TextView(this).apply {
        text = label; MoteUi.type(this, NativeFontRole.META, medium = true); MoteUi.textColor(this, NativeColorRole.MUTED)
    }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(20); bottomMargin = moteDp(4) })

    private fun control(parent: LinearLayout, label: String, identity: String, open: () -> Unit): Pair<TextView, Button> {
        parent.addView(View(this).apply { MoteUi.backgroundColor(this, NativeColorRole.DIVIDER) }, LinearLayout.LayoutParams(-1, moteDp(1)))
        val row = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL; minimumHeight = moteDp(64); tag = identity; isFocusable = true
            setPadding(0, moteDp(MoteTheme.spaceInline), 0, moteDp(MoteTheme.spaceInline))
            background = MoteUi.clickable(this@CaptureStatusActivity, NativeColorRole.TRANSPARENT, 0, false); setOnClickListener { open() }
        }
        val words = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        words.addView(TextView(this).apply { text = label; MoteUi.type(this, NativeFontRole.ROW, medium = true); MoteUi.textColor(this, NativeColorRole.INK) })
        val state = TextView(this).apply { tag = "$identity-state"; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED) }
        words.addView(state)
        row.addView(words, LinearLayout.LayoutParams(0, -2, 1f))
        val action = MoteUi.action(Button(this), MoteUi.ButtonRole.TEXT).apply { visibility = View.GONE; tag = "$identity-action"; MoteUi.textColor(this, NativeColorRole.ACCENT) }
        row.addView(action)
        parent.addView(row, LinearLayout.LayoutParams(-1, -2))
        return state to action
    }

    internal fun render() {
        if (closed || isDestroyed || worker.isShutdown) return
        reader.request()
    }

    private fun present(f: CaptureOverview.Facts) {
        facts = f
        line.bind(CaptureOverview.line(f))
        val (screenState, screenAction) = screen
        screenState.text = when {
            f.screenPausedAt != null && !f.screenSelected -> MoteI18n.text("已暂停") + " · " + CaptureOverview.since(f.screenPausedAt, Instant.now(), ZoneId.systemDefault())
            !f.screenSelected -> MoteI18n.text("关闭")
            !f.enabled -> MoteI18n.text("已暂停")
            f.screenLive -> MoteI18n.text("采集中")
            else -> MoteI18n.text("等待采集权限")
        }
        // After a full stop the line and the start button resume everything; the row only resumes its own pause.
        val screenPaused = CaptureOverview.screenPaused(f)
        screenAction.visibility = if (f.enabled && f.screenSelected || screenPaused) View.VISIBLE else View.GONE
        screenAction.text = MoteI18n.text(if (screenPaused) "恢复采集" else "暂停")
        screenAction.setOnClickListener { if (screenPaused) forward(CaptureOverview.Action.RESUME) else pauseScreen() }
        system.text = when {
            !f.observesSystem -> MoteI18n.text("关闭")
            !f.enabled -> MoteI18n.text("已暂停")
            f.systemLive -> MoteI18n.text("采集中")
            else -> MoteI18n.text("等待采集权限")
        }
        folders.text = if (f.folders > 0) MoteI18n.text("{0} 个文件夹", f.folders) else MoteI18n.text("关闭")
        val (sendState, sendAction) = send
        sendState.text = CaptureOverview.send(f).first.ifBlank { MoteI18n.text("按设置发送") }
        sendAction.visibility = if (f.connected) View.VISIBLE else View.GONE
        sendAction.text = MoteI18n.text(if (f.sendPaused) "恢复" else "暂停")
        sendAction.setOnClickListener { toggleSend(!f.sendPaused) }
        all.text = MoteI18n.text(if (f.enabled) "暂停全部采集" else "开始采集"); all.visibility = View.VISIBLE
        listOf(screenAction, sendAction, all).forEach { it.isEnabled = !working }
    }

    private fun pauseScreen() = work { done -> CaptureControls.pauseScreen(this) { result -> result.exceptionOrNull()?.let(::notice); done() } }
    private fun toggleSend(paused: Boolean) = work { done -> CaptureControls.setSendingPaused(this, paused) { result -> result.exceptionOrNull()?.let(::notice); done() } }
    private fun toggleAll() {
        if (facts?.enabled != true) { forward(CaptureOverview.Action.RESUME); return }
        work { done -> CaptureControls.stopAll(this) { result -> result.exceptionOrNull()?.let(::notice); done() } }
    }
    private fun work(run: (() -> Unit) -> Unit) {
        if (working) return
        working = true; facts?.let(::present)
        run { working = false; if (!isDestroyed) render() }
    }
    private fun notice(error: Throwable) = android.widget.Toast.makeText(this, error.message ?: MoteI18n.text("保存或调度失败，请重试；已保存内容不会丢失"), android.widget.Toast.LENGTH_LONG).show()

    /** Resume, restart and repair run where the preview, permissions and system consent already live. */
    private fun forward(action: CaptureOverview.Action) = handOff("captureAction", action.name)
    private fun forwardPage(page: String) = handOff("page", page)
    /** The app takes over the task. Opened from the tile or notification, the panel never stays behind the home. */
    private fun handOff(key: String, value: String) {
        startActivity(Intent(this, MainActivity::class.java).putExtra(key, value).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }
}
