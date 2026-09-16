package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.WindowManager
import android.widget.*

class AppUpdatesActivity : Activity() {
    private lateinit var store: AppUpdateStore
    private lateinit var status: TextView
    private lateinit var primary: Button
    private lateinit var cancel: Button
    private lateinit var progress: ProgressBar
    private lateinit var repository: EditText
    private lateinit var channel: Spinner
    private lateinit var wifi: CheckBox
    private val handler = Handler(Looper.getMainLooper())
    private val task by lazy { UiTask(this) }
    private val cancelTask by lazy { UiTask(this) }
    private val refresh = object : Runnable { override fun run() { render(); handler.postDelayed(this, 1000) } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val loading = moteDetailPage(); val label = TextView(this); loading.addView(label)
        task.start("正在读取更新设置…", { label.text = it }, {
            val value = AppUpdateStore(applicationContext); value to value.config()
        }) { result ->
            result.onSuccess { (value, config) -> store = value; buildUi(config); if (foreground) background("正在读取安装状态…") { AppUpdateInstaller.reconcile(applicationContext); AppUpdateWork.reconcile(applicationContext) } }
                .onFailure { label.text = "更新设置读取失败，请重试" }
        }
    }
    private fun buildUi(initialConfig: UpdateConfig) {
        val body = moteDetailPage()
        fun text(value: String, size: Float = 14f) = TextView(this).apply { text = value; textSize = size; setPadding(0, moteDp(10), 0, moteDp(10)) }.also(body::addView)
        fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; setOnClickListener { runCatching(action).onFailure { Toast.makeText(this@AppUpdatesActivity, message((it as? UpdateFailure)?.code ?: "failed"), Toast.LENGTH_LONG).show() } } }.also(body::addView)
        text("应用更新", 28f)
        text("当前版本 ${BuildConfig.VERSION_NAME}")
        status = text("等待检查", 16f)
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100 }; body.addView(progress)
        primary = button("检查更新") {
            when (UpdatePresentation.action(store.prefs.getString("state", "idle")!!, store.prefs.getLong("availableCode", 0) > BuildConfig.VERSION_CODE)) {
                "download" -> background("正在提交下载…") { AppUpdateWork.enqueue(applicationContext, "download") }
                "install" -> {
                    if (!packageManager.canRequestPackageInstalls()) startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
                    else background("正在准备安装…") { val ticket = AppUpdateInstaller.request(applicationContext); AppUpdateInstaller.stage(applicationContext, ticket) }
                }
                "check" -> background("正在检查更新…") { AppUpdateWork.enqueue(applicationContext, "check") }
            }
        }
        cancel = button("取消") {
            background("正在取消…", cancelTask) {
                if (store.prefs.getString("state", "") in UpdatePresentation.installStates) AppUpdateInstaller.cancelSession(applicationContext)
                else AppUpdateWork.cancel(applicationContext)
            }
        }
        val advanced = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = android.view.View.GONE }
        button("更新设置") { advanced.visibility = if (advanced.visibility == android.view.View.VISIBLE) android.view.View.GONE else android.view.View.VISIBLE }
        body.addView(advanced)
        advanced.addView(TextView(this).apply { text = "发布仓库" })
        repository = EditText(this).apply { setSingleLine(); setText(initialConfig.repository); contentDescription = "更新发布仓库" }; advanced.addView(repository)
        channel = Spinner(this).apply { adapter = ArrayAdapter(this@AppUpdatesActivity, android.R.layout.simple_spinner_dropdown_item, listOf("稳定版", "预览版")); setSelection(if (initialConfig.channel == "preview") 1 else 0) }; advanced.addView(channel)
        wifi = CheckBox(this).apply { text = "仅非计费网络下载"; isChecked = initialConfig.wifiOnly }; advanced.addView(wifi)
        advanced.addView(Button(this).apply { text = "保存并检查更新"; setOnClickListener {
            runCatching {
                val config = UpdateConfig(repository.text.toString().trim(), if (channel.selectedItemPosition == 1) "preview" else "stable", wifi.isChecked)
                config.validate()
                background("正在保存更新设置…") { AppUpdateWork.cancel(applicationContext); store.save(config); AppUpdateWork.enqueue(applicationContext, "check") }
            }.onFailure { Toast.makeText(this@AppUpdatesActivity, message((it as? UpdateFailure)?.code ?: "failed"), Toast.LENGTH_LONG).show() }
        } })
        text("更新保留设置与本机记录，安装由系统确认。", 13f)
        MoteUi.styleTree(body)
        MoteUi.button(primary, true)
        render()
    }
    override fun onResume() { super.onResume(); foreground = true; if (::store.isInitialized && ::status.isInitialized) background("正在读取安装状态…") { AppUpdateInstaller.reconcile(applicationContext); AppUpdateWork.reconcile(applicationContext) }; handler.post(refresh) }
    override fun onPause() { foreground = false; handler.removeCallbacks(refresh); super.onPause() }
    private fun background(label: String, runner: UiTask = task, action: () -> Unit) {
        if (runner.busy) { Toast.makeText(this, "操作正在进行", Toast.LENGTH_SHORT).show(); return }
        primary.isEnabled = false
        runner.start(label, { status.text = message(store.prefs.getString("state", "idle")!!) + "\n" + it }, { action() }) { result ->
            result.onFailure { Toast.makeText(this, message((it as? UpdateFailure)?.code ?: "failed"), Toast.LENGTH_LONG).show() }
            render()
        }
    }
    private fun render() {
        if (!::status.isInitialized || task.busy || cancelTask.busy) return
        val version = store.prefs.getString("availableVersion", "")!!; val size = store.prefs.getLong("size", 0); val bytes = store.prefs.getLong("bytes", 0)
        val state = store.prefs.getString("state", "idle")!!
        val action = UpdatePresentation.action(state, store.prefs.getLong("availableCode", 0) > BuildConfig.VERSION_CODE)
        primary.text = when (action) { "download" -> "下载更新"; "install" -> "安装更新"; "busy" -> "处理中…"; else -> "检查更新" }
        primary.isEnabled = action != "busy"
        cancel.visibility = if (state in UpdatePresentation.transferStates || state in UpdatePresentation.installStates) android.view.View.VISIBLE else android.view.View.GONE
        progress.visibility = if (state in UpdatePresentation.transferStates || state in UpdatePresentation.installStates) android.view.View.VISIBLE else android.view.View.GONE
        progress.isIndeterminate = state != "downloading" || size <= 0
        if (size > 0) progress.progress = (bytes * 100 / size).toInt().coerceIn(0, 100)
        status.text = message(state) + if (version.isEmpty()) "" else "\n版本 $version · %.1f MiB\n已下载 %.1f MiB".format(size / 1048576.0, bytes / 1048576.0)
    }
    companion object {
        @Volatile var foreground = false; private set
        fun message(code: String): String = when (code) {
            "queued" -> "已提交，等待系统启动任务"; "waiting_wifi" -> "等待非计费网络，可在更新设置中调整"; "scheduler" -> "上次任务未完成，请重试";
            "idle" -> "尚未检查更新"; "waiting_network" -> "等待网络和系统后台调度"; "checking" -> "检查 GitHub 发布并验证清单签名…"
            "current", "not_newer" -> "已是最新版本"; "available" -> "发现已验证发布，可下载"
            "downloading" -> "正在下载，退出页面后仍按系统调度继续"; "verifying" -> "正在校验 APK 大小、SHA-256 和签名"
            "ready" -> "下载完成，可以安装"; "preparing" -> "正在重新校验安装文件，可取消"; "staging" -> "正在提交安装文件给 Android"
            "install_pending", "awaiting_user" -> "等待系统安装确认；未弹出时查看通知，或取消待确认安装后重试"
            "installed" -> "系统已完成更新；已有应用数据保留"; "install_permission" -> "请在系统允许此应用安装更新，返回后再次点击安装"
            "certificate", "apk_signature" -> "APK 签名与当前应用不兼容或无效，已阻止更新；不会卸载旧应用"
            "checksum", "asset_size" -> "APK 大小或 SHA-256 不匹配，未交给系统安装"
            "package" -> "APK 包名、版本或系统要求与当前应用不符，已阻止安装"
            "manifest", "manifest_signature", "host", "redirect" -> "发布清单签名、格式或来源不可信，已拒绝"
            "not_found" -> "该渠道尚无可用的已签名发布，或 GitHub 未找到发布清单"
            "asset_missing" -> "请先检查更新；该发布可能没有匹配当前包名的 Android 资产"
            "rate_limit" -> "GitHub 暂时限流，稍后重试"; "network" -> "网络暂不可用，断点保留，等待重试"
            "storage" -> "更新空间不足或文件保存失败；应用数据未删除"; "configuration" -> "仓库应为 owner/repository，渠道为 stable 或 preview"
            "cancelled" -> "操作已取消；旧应用数据及下载断点保留"; "install_failed" -> "系统未确认安装成功；旧应用保留，可重新检查或安装"
            else -> "更新未完成，请重试；旧应用和数据保留"
        }
    }
}
