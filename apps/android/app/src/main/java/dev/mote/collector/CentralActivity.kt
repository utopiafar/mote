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
    private var files: ValueCallback<Array<Uri>>? = null
    private var server = ""
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(MoteUi.background); moteInsets() }
        root.addView(TextView(this).apply {
            text = MoteI18n.text("‹  返回"); contentDescription = MoteI18n.text("返回上一页")
            textSize = 15f; setTextColor(MoteUi.accent); gravity = Gravity.CENTER_VERTICAL
            setPadding(moteDp(20), 0, moteDp(20), 0); minHeight = moteDp(48)
            isFocusable = true; setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(-1, -2))
        val status = TextView(this).apply { setPadding(moteDp(20), moteDp(8), moteDp(20), moteDp(8)); text = MoteI18n.text("正在连接中央节点…") }
        root.addView(status)
        val retry = Button(this).apply { text = MoteI18n.text("重试"); visibility = View.GONE }
        root.addView(retry, LinearLayout.LayoutParams(-2, -2))
        setContentView(root)
        UiTask(this).start("", { status.text = it }, { Settings(this).read().also { PrivacyRules.validateEndpoint(it.server, it.debugHttp, BuildConfig.DEBUG) } }) { result ->
            result.onFailure { status.text = it.message }.onSuccess { config ->
                if (isFinishing || isDestroyed) return@onSuccess
                server = config.server.trimEnd('/')
                web = CentralWebSession.acquire(this, server)
                web.webViewClient = CentralOriginClient(Uri.parse(server)) {
                    CentralWebSession.failed(web)
                    status.visibility = View.VISIBLE
                    status.text = MoteI18n.text("中央界面加载失败，请检查连接后重试")
                    retry.visibility = View.VISIBLE
                }
                web.webChromeClient = object : WebChromeClient() {
                    override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                        files?.onReceiveValue(null); files = callback
                        return try { startActivityForResult(params.createIntent(), 71); true } catch (_: Exception) { files = null; false }
                    }
                }
                root.addView(web, LinearLayout.LayoutParams(-1, 0, 1f))
                status.visibility = View.GONE
                val page = intent.getStringExtra("page").takeIf { it in listOf("ask", "notes", "vault", "overview", "archive", "actions") } ?: "ask"
                val destination = "$server/#$page"
                retry.setOnClickListener {
                    retry.visibility = View.GONE; status.visibility = View.GONE
                    CentralWebSession.navigate(web, destination)
                }
                CentralWebSession.navigate(web, destination)
            }
        }
    }
    override fun onResume() {
        super.onResume()
        if (::web.isInitialized) {
            // Never carry an open central page across a node change.
            if (Settings(this).read().server.trimEnd('/') != server) { recreate(); return }
            web.onResume()
        }
    }
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
