package dev.mote.collector

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.webkit.*
import android.widget.*

/** Shared central UI and login for Ask, archive and workbench. */
open class CentralActivity : MoteActivity() {
    private lateinit var web: WebView
    private lateinit var root: LinearLayout
    private lateinit var status: TextView
    private lateinit var retry: Button
    private lateinit var connection: Button
    private val entry = CentralEntryState()
    private val task by lazy { UiTask(this) }
    private var files: ValueCallback<Array<Uri>>? = null

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(MoteUi.background); moteInsets() }
        root.addView(TextView(this).apply {
            text = MoteI18n.text("‹  返回"); contentDescription = MoteI18n.text("返回上一页")
            textSize = 15f; setTextColor(MoteUi.accent); gravity = Gravity.CENTER_VERTICAL
            setPadding(moteDp(20), 0, moteDp(20), 0); minHeight = moteDp(48)
            isFocusable = true; setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(-1, -2))
        status = TextView(this).apply { text = MoteI18n.text("正在读取本机设置…"); setPadding(moteDp(20), moteDp(16), moteDp(20), moteDp(16)) }
        root.addView(status)
        retry = Button(this).apply { visibility = View.GONE; text = MoteI18n.text("重试"); setOnClickListener { openCentral(forceReload = true) } }
        root.addView(retry, LinearLayout.LayoutParams(-2, -2))
        connection = Button(this).apply {
            text = MoteI18n.text("连接设置")
            setOnClickListener { startActivity(Intent(this@CentralActivity, MainActivity::class.java).putExtra("page", "CONNECTION").putExtra("returnToCentral", true)) }
        }
        root.addView(connection, LinearLayout.LayoutParams(-2, -2))
        setContentView(root)
    }

    private fun present() {
        if (::web.isInitialized) web.visibility = if (entry.showWeb) View.VISIBLE else View.GONE
        status.visibility = if (entry.showWeb) View.GONE else View.VISIBLE
        retry.visibility = if (entry.phase == CentralEntryState.Phase.FAILED) View.VISIBLE else View.GONE
        connection.visibility = if (entry.showWeb) View.GONE else View.VISIBLE
        status.text = when (entry.phase) {
            CentralEntryState.Phase.NEEDS_NODE -> MoteI18n.text("先选择中央节点。本机记录可以继续保存；选择节点后，中央资料仍需单独登录。")
            CentralEntryState.Phase.LOADING -> MoteI18n.text("正在连接中央节点…")
            CentralEntryState.Phase.FAILED -> MoteI18n.text("中央界面暂时无法打开。本机记录不受影响；请检查节点地址和网络后重试，或打开连接设置。")
            CentralEntryState.Phase.READY -> ""
        }
    }

    private fun openCentral(forceReload: Boolean = false) {
        if (task.busy) return
        task.start(MoteI18n.text("正在读取本机设置…"), { status.text = it }, {
            val settings = Settings(this)
            settings.read() to settings.centralEndpoint()
        }) { result ->
            if (isFinishing || isDestroyed) return@start
            result.onFailure { entry.failed(); present() }.onSuccess { (config, confirmed) ->
                // Returning from the picker, background or native settings must not
                // navigate an existing session back to the Activity's initial page.
                val resume = !forceReload && ::web.isInitialized && entry.canResume(config.server, confirmed)
                if (!resume && !entry.begin(config.server, confirmed)) { present(); return@onSuccess }
                if (runCatching { PrivacyRules.validateEndpoint(config.server, config.debugHttp, BuildConfig.DEBUG) }.isFailure) {
                    entry.failed(); present(); return@onSuccess
                }
                if (resume) { web.onResume(); return@onSuccess }
                web = CentralWebSession.acquire(this, entry.server)
                web.visibility = View.GONE
                web.webViewClient = CentralOriginClient(Uri.parse(entry.server), onError = {
                    CentralWebSession.failed(web)
                    entry.failed(); present()
                }, onLoaded = {
                    entry.finished(); present()
                })
                web.webChromeClient = object : WebChromeClient() {
                    override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                        files?.onReceiveValue(null); files = callback
                        return try { startActivityForResult(params.createIntent(), 71); true } catch (_: Exception) { files = null; false }
                    }
                }
                root.addView(web, LinearLayout.LayoutParams(-1, 0, 1f))
                val page = intent.getStringExtra("page").takeIf { it in listOf("ask", "notes", "vault", "overview", "archive", "actions") } ?: "ask"
                if (!CentralWebSession.navigate(web, "${entry.server}/#$page") && web.progress == 100) entry.finished()
                present()
            }
        }
    }

    override fun onResume() { super.onResume(); openCentral() }
    override fun onPause() { if (::web.isInitialized) web.onPause(); super.onPause() }
    @Deprecated("Native document picker")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 71) { files?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data)); files = null }
    }
    override fun onDestroy() {
        files?.onReceiveValue(null); files = null
        if (::web.isInitialized) CentralWebSession.release(web)
        super.onDestroy()
    }
}
