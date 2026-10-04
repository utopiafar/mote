package dev.mote.collector

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager

/** Compatibility host for central deep links; primary Ask lives in MainActivity. */
open class CentralActivity : MoteActivity() {
    private lateinit var content: CentralContent
    internal val client get() = content.client
    internal val isWorking get() = content.isWorking
    internal fun navigate(page: String) = content.navigate(page)

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        content = CentralContent(this, state, intent.getStringExtra("page") ?: "ask")
        content.root.moteInsets()
        setContentView(content.root)
        if (android.os.Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { navigateBack() }
    }
    override fun onResume() { super.onResume(); content.resume() }
    override fun onPause() { content.pause(); super.onPause() }
    override fun onDestroy() { content.close(); super.onDestroy() }
    override fun onSaveInstanceState(state: Bundle) { content.saveState(state); super.onSaveInstanceState(state) }
    override fun onNewIntent(next: Intent) { super.onNewIntent(next); intent = next; next.getStringExtra("page")?.let(content::navigate) }
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Deprecated("Native back navigation") override fun onBackPressed() { navigateBack() }
    private fun navigateBack() { if (!content.back()) finish() }
    @Deprecated("Native document picker") override fun onActivityResult(request: Int, result: Int, data: Intent?) {
        super.onActivityResult(request, result, data); content.activityResult(request, result, data)
    }
}
