package dev.mote.collector

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import dev.mote.collector.plugins.SystemEntriesPlugin

/** Minimal card reader owned by the notification bridge. System permission and
 * Notification eligibility never filter this inbox. Full assistant operations belong to
 * the assistant pages; this surface only reads current results. */
class AssistantInboxActivity : MoteActivity() {
    private lateinit var body: LinearLayout
    private lateinit var task: UiTask
    private val handler = Handler(Looper.getMainLooper())
    private var origin = ""
    private var cardId: String? = null
    private var cursor: String? = null
    private var visit = 0L
    private var resumed = false
    private var markRead = false
    private val refresh = object : Runnable {
        override fun run() { if (resumed) { load(); handler.postDelayed(this, 15000) } }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        task = UiTask(this)
        origin = savedInstanceState?.getString("origin") ?: intent.getStringExtra("origin") ?: CentralAccess.resolve(this).server
        cardId = if (savedInstanceState != null) savedInstanceState.getString("cardId") else intent.getStringExtra("cardId")
        cursor = savedInstanceState?.getString("cursor")
        markRead = cardId != null
        body = moteDetailPage(title = MoteI18n.text("通知"), onBack = { if (cardId != null || cursor != null) showInbox() else finish() })
    }
    override fun onNewIntent(next: Intent) {
        super.onNewIntent(next); intent = next
        visit++; origin = next.getStringExtra("origin").orEmpty(); cardId = next.getStringExtra("cardId"); cursor = null; markRead = cardId != null
        body.removeAllViews(); load()
    }
    override fun onResume() { super.onResume(); resumed = true; handler.post(refresh) }
    override fun onPause() {
        resumed = false; visit++; handler.removeCallbacks(refresh); body.removeAllViews(); super.onPause()
    }
    override fun onDestroy() { task.close(); super.onDestroy() }
    override fun onSaveInstanceState(state: Bundle) {
        state.putString("origin", origin); state.putString("cardId", cardId); state.putString("cursor", cursor)
        super.onSaveInstanceState(state)
    }
    private fun showInbox() { visit++; cardId = null; cursor = null; markRead = false; body.removeAllViews(); load() }
    private fun button(label: String, action: () -> Unit) {
        body.addView(Button(this).apply { text = MoteI18n.text(label); setOnClickListener { action() } })
    }
    private fun load() {
        if (!resumed || task.busy) return
        val version = visit; val selected = CentralAccess.resolve(this); val id = cardId; val after = cursor; val read = markRead
        val availability = SystemEntriesPlugin.availability(this)
        if (!availability.active || selected.server != origin || selected.client == null || id != null && MoteLink.uuidId(id) == null) {
            body.removeAllViews()
            SecondaryUi.text(body, when {
                !availability.active -> availability.reason.orEmpty()
                selected.client == null -> MoteI18n.text("先登录中央，各页面会共用这次登录")
                selected.server != origin -> MoteI18n.text("登录会话已变更，请重新打开中央页面。")
                else -> MoteI18n.text("请求的资源不存在或已删除。")
            }); return
        }
        task.start("", {}, {
            val reader = AssistantNotificationReader(selected.client)
            if (id == null) reader.page(after) else reader.card(id, read)
        }) { result ->
            if (!resumed || version != visit) { if (resumed) load(); return@start }
            body.removeAllViews()
            val current = CentralAccess.resolve(this)
            if (current.server != origin || current.generation != selected.generation || current.client == null || !SystemEntriesPlugin.availability(this).active) {
                SecondaryUi.text(body, MoteI18n.text("登录会话已变更，请重新打开中央页面。")); return@start
            }
            button("刷新") { load() }
            result.onSuccess { value ->
                when (value) {
                    is AssistantCardPreview -> {
                        markRead = false
                        button("返回") { showInbox() }
                        SecondaryUi.text(body, value.title, heading = true)
                        SecondaryUi.text(body, value.body).setTextIsSelectable(true)
                    }
                    is AssistantNotificationReader.Page -> {
                        if (value.items.isEmpty()) SecondaryUi.text(body, MoteI18n.text("暂无记录"))
                        value.items.forEach { card -> SecondaryUi.row(body, card.title, "") {
                            visit++; cardId = card.id; markRead = true; body.removeAllViews(); load()
                        } }
                        value.nextCursor?.let { next -> button("加载更多") { visit++; cursor = next; body.removeAllViews(); load() } }
                        if (cursor != null) button("返回") { showInbox() }
                    }
                }
            }.onFailure { error -> SecondaryUi.text(body, if (error is CentralFailure) error.message.orEmpty() else MoteI18n.text("连接暂时中断，请检查网络。")) }
            MoteUi.styleTree(body)
        }
    }
}
