package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.*
import java.io.File

/** Central content uses Android Views. Captured content is never executable. */
open class CentralActivity : MoteActivity() {
    private val task by lazy { UiTask(this) }
    private val handler = Handler(Looper.getMainLooper())
    private val session by lazy { CentralSession.get(this) }
    private lateinit var body: LinearLayout
    private lateinit var status: TextView
    private lateinit var title: TextView
    private lateinit var navigation: LinearLayout
    internal var client: CentralClient? = null; private set
    internal var server = ""; private set
    internal val isWorking get() = task.busy || pending.isNotEmpty()
    internal val navigationRevision get() = revision
    private var page = "ask"
    @Volatile private var revision = 0L
    private var resumed = false
    private val pending = java.util.ArrayDeque<Pair<Long, () -> Unit>>()
    private var screens: CentralScreens? = null
    private var pickerOrigin: String? = null
    private var pickerChat = false
    private var pickerGeneration = -1L
    private var pickerInstruction = ""
    private var downloadPath: String? = null
    private var downloadOrigin: String? = null
    private var downloadGeneration = -1L
    private val refreshRun = Runnable { if (resumed && page == "ask") screens?.pollAsk() }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        page = state?.getString("centralPage") ?: intent.getStringExtra("page") ?: "ask"
        pickerOrigin = state?.getString("pickerOrigin"); pickerChat = state?.getBoolean("pickerChat") ?: false
        pickerGeneration = state?.getLong("pickerGeneration") ?: -1L
        pickerInstruction = state?.getString("pickerInstruction").orEmpty()
        downloadPath = state?.getString("downloadPath"); downloadOrigin = state?.getString("downloadOrigin")
        downloadGeneration = state?.getLong("downloadGeneration") ?: -1L
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(MoteUi.background); moteInsets() }
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(moteDp(12), 0, moteDp(12), 0) }
        header.addView(Button(this).apply { text = MoteI18n.text("返回"); setOnClickListener { navigateBack() } })
        title = TextView(this).apply { textSize = 21f; setTextColor(MoteUi.ink) }
        header.addView(title, LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(Button(this).apply { text = MoteI18n.text("更多"); setOnClickListener { more() } })
        root.addView(header)
        status = TextView(this).apply {
            tag = "central-status"
            setTextColor(MoteUi.muted); setPadding(moteDp(20), moteDp(8), moteDp(20), moteDp(8))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }; root.addView(status)
        val scroll = ScrollView(this).apply { isFillViewport = true }
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(20), moteDp(12), moteDp(20), moteDp(24)) }
        scroll.addView(body); root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        navigation = LinearLayout(this).apply { gravity = Gravity.CENTER; setPadding(moteDp(4), 0, moteDp(4), 0) }
        listOf("overview" to "中央工作台", "archive" to "中央资料库", "ask" to "问一问", "notes" to "随手记").forEach { (id, label) ->
            navigation.addView(Button(this).apply { text = MoteI18n.text(label); textSize = 12f; setOnClickListener { navigate(id) } }, LinearLayout.LayoutParams(0, -2, 1f))
        }; root.addView(navigation)
        setContentView(root); MoteUi.styleTree(header); MoteUi.styleTree(navigation)
        if (android.os.Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { navigateBack() }
    }

    override fun onResume() {
        super.onResume(); resumed = true
        work(MoteI18n.text("正在读取本机设置…"), { CentralAccess.resolve(this) }) { selected ->
            val endpoint = selected.server
            if (endpoint.isBlank()) {
                server = ""; client = null; body.removeAllViews(); navigation.visibility = View.GONE
                title.text = MoteI18n.text("中央节点")
                text(MoteI18n.text("先在连接设置选择中央节点，再登录中央管理页面。"))
                connectionButton()
                return@work
            }
            val changed = server != endpoint
            val authenticated = client == null && selected.client != null
            server = endpoint; client = selected.client
            navigation.visibility = if (client != null) View.VISIBLE else View.GONE
            if (changed || screens == null) screens = CentralScreens(this, body, File(noBackupFilesDir, "central-native/" + SourceRules.hash(endpoint)))
            if (client == null) { screens?.clearPrivateState(); login() }
            else if (changed || authenticated || body.childCount == 0) navigate(page) else if (page == "ask") scheduleAskPoll()
        }
    }
    override fun onPause() { resumed = false; handler.removeCallbacks(refreshRun); screens?.close(); super.onPause() }
    override fun onDestroy() { handler.removeCallbacks(refreshRun); pending.clear(); screens?.close(); super.onDestroy() }
    override fun onSaveInstanceState(state: Bundle) {
        state.putString("centralPage", page); state.putString("pickerOrigin", pickerOrigin); state.putBoolean("pickerChat", pickerChat)
        state.putLong("pickerGeneration", pickerGeneration); state.putString("downloadPath", downloadPath)
        state.putString("pickerInstruction", pickerInstruction)
        state.putString("downloadOrigin", downloadOrigin); state.putLong("downloadGeneration", downloadGeneration)
        super.onSaveInstanceState(state)
    }
    // Android 13+ uses the callback registered above; this handles Android 10–12.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Deprecated("Native back navigation") override fun onBackPressed() { navigateBack() }
    private fun navigateBack() { if (screens?.back() != true) finish() }

    internal fun navigate(next: String) {
        page = next; revision++; pending.clear(); handler.removeCallbacks(refreshRun); screens?.close(); body.removeAllViews()
        title.text = CentralScreens.pages.firstOrNull { it.first == next }?.second?.let { MoteI18n.text(it) } ?: MoteI18n.text("中央资料库")
        if (client == null) { login(); return }
        screens?.show(next)
    }
    private fun more() {
        val entries = CentralScreens.pages + listOf("logout" to "退出登录")
        MoteDialogBuilder(this).setTitle(MoteI18n.text("中央节点")).setItems(entries.map { MoteI18n.text(it.second) }.toTypedArray()) { _, index ->
            val next = entries[index].first
            if (next == "logout") work(MoteI18n.text("正在退出登录…"), { runCatching { session.signOut() } }) { result ->
                client = null; revision++; screens?.clearPrivateState(); login()
                result.exceptionOrNull()?.let { notice(it.message ?: MoteI18n.text("操作失败")) }
            }
            else navigate(next)
        }.setNegativeButton(MoteI18n.text("关闭"), null).show()
    }
    private fun connectionButton() = button(MoteI18n.text("连接设置")) {
        startActivity(Intent(this, MainActivity::class.java).putExtra("page", "CONNECTION").putExtra("returnToCentral", true))
    }
    private fun login() {
        revision++; body.removeAllViews(); navigation.visibility = View.GONE; title.text = MoteI18n.text("登录中央节点")
        text(server); text(MoteI18n.text("各中央页面共用此登录。设备配对仅用于采集同步，不授予中央管理权限。"))
        val credential = field(MoteI18n.text("中央管理令牌"), password = true)
        text(MoteI18n.text("登录会话有效期"))
        val lifetime = Spinner(this).apply {
            adapter = ArrayAdapter(this@CentralActivity, android.R.layout.simple_spinner_dropdown_item,
                listOf(MoteI18n.text("本次应用会话"), MoteI18n.text("1 天"), MoteI18n.text("7 天"), MoteI18n.text("30 天")))
        }; body.addView(lifetime)
        button(MoteI18n.text("登录并继续"), true) {
            val token = credential.text.toString().trim()
            val duration = listOf(0L, 86400000L, 7 * 86400000L, 30 * 86400000L)[lifetime.selectedItemPosition]
            val origin = server; val generation = session.generation; credential.setText("")
            work(MoteI18n.text("正在验证令牌…"), {
                require(token.length in 32..8192 && token.none { it == '\r' || it == '\n' }) { MoteI18n.text("请输入有效的中央所有者令牌") }
                CentralClient(origin, token).get("/api/configuration")
                session.signIn(origin, token, duration, generation)
            }) { client = session.client(origin); navigation.visibility = View.VISIBLE; navigate(page) }
        }
        connectionButton()
    }

    internal fun text(value: String, size: Float = 15f, parent: LinearLayout = body): TextView = TextView(this).apply {
        text = value; textSize = size; setTextColor(MoteUi.ink); setTextIsSelectable(true); setPadding(0, moteDp(8), 0, moteDp(8))
    }.also(parent::addView)
    internal fun button(label: String, primary: Boolean = false, parent: LinearLayout = body, action: () -> Unit): Button = MoteUi.button(Button(this).apply {
        text = label; setOnClickListener { if (!task.busy) runCatching(action).onFailure { notice(it.message ?: MoteI18n.text("操作失败")) } }
    }, primary).also { parent.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(8) }) }
    internal fun field(label: String, value: String = "", multiline: Boolean = false, password: Boolean = false, parent: LinearLayout = body): EditText {
        text(label, 13f, parent)
        return MoteUi.field(EditText(this).apply {
            hint = label; contentDescription = label; setText(value); isSaveEnabled = false
            MoteUi.textInput(this, InputType.TYPE_CLASS_TEXT or if (password) InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_FLAG_CAP_SENTENCES, multiline)
        }).also(parent::addView)
    }
    internal fun card(parent: LinearLayout = body): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; background = MoteUi.shape(this@CentralActivity, android.graphics.Color.WHITE, 16, true)
        setPadding(moteDp(14), moteDp(10), moteDp(14), moteDp(10))
    }.also { parent.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(12) }) }
    internal fun notice(message: String) { status.text = message }
    internal fun enterDetail() { revision++; pending.clear(); handler.removeCallbacks(refreshRun) }
    internal fun requestFailure(error: Throwable, generation: Long = session.generation) {
        status.text = error.message ?: MoteI18n.text("操作失败")
        if (client == null && body.childCount == 0) {
            button(MoteI18n.text("重试")) { recreate() }; connectionButton()
        }
        if (error is CentralFailure && error.status == 401 && error.code in setOf("", "unauthorized")) {
            work(MoteI18n.text("正在退出登录…"), { session.signOut(generation) }) { client = null; screens?.clearPrivateState(); login(); notice(error.message.orEmpty()) }
        } else if (page == "ask") scheduleAskPoll(5000)
    }
    internal fun scheduleAskPoll(delay: Long = 1500) { handler.removeCallbacks(refreshRun); if (resumed && page == "ask") handler.postDelayed(refreshRun, delay) }
    internal fun <T> work(label: String, job: (UiTask.Progress) -> T, done: (T) -> Unit) {
        if (task.busy) { pending.add(revision to { work(label, job, done) }); return }
        val version = revision
        val generation = session.generation
        val inputs = mutableListOf<View>()
        fun lock(view: View) {
            if (view is EditText || view is Spinner || view is CheckBox) { if (view.isEnabled) { inputs.add(view); view.isEnabled = false } }
            if (view is android.view.ViewGroup) for (i in 0 until view.childCount) lock(view.getChildAt(i))
        }; lock(body)
        task.start(label, { status.text = it }, job) { result ->
            inputs.forEach { it.isEnabled = true }
            if (version == revision) {
                result.onSuccess { status.text = ""; runCatching { done(it) }.onFailure { error -> status.text = error.message ?: MoteI18n.text("操作失败") } }
                    .onFailure { error ->
                        requestFailure(error, generation)
                    }
            }
            while (pending.isNotEmpty()) { val next = pending.removeFirst(); if (next.first == revision) { next.second.invoke(); break } }
        }
    }
    internal fun pickAttachment(chat: Boolean = false) {
        pickerOrigin = server; pickerChat = chat; pickerGeneration = session.generation
        val picker = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(if (chat) "image/*" else "*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, if (chat) arrayOf("image/png", "image/jpeg", "image/webp") else arrayOf("image/*", "audio/*"))
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        @Suppress("DEPRECATION") startActivityForResult(picker, 71)
    }
    internal fun saveCentral(path: String, name: String, mime: String) {
        downloadPath = path; downloadOrigin = server; downloadGeneration = session.generation
        @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime).putExtra(Intent.EXTRA_TITLE, name), 72)
    }
    internal fun pickImport() {
        pickerOrigin = server; pickerGeneration = session.generation
        pickerInstruction = screens?.importInstruction.orEmpty()
        @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*"), 73)
    }
    @Deprecated("Native document picker") override fun onActivityResult(request: Int, result: Int, data: Intent?) {
        super.onActivityResult(request, result, data)
        if (result != Activity.RESULT_OK || data == null) return
        if (request == 72) {
            val uri = data.data ?: return; val path = downloadPath ?: return
            val origin = downloadOrigin; val generation = downloadGeneration; downloadPath = null
            work(MoteI18n.text("正在导出中央资料…"), {
                val selected = CentralAccess.resolve(this)
                check(selected.server == origin && session.generation == generation) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
                val api = requireNotNull(selected.client)
                requireNotNull(contentResolver.openOutputStream(uri, "wt")).use { api.download(path, it) }
            }) { notice(MoteI18n.text("资料已导出")) }; return
        }
        if (request !in setOf(71, 73)) return
        val origin = pickerOrigin; val chat = pickerChat; pickerOrigin = null
        val uris = data.clipData?.let { clip -> (0 until clip.itemCount).map { clip.getItemAt(it).uri } } ?: listOfNotNull(data.data)
        if (origin != server || client == null || pickerGeneration != session.generation) { notice(MoteI18n.text("登录会话已变更，请重新打开中央页面。")); return }
        if (request == 73) uris.firstOrNull()?.let { screens?.importInstruction = pickerInstruction; screens?.importFile(it) }
        else screens?.addAttachments(uris, chat)
    }
}
