package dev.mote.collector

import android.annotation.SuppressLint
import android.app.Activity
import android.content.MutableContextWrapper
import android.net.Uri
import android.webkit.*

/** One central browsing session per app process. No collector credential or native JS bridge. */
internal object CentralWebSession {
    private var origin = ""
    private var view: WebView? = null
    private var context: MutableContextWrapper? = null
    private var reloadRequired = false

    @SuppressLint("SetJavaScriptEnabled")
    fun acquire(activity: Activity, server: String): WebView {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper())
        val next = server.trimEnd('/')
        if (view != null && origin != next) {
            val old = requireNotNull(view)
            (old.parent as? android.view.ViewGroup)?.removeView(old)
            old.stopLoading(); old.destroy(); view = null; context = null; reloadRequired = false
        }
        origin = next
        val wrapper = context ?: MutableContextWrapper(activity).also { context = it }
        wrapper.baseContext = activity
        val web = view ?: WebView(wrapper).apply {
            settings.javaScriptEnabled = true; settings.domStorageEnabled = true
            settings.allowFileAccess = false; settings.allowContentAccess = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            webViewClient = CentralOriginClient(Uri.parse(next))
        }.also { view = it }
        (web.parent as? android.view.ViewGroup)?.removeView(web)
        web.onResume()
        return web
    }

    fun failed(web: WebView) { if (web === view) reloadRequired = true }
    fun navigate(web: WebView, destination: String) {
        if (web.url != destination || reloadRequired) {
            reloadRequired = false
            web.loadUrl(destination)
        }
    }

    fun release(web: WebView) {
        if (web !== view) return
        if (web.progress < 100) reloadRequired = true
        (web.parent as? android.view.ViewGroup)?.removeView(web)
        web.stopLoading(); web.onPause()
        web.webChromeClient = null
        web.webViewClient = CentralOriginClient(Uri.parse(origin))
        context?.let { it.baseContext = it.applicationContext }
        // Keep the document and sessionStorage. Returning from a native page shares
        // the same login; process death still ends a window-scoped session.
    }
}

internal class CentralOriginClient(private val origin: Uri, private val onError: () -> Unit = {}) : WebViewClient() {
    private fun allowed(uri: Uri) = uri.scheme == origin.scheme && uri.host == origin.host && uri.port == origin.port
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = !allowed(request.url)
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
        if (allowed(request.url)) null else WebResourceResponse("text/plain", "UTF-8", java.io.ByteArrayInputStream(ByteArray(0)))
    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) onError()
    }
}
