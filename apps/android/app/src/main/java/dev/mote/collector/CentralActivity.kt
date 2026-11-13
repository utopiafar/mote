package dev.mote.collector

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import dev.mote.collector.plugins.AssistantPlugin

/** Compatibility host for central deep links; primary Ask lives in MainActivity. */
open class CentralActivity : MoteActivity() {
    private lateinit var content: CentralContent
    internal val client get() = content.client
    internal val isWorking get() = content.isWorking
    internal val selectedAskConversationId get() = content.selectedAskConversationId
    internal fun navigate(page: String) = content.navigate(page)

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        applyLinkExtra(intent)
        content = CentralContent(this, state, intent.getStringExtra("page") ?: "ask")
        if (state == null) intent.getStringExtra("insightId")?.let(content::openInsight)
        content.root.moteInsets()
        setContentView(content.root)
        content.takeLinkNotice()
        if (state == null && intent.getBooleanExtra("featureGuide", false)) content.showFeatureGuide()
        if (android.os.Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { navigateBack() }
    }
    override fun onResume() { super.onResume(); content.resume() }
    override fun onPause() { content.pause(); super.onPause() }
    override fun onDestroy() { content.close(); super.onDestroy() }
    override fun onSaveInstanceState(state: Bundle) { content.saveState(state); super.onSaveInstanceState(state) }
    override fun onNewIntent(next: Intent) { super.onNewIntent(next); intent = next; applyLinkExtra(next); content.captureAskConversationIntent();next.getStringExtra("insightId")?.let(content::openInsight) ?: next.getStringExtra("page")?.let(content::navigate); content.takeLinkNotice() }

    /** A canonical `link` extra resolves through the shared deep-link schema
     * and lands on the existing guarded extras; foreign, revoked and deleted
     * links carry no destination instead of retargeting another object. A
     * refused or malformed link is shown as an explicit page notice. */
    private fun applyLinkExtra(next: Intent) {
        val raw = next.getStringExtra("link") ?: return
        next.removeExtra("link")
        AssistantPlugin.ensure(this)
        val host = (application as? MoteApplication)?.pluginHost
        when (val outcome = MoteLinkNavigation.open(host, raw, CentralAccess.resolve(this).server)) {
            is MoteLinkNavigation.Outcome.Open -> {
                val destination = outcome.destination
                if (destination is MoteLink.Destination.Extras) {
                    next.putExtra("page", destination.page)
                    destination.conversationId?.let { next.putExtra("conversationId", it) }
                    destination.evidenceId?.let { next.putExtra("evidenceId", it); next.putExtra("evidenceOrigin", MoteLink.parse(raw)?.scope?.origin) }
                }
            }
            is MoteLinkNavigation.Outcome.Refused -> next.putExtra("linkNotice", outcome.reason.messageKey)
        }
    }
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Deprecated("Native back navigation") override fun onBackPressed() { navigateBack() }
    private fun navigateBack() { if (!content.back()) finish() }
    @Deprecated("Native document picker") override fun onActivityResult(request: Int, result: Int, data: Intent?) {
        super.onActivityResult(request, result, data); content.activityResult(request, result, data)
    }
}
