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
            result.onSuccess { (value, config) -> store = value; buildUi(config); if (foreground) background("正在读取安装状态…") { AppUpdateInstaller.reconcile(applicationContext) } }
                .onFailure { label.text = "更新设置读取失败，请重试" }
        }
    }
    private fun buildUi(initialConfig: UpdateConfig) {
        val body = moteDetailPage()
        fun text(value: String, size: Float = 14f) = TextView(this).apply { text = value; textSize = size; setPadding(0, moteDp(10), 0, moteDp(10)) }.also(body::addView)
        fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; setOnClickListener { runCatching(action).onFailure { Toast.makeText(this@AppUpdatesActivity, message((it as? UpdateFailure)?.code ?: "failed"), Toast.LENGTH_LONG).show() } } }.also(body::addView)
        text("应用更新", 28f); text("当前 ${BuildConfig.VERSION_NAME} · code ${BuildConfig.VERSION_CODE}\n${packageName}\n检查和下载由你发起，最终由 Android 系统确认安装。")
        text("发布仓库（owner/repository）")
        repository = EditText(this).apply { setSingleLine(); setText(initialConfig.repository); contentDescription = "更新发布仓库" }; body.addView(repository)
        channel = Spinner(this).apply { adapter = ArrayAdapter(this@AppUpdatesActivity, android.R.layout.simple_spinner_dropdown_item, listOf("稳定版 stable", "预览版 preview")); setSelection(if (initialConfig.channel == "preview") 1 else 0) }; body.addView(channel)
        wifi = CheckBox(this).apply { text = "仅非计费 Wi-Fi 下载 APK"; isChecked = initialConfig.wifiOnly }; body.addView(wifi)
        text("其他仓库必须发布由 Mote 内置 RSA 公钥签署的清单。不会信任服务器下发的新公钥，也不会发送中央节点令牌。")
        button("保存渠道并检查更新") {
            val config = UpdateConfig(repository.text.toString().trim(), if (channel.selectedItemPosition == 1) "preview" else "stable", wifi.isChecked)
            config.validate(); background("正在保存渠道…") { AppUpdateWork.cancel(applicationContext); store.save(config); AppUpdateWork.enqueue(applicationContext, "check") }
        }
        status = text("等待检查", 16f).apply { setPadding(0, 24, 0, 24) }
        button("下载 / 继续下载") { background("正在提交下载…") { AppUpdateWork.enqueue(applicationContext, "download") } }
        button("取消下载（保留断点）") { background("正在取消下载…", cancelTask) { AppUpdateWork.cancel(applicationContext) } }
        button("交给系统安装") {
            if (!packageManager.canRequestPackageInstalls()) startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
            else AlertDialog.Builder(this).setTitle("安装更新").setMessage("系统会替换同包名、同签名的应用，保留设置、队列、草稿、模型和数据。采集可能短暂中断；投屏模式更新后需重新授权。不会自动卸载。")
                .setNegativeButton("取消", null).setPositiveButton("继续") { _, _ ->
                    background("正在准备安装…") { val ticket = AppUpdateInstaller.request(applicationContext); AppUpdateInstaller.stage(applicationContext, ticket) }
                }.show()
        }
        button("取消待确认的安装") { background("正在取消安装…", cancelTask) { AppUpdateInstaller.cancelSession(applicationContext) } }
        text("签名不一致会阻止更新，不会删除旧应用。0.4.0 本机 debug 安装包只能接受同一证书签名的后续包。系统安装权限、小米安装校验或省电限制仍需你在系统确认；安装失败时保留现有数据。")
        MoteUi.styleTree(body)
    }
    override fun onResume() { super.onResume(); foreground = true; if (::store.isInitialized && ::status.isInitialized) background("正在读取安装状态…") { AppUpdateInstaller.reconcile(applicationContext) }; handler.post(refresh) }
    override fun onPause() { foreground = false; handler.removeCallbacks(refresh); super.onPause() }
    private fun background(label: String, runner: UiTask = task, action: () -> Unit) {
        runner.start(label, { status.text = message(store.prefs.getString("state", "idle")!!) + "\n" + it }, { action() }) { result ->
            result.onFailure { Toast.makeText(this, message((it as? UpdateFailure)?.code ?: "failed"), Toast.LENGTH_LONG).show() }
            render()
        }
    }
    private fun render() {
        if (!::status.isInitialized || task.busy || cancelTask.busy) return
        val version = store.prefs.getString("availableVersion", "")!!; val size = store.prefs.getLong("size", 0); val bytes = store.prefs.getLong("bytes", 0)
        status.text = message(store.prefs.getString("state", "idle")!!) + if (version.isEmpty()) "" else "\n清单版本 $version · %.1f MiB\n已下载 %.1f MiB".format(size / 1048576.0, bytes / 1048576.0)
    }
    companion object {
        @Volatile var foreground = false; private set
        fun message(code: String): String = when (code) {
            "idle" -> "尚未检查更新"; "waiting_network" -> "等待网络和系统后台调度"; "checking" -> "检查 GitHub 发布并验证清单签名…"
            "current", "not_newer" -> "没有可安装的更高 versionCode；不会降级"; "available" -> "发现已验证发布，可下载"
            "downloading" -> "正在下载，退出页面后仍按系统调度继续"; "verifying" -> "正在校验 APK 大小、SHA-256 和签名"
            "ready" -> "APK 已校验，点击交给系统安装"; "preparing" -> "正在重新校验安装文件，可取消"; "staging" -> "正在提交安装文件给 Android"
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
