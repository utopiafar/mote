package dev.mote.collector

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.*
import android.widget.*

/** Owner login stays inside the central origin. No native bridge or collector-token injection. */
class CentralActivity : MoteActivity() {
    private lateinit var web: WebView
    private var files: ValueCallback<Array<Uri>>? = null
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
        val body = moteDetailPage()
        val status = TextView(this).apply { text = MoteI18n.text("使用中央所有者令牌登录；离开页面后对话仍在中央继续。") }; body.addView(status)
        UiTask(this).start("", { status.text = it }, { Settings(this).read().also { it.validateConnection() } }) { result ->
            result.onFailure { status.text = it.message }.onSuccess { config ->
                val origin = Uri.parse(config.server)
                fun allowed(uri: Uri) = uri.scheme == origin.scheme && uri.host == origin.host && uri.port == origin.port
                web = WebView(this).apply {
                    settings.javaScriptEnabled = true; settings.domStorageEnabled = true
                    settings.allowFileAccess = false; settings.allowContentAccess = true // Explicit SAF selections returned by the file chooser.
                    settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = !allowed(request.url)
                        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                            if (allowed(request.url)) null else WebResourceResponse("text/plain", "UTF-8", java.io.ByteArrayInputStream(ByteArray(0)))
                        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) { if (request.isForMainFrame) status.text = MoteI18n.text("中央界面加载失败，请检查连接后重试") }
                    }
                    webChromeClient = object : WebChromeClient() {
                        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                            files?.onReceiveValue(null); files = callback
                            return try { startActivityForResult(params.createIntent(), 71); true } catch (_: Exception) { files = null; false }
                        }
                    }
                }
                body.addView(web, LinearLayout.LayoutParams(-1, resources.displayMetrics.heightPixels - moteDp(150)))
                val page = intent.getStringExtra("page").takeIf { it in listOf("ask", "notes", "vault") } ?: "ask"
                web.loadUrl(config.server.trimEnd('/') + "/#" + page)
            }
        }
    }
    @Deprecated("Native document picker")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 71) { files?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data)); files = null }
    }
    override fun onDestroy() { files?.onReceiveValue(null); if (::web.isInitialized) { web.stopLoading(); web.destroy() }; super.onDestroy() }
}
