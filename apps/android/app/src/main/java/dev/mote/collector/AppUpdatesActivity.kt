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
import dev.mote.collector.plugins.NativeSystemToolsPlugin

class AppUpdatesActivity : MoteActivity() {
    private lateinit var store: AppUpdateStore
    private lateinit var status: TextView
    private lateinit var primary: Button
    private lateinit var cancel: Button
    private lateinit var deletePackage: Button
    private lateinit var primaryActions: android.view.ViewGroup
    private lateinit var otherPackageActions: android.view.ViewGroup
    private lateinit var progress: ProgressBar
    private lateinit var repository: EditText
    private lateinit var channel: Spinner
    private lateinit var wifi: CheckBox
    private var restoredState: Bundle? = null
    private var settingsPanel: LinearLayout? = null
    private val handler = Handler(Looper.getMainLooper())
    private val task by lazy { UiTask(this) }
    private val cancelTask by lazy { UiTask(this) }
    private val systemTools by lazy { NativeSystemToolsPlugin.owner(this) }
    private val refresh = object : Runnable { override fun run() { render(); handler.postDelayed(this, 1000) } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        restoredState = savedInstanceState
        if (RuntimeProfile.current == RuntimeProfile.DEV) {
            val body = moteDetailPage(title = MoteI18n.text("应用更新"))
            val card = SecondaryUi.column(body, card = true)
            SecondaryUi.text(card, "Mote DEV · ${BuildConfig.VERSION_NAME}", muted = true)
            SecondaryUi.text(card, MoteI18n.text("DEV 构建手动安装"), heading = true)
            SecondaryUi.text(card, MoteI18n.text("DEV 构建按提交保存在 GitHub Actions，请选择对应运行的 Artifact 下载并手动安装。"), muted = true)
            SecondaryUi.action(SecondaryUi.actions(card), MoteI18n.text("打开构建页面"), primary = true) {
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/utopiafar/mote/actions/workflows/release-android.yml"))) }
                    .onFailure { Toast.makeText(this@AppUpdatesActivity, MoteI18n.text("无法打开 GitHub，请安装或启用浏览器后重试"), Toast.LENGTH_LONG).show() }
            }
            MoteUi.styleTree(body)
            return
        }
        val loading = moteDetailPage(title = MoteI18n.text("应用更新")); val label = TextView(this); loading.addView(label)
        task.start(MoteI18n.text("正在读取更新设置…"), { label.text = it }, {
            val value = AppUpdateStore(applicationContext); value to value.config()
        }) { result ->
            result.onSuccess { (value, config) -> store = value; buildUi(config); if (foreground) background(MoteI18n.text("正在读取安装状态…")) { systemTools.reconcileUpdates(applicationContext); AppUpdateWork.reconcile(applicationContext) } }
                .onFailure { label.text = MoteI18n.text("更新设置读取失败，请重试") }
        }
    }
    private fun buildUi(initialConfig: UpdateConfig) {
        val body = moteDetailPage(title = MoteI18n.text("应用更新"))
        val card = SecondaryUi.column(body, card = true)
        SecondaryUi.text(card, MoteI18n.text("当前版本 {0}", BuildConfig.VERSION_NAME), muted = true)
        status = SecondaryUi.text(card, MoteI18n.text("等待检查"), heading = true)
        SecondaryUi.text(card, MoteI18n.text("更新保留设置与本机记录，安装由系统确认。"), muted = true)
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100 }; card.addView(progress)
        val actions = SecondaryUi.actions(card)
        primaryActions = actions
        fun button(label: String, action: () -> Unit) = SecondaryUi.action(actions, label) {
            runCatching(action).onFailure { Toast.makeText(this@AppUpdatesActivity, message((it as? UpdateFailure)?.code ?: "failed"), Toast.LENGTH_LONG).show() }
        }
        primary = button(MoteI18n.text("检查更新")) {
            when (UpdatePresentation.action(store.prefs.getString("state", "idle")!!, store.prefs.getLong("availableCode", 0) > BuildConfig.VERSION_CODE)) {
                "download" -> background(MoteI18n.text("正在提交下载…")) { AppUpdateWork.enqueue(applicationContext, "download") }
                "install" -> {
                    if (!packageManager.canRequestPackageInstalls()) startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
                    else background(MoteI18n.text("正在准备安装…")) { val ticket = systemTools.requestUpdate(applicationContext); systemTools.stageUpdate(applicationContext, ticket) }
                }
                "check" -> background(MoteI18n.text("正在检查更新…")) { AppUpdateWork.enqueue(applicationContext, "check") }
            }
        }
        cancel = button(MoteI18n.text("取消")) {
            background(MoteI18n.text("正在取消…"), cancelTask) {
                if (store.prefs.getString("state", "") in UpdatePresentation.installStates) systemTools.cancelUpdate(applicationContext)
                else AppUpdateWork.cancel(applicationContext)
            }
        }
        deletePackage = button(MoteI18n.text("删除已下载包")) {
            background(MoteI18n.text("正在删除更新包…")) { store.deleteDownloadedPackages() }
        }
        val advanced = SecondaryUi.disclosure(body, MoteI18n.text("更新设置"), "app-update-settings", restoredState?.getBoolean("settingsExpanded") == true)
        settingsPanel = advanced
        actions.removeView(deletePackage)
        otherPackageActions = SecondaryUi.actions(advanced)
        otherPackageActions.addView(deletePackage)
        SecondaryUi.text(advanced, MoteI18n.text("删除下载的 APK 和未完成下载，保留应用设置和记录；需要时可以重新下载。"), muted = true)
        advanced.addView(TextView(this).apply { text = MoteI18n.text("发布仓库") })
        repository = EditText(this).apply { setSingleLine(); setText(restoredState?.getString("repository") ?: initialConfig.repository); contentDescription = MoteI18n.text("更新发布仓库") }; advanced.addView(repository)
        channel = Spinner(this).apply { adapter = ArrayAdapter(this@AppUpdatesActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("稳定版"), MoteI18n.text("预览版"))); setSelection(restoredState?.getInt("channel") ?: if (initialConfig.channel == "preview") 1 else 0) }; advanced.addView(channel)
        wifi = CheckBox(this).apply { text = MoteI18n.text("仅非计费网络下载"); isChecked = restoredState?.getBoolean("wifi") ?: initialConfig.wifiOnly }; advanced.addView(wifi)
        advanced.addView(Button(this).apply { text = MoteI18n.text("保存并检查更新"); setOnClickListener {
            runCatching {
                val config = UpdateConfig(repository.text.toString().trim(), if (channel.selectedItemPosition == 1) "preview" else "stable", wifi.isChecked)
                config.validate()
                background(MoteI18n.text("正在保存更新设置…")) { AppUpdateWork.cancel(applicationContext); store.save(config); AppUpdateWork.enqueue(applicationContext, "check") }
            }.onFailure { Toast.makeText(this@AppUpdatesActivity, message((it as? UpdateFailure)?.code ?: "failed"), Toast.LENGTH_LONG).show() }
        } })
        MoteUi.styleTree(body)
        MoteUi.button(primary, true)
        render()
    }
    override fun onResume() { super.onResume(); foreground = true; if (::store.isInitialized && ::status.isInitialized) background(MoteI18n.text("正在读取安装状态…")) { systemTools.reconcileUpdates(applicationContext); AppUpdateWork.reconcile(applicationContext) }; handler.post(refresh) }
    override fun onPause() { foreground = false; handler.removeCallbacks(refresh); super.onPause() }
    private fun background(label: String, runner: UiTask = task, action: () -> Unit) {
        if (runner.busy) { Toast.makeText(this, MoteI18n.text("操作正在进行"), Toast.LENGTH_SHORT).show(); return }
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
        primary.text = when (action) { "download" -> MoteI18n.text("下载更新"); "install" -> MoteI18n.text("安装更新"); "busy" -> MoteI18n.text("处理中…"); else -> MoteI18n.text("检查更新") }
        primary.isEnabled = action != "busy"
        val packageParent = if (action == "install") primaryActions else otherPackageActions
        if (deletePackage.parent !== packageParent) {
            (deletePackage.parent as? android.view.ViewGroup)?.removeView(deletePackage)
            packageParent.addView(deletePackage)
        }
        deletePackage.tag = "update-delete-package"
        deletePackage.isEnabled = state !in UpdatePresentation.installStates && !store.prefs.getBoolean("installRequestActive", false)
        cancel.visibility = if (state in UpdatePresentation.transferStates || state in UpdatePresentation.installStates) android.view.View.VISIBLE else android.view.View.GONE
        progress.visibility = if (state in UpdatePresentation.transferStates || state in UpdatePresentation.installStates) android.view.View.VISIBLE else android.view.View.GONE
        progress.isIndeterminate = state != "downloading" || size <= 0
        if (size > 0) progress.progress = (bytes * 100 / size).toInt().coerceIn(0, 100)
        status.text = message(state) + if (version.isEmpty()) "" else MoteI18n.text("\n版本 {0} · %.1f MiB\n已下载 %.1f MiB", version).format(size / 1048576.0, bytes / 1048576.0)
    }
    override fun onSaveInstanceState(outState: Bundle) {
        if (::repository.isInitialized) {
            outState.putString("repository", repository.text.toString()); outState.putInt("channel", channel.selectedItemPosition)
            outState.putBoolean("wifi", wifi.isChecked); outState.putBoolean("settingsExpanded", settingsPanel?.visibility == android.view.View.VISIBLE)
        }
        super.onSaveInstanceState(outState)
    }
    companion object {
        @Volatile var foreground = false; private set
        fun message(code: String): String = when (code) {
            "queued" -> MoteI18n.text("已提交，等待系统启动任务"); "waiting_wifi" -> MoteI18n.text("等待非计费网络，可在更新设置中调整"); "scheduler" -> MoteI18n.text("上次任务未完成，请重试");
            "idle" -> MoteI18n.text("尚未检查更新"); "waiting_network" -> MoteI18n.text("等待网络和系统后台调度"); "checking" -> MoteI18n.text("检查 GitHub 发布并验证清单签名…")
            "current", "not_newer" -> MoteI18n.text("已是最新版本"); "available" -> MoteI18n.text("发现已验证发布，可下载")
            "downloading" -> MoteI18n.text("正在下载，退出页面后仍按系统调度继续"); "verifying" -> MoteI18n.text("正在校验 APK 大小、SHA-256 和签名")
            "ready" -> MoteI18n.text("下载完成，可以安装"); "preparing" -> MoteI18n.text("正在重新校验安装文件，可取消"); "staging" -> MoteI18n.text("正在提交安装文件给 Android")
            "install_pending", "awaiting_user" -> MoteI18n.text("等待系统安装确认；未弹出时查看通知，或取消待确认安装后重试")
            "installed" -> MoteI18n.text("系统已完成更新；已有应用数据保留"); "install_permission" -> MoteI18n.text("请在系统允许此应用安装更新，返回后再次点击安装")
            "certificate", "apk_signature" -> MoteI18n.text("APK 签名与当前应用不兼容或无效，已阻止更新；不会卸载旧应用")
            "checksum", "asset_size" -> MoteI18n.text("APK 大小或 SHA-256 不匹配，未交给系统安装")
            "package" -> MoteI18n.text("APK 包名、版本或系统要求与当前应用不符，已阻止安装")
            "manifest", "manifest_signature", "host", "redirect" -> MoteI18n.text("发布清单签名、格式或来源不可信，已拒绝")
            "not_found" -> MoteI18n.text("该渠道尚无可用的已签名发布，或 GitHub 未找到发布清单")
            "asset_missing" -> MoteI18n.text("请先检查更新；该发布可能没有匹配当前包名的 Android 资产")
            "rate_limit" -> MoteI18n.text("GitHub 暂时限流，稍后重试"); "access_denied" -> MoteI18n.text("更新服务器拒绝访问，请检查网络入口或发布资源的访问权限。"); "network" -> MoteI18n.text("网络暂不可用，断点保留，等待重试")
            "storage" -> MoteI18n.text("更新空间不足或文件保存失败；应用数据未删除"); "configuration" -> MoteI18n.text("仓库应为 owner/repository，渠道为 stable 或 preview")
            "cancelled" -> MoteI18n.text("操作已取消；旧应用数据及下载断点保留"); "install_failed" -> MoteI18n.text("系统未确认安装成功；旧应用保留，可重新检查或安装")
            else -> MoteI18n.text("更新未完成，请重试；旧应用和数据保留")
        }
    }
}
