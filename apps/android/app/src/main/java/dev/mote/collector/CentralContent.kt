package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.graphics.Color
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
    private val accessTask by lazy { UiTask(activity) }
    private val handler = Handler(Looper.getMainLooper())
    private val session by lazy { CentralSession.get(this) }
    private lateinit var body: LinearLayout
    private lateinit var addAction: TextView
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
    private var foregroundRevision = 0L
    // This is a UI routing stamp. Authorization always reads the current session in background work.
    private var accessGeneration = -1L
    private var accessReady = false
    private var pendingResult: Triple<Int, Int, Intent?>? = null
    private val pending = java.util.ArrayDeque<Pair<Long, () -> Unit>>()
    private var browserLoginId: String? = null
    private var browserVerifier: String? = null
    private var browserGeneration = -1L
    private var browserDurationMs = 2592000000L
    private var screens: CentralScreens? = null
    private var restoredWorkState = state?.getBundle("workActivity")
    private val restoredWorkOrigin = state?.getString("workActivityOrigin")
    private val restoredWorkOwner = state?.getString("workActivityOwner")
    private var pickerOrigin: String? = null
    private var pickerChat = false
    private var pickerGeneration = -1L
    private var pickerOwner: String? = null
    private var pickerInstruction = ""
    private var downloadPath: String? = null
    private var downloadOrigin: String? = null
    private var downloadGeneration = -1L
    private var downloadOwner: String? = null
    private var downloadReceipt: String? = null
    private var downloadExpected: String? = null
    private val refreshRun = Runnable { if (resumed) when (page) { "ask" -> screens?.pollAsk(); "activity" -> screens?.pollWorkActivity() } }

    private val refreshLogin = object : Runnable {
        override fun run() {
            if (!resumed) return
            if (accessReady && !accessTask.busy) {
                val foreground = foregroundRevision
                val version = revision
                accessTask.start("", {}, { CentralAccess.resolve(this@CentralContent) }) { result ->
                    if (resumed && foreground == foregroundRevision && version == revision && !isDestroyed && !isFinishing) {
                        result.onSuccess { selected ->
                            if (selected.generation >= accessGeneration && (selected.generation != accessGeneration || selected.server != server || (selected.client == null) != (client == null))) applyAccess(selected)
                        }.onFailure {
                            client = null; screens?.close(); screens?.clearPrivateState(); login()
                            notice(it.message ?: MoteI18n.text("操作失败"))
                        }
                    }
                }
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
        pickerOwner = state?.getString("pickerOwner")
        pickerInstruction = state?.getString("pickerInstruction").orEmpty()
        downloadPath = state?.getString("downloadPath"); downloadOrigin = state?.getString("downloadOrigin")
        downloadGeneration = state?.getLong("downloadGeneration") ?: -1L
        downloadOwner = state?.getString("downloadOwner"); downloadReceipt = state?.getString("downloadReceipt"); downloadExpected = state?.getString("downloadExpected")
        val shell = NativeAppShell(activity)
        root = shell
        val compactHeader = resources.configuration.screenWidthDp < 360 || resources.configuration.fontScale > 1.2f
        val header = LinearLayout(this).apply {
            orientation = if (compactHeader) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL; tag = "central-header"; setPadding(moteDp(12), 0, moteDp(12), 0)
        }
        val heading = if (compactHeader) LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL } else header
        val actions = if (compactHeader) LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL } else header
        backButton = TextView(this).apply {
            text = "‹"; contentDescription = MoteI18n.text("返回上级"); textSize = 28f; gravity = Gravity.CENTER
            isFocusable = true; minHeight = moteDp(48); setOnClickListener { if (!back()) { if (openLocalPage != null) localPage("LIBRARY") else activity.finish() } }
        }
        heading.addView(backButton, LinearLayout.LayoutParams(moteDp(44), -2))
        title = TextView(this).apply { tag = "central-title"; MoteUi.type(this, NativeFontRole.APPBAR, medium = true); maxLines = Int.MAX_VALUE; ellipsize = null; MoteUi.textColor(this, NativeColorRole.INK) }
        heading.addView(title, LinearLayout.LayoutParams(0, -2, 1f))
        fun headerAction(label: String, description: String = label, tonal: Boolean = false, action: () -> Unit): TextView {
            val item = TextView(this).apply {
                text = MoteI18n.text(label); contentDescription = MoteI18n.text(description); MoteUi.type(this, NativeFontRole.ACTION, medium = true); gravity = Gravity.CENTER
                MoteUi.textColor(this, if (tonal) NativeColorRole.ACCENT else NativeColorRole.MUTED)
                isFocusable = true; minHeight = moteDp(MoteTheme.controlHeight); background = MoteUi.clickable(this@CentralContent, if (tonal) MoteTheme.surface else Color.TRANSPARENT, MoteUi.actionRadius, outline = tonal, strokeColor = MoteUi.controlBorder)
                setOnClickListener { action() }
            }
            actions.addView(item, (if (compactHeader) LinearLayout.LayoutParams(0, -2, 1f) else LinearLayout.LayoutParams(moteDp(56), -2)).apply { marginStart = moteDp(4) })
            return item
        }
        addAction = headerAction("添加", "添加内容", tonal = true) { activity.showMoteAddActions() }
        headerAction("设置") { localPage("SETTINGS") }
        headerAction("更多") { more() }
        if (compactHeader) {
            header.addView(heading, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(6) })
            header.addView(actions, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(6) })
        }
        shell.header(header)
        status = TextView(this).apply {
            tag = "central-status"
            visibility = View.GONE
            MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(moteDp(16), moteDp(8), moteDp(16), moteDp(8))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }; shell.header(status)
        collectionBar = LinearLayout(this).apply { tag = "central-collection-scope"; orientation = LinearLayout.VERTICAL; visibility = View.GONE; setPadding(moteDp(16), 0, moteDp(16), moteDp(8)) }
        shell.header(collectionBar)
        val scroll = ScrollView(this).apply { isFillViewport = true }
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(16), moteDp(12), moteDp(16), moteDp(24)) }
        scroll.addView(body); shell.content(scroll)
        if (openLocalPage == null) navigation = MotePrimaryNavigation(activity) { destination ->
            when (destination) {
                MotePrimaryTab.ASK -> { pageHistory.clear(); navigate("ask", remember = false) }
                MotePrimaryTab.LIBRARY -> { pageHistory.clear(); navigate("archive", remember = false) }
                MotePrimaryTab.SOURCES -> activity.openMotePrimary(destination)
                MotePrimaryTab.ACTIVITY -> { pageHistory.clear(); navigate("activity", remember = false) }
            }
        }
        navigation?.let(shell::navigation)
        MoteUi.styleTree(header); navigation?.select(MoteNavigation.centralTab(page)); updateBackButton()
    }

    fun resume() {
        resumed = true; foregroundRevision++
        // Retire already-rendered private content before the async resolver can
        // wait behind other work. The original account's durable state stays put.
        if (screens?.ownsSelectedAccount() == false) {
            revision++; pending.clear(); screens?.close(); screens?.clearPrivateState()
            screens = null; client = null; status.text = ""; collectionBar.visibility = View.GONE
        }
        handler.removeCallbacks(refreshLogin); handler.postDelayed(refreshLogin, 1000)
        work(MoteI18n.text("正在读取本机设置…"), { CentralAccess.resolve(this) }, allowSessionChange = true) { selected ->
            applyAccess(selected)
            if (client == null && browserLoginId != null && server.isNotBlank()) pollBrowserLogin()
            deliverPendingResult()
            if (client != null) screens?.resume()
        }
    }
    private fun applyAccess(selected: CentralAccess.Selection) {
        if (selected.generation < accessGeneration) return
        val endpoint = selected.server
        val sessionChanged = accessGeneration != selected.generation
        accessGeneration = selected.generation
        if (endpoint.isBlank()) {
            server = ""; client = null; revision++; pending.clear(); screens?.close(); screens?.clearPrivateState(); body.removeAllViews(); collectionBar.visibility = View.GONE
            disconnected()
            return
        }
        val changed = server != endpoint
        val authenticated = client == null && selected.client != null
        if (sessionChanged) { screens?.close(); screens?.clearPrivateState() }
        server = endpoint
        if (changed || sessionChanged || client == null || selected.client == null) client = selected.client
        if (changed || sessionChanged || screens == null) {
            screens = CentralScreens(this, body, File(accountDirectory(), "central-native/" + SourceRules.hash(endpoint)))
            if (endpoint == restoredWorkOrigin && accountOwnerKey() == restoredWorkOwner) restoredWorkState?.let { screens?.restoreWorkState(it) }
            restoredWorkState = null
        }
        if (client == null) { screens?.clearPrivateState(); login() }
        else if (changed || authenticated || sessionChanged || body.childCount == 0) navigate(page) else if (page == "ask") scheduleAskPoll() else if (page == "activity") scheduleActivityPoll()
    }
    private fun deliverPendingResult() {
        accessReady = true
        pendingResult?.let { (request, result, data) -> pendingResult = null; activityResult(request, result, data) }
    }
    fun pause() { resumed = false; foregroundRevision++; accessReady = false; pending.clear(); handler.removeCallbacks(refreshLogin); handler.removeCallbacks(refreshRun); screens?.close() }
    fun close() { pause(); pending.clear() }
    fun saveState(state: Bundle) {
        state.putLong("browserDurationMs", browserDurationMs)
        state.putString("browserLoginId", browserLoginId); state.putString("browserVerifier", browserVerifier); state.putLong("browserGeneration", browserGeneration)
        state.putString("centralPage", page); state.putString("pickerOrigin", pickerOrigin); state.putBoolean("pickerChat", pickerChat)
        state.putStringArrayList("pageHistory", ArrayList(pageHistory))
        state.putString("pickerOwner", pickerOwner); state.putLong("pickerGeneration", pickerGeneration); state.putString("downloadPath", downloadPath)
        state.putString("pickerInstruction", pickerInstruction)
        state.putString("downloadOrigin", downloadOrigin); state.putLong("downloadGeneration", downloadGeneration)
        state.putString("downloadOwner", downloadOwner); state.putString("downloadReceipt", downloadReceipt); state.putString("downloadExpected", downloadExpected)
        state.putString("workActivityOrigin", server)
        state.putString("workActivityOwner", accountOwnerKey())
        state.putBundle("workActivity", Bundle().also { screens?.saveWorkState(it) })
    }
    fun back(): Boolean {
        if (screens?.back() == true) { updateBackButton(); return true }
        val previous = if (pageHistory.isNotEmpty()) pageHistory.removeAt(pageHistory.lastIndex) else MoteNavigation.centralParent(page)
        if (previous == null) return false
        navigate(previous, remember = false)
        return true
    }
    private fun updateBackButton() {
        backButton.visibility = if (openLocalPage != null && page in setOf("ask", "activity") && pageHistory.isEmpty()) View.GONE else View.VISIBLE
        addAction.visibility = if (MoteNavigation.centralAllowsAdd(page)) View.VISIBLE else View.GONE
    }

    internal fun navigate(next: String, remember: Boolean = true) {
        if (remember && next != page) pageHistory.add(page)
        page = next; revision++; pending.clear(); handler.removeCallbacks(refreshRun); screens?.close(); body.removeAllViews()
        navigation?.select(MoteNavigation.centralTab(next)); updateCollectionBar(); updateBackButton()
        title.text = CentralScreens.pages.firstOrNull { it.first == if (next == "extensions") "plugins" else next }?.second?.let { MoteI18n.text(it) } ?: MoteI18n.text("中央资料库")
        if (screens?.ownsSelectedAccount() == false) { resolveSelectedAccount(); return }
        if (client == null) { if (server.isBlank()) disconnected() else login(); return }
        runCatching { screens?.show(next) }.onFailure { error ->
            if (screens?.ownsSelectedAccount() == false) resolveSelectedAccount() else requestFailure(error)
        }
    }
    private fun resolveSelectedAccount() {
        screens?.clearPrivateState(); screens = null; client = null; collectionBar.visibility = View.GONE
        work(MoteI18n.text("正在读取本机设置…"), { CentralAccess.resolve(this) }, allowSessionChange = true) { applyAccess(it) }
    }
    internal fun openWorkDestination(page: String) {
        if (openLocalPage != null && page == "ask") localPage("ASK")
        else if (openLocalPage != null && page == "sources") localPage("SOURCES")
        else navigate(page)
    }
    private fun disconnected() {
        title.text = CentralScreens.pages.firstOrNull { it.first == page }?.second?.let { MoteI18n.text(it) } ?: MoteI18n.text("中央资料库")
        text(MoteI18n.text(when {
            page == "ask" -> "中央问答暂不可用。连接中央后，可以根据已整理的内容提问；文件和随手记仍可在本机保存。"
            page in MoteNavigation.libraryPages -> "中央资料库暂不可用。连接中央后，可浏览已归档的资料；文件和随手记仍可在本机保存和查看。"
            else -> "中央功能需要连接中央；文件和随手记仍可在本机保存和查看。"
        }))
        connectionButton()
    }
    internal fun showFeatureGuide() = more()
    private fun more() {
        val titles = MoteNavigation.groups.map { MoteI18n.text(it.titleKey) } + MoteI18n.text("退出登录")
        MoteDialogBuilder(this).setTitle(MoteI18n.text("此客户端支持的中央功能")).setItems(titles.toTypedArray()) { _, index ->
            if (index == MoteNavigation.groups.size) {
                val expected = accessGeneration
                work(MoteI18n.text("正在退出登录…"), { session.signOut(expected); CentralAccess.resolve(this) }, allowSessionChange = true) { selected -> applyAccess(selected) }
            }
            else {
                val group = MoteNavigation.groups[index]
                val entries = group.pages.mapNotNull { id -> CentralScreens.pages.find { it.first == id } }
                MoteDialogBuilder(this).setTitle(MoteI18n.text(group.titleKey))
                    .setItems(entries.map { MoteI18n.text(it.second) }.toTypedArray()) { _, position -> navigate(entries[position].first) }
                    .setNegativeButton(MoteI18n.text("返回")) { _, _ -> more() }.show()
            }
        }.setNegativeButton(MoteI18n.text("取消"), null).show()
    }
    private fun updateCollectionBar() {
        collectionBar.removeAllViews()
        if (client == null || page !in MoteNavigation.libraryBrowsePages) { collectionBar.visibility = View.GONE; return }
        collectionBar.visibility = View.VISIBLE
        val scope = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        scope.addView(TextView(this).apply {
            text = MoteI18n.text("中央资料库"); MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.ACCENT)
            background = MoteUi.shape(this@CentralContent, NativeColorRole.TINT, 8); setPadding(moteDp(12), moteDp(8), moteDp(12), moteDp(8))
        }, LinearLayout.LayoutParams(0, -2, 1f))
        scope.addView(MoteUi.button(Button(this).apply { text = MoteI18n.text("本机保留"); setOnClickListener { localPage("LIBRARY") } }))
        collectionBar.addView(scope)
        val entries = MoteNavigation.libraryBrowsePages.mapNotNull { id -> CentralScreens.pages.find { it.first == id } }
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
        val bindLocal = CheckBox(this).apply { text = MoteI18n.text("将本机未绑定资料归入此账号"); body.addView(this) }
        val username = field(MoteI18n.text("用户名"))
        val credential = field(MoteI18n.text("密码"), password = true)
        text(MoteI18n.text("登录会话有效期"))
        val lifetime = Spinner(this).apply {
            adapter = ArrayAdapter(this@CentralContent, android.R.layout.simple_spinner_dropdown_item,
                listOf(MoteI18n.text("本次应用会话"), MoteI18n.text("1 天"), MoteI18n.text("7 天"), MoteI18n.text("30 天")))
        }; lifetime.setSelection(3); body.addView(lifetime)
        button(MoteI18n.text("登录并继续"), true) {
            val password = credential.text.toString()
            val loginName = username.text.toString().trim()
            val adoptLocal = bindLocal.isChecked
            val duration = listOf(0L, 86400000L, 7 * 86400000L, 30 * 86400000L)[lifetime.selectedItemPosition]
            val origin = server; val generation = accessGeneration; credential.setText("")
            work(MoteI18n.text("正在验证令牌…"), {
                check(session.generation == generation) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
                val (code, result) = HttpJson.post(origin + "/api/auth/login", org.json.JSONObject().put("username", loginName).put("password", password).put("mode", "client").put("durationMs", duration))
                if (code !in 200..299 || result == null) throw CentralFailure(code, centralResponseFailureCode(result))
                val grant = result
                session.signIn(origin, grant.getString("token"), duration, generation, adoptLocal)
                CentralAccess.resolve(this)
            }, allowSessionChange = true) { selected -> applyAccess(selected) }
        }
        button(MoteI18n.text("使用浏览器登录")) { beginBrowserLogin(listOf(0L, 86400000L, 604800000L, 2592000000L)[lifetime.selectedItemPosition]) }
        connectionButton()
    }

    private fun beginBrowserLogin(durationMs: Long) {
        val origin = server; val expected = accessGeneration
        val verifier = android.util.Base64.encodeToString(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
        work(MoteI18n.text("正在连接中央节点…"), {
            val config = Settings(this).read()
            val (code, value) = HttpJson.post(origin + "/api/login/requests", org.json.JSONObject().put("serverUrl", origin).put("deviceId", Settings(this).deviceId)
                .put("deviceName", config.deviceName).put("platform", "android").put("purpose", "central").put("challenge", SourceRules.hash(verifier)).put("durationMs", durationMs))
            check(code == 200); requireNotNull(value).getString("id")
        }) { id ->
            check(origin == server && expected == accessGeneration)
            browserLoginId = id; browserVerifier = verifier; browserGeneration = expected; browserDurationMs = durationMs
            startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(origin + "/#/ask?loginRequest=" + id)))
        }
    }
    private fun pollBrowserLogin() {
        val id = browserLoginId ?: return; val verifier = browserVerifier ?: return; val origin = server; val expected = browserGeneration
        work(MoteI18n.text("正在验证令牌…"), {
            check(session.generation == expected) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
            val (code, value) = HttpJson.post(origin + "/api/login/poll", org.json.JSONObject().put("id", id).put("verifier", verifier))
            if (code !in 200..299) { browserLoginId = null; browserVerifier = null; error(MoteI18n.text("登录会话已变更，请重新打开中央页面。")) }
            val result = requireNotNull(value)
            if (result.optBoolean("ready")) {
                session.signIn(origin, result.getString("token"), browserDurationMs, expected)
                runCatching { HttpJson.post(origin + "/api/login/ack", org.json.JSONObject().put("id", id).put("verifier", verifier)) }
            }
            if (result.optBoolean("ready")) CentralAccess.resolve(this)
            else { check(session.generation == expected) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }; null }
        }, allowSessionChange = true) { selected ->
            if (selected != null) { browserLoginId = null; browserVerifier = null; applyAccess(selected) }
            else if (resumed) handler.postDelayed({ if (resumed && browserLoginId == id) pollBrowserLogin() }, 1500)
        }
    }

    internal fun text(value: String, role: NativeFontRole = NativeFontRole.BODY, parent: LinearLayout = body): TextView = TextView(this).apply {
        text = value; MoteUi.type(this, role); MoteUi.textColor(this, NativeColorRole.INK); setTextIsSelectable(true); setPadding(0, moteDp(8), 0, moteDp(8))
    }.also(parent::addView)
    internal fun text(value: String, size: Float, parent: LinearLayout = body): TextView = TextView(this).apply {
        text = value; MoteUi.type(this, size.toInt()); MoteUi.textColor(this, NativeColorRole.INK); setTextIsSelectable(true); setPadding(0, moteDp(8), 0, moteDp(8))
    }.also(parent::addView)
    internal fun button(label: String, primary: Boolean = false, parent: LinearLayout = body, action: () -> Unit): Button = MoteUi.button(Button(this).apply {
        val owner = client; val pageRevision = revision
        text = label; setOnClickListener { if (client === owner && revision == pageRevision && !task.busy) runCatching { action(); MoteUi.styleSelects(body) }.onFailure { notice(it.message ?: MoteI18n.text("操作失败")) } }
    }, primary).also { parent.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(8) }) }
    internal fun field(label: String, value: String = "", multiline: Boolean = false, password: Boolean = false, parent: LinearLayout = body): EditText {
        text(label, NativeFontRole.SUPPORT, parent)
        return MoteUi.field(EditText(this).apply {
            hint = label; contentDescription = label; setText(value); isSaveEnabled = false
            MoteUi.textInput(this, InputType.TYPE_CLASS_TEXT or if (password) InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_FLAG_CAP_SENTENCES, multiline)
        }).also { parent.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(MoteTheme.spaceInline) }) }
    }
    internal fun card(parent: LinearLayout = body): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; background = MoteUi.shape(this@CentralContent, NativeColorRole.SURFACE)
        setPadding(moteDp(14), moteDp(10), moteDp(14), moteDp(10))
    }.also { parent.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(12) }) }
    internal fun selectRow(title: String, subtitle: String, parent: LinearLayout, action: () -> Unit): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = moteDp(64)
        setPadding(moteDp(14), moteDp(10), moteDp(14), moteDp(10))
        background = MoteUi.clickable(this@CentralContent, NativeColorRole.SURFACE)
        isFocusable = true; contentDescription = title + ". " + subtitle
        val copy = LinearLayout(this@CentralContent).apply { orientation = LinearLayout.VERTICAL }
        copy.addView(TextView(this@CentralContent).apply { text = title; MoteUi.type(this, NativeFontRole.ROW, medium = true); MoteUi.textColor(this, NativeColorRole.INK); maxLines = 2 })
        copy.addView(TextView(this@CentralContent).apply {
            text = subtitle; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
            setPadding(0, moteDp(4), 0, 0)
        })
        addView(copy, LinearLayout.LayoutParams(0, -2, 1f))
        addView(TextView(this@CentralContent).apply { text = "›"; textSize = 20f; MoteUi.textColor(this, NativeColorRole.ACCENT) }, LinearLayout.LayoutParams(moteDp(20), -2))
        setOnClickListener { if (!task.busy) runCatching { action(); MoteUi.styleSelects(body) }.onFailure { notice(it.message ?: MoteI18n.text("操作失败")) } }
    }.also { parent.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(4) }) }
    internal fun disclosure(label: String, parent: LinearLayout = body, build: (LinearLayout) -> Unit) {
        val section = card(parent)
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        var built = false
        button(label + "  ›", parent = section) {
            if (!built) { build(content); built = true }
            content.visibility = if (content.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }.apply { contentDescription = label; accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        section.addView(content)
    }
    internal fun notice(message: String) {
        status.text = message
        status.visibility = if (message.isBlank()) View.GONE else View.VISIBLE
    }
    internal fun enterDetail() { backButton.visibility = View.VISIBLE; revision++; pending.clear(); handler.removeCallbacks(refreshRun) }
    internal fun requestFailure(error: Throwable, generation: Long = accessGeneration) {
        notice(error.message ?: MoteI18n.text("操作失败"))
        if (client == null && body.childCount == 0) {
            button(MoteI18n.text("重试")) { recreate() }; connectionButton()
        }
        if (error is CentralFailure && error.status == 401 && error.code in setOf("", "unauthorized", "invalid_identity", "identity_required", "connection_revoked", "session_binding_required")) {
            work(MoteI18n.text("正在退出登录…"), { session.signOut(generation); CentralAccess.resolve(this) }, allowSessionChange = true) { selected -> applyAccess(selected); notice(error.message.orEmpty()) }
        } else {
            handler.removeCallbacks(refreshLogin); handler.post(refreshLogin)
            if (page == "ask") scheduleAskPoll(5000)
        }
    }
    internal fun scheduleAskPoll(delay: Long = 1500) { handler.removeCallbacks(refreshRun); if (resumed && page == "ask") handler.postDelayed(refreshRun, delay) }
    internal fun scheduleActivityPoll() { handler.removeCallbacks(refreshRun); if (resumed && page == "activity") handler.postDelayed(refreshRun, 3000) }
    private data class WorkValue<T>(val value: T, val generation: Long)
    internal fun <T> work(label: String, job: (UiTask.Progress) -> T, done: (T) -> Unit) = work(label, job, false, done)
    private fun <T> work(label: String, job: (UiTask.Progress) -> T, allowSessionChange: Boolean, done: (T) -> Unit) {
        if (task.busy) { pending.add(revision to { work(label, job, allowSessionChange, done) }); return }
        val version = revision
        val foreground = foregroundRevision
        val generation = accessGeneration
        val origin = server
        val authenticated = client != null
        val inputs = mutableListOf<View>()
        fun lock(view: View) {
            if (view is EditText || view is Spinner || view is CompoundButton) { if (view.isEnabled) { inputs.add(view); view.isEnabled = false } }
            if (view is android.view.ViewGroup) for (i in 0 until view.childCount) lock(view.getChildAt(i))
        }; lock(body)
        task.start(label, { if (foreground == foregroundRevision && resumed) notice(it) }, { progress ->
            val before = CentralAccess.resolve(this)
            check(allowSessionChange || generation < 0 || before.generation == generation) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
            check(allowSessionChange || !authenticated || before.client != null && before.server == origin) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
            val value = job(progress)
            val after = CentralAccess.resolve(this)
            check(allowSessionChange || after.generation == before.generation) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
            check(allowSessionChange || !authenticated || after.client != null && after.server == origin) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
            check(value !is CentralAccess.Selection || value.generation == after.generation && (value.client == null) == (after.client == null)) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
            WorkValue(value, after.generation)
        }) { result ->
            inputs.forEach { it.isEnabled = true }
            if (version == revision && foreground == foregroundRevision && resumed && !isDestroyed && !isFinishing) {
                result.onSuccess { completed ->
                    if (completed.generation >= accessGeneration) {
                        notice(""); runCatching { done(completed.value); MoteUi.styleSelects(body) }.onFailure { error -> notice(error.message ?: MoteI18n.text("操作失败")) }
                    }
                }
                    .onFailure { error ->
                        requestFailure(error, generation)
                    }
            }
            while (resumed && pending.isNotEmpty()) { val next = pending.removeFirst(); if (next.first == revision) { next.second.invoke(); break } }
        }
    }
    internal fun pickAttachment(chat: Boolean = false) {
        pickerOrigin = server; pickerChat = chat; pickerGeneration = accessGeneration; pickerOwner = accountOwnerKey()
        val picker = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(if (chat) "image/*" else "*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, if (chat) arrayOf("image/png", "image/jpeg", "image/webp") else arrayOf("image/*", "audio/*"))
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        @Suppress("DEPRECATION") activity.startActivityForResult(picker, 71)
    }
    internal fun saveCentral(path: String, name: String, mime: String, expected: CentralDownload? = null) {
        downloadPath = path; downloadOrigin = server; downloadGeneration = accessGeneration
        downloadOwner = accountOwnerKey(); downloadReceipt = null
        downloadExpected = expected?.let { org.json.JSONObject().put("bytes", it.bytes).put("sha256", it.sha256).put("contentType", it.contentType).put("requireEtag", it.requireEtag).toString() }
        @Suppress("DEPRECATION") activity.startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime).putExtra(Intent.EXTRA_TITLE, name), 72)
    }
    internal fun savePortable(receipt: org.json.JSONObject) {
        saveCentral(CentralPortable.PATH + "/" + receipt.getString("id") + "/content", receipt.getString("filename"), "application/json")
        downloadReceipt = receipt.toString()
    }
    internal fun pickImport() {
        pickerOrigin = server; pickerGeneration = accessGeneration; pickerOwner = accountOwnerKey()
        pickerInstruction = screens?.importInstruction.orEmpty()
        @Suppress("DEPRECATION") activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*"), 73)
    }
    internal fun pickPortableImport(operationId: String? = null) {
        operationId?.let(java.util.UUID::fromString)
        pickerOrigin = server; pickerGeneration = accessGeneration; pickerOwner = accountOwnerKey(); pickerInstruction = operationId.orEmpty()
        @Suppress("DEPRECATION") activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/json"), 74)
    }
    fun activityResult(request: Int, result: Int, data: Intent?) {
        if (result != Activity.RESULT_OK || data == null) return
        if (!accessReady) { pendingResult = Triple(request, result, data); if (!resumed) resume(); return }
        if (request == 72) {
            val uri = data.data ?: return; val path = downloadPath ?: return
            val origin = downloadOrigin; val generation = downloadGeneration; val owner = downloadOwner
            val receipt = downloadReceipt; val expected = downloadExpected?.let { org.json.JSONObject(it) }?.let { CentralDownload(it.getLong("bytes"), it.getString("sha256"), it.getString("contentType"), it.getBoolean("requireEtag")) }; downloadPath = null; downloadReceipt = null; downloadExpected = null; downloadOwner = null
            work(MoteI18n.text("正在导出中央资料…"), {
                val selected = CentralAccess.resolve(this)
                check(selected.server == origin && session.generation == generation && accountOwnerKey() == owner) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
                val api = requireNotNull(selected.client)
                if (expected != null) api.downloadVerified(path, { requireNotNull(contentResolver.openOutputStream(uri, "wt")) }, expected, File(accountDirectory(), "central-native/downloads"))
                else if (receipt == null) api.downloadStaged(path, { requireNotNull(contentResolver.openOutputStream(uri, "wt")) }, File(accountDirectory(), "central-native/downloads"))
                else CentralPortable(api).save(org.json.JSONObject(receipt), File(accountDirectory(), "central-native/downloads")) {
                    requireNotNull(contentResolver.openOutputStream(uri, "wt"))
                }
            }) { notice(MoteI18n.text("资料已导出")) }; return
        }
        if (request !in setOf(71, 73, 74)) return
        val origin = pickerOrigin; val owner = pickerOwner; val chat = pickerChat; pickerOrigin = null; pickerOwner = null
        val uris = data.clipData?.let { clip -> (0 until clip.itemCount).map { clip.getItemAt(it).uri } } ?: listOfNotNull(data.data)
        if (origin != server || client == null || pickerGeneration != accessGeneration || owner != accountOwnerKey()) { notice(MoteI18n.text("登录会话已变更，请重新打开中央页面。")); return }
        if (request == 74) uris.firstOrNull()?.let { screens?.importPortableFile(it, pickerInstruction.takeIf(String::isNotBlank)) }
        else if (request == 73) uris.firstOrNull()?.let { screens?.importInstruction = pickerInstruction; screens?.importFile(it) }
        else screens?.addAttachments(uris, chat)
    }
}
