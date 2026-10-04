package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.content.ContextWrapper
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.*
import java.io.File

/** Reusable native central content. The host owns the window and primary navigation. */
internal class CentralContent(
    private val activity: MoteActivity,
    state: Bundle?,
    initialPage: String = "ask",
    private val openLocalPage: ((String) -> Unit)? = null,
) : ContextWrapper(activity) {
    val root: LinearLayout
    private lateinit var backButton: TextView
    val isDestroyed get() = activity.isDestroyed
    val isFinishing get() = activity.isFinishing
    fun recreate() = activity.recreate()
    private fun localPage(page: String) { openLocalPage?.invoke(page) ?: activity.openMoteLocalPage(page) }
    private val task by lazy { UiTask(activity) }
    private val handler = Handler(Looper.getMainLooper())
    private val session by lazy { CentralSession.get(this) }
    private lateinit var body: LinearLayout
    private lateinit var status: TextView
    private lateinit var title: TextView
    private var navigation: MotePrimaryNavigation? = null
    private lateinit var collectionBar: LinearLayout
    private val pageHistory = mutableListOf<String>()
    internal var client: CentralClient? = null; private set
    internal var server = ""; private set
    internal val isWorking get() = task.busy || pending.isNotEmpty()
    internal val navigationRevision get() = revision
    private var page = "ask"
    @Volatile private var revision = 0L
    private var resumed = false
    private var accessReady = false
    private var pendingResult: Triple<Int, Int, Intent?>? = null
    private val pending = java.util.ArrayDeque<Pair<Long, () -> Unit>>()
    private var browserLoginId: String? = null
    private var browserVerifier: String? = null
    private var browserGeneration = -1L
    private var browserDurationMs = 2592000000L
    private var screens: CentralScreens? = null
    private var pickerOrigin: String? = null
    private var pickerChat = false
    private var pickerGeneration = -1L
    private var pickerInstruction = ""
    private var downloadPath: String? = null
    private var downloadOrigin: String? = null
    private var downloadGeneration = -1L
    private val refreshRun = Runnable { if (resumed && page == "ask") screens?.pollAsk() }

    private val refreshLogin = object : Runnable {
        override fun run() {
            if (!resumed) return
            if (client != null && Settings(this@CentralContent).read().connectionToken().isBlank()) {
                client = null; screens?.close(); screens?.clearPrivateState(); login()
            }
            handler.postDelayed(this, 1000)
        }
    }

    init {
        browserLoginId = state?.getString("browserLoginId"); browserVerifier = state?.getString("browserVerifier"); browserGeneration = state?.getLong("browserGeneration") ?: -1L
        browserDurationMs = state?.getLong("browserDurationMs", 2592000000L) ?: 2592000000L
        page = state?.getString("centralPage") ?: initialPage
        pageHistory.addAll(state?.getStringArrayList("pageHistory").orEmpty())
        pickerOrigin = state?.getString("pickerOrigin"); pickerChat = state?.getBoolean("pickerChat") ?: false
        pickerGeneration = state?.getLong("pickerGeneration") ?: -1L
        pickerInstruction = state?.getString("pickerInstruction").orEmpty()
        downloadPath = state?.getString("downloadPath"); downloadOrigin = state?.getString("downloadOrigin")
        downloadGeneration = state?.getLong("downloadGeneration") ?: -1L
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(MoteUi.background) }
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; tag = "central-header"; setPadding(moteDp(12), 0, moteDp(12), 0) }
        backButton = TextView(this).apply {
            text = "‹"; contentDescription = MoteI18n.text("返回上一页"); textSize = 28f; gravity = Gravity.CENTER
            isFocusable = true; minHeight = moteDp(48); setOnClickListener { if (!back()) { if (openLocalPage != null) localPage("OVERVIEW") else activity.finish() } }
        }
        header.addView(backButton, LinearLayout.LayoutParams(moteDp(44), -2))
        title = TextView(this).apply { tag = "central-title"; textSize = 20f; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; setTextColor(MoteUi.ink) }
        header.addView(title, LinearLayout.LayoutParams(0, -2, 1f))
        fun headerAction(label: String, description: String = label, action: () -> Unit) {
            header.addView(TextView(this).apply {
                text = MoteI18n.text(label); contentDescription = MoteI18n.text(description); textSize = 13f; gravity = Gravity.CENTER
                isFocusable = true; minHeight = moteDp(48); background = MoteUi.clickable(this@CentralContent, MoteUi.tint, 12)
                setOnClickListener { action() }
            }, LinearLayout.LayoutParams(moteDp(56), -2).apply { marginStart = moteDp(4) })
        }
        headerAction("记录", "写一条随手记") { localPage("NOTES") }
        headerAction("更多") { more() }
        root.addView(header)
        status = TextView(this).apply {
            tag = "central-status"
            setTextColor(MoteUi.muted); setPadding(moteDp(20), moteDp(8), moteDp(20), moteDp(8))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }; root.addView(status)
        collectionBar = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(20), 0, moteDp(20), moteDp(8)) }
        root.addView(collectionBar)
        val scroll = ScrollView(this).apply { isFillViewport = true }
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(20), moteDp(12), moteDp(20), moteDp(24)) }
        scroll.addView(body); root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        if (openLocalPage == null) navigation = MotePrimaryNavigation(activity) { destination ->
            when (destination) {
                MotePrimaryTab.ASK -> { pageHistory.clear(); navigate("ask", remember = false) }
                MotePrimaryTab.LIBRARY -> { pageHistory.clear(); navigate("archive", remember = false) }
                else -> activity.openMotePrimary(destination)
            }
        }
        navigation?.let(root::addView)
        MoteUi.styleTree(header); navigation?.select(MoteNavigation.centralTab(page)); updateBackButton()
    }

    fun resume() {
        resumed = true
        handler.removeCallbacks(refreshLogin); handler.postDelayed(refreshLogin, 1000)
        work(MoteI18n.text("正在读取本机设置…"), { CentralAccess.resolve(this) }) { selected ->
            val endpoint = selected.server
            if (endpoint.isBlank()) {
                server = ""; client = null; body.removeAllViews(); collectionBar.visibility = View.GONE
                title.text = MoteI18n.text("中央节点")
                text(MoteI18n.text("先在连接设置选择中央节点，再登录中央管理页面。"))
                connectionButton()
                deliverPendingResult()
                return@work
            }
            val changed = server != endpoint
            val authenticated = client == null && selected.client != null
            server = endpoint; client = selected.client
            if (changed || screens == null) screens = CentralScreens(this, body, File(noBackupFilesDir, "central-native/" + SourceRules.hash(endpoint)))
            if (client == null) { screens?.clearPrivateState(); login(); if (browserLoginId != null) pollBrowserLogin() }
            else if (changed || authenticated || body.childCount == 0) navigate(page) else if (page == "ask") scheduleAskPoll()
            deliverPendingResult()
        }
    }
    private fun deliverPendingResult() {
        accessReady = true
        pendingResult?.let { (request, result, data) -> pendingResult = null; activityResult(request, result, data) }
    }
    fun pause() { resumed = false; accessReady = false; handler.removeCallbacks(refreshLogin); handler.removeCallbacks(refreshRun); screens?.close() }
    fun close() { pause(); pending.clear() }
    fun saveState(state: Bundle) {
        state.putLong("browserDurationMs", browserDurationMs)
        state.putString("browserLoginId", browserLoginId); state.putString("browserVerifier", browserVerifier); state.putLong("browserGeneration", browserGeneration)
        state.putString("centralPage", page); state.putString("pickerOrigin", pickerOrigin); state.putBoolean("pickerChat", pickerChat)
        state.putStringArrayList("pageHistory", ArrayList(pageHistory))
        state.putLong("pickerGeneration", pickerGeneration); state.putString("downloadPath", downloadPath)
        state.putString("pickerInstruction", pickerInstruction)
        state.putString("downloadOrigin", downloadOrigin); state.putLong("downloadGeneration", downloadGeneration)
    }
    fun back(): Boolean {
        if (screens?.back() == true) { updateBackButton(); return true }
        val previous = if (pageHistory.isNotEmpty()) pageHistory.removeAt(pageHistory.lastIndex) else MoteNavigation.centralParent(page)
        if (previous == null) return false
        navigate(previous, remember = false)
        return true
    }
    private fun updateBackButton() {
        backButton.visibility = if (openLocalPage != null && page == "ask" && pageHistory.isEmpty()) View.GONE else View.VISIBLE
    }

    internal fun navigate(next: String, remember: Boolean = true) {
        if (remember && next != page) pageHistory.add(page)
        page = next; revision++; pending.clear(); handler.removeCallbacks(refreshRun); screens?.close(); body.removeAllViews()
        navigation?.select(MoteNavigation.centralTab(next)); updateCollectionBar(); updateBackButton()
        title.text = CentralScreens.pages.firstOrNull { it.first == next }?.second?.let { MoteI18n.text(it) } ?: MoteI18n.text("中央资料库")
        if (client == null) { login(); return }
        screens?.show(next)
    }
    private fun more() {
        val titles = MoteNavigation.groups.map { MoteI18n.text(it.titleKey) } + MoteI18n.text("退出登录")
        MoteDialogBuilder(this).setTitle(MoteI18n.text("中央资料库")).setItems(titles.toTypedArray()) { _, index ->
            if (index == MoteNavigation.groups.size) work(MoteI18n.text("正在退出登录…"), { runCatching { session.signOut() } }) { result ->
                client = null; revision++; screens?.clearPrivateState(); login()
                result.exceptionOrNull()?.let { notice(it.message ?: MoteI18n.text("操作失败")) }
            }
            else {
                val group = MoteNavigation.groups[index]
                val entries = group.pages.mapNotNull { id -> CentralScreens.pages.find { it.first == id } }
                MoteDialogBuilder(this).setTitle(MoteI18n.text(group.titleKey))
                    .setItems(entries.map { MoteI18n.text(it.second) }.toTypedArray()) { _, position -> navigate(entries[position].first) }
                    .setNegativeButton(MoteI18n.text("返回")) { _, _ -> more() }.show()
            }
        }.setNegativeButton(MoteI18n.text("关闭"), null).show()
    }
    private fun updateCollectionBar() {
        collectionBar.removeAllViews()
        if (client == null || MoteNavigation.centralTab(page) != MotePrimaryTab.LIBRARY) { collectionBar.visibility = View.GONE; return }
        collectionBar.visibility = View.VISIBLE
        val scope = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        scope.addView(TextView(this).apply {
            text = MoteI18n.text("中央资料库"); textSize = 12f; setTextColor(MoteUi.accent)
            background = MoteUi.shape(this@CentralContent, MoteUi.tint, 8); setPadding(moteDp(12), moteDp(8), moteDp(12), moteDp(8))
        }, LinearLayout.LayoutParams(0, -2, 1f))
        scope.addView(MoteUi.button(Button(this).apply { text = MoteI18n.text("本机保留"); setOnClickListener { localPage("LIBRARY") } }))
        collectionBar.addView(scope)
        val entries = MoteNavigation.libraryPages.mapNotNull { id -> CentralScreens.pages.find { it.first == id } }
        collectionBar.addView(Spinner(this).apply {
            contentDescription = MoteI18n.text("资料类型")
            adapter = ArrayAdapter(this@CentralContent, android.R.layout.simple_spinner_dropdown_item, entries.map { MoteI18n.text(it.second) })
            setSelection(entries.indexOfFirst { it.first == page }.coerceAtLeast(0))
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) { if (entries[position].first != page) navigate(entries[position].first) }
            }
        }, LinearLayout.LayoutParams(-1, moteDp(48)))
    }
    private fun connectionButton() = button(MoteI18n.text("连接设置")) {
        if (openLocalPage != null) localPage("CONNECTION")
        else startActivity(Intent(this, MainActivity::class.java).putExtra("page", "CONNECTION").putExtra("returnToCentral", true))
    }
    private fun login() {
        revision++; body.removeAllViews(); collectionBar.visibility = View.GONE; title.text = MoteI18n.text("登录中央节点")
        navigation?.select(MoteNavigation.centralTab(page))
        text(server); text(MoteI18n.text("登录一次即可使用问答、资料库和同步等所有中央功能。"))
        val credential = field(MoteI18n.text("中央管理令牌"), password = true)
        text(MoteI18n.text("登录会话有效期"))
        val lifetime = Spinner(this).apply {
            adapter = ArrayAdapter(this@CentralContent, android.R.layout.simple_spinner_dropdown_item,
                listOf(MoteI18n.text("本次应用会话"), MoteI18n.text("1 天"), MoteI18n.text("7 天"), MoteI18n.text("30 天")))
        }; lifetime.setSelection(3); body.addView(lifetime)
        button(MoteI18n.text("登录并继续"), true) {
            val token = credential.text.toString().trim()
            val duration = listOf(0L, 86400000L, 7 * 86400000L, 30 * 86400000L)[lifetime.selectedItemPosition]
            val origin = server; val generation = session.generation; credential.setText("")
            work(MoteI18n.text("正在验证令牌…"), {
                require(token.length in 32..8192 && token.none { it == '\r' || it == '\n' }) { MoteI18n.text("请输入有效的中央所有者令牌") }
                CentralClient(origin, token).get("/api/configuration")
                val config = Settings(this).read()
                val grant = CentralClient(origin, token).post("/api/login/session", org.json.JSONObject().put("serverUrl", origin).put("deviceId", Settings(this).deviceId)
                    .put("deviceName", config.deviceName).put("platform", "android").put("durationMs", duration))
                session.signIn(origin, grant.getString("token"), duration, generation)
            }) { client = session.client(origin); navigate(page) }
        }
        button(MoteI18n.text("使用浏览器登录")) { beginBrowserLogin(listOf(0L, 86400000L, 604800000L, 2592000000L)[lifetime.selectedItemPosition]) }
        connectionButton()
    }

    private fun beginBrowserLogin(durationMs: Long) {
        val origin = server; val expected = session.generation
        val verifier = android.util.Base64.encodeToString(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
        work(MoteI18n.text("正在连接中央节点…"), {
            val config = Settings(this).read()
            val (code, value) = HttpJson.post(origin + "/api/login/requests", org.json.JSONObject().put("serverUrl", origin).put("deviceId", Settings(this).deviceId)
                .put("deviceName", config.deviceName).put("platform", "android").put("challenge", SourceRules.hash(verifier)).put("durationMs", durationMs))
            check(code == 200); requireNotNull(value).getString("id")
        }) { id ->
            check(origin == server && expected == session.generation)
            browserLoginId = id; browserVerifier = verifier; browserGeneration = expected; browserDurationMs = durationMs
            startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(origin + "/#/ask?loginRequest=" + id)))
        }
    }
    private fun pollBrowserLogin() {
        val id = browserLoginId ?: return; val verifier = browserVerifier ?: return; val origin = server
        work(MoteI18n.text("正在验证令牌…"), {
            val (code, value) = HttpJson.post(origin + "/api/login/poll", org.json.JSONObject().put("id", id).put("verifier", verifier))
            if (code !in 200..299) { browserLoginId = null; browserVerifier = null; error(MoteI18n.text("登录会话已变更，请重新打开中央页面。")) }
            val result = requireNotNull(value)
            if (result.optBoolean("ready")) {
                session.signIn(origin, result.getString("token"), browserDurationMs, browserGeneration)
                runCatching { HttpJson.post(origin + "/api/login/ack", org.json.JSONObject().put("id", id).put("verifier", verifier)) }
            }
            result.optBoolean("ready")
        }) { ready ->
            if (ready) { browserLoginId = null; browserVerifier = null; client = session.client(origin); navigate(page) }
            else if (resumed) handler.postDelayed({ if (resumed && browserLoginId == id) pollBrowserLogin() }, 1500)
        }
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
        orientation = LinearLayout.VERTICAL; background = MoteUi.shape(this@CentralContent, android.graphics.Color.WHITE, 16, true)
        setPadding(moteDp(14), moteDp(10), moteDp(14), moteDp(10))
    }.also { parent.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(12) }) }
    internal fun notice(message: String) { status.text = message }
    internal fun enterDetail() { backButton.visibility = View.VISIBLE; revision++; pending.clear(); handler.removeCallbacks(refreshRun) }
    internal fun requestFailure(error: Throwable, generation: Long = session.generation) {
        status.text = error.message ?: MoteI18n.text("操作失败")
        if (client == null && body.childCount == 0) {
            button(MoteI18n.text("重试")) { recreate() }; connectionButton()
        }
        if (error is CentralFailure && error.status == 401 && error.code in setOf("", "unauthorized")) {
            work(MoteI18n.text("正在退出登录…"), { session.signOut(generation) }) { client = null; screens?.clearPrivateState(); login(); notice(error.message.orEmpty()) }
        } else if (Settings(this).read().connectionToken().isBlank()) {
            client = null; screens?.clearPrivateState(); login(); notice(error.message.orEmpty())
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
        @Suppress("DEPRECATION") activity.startActivityForResult(picker, 71)
    }
    internal fun saveCentral(path: String, name: String, mime: String) {
        downloadPath = path; downloadOrigin = server; downloadGeneration = session.generation
        @Suppress("DEPRECATION") activity.startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime).putExtra(Intent.EXTRA_TITLE, name), 72)
    }
    internal fun pickImport() {
        pickerOrigin = server; pickerGeneration = session.generation
        pickerInstruction = screens?.importInstruction.orEmpty()
        @Suppress("DEPRECATION") activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*"), 73)
    }
    fun activityResult(request: Int, result: Int, data: Intent?) {
        if (result != Activity.RESULT_OK || data == null) return
        if (!accessReady) { pendingResult = Triple(request, result, data); if (!resumed) resume(); return }
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
