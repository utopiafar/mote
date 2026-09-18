package dev.mote.collector

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.WindowManager
import android.widget.*
import org.json.JSONObject
import java.util.UUID

/** Native controls only. Captured evidence and model output are always plain text. */
class AskActivity : MoteActivity() {
    private val task by lazy { UiTask(this) }
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var messages: LinearLayout
    private lateinit var history: LinearLayout
    private lateinit var question: EditText
    private lateinit var token: EditText
    private lateinit var status: TextView
    private lateinit var send: Button
    private lateinit var stop: Button
    private lateinit var newChat: Button
    private lateinit var more: Button
    private var ownerToken = ""
    private var signedOut = false
    private var origin = ""
    private var conversationId: String? = null
    private var run: JSONObject? = null
    private var cursor: String? = null
    private var pendingAdmission: JSONObject? = null
    private var resumed = false
    private val poll = Runnable { if (resumed && run != null && !task.busy) refreshRun() }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val body = moteDetailPage()
        fun label(value: String) = TextView(this).apply { text = MoteI18n.text(value); textSize = 16f; setPadding(0, moteDp(8), 0, moteDp(8)) }.also(body::addView)
        fun button(value: String, action: () -> Unit) = Button(this).apply { text = MoteI18n.text(value); setOnClickListener { action() } }.also(body::addView)
        label("问一问").textSize = 28f
        label("直接连接中央归档；离开页面后回答仍继续。")
        status = label("")
        token = EditText(this).apply { hint = MoteI18n.text("中央所有者令牌（设备凭据没有问答权限）"); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; setSingleLine(); isSaveEnabled = false }; body.addView(token)
        button("登录问答（仅本次会话）") {
            if (task.busy) return@button
            val value = token.text.toString().trim(); token.setText("")
            if (value.length !in 32..8192 || value.contains('\n') || value.contains('\r')) { status.text = MoteI18n.text("请输入有效的中央所有者令牌"); return@button }
            ownerToken = value; signedOut = false; conversationId = null; run = null; messages.removeAllViews(); refresh()
        }
        button("退出问答登录") { if (!task.busy) { ownerToken = ""; signedOut = true; run = null; conversationId = null; messages.removeAllViews(); history.removeAllViews(); handler.removeCallbacks(poll); status.text = MoteI18n.text("已退出问答登录"); controls() } }
        button("刷新对话历史") { refresh() }
        newChat = button("新对话") { if (!task.busy && run?.optString("status") != "running") { conversationId = null; run = null; messages.removeAllViews(); status.text = ""; controls() } }
        history = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(history)
        more = button("加载更早的对话") { loadHistory(true) }; more.visibility = android.view.View.GONE
        messages = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(messages)
        question = EditText(this).apply { hint = MoteI18n.text("你的问题"); minLines = 3; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE; filters = arrayOf(android.text.InputFilter.LengthFilter(8000)); isSaveEnabled = false }; body.addView(question)
        send = button("发送") { submit() }
        stop = button("停止回答") { val id = run?.optString("id") ?: return@button; work({ request("POST", "/api/query-runs/$id/cancel", JSONObject()) }) { value -> run = value; renderRun(); schedulePoll() } }
        MoteUi.styleTree(body); controls(); refresh()
    }
    private fun request(method: String, path: String, body: JSONObject? = null): JSONObject {
        check(!signedOut) { MoteI18n.text("问一问需要有效的中央所有者令牌，请登录。") }
        val config = Settings(applicationContext).read(); config.validateConnection()
        if (origin.isEmpty()) origin = config.server
        check(origin == config.server) { MoteI18n.text("中央节点已改变，请关闭问答后重新打开。") }
        val (code, result) = HttpJson.request(method, config.server + path, body, ownerToken.ifBlank { config.token }, maxResponseBytes = 8 * 1024 * 1024)
        check(code in 200..299) { if (code == 401 || code == 403) MoteI18n.text("问一问需要有效的中央所有者令牌，请登录。") else MoteI18n.text("问答请求失败（HTTP {0}），请检查中央节点模型设置或稍后重试。", code) }
        return requireNotNull(result) { MoteI18n.text("中央节点响应无效") }
    }
    private fun <T> work(action: () -> T, done: (T) -> Unit) {
        if (task.busy) return
        task.start(MoteI18n.text("正在连接中央节点…"), { status.text = it }, { action() }) { result ->
            result.onSuccess(done).onFailure { status.text = (it.message ?: MoteI18n.text("请求失败")) + "\n" + MoteI18n.text("请刷新检查结果，避免重复发送。") }
            controls()
        }
        controls()
    }
    private fun refresh() = work({ request("GET", "/api/conversations?limit=30") to request("GET", "/api/query-runs") }) { (page, runs) ->
        renderHistory(page, false)
        val items = runs.getJSONArray("items")
        for (i in 0 until items.length()) { val item = items.getJSONObject(i); if (item.optString("status") == "running") { run = item; break } }
        renderRun(); schedulePoll()
    }
    private fun loadHistory(append: Boolean) = work({ request("GET", "/api/conversations?limit=30" + if (append && cursor != null) "&cursor=" + java.net.URLEncoder.encode(cursor, "UTF-8") else "") }) { renderHistory(it, append) }
    private fun renderHistory(page: JSONObject, append: Boolean) {
        if (!append) history.removeAllViews()
        val items = page.getJSONArray("items")
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            history.addView(Button(this).apply {
                text = item.getString("title")
                setOnClickListener { if (!task.busy && run?.optString("status") != "running") {
                    run = null; conversationId = null; messages.removeAllViews()
                    work({ request("GET", "/api/conversations/" + item.getString("id")) }) { renderConversation(it) }
                } }
            })
        }
        cursor = page.optString("nextCursor").takeIf { it.isNotBlank() && it != "null" }; more.visibility = if (cursor == null) android.view.View.GONE else android.view.View.VISIBLE
    }
    private fun renderConversation(value: JSONObject) {
        conversationId = value.getString("id"); messages.removeAllViews()
        val turns = value.getJSONArray("turns")
        for (i in 0 until turns.length()) {
            val turn = turns.getJSONObject(i); val result = turn.optJSONObject("result")
            messages.addView(TextView(this).apply { text = turn.getString("question"); textSize = 18f; setTypeface(null, android.graphics.Typeface.BOLD); setPadding(0, moteDp(16), 0, moteDp(8)); setTextIsSelectable(true) })
            messages.addView(TextView(this).apply { text = result?.optString("answer") ?: turn.optJSONObject("error")?.optString("message") ?: MoteI18n.text("回答未完成"); textSize = 16f; setTextIsSelectable(true) })
            val citations = result?.optJSONArray("citations") ?: continue
            for (j in 0 until citations.length()) {
                val citation = citations.getJSONObject(j)
                messages.addView(TextView(this).apply { text = "${citation.optString("appName")} · ${citation.optString("capturedAt")}\n${citation.optString("id")}\n${citation.optString("excerpt")}"; textSize = 13f; setPadding(0, moteDp(8), 0, moteDp(8)); setTextIsSelectable(true) })
            }
        }
    }
    private fun submit() {
        if (task.busy || run?.optString("status") == "running") return
        val text = question.text.toString().trim(); if (text.isBlank()) return
        val input = JSONObject().put("question", text).put("timeZone", java.util.TimeZone.getDefault().id)
        conversationId?.let { input.put("conversationId", it) }
        val body = pendingAdmission?.takeIf { it.getJSONObject("input").toString() == input.toString() } ?: JSONObject().put("id", UUID.randomUUID().toString()).put("input", input)
        pendingAdmission = body
        work({ try { request("POST", "/api/query-runs", body) } catch (_: java.io.IOException) { request("POST", "/api/query-runs", body) } }) {
            pendingAdmission = null; run = it; question.setText(""); renderRun(); schedulePoll()
        }
    }
    private fun refreshRun() {
        val id = run?.optString("id") ?: return
        work({
            val value = request("GET", "/api/query-runs/$id")
            val conversation = value.optString("conversationId").takeIf { it.isNotBlank() && it != "null" && value.optString("status") != "running" }?.let { request("GET", "/api/conversations/$it") }
            value to conversation
        }) { (value, conversation) -> run = value; conversation?.let(::renderConversation); renderRun(); if (value.optString("status") == "running") schedulePoll() }
    }
    private fun renderRun() {
        status.text = when (run?.optString("status")) {
            "running" -> run?.optJSONArray("events")?.let { events -> if (events.length() > 0) events.getJSONObject(events.length() - 1).optString("message").ifBlank { MoteI18n.text("中央节点正在回答…") } else MoteI18n.text("中央节点正在回答…") }
            "completed" -> MoteI18n.text("回答已完成")
            "cancelled" -> MoteI18n.text("已停止回答")
            "failed" -> run?.optJSONObject("error")?.optString("message") ?: MoteI18n.text("回答未完成")
            else -> MoteI18n.text("请选择历史对话或开始提问")
        }
        controls()
    }
    private fun controls() {
        if (!::send.isInitialized) return
        val busy = task.busy || run?.optString("status") == "running"
        send.isEnabled = !busy; newChat.isEnabled = !busy; stop.visibility = if (run?.optString("status") == "running") android.view.View.VISIBLE else android.view.View.GONE; stop.isEnabled = !task.busy
        for (i in 0 until history.childCount) history.getChildAt(i).isEnabled = !busy
    }
    private fun schedulePoll() { handler.removeCallbacks(poll); if (resumed) handler.postDelayed(poll, 1000) }
    override fun onResume() { super.onResume(); resumed = true; schedulePoll() }
    override fun onPause() { resumed = false; handler.removeCallbacks(poll); super.onPause() }
    override fun onDestroy() { handler.removeCallbacks(poll); ownerToken = ""; super.onDestroy() }
}
