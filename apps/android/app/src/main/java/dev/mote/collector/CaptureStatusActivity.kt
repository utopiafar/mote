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
import dev.mote.collector.plugins.CapturePlugin
import dev.mote.collector.plugins.SourceProviderPlugin
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import java.time.Instant
import java.time.ZoneId
import java.util.concurrent.Executors

/**
 * The capture status panel behind the home line, the notification and the tile. Screen, other sources and
 * sending keep separate controls; resuming or restarting goes back to the app's preview and system consent.
 */
class CaptureStatusActivity : MoteActivity() {
    internal data class ReadHooks(val execute: java.util.concurrent.Executor, val read: () -> CaptureOverview.Facts, val post: (Runnable) -> Unit)
    internal companion object { @Volatile var readHooks: ReadHooks? = null }
    private val instanceReadHooks = readHooks
    private val worker = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var screenDetail: TextView
    private lateinit var screenSwitch: MoteComponents.MoteSwitch
    private lateinit var screenFix: View
    private lateinit var systemDetail: TextView
    private lateinit var systemSwitch: MoteComponents.MoteSwitch
    private lateinit var foldersValue: TextView
    private lateinit var sendDetail: TextView
    private lateinit var sendButton: View
    private lateinit var all: Button
    private lateinit var more: Button
    private var moreMenu: android.widget.PopupWindow? = null
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
            CaptureOverview.facts(applicationContext, settings, config, LocalStatusProducer.get(applicationContext).state.value)
        }
    }
    private val refresh = object : Runnable { override fun run() { render(); handler.postDelayed(this, 2500) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val content = moteDetailPage(primary = null, title = MoteI18n.text("采集状态"), onBack = ::leave)
        window.decorView.findViewWithTag<TextView>("detail-title")?.let { MoteUi.type(it, 16, medium = true) }
        // The panel is the capture sheet: keep its own chrome on the raised surface the sheet uses over the home.
        var shell: View? = content
        while (shell != null && shell !is NativeAppShell) shell = shell.parent as? View
        shell?.let { MoteUi.backgroundColor(it, NativeColorRole.SURFACE_RAISED) }
        paintPanelBars()
        content.setPadding(moteDp(16), moteDp(4), moteDp(16), moteDp(16))
        val group = MoteComponents.group(this)
        fun add(row: PanelRow) {
            if (group.childCount > 0) group.addView(MoteComponents.divider(this))
            group.addView(row.root, LinearLayout.LayoutParams(-1, -2))
        }

        val screen = row(MoteGlyph.SCREEN, MoteI18n.text("屏幕采集"), "capture-status-screen") { forwardPage("PRIVACY") }
        screenDetail = screen.detail.apply { tag = "capture-status-screen-state" }
        screenSwitch = MoteComponents.switch(this, false, MoteI18n.text("屏幕采集")) { on -> toggleScreen(on) }
            .apply { tag = "capture-status-screen-toggle" }
        screenFix = MoteComponents.smallButton(this, MoteI18n.text("处理")) { repairScreen() }
            .apply { tag = "capture-status-screen-action" }
        screen.trailing.addView(screenSwitch)
        screen.trailing.addView(screenFix)
        add(screen)

        val system = row(MoteGlyph.BELL, MoteI18n.text("通知与设备信息"), "capture-status-system")
        systemDetail = system.detail.apply { tag = "capture-status-system-state" }
        systemSwitch = MoteComponents.switch(this, false, MoteI18n.text("通知与设备信息")) { on -> toggleSystem(on) }
            .apply { tag = "capture-status-system-toggle" }
        system.trailing.addView(systemSwitch)
        add(system)

        val folders = row(MoteGlyph.FOLDER, MoteI18n.text("同步文件夹"), "capture-status-folders") {
            startActivity(Intent(this, SourcesActivity::class.java))
        }
        folders.detail.visibility = View.GONE
        foldersValue = TextView(this).apply {
            tag = "capture-status-folders-state"; MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.MUTED)
        }
        folders.trailing.addView(foldersValue)
        folders.trailing.addView(MoteComponents.icon(this, MoteGlyph.CHEV, NativeColorRole.MUTED, 16),
            LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(8) })
        add(folders)

        val send = row(MoteGlyph.SEND, MoteI18n.text("发送"), "capture-status-send")
        sendDetail = send.detail.apply { tag = "capture-status-send-state" }
        sendButton = MoteComponents.smallButton(this, MoteI18n.text("立即发送")) { sendNow() }
            .apply { tag = "capture-status-send-now" }
        send.trailing.addView(sendButton)
        add(send)

        content.addView(group, LinearLayout.LayoutParams(-1, -2))
        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
        }
        all = MoteComponents.button(this, "", MoteUi.ButtonRole.SECONDARY) { toggleAll() }.apply { tag = "capture-status-all" }
        actions.addView(all, LinearLayout.LayoutParams(0, -2, 1f))
        more = MoteComponents.button(this, MoteI18n.text("更多"), MoteUi.ButtonRole.TEXT) { showMore() }.apply { tag = "capture-status-more" }
        actions.addView(more, LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(8) })
        content.addView(actions, LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(16) })
        MoteUi.styleTree(content)
        if (android.os.Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { leave() }
    }
    override fun onResume() { super.onResume(); handler.post(refresh) }
    override fun onPause() { handler.removeCallbacks(refresh); super.onPause() }
    override fun onDestroy() { closed = true; moreMenu?.dismiss(); moreMenu = null; handler.removeCallbacks(refresh); reader.close(); worker.shutdown(); super.onDestroy() }
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Deprecated("Native back navigation") override fun onBackPressed() = leave()

    /** Opened from the notification or tile, this may be the only screen in its task; back then lands on the home. */
    private fun leave() {
        if (isTaskRoot) startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    @Suppress("DEPRECATION")
    private fun paintPanelBars() {
        window.statusBarColor = MoteTheme.surfaceRaised
        window.navigationBarColor = MoteTheme.surfaceRaised
    }

    private class PanelRow(val root: LinearLayout, val detail: TextView, val trailing: LinearLayout)

    private fun row(icon: MoteGlyph, title: String, identity: String, open: (() -> Unit)? = null): PanelRow {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
            minimumHeight = moteDp(MoteTheme.controlHeight)
            setPadding(moteDp(14), moteDp(9), moteDp(14), moteDp(9))
            tag = identity
            if (open != null) {
                background = MoteUi.clickable(this@CaptureStatusActivity, NativeColorRole.TRANSPARENT, NativeRadiusRole.CONTAINER, false)
                isFocusable = true; isClickable = true
                setOnClickListener { open() }
            }
        }
        root.addView(MoteComponents.icon(this, icon, NativeColorRole.MUTED, 20), LinearLayout.LayoutParams(moteDp(20), moteDp(20)).apply { marginEnd = moteDp(12) })
        val words = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        words.addView(TextView(this).apply { text = title; MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK) })
        val detail = TextView(this).apply { MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED) }
        words.addView(detail)
        root.addView(words, LinearLayout.LayoutParams(0, -2, 1f))
        val trailing = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false }
        root.addView(trailing, LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(12) })
        return PanelRow(root, detail, trailing)
    }

    internal fun render() {
        if (closed || isDestroyed || worker.isShutdown) return
        reader.request()
    }

    private fun present(f: CaptureOverview.Facts) {
        facts = f
        val model = CapturePanel.model(f)
        screenDetail.text = model.screen.detail
        MoteUi.textColor(screenDetail, if (model.screen.mode == CapturePanel.ScreenMode.FIX) NativeColorRole.WARNING else NativeColorRole.MUTED)
        screenSwitch.setChecked(model.screen.checked)
        screenSwitch.visibility = if (model.screen.mode == CapturePanel.ScreenMode.SWITCH) View.VISIBLE else View.GONE
        screenFix.visibility = if (model.screen.mode == CapturePanel.ScreenMode.FIX) View.VISIBLE else View.GONE
        systemDetail.text = model.system.detail
        systemSwitch.setChecked(model.system.checked)
        foldersValue.text = model.folders
        sendDetail.text = model.send
        MoteUi.textColor(sendDetail, if (model.sendAttention) NativeColorRole.WARNING else NativeColorRole.MUTED)
        sendButton.visibility = if (model.sendAction) View.VISIBLE else View.GONE
        all.text = model.all
        listOf(screenSwitch, systemSwitch, screenFix, sendButton, all, more).forEach { it.isEnabled = !working }
    }

    private fun toggleScreen(on: Boolean) {
        val f = facts ?: return
        if (!on) {
            if (f.enabled && f.screenSelected) pauseScreen()
            return
        }
        when {
            !f.screenSelected -> forwardPage("PRIVACY")
            !f.enabled || CaptureOverview.screenPaused(f) -> forward(CaptureOverview.Action.RESUME)
        }
    }

    private fun toggleSystem(on: Boolean) {
        val f = facts ?: return
        if (!on) {
            if (f.enabled && f.observesSystem) setSystemSources(false)
            return
        }
        if (!f.enabled) { forward(CaptureOverview.Action.RESUME); return }
        if (!f.observesSystem) setSystemSources(true)
    }

    /** The row covers the observations dialog's non-screen sources: turning it off stops all three, on selects the two named ones. */
    private fun setSystemSources(on: Boolean) = work { done ->
        worker.execute {
            val current = runCatching { Settings(applicationContext).read() }
            handler.post {
                if (closed || isDestroyed) { done(); return@post }
                current.onFailure { notice(it); done() }.onSuccess { config ->
                    val next = if (on) config.copy(notificationCollectionEnabled = true, deviceEventCollectionEnabled = true)
                    else config.copy(notificationCollectionEnabled = false, deviceEventCollectionEnabled = false, mediaCollectionEnabled = false)
                    RuntimeSettings.apply(this, next, expected = config) { result ->
                        result.exceptionOrNull()?.let(::notice); done()
                    }
                }
            }
        }
    }

    private fun sendNow() = work { done ->
        worker.execute {
            val config = runCatching { Settings(applicationContext).read() }.getOrElse {
                handler.post { notice(it); done() }
                return@execute
            }
            if (!config.hasSyncConnection()) {
                handler.post { toast(MoteI18n.text("记录已保存在本机；连接节点后才可以同步")); done() }
                return@execute
            }
            val result = runCatching {
                config.validateConnection()
                ConnectionGuard.sync {
                    if (localSources().sources().any { it.enabled }) SourceProviderPlugin.owner(applicationContext).schedule(manual = true, syncExplicit = true)
                    else UploadWorker.schedule(applicationContext, config, true)
                } ?: error(MoteI18n.text("正在应用设置，请稍后重试"))
            }
            handler.post {
                result.onSuccess { toast(MoteI18n.text("已请求同步；仍遵守网络约束")) }.onFailure { notice(it) }
                done()
            }
        }
    }

    private fun pauseScreen() = work { done -> CapturePlugin.controls().pauseScreen(this) { result -> result.exceptionOrNull()?.let(::notice); done() } }
    private fun toggleAll() {
        if (facts?.enabled != true) { forward(CaptureOverview.Action.RESUME); return }
        work { done -> CapturePlugin.controls().stopAll(this) { result -> result.exceptionOrNull()?.let(::notice); done() } }
    }
    private fun repairScreen() {
        val action = facts?.let { CaptureOverview.line(it).action } ?: CaptureOverview.Action.PERMISSIONS
        forward(action)
    }
    private fun work(run: (() -> Unit) -> Unit) {
        if (working) return
        working = true; facts?.let(::present)
        run { working = false; if (!isDestroyed) render() }
    }
    private fun notice(error: Throwable) = android.widget.Toast.makeText(this, error.message ?: MoteI18n.text("保存或调度失败，请重试；已保存内容不会丢失"), android.widget.Toast.LENGTH_LONG).show()
    private fun toast(message: String) = android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_SHORT).show()

    private fun showMore() {
        val width = moteDp(208)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, moteDp(6), 0, moteDp(6))
            background = MoteUi.shape(this@CaptureStatusActivity, NativeColorRole.SURFACE_RAISED, NativeRadiusRole.CONTROL, true, NativeColorRole.HAIR)
        }
        val popup = android.widget.PopupWindow(card, width, android.view.ViewGroup.LayoutParams.WRAP_CONTENT, true).apply {
            isOutsideTouchable = true
            setBackgroundDrawable(android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT))
            elevation = moteDp(10).toFloat()
        }
        moreMenu?.dismiss()
        moreMenu = popup
        val items = listOf(
            MoteI18n.text("采集与同步") to { startActivity(Intent(this, SourcesActivity::class.java)) },
            MoteI18n.text("采集范围") to { forwardPage("PRIVACY") },
            MoteI18n.text("采集与存储详情") to { startActivity(Intent(this, ActivityStatsActivity::class.java)) },
            MoteI18n.text("来源") to { handOff("page", "SOURCES") }
        )
        items.forEachIndexed { index, (label, action) ->
            card.addView(TextView(this).apply {
                text = label; tag = "capture-status-more-item-$index"
                gravity = Gravity.CENTER_VERTICAL; minHeight = moteDp(48)
                setPadding(moteDp(16), 0, moteDp(16), 0)
                MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK)
                background = MoteUi.clickable(this@CaptureStatusActivity, NativeColorRole.TRANSPARENT, 0, false)
                isFocusable = true
                setOnClickListener { popup.dismiss(); action() }
            }, LinearLayout.LayoutParams(-1, -2))
        }
        card.measure(android.view.View.MeasureSpec.makeMeasureSpec(width, android.view.View.MeasureSpec.EXACTLY),
            android.view.View.MeasureSpec.makeMeasureSpec(0, android.view.View.MeasureSpec.UNSPECIFIED))
        val location = IntArray(2); more.getLocationOnScreen(location)
        val x = (more.rootView.width - moteDp(16) - width).coerceAtLeast(moteDp(16))
        val y = (location[1] - card.measuredHeight - moteDp(8)).coerceAtLeast(moteDp(24))
        popup.showAtLocation(more, Gravity.TOP or Gravity.START, x, y)
    }

    /** Resume, restart and repair run where the preview, permissions and system consent already live. */
    private fun forward(action: CaptureOverview.Action) = handOff("captureAction", action.name)
    private fun forwardPage(page: String) = handOff("page", page)
    /** The app takes over the task. Opened from the tile or notification, the panel never stays behind the home. */
    private fun handOff(key: String, value: String) {
        startActivity(Intent(this, MainActivity::class.java).putExtra(key, value).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }
}

/** The panel's four rows and bottom actions derived from one read; the Activity only binds them to native controls. */
internal object CapturePanel {
    enum class ScreenMode { SWITCH, FIX }
    data class Screen(val detail: String, val mode: ScreenMode, val checked: Boolean)
    data class SwitchRow(val detail: String, val checked: Boolean)
    data class Model(
        val screen: Screen, val system: SwitchRow, val folders: String,
        val send: String, val sendAttention: Boolean, val sendAction: Boolean,
        val all: String,
    )

    fun model(f: CaptureOverview.Facts, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Model {
        val screenPaused = CaptureOverview.screenPaused(f)
        val fix = f.enabled && f.screenSelected && !screenPaused && !f.screenLive
        val screen = when {
            !f.enabled -> MoteI18n.text("已暂停")
            screenPaused -> MoteI18n.text("{0} 起暂停", CaptureOverview.moment(f.screenPausedAt!!, now, zone))
            !f.screenSelected -> MoteI18n.text("关闭")
            f.screenLive -> MoteI18n.text("采集中")
            else -> MoteI18n.text("等待采集权限")
        }
        val system = when {
            !f.enabled -> MoteI18n.text("已暂停")
            !f.observesSystem -> MoteI18n.text("关闭")
            f.systemLive -> MoteI18n.text("采集中")
            else -> MoteI18n.text("等待采集权限")
        }
        val (send, sendAttention) = CaptureOverview.send(f)
        return Model(
            screen = Screen(screen, if (fix) ScreenMode.FIX else ScreenMode.SWITCH, f.enabled && f.screenSelected && !screenPaused),
            system = SwitchRow(system, f.enabled && f.observesSystem),
            folders = if (f.folders > 0) MoteI18n.text("{0} 个文件夹", f.folders) else MoteI18n.text("关闭"),
            send = send.ifBlank { MoteI18n.text("按设置发送") }, sendAttention = sendAttention,
            sendAction = !f.sendPaused,
            all = MoteI18n.text(if (f.enabled) "暂停全部采集" else "恢复采集")
        )
    }
}
