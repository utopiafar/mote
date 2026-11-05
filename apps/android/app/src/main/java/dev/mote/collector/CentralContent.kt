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
import dev.mote.collector.plugins.NativeWorkDiscoveryPlugin
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import java.io.File

/** Reusable native central content. The host owns the window and primary navigation. */
internal class CentralContent(
    private val activity: MoteActivity,
    state: Bundle?,
    initialPage: String = "ask",
    private val openLocalPage: ((String) -> Unit)? = null,
    private val embeddedActions: Boolean = false,
    private val openCalendar: (() -> Unit)? = null,
) : ContextWrapper(activity) {
    fun openCaptureReader(origin: String, row: org.json.JSONObject, conversationId: String?, returnScroll: Int? = null, workMemory: WorkMemoryReference? = null) {
        val restore = if (conversationId != null && returnScroll != null) ReaderReturn(origin, accessGeneration, revision, conversationId, returnScroll) else null
        pendingReaderReturn = restore
        val workRestore = if(workMemory!=null) ReaderReturn(origin,accessGeneration,revision,workMemory.work,contentScroll()) else null
        try {
            dev.mote.collector.plugins.NativeLibraryPlugin.owner(activity).openCapture(activity,origin,row,conversationId,workMemory,accessGeneration)
            if(workRestore!=null) { pendingWorkReaderReturn=workRestore;body.visibility=View.INVISIBLE }
        }
        catch (error: Exception) { pendingReaderReturn = null; throw error }
    }
    /** The plugin view bound to this content; disposed when its route,
     * pause or Activity ends while the durable owner persists. Removing the
     * mounted slot lets the existing body.childCount == 0 resume path
     * remount the route instead of leaving dead UI. */
    private var pluginView: dev.mote.collector.plugins.PluginViewSession? = null
    private var pluginViewSlot: android.view.View? = null
    fun disposePluginView() {
        pluginView?.dispose(); pluginView = null
        pluginViewSlot?.let { (it.parent as? android.view.ViewGroup)?.removeView(it) }
        pluginViewSlot = null
    }

    /** Plugin-owned route binding: a registered factory must mount its
     * contribution into the shell before the route is reported handled; a
     * failed mount disposes the fresh session and falls back. */
    fun pluginRoute(page: String, container: Any): Boolean {
        val host = (activity.application as? MoteApplication)?.pluginHost ?: return false
        val factory = host.route(page) ?: return false
        val owner = host.routeOwner(page) ?: return false
        disposePluginView()
        val session = host.onViewRecreated(owner)
        // The factory mounts into a disposable child slot: a thrown mount
        // removes everything it added, so the fallback never shares the body
        // with partial plugin UI.
        val parent = container as? android.view.ViewGroup
        val slot: Any = parent?.let { android.widget.LinearLayout(activity).apply { orientation = android.widget.LinearLayout.VERTICAL }.also(it::addView) } ?: container
        return try {
            session.registerView(factory(session, slot))
            pluginView = session
            if (slot !== container) pluginViewSlot = slot as android.view.View
            true
        } catch (error: Throwable) {
            // Cleanup must never mask the mount error or block the fallback.
            runCatching { if (slot !== container) parent?.removeView(slot as android.view.View) }
            session.dispose()
            false
        }
    }

    fun requestedFileId(): String? = activity.intent.getStringExtra("fileId")
    fun requestedFileOriginMatches(): Boolean = activity.intent.getStringExtra("fileOrigin") == server
    fun recordNew() = activity.openRecordEditor()
    internal fun openCalendarActions() { openCalendar?.invoke() ?: activity.startActivity(Intent(activity,CalendarActionsActivity::class.java)) }
    internal fun backWithinPage(): Boolean = screens?.back() == true
    internal val actionsEmbedded get() = embeddedActions
    private var pendingTodoDraft: NativeTodoDraft? = null
    internal fun restoreTodoDraft(value: NativeTodoDraft?) { pendingTodoDraft=value }
    internal fun retainTodoDraft(): NativeTodoDraft? = body.findViewWithTag<EditText>("todo-title")?.let { NativeTodoDraft(server,accessGeneration,it.text.toString()) }
    internal fun takeTodoDraft(): String? = pendingTodoDraft?.let { value->pendingTodoDraft=null;if(value.origin==server&&value.generation==accessGeneration)value.text else null }

    fun recordConversation(text: String, conversationId: String, turnId: String, question: String, citations: List<String>) = activity.openRecordEditor(text, conversationId, turnId, question, citations, server)
    // The intent belongs to the owner/session that received it, including while another run is unresolved.
    fun captureAskConversationIntent() {
        if(activity.intent.hasExtra("conversationId") && !activity.intent.hasExtra("moteConversationGeneration")) {
            val selected=CentralAccess.resolve(this)
            activity.intent.putExtra("moteConversationOrigin",selected.server).putExtra("moteConversationGeneration",selected.generation)
        }
    }
    fun requestedAskConversation():String? {
        val id=activity.intent.getStringExtra("conversationId") ?: return null
        if(runCatching { java.util.UUID.fromString(id) }.isFailure || activity.intent.getStringExtra("moteConversationOrigin")!=server || activity.intent.getLongExtra("moteConversationGeneration",-1)!=accessGeneration) { clearAskConversationIntent();return null }
        return id
    }
    fun clearAskConversationIntent() { listOf("conversationId","moteConversationOrigin","moteConversationGeneration").forEach(activity.intent::removeExtra) }
    fun acceptAskConversation(id:String) { if(requestedAskConversation()==id)clearAskConversationIntent() }
    internal val selectedAskConversationId get()=screens?.selectedAskConversationId

    fun takeAskEvidence(): String? {
        val evidence=activity.intent.getStringExtra("evidenceId") ?: return null
        val expected=activity.intent.getStringExtra("evidenceOrigin")
        activity.intent.removeExtra("evidenceId"); activity.intent.removeExtra("evidenceOrigin")
        if (expected != null && expected != server) { notice(MoteI18n.text("访问凭据已失效，请重新连接。")); return null }
        return evidence
    }

    val root: LinearLayout
    private lateinit var backButton: ImageButton
    private lateinit var headerDivider: View
    val isDestroyed get() = activity.isDestroyed
    val isFinishing get() = activity.isFinishing
    fun recreate() = activity.recreate()
    private fun localPage(page: String) { openLocalPage?.invoke(page) ?: activity.openMoteLocalPage(page) }
    private val task by lazy { UiTask(activity) }
    private val accessTask by lazy { UiTask(activity) }
    private val handler = Handler(Looper.getMainLooper())
    private val session by lazy { CentralSession.get(this) }
    private lateinit var body: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var addAction: TextView
    private lateinit var status: TextView
    private lateinit var title: TextView
    private lateinit var collectionBar: LinearLayout
    private lateinit var composer: LinearLayout
    private var insightMoreAction: (() -> Unit)? = null
    private lateinit var settingsAction: TextView
    private lateinit var moreAction: TextView
    private lateinit var historyAction: TextView
    private lateinit var newConversationAction: TextView
    private lateinit var conversationMoreAction: TextView
    private lateinit var memoryFilterAction: ImageButton
    private var memoryFilter: (() -> Unit)? = null
    private val pageHistory = mutableListOf<String>()
    internal var client: CentralClient? = null; private set
    internal var server = ""; private set
    internal val isWorking get() = task.busy || pending.isNotEmpty()
    internal val navigationRevision get() = revision
    internal val currentAccessGeneration get() = accessGeneration
    internal fun readVisit(): () -> Boolean {
        val version=revision;val foreground=foregroundRevision
        return { version==revision && foreground==foregroundRevision && resumed && !isDestroyed && !isFinishing }
    }
    private var page = "ask"
    @Volatile private var revision = 0L
    @Volatile private var resumed = false
    @Volatile private var foregroundRevision = 0L
    // This is a UI routing stamp. Authorization always reads the current session in background work.
    private var accessGeneration = -1L
    private var accessReady = false
    private data class ReaderReturn(val origin: String, val generation: Long, val revision: Long, val conversationId: String, val scroll: Int)
    private var pendingReaderReturn: ReaderReturn? = null
    private var pendingWorkReaderReturn: ReaderReturn? = null
    private var pendingResult: Triple<Int, Int, Intent?>? = null
    private val pending = java.util.ArrayDeque<Pair<Long, () -> Unit>>()
    private var browserLoginId: String? = null
    private var browserVerifier: String? = null
    private var browserGeneration = -1L
    private var browserDurationMs = 2592000000L
    private var screens: CentralScreens? = null
    private var restoredTopicsState = state?.getBundle("memoryTopics")
    private val restoredTopicsOrigin = state?.getString("memoryTopicsOrigin")
    private var restoredWorkState = state?.getBundle("workActivity")
    private val restoredWorkOrigin = state?.getString("workActivityOrigin")
    private val restoredWorkGeneration = state?.getLong("workActivityGeneration",-1) ?: -1
    private val restoredWorkProcess = state?.getString("workActivityProcess")
    private var restoredInsightState = state?.getBundle("insightState")
    private val restoredInsightOrigin = state?.getString("insightOrigin")
    private var pendingInsightId = state?.getString("insightId")
    private var pickerOrigin: String? = null
    private var pickerChat = false
    private var pickerGeneration = -1L
    private var pickerInstruction = ""
    private var downloadPath: String? = null
    private var downloadOrigin: String? = null
    private var downloadGeneration = -1L
    private val refreshRun = Runnable { if (resumed) when (page) { "ask" -> screens?.pollAsk(); "activity" -> screens?.pollWorkActivity(); "memories" -> screens?.pollMemoryTopics(); "insights" -> screens?.pollInsight() } }
    // Work and discovery polling belongs to the plugin: only a visible page
    // keeps a refresh armed, and leaving either page cancels it.
    private val workDiscovery = NativeWorkDiscoveryPlugin.owner(this)
    private val workPolling = workDiscovery.polling(
        visible = { workDiscovery.active && resumed && page in setOf("activity", "insights") },
        schedule = { delay -> handler.postDelayed(refreshRun, delay) },
        cancel = { handler.removeCallbacks(refreshRun) },
    )

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
        captureAskConversationIntent()
        browserLoginId = state?.getString("browserLoginId"); browserVerifier = state?.getString("browserVerifier"); browserGeneration = state?.getLong("browserGeneration") ?: -1L
        browserDurationMs = state?.getLong("browserDurationMs", 2592000000L) ?: 2592000000L
        page = state?.getString("centralPage") ?: initialPage
        pageHistory.addAll(state?.getStringArrayList("pageHistory").orEmpty())
        pickerOrigin = state?.getString("pickerOrigin"); pickerChat = state?.getBoolean("pickerChat") ?: false
        pickerGeneration = state?.getLong("pickerGeneration") ?: -1L
        pickerInstruction = state?.getString("pickerInstruction").orEmpty()
        downloadPath = state?.getString("downloadPath"); downloadOrigin = state?.getString("downloadOrigin")
        downloadGeneration = state?.getLong("downloadGeneration") ?: -1L
        val shell = NativeAppShell(activity)
        root = shell
        val compactHeader = resources.configuration.screenWidthDp < 360 || resources.configuration.fontScale > 1.2f
        val header = LinearLayout(this).apply {
            orientation = if (compactHeader) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL; tag = "central-header"; setPadding(moteDp(12), 0, moteDp(12), 0)
        }
        val heading = if (compactHeader) LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL } else header
        val actions = if (compactHeader) LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL } else header
        backButton = MoteComponents.iconButton(this, MoteGlyph.BACK, "返回上级") {
            if (!back()) { if (openLocalPage != null) localPage("OVERVIEW") else activity.finish() }
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
        addAction = headerAction("记下", "记下", tonal = true) { activity.openRecordEditor() }
        settingsAction = headerAction("设置") { localPage("SETTINGS") }
        moreAction = headerAction("更多") { if (page == "insights") insightMoreAction?.invoke() ?: more() else more() }
        historyAction = headerAction("◷", "对话历史") { screens?.showAskHistory() }
        newConversationAction = headerAction("＋", "新对话") { screens?.newConversation() }
        conversationMoreAction = headerAction("⋯", "对话更多") { screens?.conversationMore() }
        memoryFilterAction = MoteComponents.iconButton(this, MoteGlyph.SLIDERS, "筛选") { memoryFilter?.invoke() }.apply { tag = "memory-filter" }
        actions.addView(memoryFilterAction, LinearLayout.LayoutParams(moteDp(48), moteDp(48)))
        header.minimumHeight = moteDp(if (page == "memories") 56 else 66)
        if (compactHeader) {
            header.addView(heading, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(6) })
            header.addView(actions, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(6) })
        }
        shell.header(header)
        headerDivider = View(this).apply { MoteUi.backgroundColor(this, NativeColorRole.DIVIDER); layoutParams = LinearLayout.LayoutParams(-1,moteDp(1));if(embeddedActions)visibility=View.GONE }
        shell.header(headerDivider)
        if(embeddedActions){require(initialPage=="actions");header.visibility=View.GONE}
        status = TextView(this).apply {
            tag = "central-status"
            visibility = View.GONE
            MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(moteDp(16), moteDp(8), moteDp(16), moteDp(8))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }; shell.header(status)
        collectionBar = LinearLayout(this).apply { tag = "central-collection-scope"; orientation = LinearLayout.VERTICAL; visibility = View.GONE; setPadding(moteDp(16), 0, moteDp(16), moteDp(8)) }
        shell.header(collectionBar)
        scroll = ScrollView(this).apply { isFillViewport = true }
        body = LinearLayout(this).apply { tag = "central-body"; orientation = LinearLayout.VERTICAL; setPadding(moteDp(16), moteDp(12), moteDp(16), moteDp(24)) }
        scroll.addView(body); shell.content(scroll)
        composer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE; tag = "ask-composer" }
        shell.footer(composer)
        MoteUi.styleTree(header); updateBackButton()
    }

    fun resume() {
        resumed = true; foregroundRevision++
        handler.removeCallbacks(refreshLogin); handler.postDelayed(refreshLogin, 1000)
        work(MoteI18n.text("正在读取本机设置…"), { CentralAccess.resolve(this) }, allowSessionChange = true) { selected ->
            applyAccess(selected)
            if (client == null && browserLoginId != null && server.isNotBlank()) pollBrowserLogin()
            deliverPendingResult()
            if (client != null) screens?.resume()
            pendingReaderReturn?.let { previous ->
                pendingReaderReturn = null
                if (resumed && page == "ask" && client != null && server == previous.origin && accessGeneration == previous.generation && revision == previous.revision && selectedAskConversationId == previous.conversationId) {
                    restoreContentScroll(previous.scroll)
                }
            }
            pendingWorkReaderReturn?.let { previous ->
                pendingWorkReaderReturn=null
                if(resumed && page=="activity" && client!=null && server==previous.origin && accessGeneration==previous.generation && revision==previous.revision)
                    screens?.restoreWorkMemoryAfterReader(previous.conversationId,previous.scroll)
                else body.visibility=View.VISIBLE
            }
        }
    }
    private fun applyAccess(selected: CentralAccess.Selection) {
        if (selected.generation < accessGeneration) return
        val endpoint = selected.server
        val sessionChanged = accessGeneration != selected.generation
        accessGeneration = selected.generation
        if (endpoint.isBlank()) {
            server = ""; client = null; revision++; pending.clear();pendingWorkReaderReturn=null;screens?.close(); screens?.clearPrivateState(); body.removeAllViews();body.visibility=View.VISIBLE; collectionBar.visibility = View.GONE
            disconnected()
            return
        }
        val changed = server != endpoint
        val authenticated = client == null && selected.client != null
        if (sessionChanged) { pendingWorkReaderReturn=null;screens?.close(); screens?.clearPrivateState();body.visibility=View.VISIBLE }
        server = endpoint; client = selected.client
        if (changed || screens == null) {
            screens = CentralScreens(this, body, File(noBackupFilesDir, "central-native/" + SourceRules.hash(endpoint)))
            val sameWorkSession=endpoint==restoredWorkOrigin && restoredWorkGeneration==selected.generation && restoredWorkProcess==WorkMemoryProcess.nonce
            if(restoredWorkState!=null && !sameWorkSession)WorkMemoryDrafts.clear()
            if (endpoint == restoredWorkOrigin) restoredWorkState?.let { screens?.restoreWorkState(it,sameWorkSession) }
            restoredWorkState = null
            if (endpoint == restoredTopicsOrigin) restoredTopicsState?.let { screens?.restoreMemoryTopics(it) }
            restoredTopicsState = null
        }
        if (client != null) {
            if (endpoint == restoredInsightOrigin) restoredInsightState?.let { screens?.restoreInsightState(it) }
            restoredInsightState = null
            pendingInsightId?.let { screens?.selectInsight(it) }; pendingInsightId = null
        }
        if (client == null) { screens?.clearPrivateState(); login() }
        else if (changed || authenticated || sessionChanged || body.childCount == 0 || (page == "ask" && activity.intent.hasExtra("conversationId"))) navigate(page) else if (page == "ask") scheduleAskPoll() else if (page == "activity") scheduleActivityPoll()
    }
    private fun deliverPendingResult() {
        accessReady = true
        pendingResult?.let { (request, result, data) -> pendingResult = null; activityResult(request, result, data) }
    }
    fun pause() { resumed = false; foregroundRevision++; accessReady = false; pending.clear(); workPolling.stop(); handler.removeCallbacks(refreshLogin); handler.removeCallbacks(refreshRun); disposePluginView(); screens?.pauseInsights(); screens?.close() }
    fun close() { disposePluginView(); pause(); pending.clear() }
    fun saveState(state: Bundle) {
        state.putLong("browserDurationMs", browserDurationMs)
        state.putString("browserLoginId", browserLoginId); state.putString("browserVerifier", browserVerifier); state.putLong("browserGeneration", browserGeneration)
        state.putString("centralPage", page); state.putString("pickerOrigin", pickerOrigin); state.putBoolean("pickerChat", pickerChat)
        state.putStringArrayList("pageHistory", ArrayList(pageHistory))
        state.putLong("pickerGeneration", pickerGeneration); state.putString("downloadPath", downloadPath)
        state.putString("pickerInstruction", pickerInstruction)
        state.putString("downloadOrigin", downloadOrigin); state.putLong("downloadGeneration", downloadGeneration)
        state.putString("memoryTopicsOrigin", server)
        state.putBundle("memoryTopics", Bundle().also { screens?.saveMemoryTopics(it) })
        state.putString("workActivityOrigin", server)
        state.putLong("workActivityGeneration",accessGeneration);state.putString("workActivityProcess",WorkMemoryProcess.nonce)
        state.putBundle("workActivity", Bundle().also { screens?.saveWorkState(it) })
        state.putString("insightId", pendingInsightId); state.putString("insightOrigin", server)
        state.putBundle("insightState", Bundle().also { screens?.saveInsightState(it) ?: restoredInsightState?.let(it::putAll) })
    }
    fun back(): Boolean {
        if (page == "files" && requestedFileId() != null) return false
        if (screens?.back() == true) { updateBackButton(); return true }
        if (page == "insights" && pageHistory.isEmpty()) return false
        val previous = if (pageHistory.isNotEmpty()) pageHistory.removeAt(pageHistory.lastIndex) else MoteNavigation.centralParent(page)
        if (previous == null) return false
        navigate(previous, remember = false)
        return true
    }
    private fun updateBackButton() {
        backButton.visibility = View.VISIBLE
        addAction.visibility = View.GONE
        val ask = page == "ask"
        moreAction.tag = if (page == "insights") "insight-more" else null
        settingsAction.visibility = if (ask || page == "insights" || page == "memories") View.GONE else View.VISIBLE
        moreAction.visibility = if (ask || page == "memories") View.GONE else View.VISIBLE
        memoryFilterAction.visibility = View.GONE
        headerDivider.visibility = if (page == "memories") View.GONE else View.VISIBLE
        historyAction.visibility = if (ask && client != null) View.VISIBLE else View.GONE
        newConversationAction.visibility = historyAction.visibility
        conversationMoreAction.visibility = View.GONE
    }
    internal fun askComposer(): LinearLayout {
        composer.removeAllViews(); composer.visibility = View.VISIBLE
        composer.addView(View(this).apply { MoteUi.backgroundColor(this, NativeColorRole.DIVIDER) }, LinearLayout.LayoutParams(-1,moteDp(1)))
        return LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(20),moteDp(10),moteDp(20),moteDp(16)) }.also(composer::addView)
    }
    internal fun hideAskComposer() { composer.visibility = View.GONE }
    internal fun restoreAskHeader() { updateCollectionBar(); title.text = MoteI18n.text("问一问") }
    internal fun askConversationActions(showMore: Boolean) { conversationMoreAction.visibility = if (showMore) View.VISIBLE else View.GONE }
    internal fun detailTitle(value: String) { title.text = value; memoryFilterAction.visibility = View.GONE; historyAction.visibility = View.GONE; newConversationAction.visibility = View.GONE; conversationMoreAction.visibility = View.GONE }

    internal fun memoryLibraryHeader(filter: () -> Unit) {
        title.text = ""; memoryFilter = filter; memoryFilterAction.visibility = View.VISIBLE
    }
    internal fun openLibraryMaterials() = localPage("LIBRARY")


    internal fun navigate(next: String, remember: Boolean = true) {
        if (remember && next != page) pageHistory.add(page)
        insightMoreAction = null
        page = next; revision++; pending.clear(); workPolling.stop(); handler.removeCallbacks(refreshRun); disposePluginView(); screens?.close(); body.removeAllViews();body.visibility=View.VISIBLE; composer.removeAllViews(); composer.visibility = View.GONE
        updateCollectionBar(); updateBackButton()
        title.text = CentralScreens.pages.firstOrNull { it.first == if (next == "extensions") "plugins" else next }?.second?.let { MoteI18n.text(it) } ?: MoteI18n.text("资料库")
        if (client == null) { if (server.isBlank()) disconnected() else login(); return }
        screens?.show(next)
    }
    internal fun openInsight(id: String) {
        if (!InsightPresentation.validId(id)) { notice(MoteI18n.text("请求的资源不存在或已删除。")); return }
        if (client == null || screens == null) pendingInsightId = id else screens?.selectInsight(id)
        navigate("insights")
    }
    internal fun contentScroll() = scroll.scrollY
    internal fun restoreContentScroll(position: Int) { val stamp = revision; scroll.post { if (stamp == revision) scroll.scrollTo(0, position.coerceAtLeast(0)) } }
    internal fun openWorkDestination(page: String) {
        if (openLocalPage != null && page == "ask") localPage("ASK")
        else if (openLocalPage != null && page == "sources") localPage("SOURCES")
        else navigate(page)
    }
    private fun disconnected() {
        insightMoreAction = null
        composer.removeAllViews(); composer.visibility = View.GONE; updateBackButton()
        title.text = CentralScreens.pages.firstOrNull { it.first == page }?.second?.let { MoteI18n.text(it) } ?: MoteI18n.text("资料库")
        text(MoteI18n.text(when {
            page == "ask" -> "中央问答暂不可用。连接中央后，可以根据已整理的内容提问；文件和记录仍可在本机保存。"
            MoteNavigation.libraryRoute(page) -> "资料库暂不可用。连接中央后，可浏览已归档的资料；文件和记录仍可在本机保存和查看。"
            else -> "中央功能需要连接中央；文件和记录仍可在本机保存和查看。"
        }))
        connectionButton()
    }
    internal fun insightChrome(titleKey: String, onMore: () -> Unit) {
        if (page != "insights") return
        title.text = MoteI18n.text(titleKey); settingsAction.visibility = View.GONE
        collectionBar.visibility = View.GONE; insightMoreAction = onMore
        moreAction.tag = "insight-more"
    }
    internal fun insightNavigation() {
        val labels = listOf("资料类型", "本机保留", "设置", "此客户端支持的中央功能")
        MoteDialogBuilder(this).setTitle(MoteI18n.text("更多"))
            .setItems(labels.map { MoteI18n.text(it) }.toTypedArray()) { _, index -> when (index) {
                0 -> { val entries = MoteNavigation.libraryBrowsePages.mapNotNull { key -> CentralScreens.pages.find { it.first == key } }
                    MoteDialogBuilder(this).setTitle(MoteI18n.text("资料类型")).setItems(entries.map { MoteI18n.text(it.second) }.toTypedArray()) { _, position -> navigate(entries[position].first) }.show() }
                1 -> localPage("LIBRARY")
                2 -> localPage("SETTINGS")
                else -> more()
            } }.setNegativeButton(MoteI18n.text("取消"), null).show()
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
        if (client == null || page == "insights" || page == "memories" || page !in MoteNavigation.libraryBrowsePages) { collectionBar.visibility = View.GONE; return }
        collectionBar.visibility = View.VISIBLE
        val scope = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        scope.addView(TextView(this).apply {
            text = MoteI18n.text("资料库"); MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.ACCENT)
            background = MoteUi.shape(this@CentralContent, NativeColorRole.TINT, 8); setPadding(moteDp(12), moteDp(8), moteDp(12), moteDp(8))
        }, LinearLayout.LayoutParams(0, -2, 1f))
        scope.addView(MoteUi.button(Button(this).apply { text = MoteI18n.text("本机保留"); setOnClickListener { localPage("LIBRARY") } }))
        collectionBar.addView(scope)
        val entries = MoteNavigation.libraryBrowsePages.mapNotNull { id -> CentralScreens.pages.find { it.first == id } }
        collectionBar.addView(Spinner(this).apply {
            contentDescription = MoteI18n.text("资料类型")
            adapter = MoteUi.choiceAdapter(this@CentralContent, entries.map { MoteI18n.text(it.second) })
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
        composer.removeAllViews(); composer.visibility = View.GONE; updateBackButton()
        revision++; body.removeAllViews(); collectionBar.visibility = View.GONE; title.text = MoteI18n.text("登录中央")
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
            val origin = server; val generation = accessGeneration; credential.setText("")
            work(MoteI18n.text("正在验证令牌…"), {
                check(session.generation == generation) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
                require(token.length in 32..8192 && token.none { it == '\r' || it == '\n' }) { MoteI18n.text("请输入有效的中央所有者令牌") }
                CentralClient(origin, token).get("/api/configuration")
                val config = Settings(this).read()
                val grant = CentralClient(origin, token).post("/api/login/session", org.json.JSONObject().put("serverUrl", origin).put("deviceId", Settings(this).deviceId)
                    .put("deviceName", config.deviceName).put("platform", "android").put("durationMs", duration))
                session.signIn(origin, grant.getString("token"), duration, generation)
                CentralAccess.resolve(this)
            }, allowSessionChange = true) { selected -> applyAccess(selected) }
        }
        button(MoteI18n.text("使用浏览器登录")) { beginBrowserLogin(listOf(0L, 86400000L, 604800000L, 2592000000L)[lifetime.selectedItemPosition]) }
        connectionButton()
    }

    private fun beginBrowserLogin(durationMs: Long) {
        val origin = server; val expected = accessGeneration
        val verifier = android.util.Base64.encodeToString(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
        work(MoteI18n.text("正在连接中央…"), {
            val config = Settings(this).read()
            val (code, value) = HttpJson.post(origin + "/api/login/requests", org.json.JSONObject().put("serverUrl", origin).put("deviceId", Settings(this).deviceId)
                .put("deviceName", config.deviceName).put("platform", "android").put("challenge", SourceRules.hash(verifier)).put("durationMs", durationMs))
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
        text = label; setOnClickListener { if (!task.busy) runCatching { action(); MoteUi.styleSelects(body) }.onFailure { notice(it.message ?: MoteI18n.text("操作失败")) } }
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
    internal fun disclosure(label: String, parent: LinearLayout = body, build: (LinearLayout) -> Unit): LinearLayout {
        val section = card(parent)
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        var built = false
        button(label + "  ›", parent = section) {
            if (!built) { build(content); built = true }
            content.visibility = if (content.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }.apply { contentDescription = label; accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        section.addView(content)
        return section
    }
    internal fun notice(message: String) {
        status.text = message
        status.visibility = if (message.isBlank()) View.GONE else View.VISIBLE
    }
    internal fun enterDetail() { backButton.visibility = View.VISIBLE; revision++; pending.clear(); workPolling.stop(); handler.removeCallbacks(refreshRun) }
    internal fun requestFailure(error: Throwable, generation: Long = accessGeneration) {
        notice((if(page=="ask")screens?.askFailurePresentation(error) else null) ?: error.message ?: MoteI18n.text("操作失败"))
        if (client == null && body.childCount == 0) {
            button(MoteI18n.text("重试")) { recreate() }; connectionButton()
        }
        if (error is CentralFailure && error.status == 401 && error.code in setOf("", "unauthorized")) {
            work(MoteI18n.text("正在退出登录…"), { session.signOut(generation); CentralAccess.resolve(this) }, allowSessionChange = true) { selected -> applyAccess(selected); notice(error.message.orEmpty()) }
        } else {
            handler.removeCallbacks(refreshLogin); handler.post(refreshLogin)
            if (page == "ask") scheduleAskPoll(5000)
        }
    }
    internal fun scheduleAskPoll(delay: Long = 1500) { handler.removeCallbacks(refreshRun); if (resumed && page == "ask") handler.postDelayed(refreshRun, delay) }
    internal fun scheduleMemoryTopicsPoll() { handler.removeCallbacks(refreshRun); if (resumed && page == "memories") handler.postDelayed(refreshRun, 5000) }
    internal fun scheduleActivityPoll(delay: Long = 3000) { workPolling.rearm(delay) }
    internal fun scheduleInsightPoll(delay: Long = 5000) { workPolling.rearm(delay) }
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
        pickerOrigin = server; pickerChat = chat; pickerGeneration = accessGeneration
        val picker = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(if (chat) "image/*" else "*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, if (chat) arrayOf("image/png", "image/jpeg", "image/webp") else arrayOf("image/*", "audio/*"))
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        @Suppress("DEPRECATION") activity.startActivityForResult(picker, 71)
    }
    internal fun saveCentral(path: String, name: String, mime: String) {
        downloadPath = path; downloadOrigin = server; downloadGeneration = accessGeneration
        @Suppress("DEPRECATION") activity.startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime).putExtra(Intent.EXTRA_TITLE, name), 72)
    }
    internal fun pickImport() {
        pickerOrigin = server; pickerGeneration = accessGeneration
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
        if (origin != server || client == null || pickerGeneration != accessGeneration) { notice(MoteI18n.text("登录会话已变更，请重新打开中央页面。")); return }
        if (request == 73) uris.firstOrNull()?.let { screens?.importInstruction = pickerInstruction; screens?.importFile(it) }
        else screens?.addAttachments(uris, chat)
    }
}
