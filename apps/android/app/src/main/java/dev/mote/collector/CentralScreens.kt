package dev.mote.collector

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.net.Uri
import android.provider.OpenableColumns
import android.text.Editable
import android.text.InputFilter
import android.text.TextWatcher
import android.text.style.ReplacementSpan
import android.widget.*
import dev.mote.collector.plugins.NativeAdministrationPlugin
import dev.mote.collector.plugins.NativeAskPlugin
import dev.mote.collector.plugins.NativeWorkDiscoveryPlugin
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import dev.mote.collector.ui.MoteIconButtonStyle
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

internal class CentralScreens(val ui: CentralContent, val body: LinearLayout, private val directory: File) {
    val client get() = requireNotNull(ui.client)
    private val cipher = ui.secretBox()
    private val askOwner = NativeAskPlugin.owner(ui)
    private val ask = askOwner.controller(directory)
    private val noteStore = CentralNoteStore(directory, cipher)
    private val importStore = CentralImports(File(directory, "import-pending"), cipher)
    private val attachmentStore = CentralStateFile(directory, "attachment-times", cipher)
    private val insightStore = CentralStateFile(directory, "insight-request", cipher)
    private val draftFailure = java.util.concurrent.atomic.AtomicReference<Throwable?>(null)
    var importInstruction = ""
    private var player: android.media.MediaPlayer? = null
    @Volatile private var audioFile: File? = null
    fun close() { askFailureDialog?.dismiss(); askFailureDialog = null; player?.release(); player = null; audioFile?.delete(); audioFile = null; admin.close() }
    private val askState get() = ask.state
    private val noteWriter = LatestWriter<JSONObject>(CentralDraftWrites.executor) {
        runCatching { noteStore.edit(it.getString("text"), it.getString("mood"), it.getJSONArray("attachments")) }
            .onSuccess { draftFailure.set(null) }.onFailure(draftFailure::set)
    }
    private var currentPage = "ask"
    private var question: EditText? = null
    private var preset: Spinner? = null
    private var model: EditText? = null
    private var modelSettings = JSONObject()
    private var conversationItems: List<HistoryConversation> = emptyList()
    private var conversationListReadable = false
    private var conversationListFailed = false
    private var conversationListView: ConversationListView? = null
    private var conversationStatus: LinearLayout? = null
    private var submitOnAskEntry = false
    private var lastConversation: JSONObject? = null
    private var lastConversationCursor: String? = null
    private var messages: LinearLayout? = null
    private var scopeBox: LinearLayout? = null
    private var scopeChip: LinearLayout? = null
    private var scopeIcon: ImageView? = null
    private var scopeLabel: TextView? = null
    private var scopeClear: ImageButton? = null
    private var runStatus: TextView? = null
    private var askFailureAction: TextView? = null
    private var askFailureDialog: android.app.AlertDialog? = null
    private var askOffline = false
    private var offlineNotice: LinearLayout? = null
    private var send: android.view.View? = null
    private var stopAction: android.view.View? = null
    private var checkRun: Button? = null
    private var retryRun: Button? = null
    private var askImagesView: LinearLayout? = null
    private var addAskImage: android.view.View? = null
    private var noteText: EditText? = null
    private var noteMood: EditText? = null
    private var noteDraft = JSONObject().put("text", "").put("mood", "").put("attachments", JSONArray())
    private var detailBack: (() -> Unit)? = null
    private var noteHistory = JSONObject()
    private val library = dev.mote.collector.plugins.NativeLibraryPlugin.owner(ui).library(this)
    private val admin = NativeAdministrationPlugin.owner(ui).centralAdmin(this)
    // Work and discovery pages are plugin-owned; this screen only routes to them.
    private val workDiscovery = NativeWorkDiscoveryPlugin.owner(ui)
    private val activity = workDiscovery.work(this)
    private val insights = workDiscovery.insights(this)

    fun show(page: String) {
        currentPage = page; detailBack = null; question = null; messages = null; noteText = null; noteMood = null
        if (page != "ask") submitOnAskEntry = false
        when (page) {
            "ask" -> loadAsk()
            "conversations" -> showConversations()
            "notes" -> loadNotes()
            "overview" -> overview()
            "activity" -> activity.show()
            "files" -> ui.requestedFileId()?.let { id ->
                if (ui.requestedFileOriginMatches()) library.openFile(id) else ui.text(MoteI18n.text("访问凭据已失效，请重新连接。"))
            } ?: library.show(page)
            "archive", "timeline", "materials", "coding", "memories", "insights", "sources", MoteNavigation.SEARCH -> library.show(page)
            else -> if (!ui.pluginRoute(page, body)) admin.show(page)
        }
    }
    fun back(): Boolean = detailBack?.let { detailBack = null; it(); true } ?: false
    fun setBack(action: () -> Unit) { ui.enterDetail(); detailBack = action; question = null; messages = null; close() }
    fun clearBack() { detailBack = null }
    fun resume() { if (currentPage in setOf("plugins", "extensions")) admin.resume(); if (currentPage == "activity") ui.scheduleActivityPoll(); if (currentPage == "memories") ui.scheduleMemoryTopicsPoll(); if (currentPage == "insights") insights.resume() }
    fun pollMemoryTopics() { if (currentPage == "memories") library.pollTopics() }
    fun saveMemoryTopics(out: android.os.Bundle) = library.saveTopics(out)
    fun restoreMemoryTopics(value: android.os.Bundle) = library.restoreTopics(value)
    fun showInsights() = insights.show()
    fun selectInsight(id: String) = insights.select(id)
    fun pollInsight() = insights.poll()
    fun pauseInsights() = insights.pause()
    fun saveInsightState(out: android.os.Bundle) = insights.save(out)
    fun restoreInsightState(value: android.os.Bundle) = insights.restore(value)
    fun pollWorkActivity() { if (currentPage == "activity") activity.poll() }
    internal val isWorkActivityPage get() = currentPage == "activity"
    fun saveWorkState(out: android.os.Bundle) = activity.saveState(out)
    fun restoreWorkState(value: android.os.Bundle, allowMemoryResult: Boolean) = activity.restoreState(value,allowMemoryResult)
    fun openWorkEvidence(ref: String, conversationId: String? = null) {
        val normalized=CentralEvidenceReference.normalize(ref)
        val captureId=CentralEvidenceReference.captureId(normalized)
        if (captureId != null && conversationId != null) library.captureEvidence(captureId,conversationId) else library.evidence(normalized)
    }
    fun openWorkMemory(id: String, returnTo: () -> Unit, accept: (JSONObject) -> Boolean, verify: (CentralClient) -> Boolean, reference: () -> WorkMemoryReference?, onOpened: () -> Unit, onFailure: (Throwable) -> Unit) = library.openWorkMemory(id,returnTo,accept,verify,reference,onOpened,onFailure)
    fun restoreWorkMemoryAfterReader(work: String, scroll: Int) = activity.restoreMemoryAfterReader(work,scroll)
    fun retainWorkMemoryForRecreation(work: String) = activity.retainMemoryForRecreation(work)
    fun clearPrivateState() {
        detailBack=null
        WorkMemoryDrafts.clear()
        askFailureDialog?.dismiss(); askFailureDialog = null; askFailureAction = null
        ask.clearImageReferences()
        askImagesView?.removeAllViews();askImagesView=null;addAskImage=null
        askOffline = false; offlineNotice = null; stopAction = null
        scopeBox=null;scopeChip=null;scopeIcon=null;scopeLabel=null;scopeClear=null
        ask.reset(); conversationItems = emptyList(); conversationListReadable = false; conversationListFailed = false
        conversationListView = null; conversationStatus = null; submitOnAskEntry = false
        modelSettings = JSONObject(); lastConversation = null; question = null; messages = null; noteText = null; noteMood = null; admin.clearPrivateState(); activity.clearPrivateState(); library.clearTopics(); insights.clear(); body.removeAllViews()
    }
    fun refresh() { if (currentPage == "insights") insights.returnFromEvidence(); ui.navigate(currentPage) }
    fun showOriginalDetail(detail: OriginalDetailPresentation) {
        NativeOriginalDetail.show(ui.hostActivity(), detail)
    }
    fun insightRequest(prompt: String): JSONObject = CentralDraftWrites.barrier {
        val saved = insightStore.read()
        if (saved.has("requestId")) saved else JSONObject().put("requestId", UUID.randomUUID().toString())
            .put("timeZone", java.time.ZoneId.systemDefault().id).apply { if (prompt.isNotBlank()) put("prompt", prompt) }
            .also(insightStore::write)
    }
    fun pendingInsightRequest(): JSONObject = CentralDraftWrites.barrier { insightStore.read() }
    fun insightAccepted() = CentralDraftWrites.barrier { insightStore.write(JSONObject()) }
    fun askAbout(id: String, label: String? = null) {
        UUID.fromString(id)
        if (!ask.beginEvidence(id, label)) { ui.notice(MoteI18n.text("请先等待当前回答完成，或停止回答。")); return }
        persistAsk(); ui.navigate("ask")
    }
    fun askAboutMaterial(reference: String, label: String? = null) {
        if(ask.busy()) { ui.notice(MoteI18n.text("请先等待当前回答完成，或停止回答。")); return }
        verifyMaterial(reference,loadDraft=true) { state ->
            ask.replace(state)
            if(!ask.beginMaterial(reference,label)) { ui.notice(MoteI18n.text("请先等待当前回答完成，或停止回答。")); return@verifyMaterial }
            persistAsk(); ui.navigate("ask")
        }
    }
    private fun verifyMaterial(reference: String, loadDraft: Boolean=false, done: (JSONObject) -> Unit) {
        val match=Regex("material:(mat_[a-f0-9]{64})@([a-f0-9]{64})").matchEntire(reference) ?: return
        val api=client; val id=match.groupValues[1]; val revision=match.groupValues[2]
        ui.work(MoteI18n.text("正在读取原文…"), {
            try {
                val read=api.get("/api/materials/"+encode(id)+"/read?revision="+encode(revision)+"&offset=0&length=1").getJSONObject("material")
                val current=api.get("/api/materials/"+encode(id))
                check(read.getString("id")==id && read.getString("revision")==revision && current.getString("revision")==revision) { MoteI18n.text("所选资料版本已变更或不可用。请清除参考或重新选择；草稿已保留。") }
                if(loadDraft) ask.readDraft() else JSONObject()
            } catch(error:CentralFailure) {
                if(error.status in setOf(404,409))throw IllegalStateException(MoteI18n.text("所选资料版本已变更或不可用。请清除参考或重新选择；草稿已保留。"),error)
                throw error
            }
        }) { done(it) }
    }
    private fun persistAsk() = ask.persist()
    private fun watch(field: EditText, changed: () -> Unit) {
        field.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = changed()
            override fun afterTextChanged(s: Editable?) = Unit
        })
    }

    private fun overview() {
        ui.button(MoteI18n.text("刷新")) { refresh() }
        val target = ui.card()
        val api = client
        ui.work(MoteI18n.text("正在连接中央…"), {
            listOf(api.get("/api/status"), api.get("/api/devices"), api.get("/api/operations?limit=5"))
        }) { data ->
            val status = data[0]
            ui.text(MoteI18n.text("中央工作台"), NativeFontRole.TITLE_MOBILE, target)
            val agent = status.getJSONObject("agent")
            ui.text(if (agent.optBoolean("configured")) MoteI18n.text("模型已配置") else MoteI18n.text("请先配置模型服务"), parent = target)
            ui.text(agent.optString("model"), parent = target)
            admin.values(status.optJSONObject("storage") ?: JSONObject(), target)
            ui.text(MoteI18n.text("设备"), NativeFontRole.SECTION, target)
            val devices = data[1].optJSONArray("items") ?: JSONArray()
            for (i in 0 until devices.length()) {
                val device = devices.getJSONObject(i)
                ui.text(device.optString("deviceName") + " · " + device.optString("lastSeenAt"), parent = target)
            }
            ui.text(MoteI18n.text("处理任务"), NativeFontRole.SECTION, target)
            admin.items(data[2], target) { row -> admin.operation(row.optString("id")) }
        }
        ui.button(MoteI18n.text("资料库")) { ui.navigate("archive") }
        ui.button(MoteI18n.text("日程建议")) {
            ui.startActivity(android.content.Intent(ui, CalendarActionsActivity::class.java))
        }
        ui.button(MoteI18n.text("Agent 视角")) { ui.navigate("agentView") }
    }

    internal val selectedAskConversationId get()=askState.optString("conversationId").takeIf { it.isNotBlank() && lastConversation?.optString("id")==it }
    private fun loadAsk() {
        val api = client
        val requestedConversation=ui.requestedAskConversation()
        ui.work(MoteI18n.text("正在读取对话…"), {
            val state = ask.readDraft()
            val remote = runCatching {
                val runs = api.get("/api/query-runs").getJSONArray("items")
                ask.adoptRunning(runs, requestedConversation, state)
                api.get("/api/model-settings")
            }
            remote.exceptionOrNull()?.let { if (it is CentralFailure && it.status in setOf(401,403)) throw it }
            state to remote
        }) { (state, remote) ->
            ask.replace(state)
            var scopeRefused = false
            ui.takeAskEvidence()?.let { evidence -> scopeRefused = !ask.beginEvidence(evidence.id, evidence.label) }
            persistAsk()
            remote.getOrNull()?.let { modelSettings = it }
            buildAsk()
            if (scopeRefused) ui.notice(MoteI18n.text("请先等待当前回答完成，或停止回答。"))
            val conversationId = askState.optString("conversationId")
            if (conversationId.isNotBlank()) {
                if (remote.isSuccess) loadConversation(conversationId)
                else lastConversation?.takeIf { it.optString("id") == conversationId }?.let(::renderConversation)
            }
            remote.exceptionOrNull()?.let { error ->
                // An unreachable Central is owned by the composer notice and its
                // retry; other read failures still need an inline retry here.
                if (error is CentralFailure) ui.button(MoteI18n.text("重试"), parent = messages ?: body) { refresh() }
                ui.requestFailure(error)
            }
            ui.requestedAskConversation()?.let { selectConversation(it,fromIntent=true) }
            if (askState.has("runId") || askState.has("pending")) ui.scheduleAskPoll()
            if (submitOnAskEntry) { submitOnAskEntry = false; submitAsk() }
        }
    }
    private fun buildAsk() {
        body.removeAllViews()
        body.setPadding(ui.moteDp(20), ui.moteDp(18), ui.moteDp(20), ui.moteDp(24))
        messages = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }.also(body::addView)
        runStatus = ui.text("", parent = messages!!).apply { visibility = android.view.View.GONE; setPadding(0,0,0,0) }
        val conversation = askState.optString("conversationId").isNotBlank()
        ui.askConversationVisible(conversation)
        ui.askBackToHistory = if (conversation) { { if (currentPage == "ask" && messages != null) { ui.openConversationList(); true } else false } } else null
        if (!conversation) ui.text(MoteI18n.text("想从留下的内容里找什么？"), NativeFontRole.TITLE_MOBILE, messages!!)
        val compose = ui.askComposer()
        offlineNotice = offlineRow().also(compose::addView)
        askImagesView=LinearLayout(ui).apply { orientation=LinearLayout.VERTICAL }.also(compose::addView)
        scopeBox = LinearLayout(ui).apply { orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.START or android.view.Gravity.CENTER_VERTICAL }.also(compose::addView)
        val chipFrame = android.widget.FrameLayout(ui).apply {
            minimumHeight = ui.moteDp(48)
        }
        scopeChip = LinearLayout(ui).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL
            minimumHeight = ui.moteDp(30); setPadding(ui.moteDp(12), 0, ui.moteDp(4), 0)
        }.also { chipFrame.addView(it, android.widget.FrameLayout.LayoutParams(-2, ui.moteDp(30)).apply { gravity = android.view.Gravity.START or android.view.Gravity.CENTER_VERTICAL }) }
        scopeIcon = MoteComponents.icon(ui, MoteGlyph.FILE, NativeColorRole.ACCENT, 16).also {
            scopeChip!!.addView(it, LinearLayout.LayoutParams(-2,-2).apply { marginEnd = ui.moteDp(6) })
        }
        scopeLabel = TextView(ui).apply {
            MoteUi.type(this, 13)
            gravity = android.view.Gravity.CENTER_VERTICAL; isFocusable = true
            maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; maxWidth = ui.moteDp(220)
            setOnClickListener {
                if(ui.isWorking)return@setOnClickListener
                ask.material()?.let { reference ->
                    MoteDialogBuilder(ui).setTitle(MoteI18n.text("调整参考范围")).setItems(arrayOf(MoteI18n.text("查看所选资料版本"),MoteI18n.text("清除范围"))) { _,index ->
                        if(index==0)library.evidence(reference)
                        else if(ask.clearScope()) { persistAsk(); updateScope() } else ui.notice(MoteI18n.text("请先等待当前回答完成，或停止回答。"))
                    }.show(); return@setOnClickListener
                }
                val id = (askState.optJSONArray("anchorEvidenceIds") ?: askState.optJSONArray("evidenceIds"))?.optString(0)
                if (id.isNullOrBlank()) { ui.navigate("archive"); return@setOnClickListener }
                val labels = listOf("参考这条记录，自动查找相关上下文", "仅查这条记录", "清除范围")
                MoteDialogBuilder(ui).setTitle(MoteI18n.text("调整参考范围")).setItems(labels.map { MoteI18n.text(it) }.toTypedArray()) { _, index ->
                    val accepted = when (index) { 0 -> ask.selectEvidence(id, label = ask.scopeLabel()); 1 -> ask.selectEvidence(id, only = true, label = ask.scopeLabel()); else -> ask.clearScope() }
                    if (accepted) { persistAsk(); updateScope() } else ui.notice(MoteI18n.text("请先等待当前回答完成，或停止回答。"))
                }.show()
            }
        }.also { scopeChip!!.addView(it, LinearLayout.LayoutParams(-2,-2)) }
        scopeClear = MoteComponents.iconButton(ui, MoteGlyph.CLOSE, "清除范围", MoteIconButtonStyle.MUTED) {
            if(ui.isWorking)return@iconButton
            if(ask.clearScope()) { persistAsk(); updateScope() } else ui.notice(MoteI18n.text("请先等待当前回答完成，或停止回答。"))
        }.apply {
            tag="scope-clear"
            minimumWidth=ui.moteDp(26); minimumHeight=ui.moteDp(30); scaleType=android.widget.ImageView.ScaleType.CENTER
            NativePresentationStyles.bind(this, "scope-clear-tint") { value ->
                (value as ImageButton).imageTintList = android.content.res.ColorStateList.valueOf(MoteUi.accent)
            }
        }.also { scopeChip!!.addView(it, LinearLayout.LayoutParams(ui.moteDp(26), ui.moteDp(30))) }
        scopeBox!!.addView(chipFrame, LinearLayout.LayoutParams(-2, ui.moteDp(48)))
        updateScope()

        val pill = LinearLayout(ui).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL
            minimumHeight = ui.moteDp(50)
            setPadding(ui.moteDp(2), 0, ui.moteDp(4), 0)
            NativePresentationStyles.bind(this, "ask-composer-pill") {
                it.background = MoteUi.shape(ui, NativeColorRole.SURFACE, NativeRadiusRole.PILL, true, NativeColorRole.CONTROL_BORDER)
            }
        }
        compose.addView(pill, LinearLayout.LayoutParams(-1, ui.moteDp(50)))
        addAskImage = MoteComponents.iconButton(ui, MoteGlyph.PHOTO, "添加图片", MoteIconButtonStyle.MUTED) {
            if (!askBusy() && ask.imageCount()<4) ui.pickAttachment(chat = true)
        }.also { pill.addView(it, LinearLayout.LayoutParams(ui.moteDp(44), ui.moteDp(48))) }
        question = EditText(ui).apply {
            hint = MoteI18n.text(if (askState.optString("conversationId").isNotBlank()) "继续问" else "问一问")
            contentDescription = MoteI18n.text("你的问题"); isSaveEnabled = false
            inputType = android.text.InputType.TYPE_CLASS_TEXT
            MoteUi.textInput(this, android.text.InputType.TYPE_CLASS_TEXT, multiline = false)
            filters = arrayOf(InputFilter.LengthFilter(8000)); setText(askState.optString("question"))
            MoteUi.type(this, 15); MoteUi.textColor(this, NativeColorRole.INK); setTextColor(MoteTheme.ink); setHintTextColor(MoteTheme.muted)
            background = null; setPadding(ui.moteDp(6), 0, ui.moteDp(6), 0); includeFontPadding = false
            maxLines = 1; minLines = 1; setSingleLine(true); imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_NONE
        }.also { pill.addView(it, LinearLayout.LayoutParams(0, ui.moteDp(48), 1f)) }
        send = MoteComponents.iconButton(ui, MoteGlyph.UP, "发送", MoteIconButtonStyle.SOLID) { submitAsk() }.apply {
            tag = "ask-send"
            NativePresentationStyles.bind(this, "ask-send") { (it as ImageButton).apply {
                minimumWidth = ui.moteDp(40); minimumHeight = ui.moteDp(40)
                background = MoteUi.clickable(ui, NativeColorRole.PRIMARY_BACKGROUND, NativeRadiusRole.PILL, false)
            } }
        }.also { pill.addView(it, LinearLayout.LayoutParams(ui.moteDp(40), ui.moteDp(40)).apply { marginStart = ui.moteDp(4) }) }
        stopAction = MoteComponents.iconButton(ui, MoteGlyph.STOP, "停止回答", MoteIconButtonStyle.FILLED) { stopAsk() }.apply {
            tag = "ask-stop"
        }.also { pill.addView(it, LinearLayout.LayoutParams(ui.moteDp(40), ui.moteDp(40)).apply { marginStart = ui.moteDp(4) }) }
        watch(question!!) { askState.put("question", question!!.text.toString()); persistAsk(); controlsAsk() }

        if (!conversation) {
            val meta = LinearLayout(ui).apply { orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL }.also(compose::addView)
            fun action(label: String, description: String = label): TextView = TextView(ui).apply {
                text = label; contentDescription = MoteI18n.text(description); MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED)
                isFocusable = true; minHeight = ui.moteDp(48); gravity = android.view.Gravity.CENTER; setPadding(ui.moteDp(8), 0, ui.moteDp(8), 0)
            }
            val modelRow = action("▸ " + MoteI18n.text("本次模型"), "本次模型")
            meta.addView(modelRow, LinearLayout.LayoutParams(-2, ui.moteDp(48)))
            modelRow.setOnClickListener { modelBoxVisibility(label = modelRow) }
            val box = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL; visibility = android.view.View.GONE }
            modelBox = box
            compose.addView(box, LinearLayout.LayoutParams(-1, -2))
            val profiles = modelSettings.optJSONArray("profiles") ?: JSONArray()
            val storedProfile = askState.optString("modelProfileId")
            val knownProfiles = (0 until profiles.length()).map { profiles.getJSONObject(it).getString("id") }
            val missingSelection = storedProfile.isNotBlank() && storedProfile !in knownProfiles
            val ids = listOf("") + knownProfiles + if (missingSelection) listOf(storedProfile) else emptyList()
            val names = listOf(MoteI18n.text("跟随功能默认")) + (0 until profiles.length()).map { profiles.getJSONObject(it).getString("name") } + if (missingSelection) listOf(storedProfile) else emptyList()
            ui.text(MoteI18n.text("模型预设"), NativeFontRole.SUPPORT, box)
            preset = Spinner(ui).apply {
                adapter = MoteUi.choiceAdapter(ui, names); setSelection(ids.indexOf(askState.optString("modelProfileId")).coerceAtLeast(0))
                onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                    override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) { askState.put("modelProfileId", ids[position]); persistAsk() }
                    override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                }
            }.also(box::addView)
            model = ui.field(MoteI18n.text("模型 ID（留空跟随预设）"), askState.optString("modelOverride"), parent = box).apply { filters = arrayOf(InputFilter.LengthFilter(512)) }
            watch(model!!) { askState.put("modelOverride", model!!.text.toString()); persistAsk() }
        } else {
            modelBox = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL; visibility = android.view.View.GONE }
            preset = null; model = null
        }
        renderAskImages()
        retryRun = ui.button(MoteI18n.text("重试同一请求"), parent = compose) { submitAsk() }
        checkRun = ui.button(MoteI18n.text("检查结果"), parent = compose) { pollAsk() }
        updateAskFailureAction()
        controlsAsk()
    }

    private fun stopAsk() {
        val id = ask.currentId(); if (id.isBlank()) return
        val api = client
        ui.work(MoteI18n.text("正在停止回答…"), { api.post("/api/query-runs/" + encode(id) + "/cancel") }) { run -> receiveRun(run) }
    }

    /** The composer banner for an unreachable Central owner; the conversation
     * already on screen stays readable and the retry reloads it. */
    private fun offlineRow(): LinearLayout = LinearLayout(ui).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL
        minimumHeight = ui.moteDp(48); visibility = if (askOffline) android.view.View.VISIBLE else android.view.View.GONE
        setPadding(ui.moteDp(16), 0, ui.moteDp(5), 0)
        NativePresentationStyles.bind(this, "ask-offline") {
            it.background = MoteUi.shape(ui, NativeColorRole.WARNING_TINT, NativeRadiusRole.PILL, false)
        }
        addView(MoteComponents.icon(ui, MoteGlyph.ALERT, NativeColorRole.WARNING, 20),
            LinearLayout.LayoutParams(ui.moteDp(20), ui.moteDp(20)).apply { marginEnd = ui.moteDp(10) })
        addView(TextView(ui).apply {
            text = MoteI18n.text("没有连上中央"); MoteUi.type(this, NativeFontRole.ROW); MoteUi.textColor(this, NativeColorRole.INK)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        // The visible pill stays 34dp like every notice action; the inset keeps
        // the whole 48dp Android touch target.
        addView(TextView(ui).apply {
            text = MoteI18n.text("重试"); contentDescription = MoteI18n.text("重试")
            MoteUi.type(this, 13, medium = true); MoteUi.textColor(this, NativeColorRole.INK)
            gravity = android.view.Gravity.CENTER; isFocusable = true; maxLines = 1
            minimumWidth = ui.moteDp(48); minimumHeight = ui.moteDp(48)
            setPadding(ui.moteDp(12), 0, ui.moteDp(12), 0)
            NativePresentationStyles.bind(this, "ask-offline-retry") {
                it.background = android.graphics.drawable.InsetDrawable(
                    MoteUi.clickable(ui, NativeColorRole.FILL, NativeRadiusRole.PILL, false),
                    0, ui.moteDp(7), 0, ui.moteDp(7),
                )
            }
            setOnClickListener { if (!ui.isWorking && askOffline) ui.retryAsk() }
        }, LinearLayout.LayoutParams(-2, ui.moteDp(48)))
    }.also { row -> row.layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = ui.moteDp(8) } }

    internal fun showOffline() {
        if (currentPage != "ask") return
        askOffline = true
        offlineNotice?.visibility = android.view.View.VISIBLE
        controlsAsk()
    }

    internal fun clearOffline() {
        askOffline = false
        offlineNotice?.visibility = android.view.View.GONE
    }
    private var modelBox: LinearLayout? = null
    private fun modelBoxVisibility(label: TextView) {
        val box = modelBox ?: return
        val show = box.visibility != android.view.View.VISIBLE
        box.visibility = if (show) android.view.View.VISIBLE else android.view.View.GONE
        label.text = (if (show) "▾ " else "▸ ") + MoteI18n.text("本次模型")
    }

    private fun askBusy() = ask.busy()
    private fun showConversations() {
        ui.detailTitle("")
        body.removeAllViews()
        body.setPadding(ui.moteDp(16), 0, ui.moteDp(16), ui.moteDp(24))
        body.addView(TextView(ui).apply {
            tag = "central-title"
            text = MoteI18n.text("对话"); MoteUi.type(this, NativeFontRole.TITLE_MOBILE, medium = true)
            MoteUi.textColor(this, NativeColorRole.INK); setPadding(ui.moteDp(4), ui.moteDp(2), ui.moteDp(4), 0)
        })
        conversationStatus = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
            .also { body.addView(it, LinearLayout.LayoutParams(-1, -2)) }
        conversationListView = ConversationListView(ui, onOpen = ::openConversation, onActions = ::conversationRowActions)
            .also { body.addView(it, LinearLayout.LayoutParams(-1, -2)) }
        val dock = ui.conversationComposer()
        dock.addView(ConversationComposerView(ui,
            onAddImage = { if (askBusy()) ui.notice(MoteI18n.text("请先等待当前回答完成，或停止回答。")) else ui.pickAttachment(chat = true) },
            onSend = ::sendConversationQuestion), LinearLayout.LayoutParams(-1, -2))
        renderConversationStatus()
        loadConversations()
    }
    private fun loadConversations() {
        if (currentPage != "conversations") return
        val api = client
        conversationListFailed = false
        renderConversationStatus()
        ui.work(MoteI18n.text("正在读取对话…"), {
            runCatching {
                val collected = mutableListOf<HistoryConversation>()
                val seen = mutableSetOf<String>()
                var cursor: String? = null
                do {
                    val page = api.get("/api/conversations?limit=30" + (cursor?.let { "&cursor=" + encode(it) } ?: ""))
                    collected.addAll(ConversationHistory.items(page.getJSONArray("items")))
                    cursor = next(page)?.takeIf { seen.add(it) }
                } while (cursor != null)
                collected
            }
        }) { result ->
            result.onSuccess { items ->
                conversationItems = items; conversationListReadable = true; conversationListFailed = false
                renderConversationStatus(); renderConversationList()
            }.onFailure { error ->
                conversationListFailed = true
                renderConversationStatus(); renderConversationList()
                ui.requestFailure(error)
            }
        }
    }
    fun refreshConversationList() { if (currentPage == "conversations") loadConversations() }
    private fun renderConversationStatus() {
        val box = conversationStatus ?: return
        box.removeAllViews()
        when {
            conversationListFailed -> {
                ui.text(MoteI18n.text("对话暂不可读取，请稍后重试。"), NativeFontRole.SUPPORT, box)
                box.addView(MoteUi.action(Button(ui).apply {
                    text = MoteI18n.text("重试"); setOnClickListener { if (!ui.isWorking) loadConversations() }
                }, MoteUi.ButtonRole.TEXT), LinearLayout.LayoutParams(-2, -2))
            }
            !conversationListReadable && conversationItems.isEmpty() -> ui.text(MoteI18n.text("正在读取对话…"), NativeFontRole.SUPPORT, box)
        }
        box.visibility = if (box.childCount == 0) android.view.View.GONE else android.view.View.VISIBLE
    }
    private fun renderConversationList() { conversationListView?.render(conversationItems) }
    private fun openConversation(id: String) { selectConversation(id, then = { ui.navigate("ask") }) }
    private fun conversationRowActions(id: String) {
        if (currentPage != "conversations" || askBusy()) return
        val api = client
        val selected = CentralAccess.resolve(ui); val expected = selected.server to selected.generation
        fun current() = ui.client === api && currentPage == "conversations" &&
            CentralAccess.resolve(ui).let { (it.server to it.generation) == expected }
        val details = ConversationHistory.deleteFailure(askState, id)
        val actions = ConversationHistory.deleteActions(askState, id)
        MoteDialogBuilder(ui).setTitle(MoteI18n.text("对话"))
            .setItems(actions.map { MoteI18n.text(it) }.toTypedArray()) { _, index ->
                if (!current()) return@setItems
                if (index == 1) { details?.let { showAskFailureDetails(it) }; return@setItems }
                MoteDialogBuilder(ui).setTitle(MoteI18n.text("删除整段对话？")).setMessage(MoteI18n.text("会删除这段对话的所有问答。已单独保存的记录保留。"))
                    .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("删除对话")) { _, _ ->
                    if (!current()) return@setPositiveButton
                    ui.work(MoteI18n.text("正在删除…"), { runCatching { api.delete("/api/conversations/" + encode(id)) } }) { outcome ->
                        outcome.onSuccess {
                            ConversationHistory.clearDeleteFailure(askState, id)
                            if (askState.optString("conversationId") == id) { askState.remove("conversationId"); askState.remove("runId"); lastConversation = null }
                            conversationItems = conversationItems.filterNot { it.id == id }
                            persistAsk(); renderConversationList()
                        }.onFailure { error ->
                            ConversationHistory.recordDeleteFailure(askState, id, error); persistAsk()
                            // Keep authentication withdrawal and conflict handling at the original shared boundary.
                            ui.requestFailure(error)
                            if (error !is CentralFailure || error.status !in setOf(401, 403, 409, 410)) ui.notice(MoteI18n.text("未能确认删除完成。请刷新查看当前状态。"))
                        }
                    }
                }.show()
            }.show()
    }
    private fun sendConversationQuestion(text: String) {
        val value = text.trim()
        if (value.isEmpty() || currentPage != "conversations") return
        if (askBusy()) { ui.notice(MoteI18n.text("请先等待当前回答完成，或停止回答。")); return }
        if (ask.hasDraft()) {
            val selected = CentralAccess.resolve(ui); val expected = selected.server to selected.generation
            fun current() = currentPage == "conversations" && CentralAccess.resolve(ui).let { (it.server to it.generation) == expected }
            MoteDialogBuilder(ui).setTitle(MoteI18n.text("还有未发送的内容"))
                .setMessage(MoteI18n.text("切换对话会舍弃当前输入和图片。你也可以留在这里继续编辑。"))
                .setNegativeButton(MoteI18n.text("继续编辑"), null)
                .setPositiveButton(MoteI18n.text("舍弃并切换")) { _, _ -> if (current()) sendConversationQuestionNow(value) }
                .show()
            return
        }
        sendConversationQuestionNow(value)
    }
    private fun sendConversationQuestionNow(value: String) {
        ui.clearAskConversationIntent()
        ask.startConversation(value)
        persistAsk()
        submitOnAskEntry = true
        ui.navigate("ask")
    }
    private fun selectConversation(id: String, discardConfirmed: Boolean = false, fromIntent:Boolean=false, then: (() -> Unit)? = null) {
        if(fromIntent && ui.requestedAskConversation()!=id)return
        if (runCatching { UUID.fromString(id) }.isFailure) { ui.notice(MoteI18n.text("请求的资源不存在或已删除。")); return }
        if (askState.optString("conversationId") == id) { ui.acceptAskConversation(id); if (then != null) then() else refresh(); return }
        if (askState.has("pending") || askState.optString("runStatus") == "running") {
            ui.notice(MoteI18n.text("请先等待当前回答完成，或停止回答。")); return
        }
        if (!discardConfirmed && ask.hasDraft()) {
            val selected=CentralAccess.resolve(ui);val expected=selected.server to selected.generation
            fun current():Boolean=CentralAccess.resolve(ui).let { (it.server to it.generation)==expected } && (!fromIntent || ui.requestedAskConversation()==id)
            MoteDialogBuilder(ui).setTitle(MoteI18n.text("还有未发送的内容"))
                .setMessage(MoteI18n.text("切换对话会舍弃当前输入和图片。你也可以留在这里继续编辑。"))
                .setNegativeButton(MoteI18n.text("继续编辑")) { _,_->if(current()&&fromIntent){ui.clearAskConversationIntent();controlsAsk()} }
                .setPositiveButton(MoteI18n.text("舍弃并切换")) { _, _ -> if(current())selectConversation(id, true,fromIntent,then) }.show()
            return
        }
        if(fromIntent)ui.acceptAskConversation(id)else ui.clearAskConversationIntent()
        ask.selectConversation(id)
        question?.setText(""); persistAsk(); if (then != null) then() else refresh()
    }

    internal fun askFailurePresentation(error: Throwable): String? {
        if (currentPage != "ask" || detailBack != null || (!askBusy() && askState.optString("runStatus") != "failed")) return null
        if (error is CentralFailure && error.status in setOf(401,403)) return null
        val chain = JSONArray(); var value: Throwable? = error
        val seen = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Throwable,Boolean>())
        while (value != null && seen.add(value)) {
            val current=value
            chain.put(JSONObject().put("message",current.message.orEmpty()).apply { if(current is CentralFailure) { put("status",current.status);put("code",current.code);put("detail",current.detail) } });value=current.cause
        }
        val requestId=ask.currentId()
        val details=askState.optJSONObject("failureDetails")?.takeIf { it.optString("requestId")==requestId }?.let { JSONObject(it.toString()) } ?: JSONObject().put("requestId",requestId)
        val errors=details.optJSONArray("errors") ?: JSONArray()
        for(index in 0 until chain.length())errors.put(chain.getJSONObject(index))
        askState.put("failureDetails",details.put("errors",errors));persistAsk();updateAskFailureAction()
        return MoteI18n.text(if(askBusy()) "结果尚未确认，请检查或重试原请求。" else "回答未完成")
    }
    private fun updateAskFailureAction() {
        val target=messages ?: return
        if (askFailureAction?.parent !== target) askFailureAction=conversationAction(target,"查看详情") {
            askState.optJSONObject("failureDetails")?.let { showAskFailureDetails(it,true) }
        }.apply { tag="ask-error-details" }
        askFailureAction?.visibility=if(askState.optJSONObject("failureDetails")?.optString("requestId")==ask.currentId()) android.view.View.VISIBLE else android.view.View.GONE
    }
    private fun showAskFailureDetails(details:JSONObject,currentRequest:Boolean=false) {
        val content=LinearLayout(ui).apply { orientation=LinearLayout.VERTICAL;setPadding(ui.moteDp(20),ui.moteDp(12),ui.moteDp(20),ui.moteDp(20)) }
        ui.text(details.toString(2),NativeFontRole.SUPPORT,content)
        if(currentRequest && details.optString("requestId")==ask.currentId()) (askState.optJSONObject("pending") ?: askState.optJSONObject("activeRequest"))?.let { ui.text(it.toString(2),NativeFontRole.SUPPORT,content).tag="ask-error-original-request" }
        askFailureDialog?.dismiss();askFailureDialog=MoteDialogBuilder(ui).setTitle(MoteI18n.text("查看详情")).setView(ScrollView(ui).apply { addView(content) }).setPositiveButton(MoteI18n.text("关闭"),null).show()
    }
    private fun controlsAsk() {
        val requested = ui.requestedAskConversation()
        val state = AskGenerationPresentation.read(
            askState,
            question?.text?.toString().orEmpty(),
            ask.pendingImages().length() > 0,
            askOffline,
            requested == null || askState.optString("conversationId") == requested,
        )
        val locked = state.busy || state.offline
        question?.isEnabled = !locked
        preset?.isEnabled = !locked; model?.isEnabled = !locked
        send?.isEnabled = state.canSend
        send?.visibility = if (state.canSend) android.view.View.VISIBLE else android.view.View.GONE
        stopAction?.visibility = if (state.stop) android.view.View.VISIBLE else android.view.View.GONE
        addAskImage?.isEnabled = !locked && ask.imageCount() < 4
        askImagesView?.let { host -> fun update(view:android.view.View) { if(view is Button)view.isEnabled=!locked && (view.tag?.toString()?.startsWith("ask-image-remove:")==true || !ui.isWorking);if(view is android.view.ViewGroup)for(i in 0 until view.childCount)update(view.getChildAt(i)) };update(host) }
        retryRun?.visibility = if (state.retry) android.view.View.VISIBLE else android.view.View.GONE
        checkRun?.visibility = if (state.check) android.view.View.VISIBLE else android.view.View.GONE
        offlineNotice?.visibility = if (state.offline) android.view.View.VISIBLE else android.view.View.GONE
        askFailureAction?.visibility=if(askState.optJSONObject("failureDetails")?.optString("requestId")==ask.currentId()) android.view.View.VISIBLE else android.view.View.GONE
    }
    private fun updateScope() {
        val strict = (askState.optJSONArray("evidenceIds")?.length() ?: 0) > 0
        val anchored = (askState.optJSONArray("anchorEvidenceIds")?.length() ?: 0) > 0
        val material=ask.material()
        val scoped = material != null || strict || anchored
        val fallback = when {
            material != null -> MoteI18n.text("参考整份资料")
            strict -> MoteI18n.text("仅查这条记录")
            anchored -> MoteI18n.text("参考这条记录，自动查找相关上下文")
            else -> "＋ " + MoteI18n.text("参考资料")
        }
        val label = if (scoped) ask.scopeLabel() ?: fallback else fallback
        scopeBox?.visibility = if (scoped || askState.optString("conversationId").isBlank()) android.view.View.VISIBLE else android.view.View.GONE
        scopeChip?.let { chip ->
            NativePresentationStyles.bind(chip, "scope-chip") { value ->
                (value as LinearLayout).apply {
                    background = if (scoped) MoteUi.shape(ui, NativeColorRole.TINT, NativeRadiusRole.PILL, false) else null
                    setPadding(ui.moteDp(if (scoped) 12 else 0), 0, 0, 0)
                }
            }
        }
        scopeIcon?.visibility = if (scoped) android.view.View.VISIBLE else android.view.View.GONE
        scopeLabel?.let { view ->
            view.text = label
            view.contentDescription = material ?: label
            NativePresentationStyles.bind(view, "scope-text") { value -> (value as TextView).setTextColor(if (scoped) MoteUi.accent else MoteUi.muted) }
        }
        scopeClear?.visibility = if (scoped) android.view.View.VISIBLE else android.view.View.GONE
    }
    private data class AskAdmission(val run:JSONObject?=null,val materialRejected:Boolean=false)
    private fun submitAsk(validatedMaterial: String? = null) {
        val target=ui.requestedAskConversation()
        if(!askState.has("pending") && target!=null && target!=askState.optString("conversationId")) { selectConversation(target,fromIntent=true);return }
        val api = client
        if(!askState.has("pending") && ask.pendingImages().length()>0) { ui.notice(MoteI18n.text("请先重试或移除尚未上传完成的图片。"));return }
        val reference=ask.material()
        if(!askState.has("pending") && reference!=null && validatedMaterial!=reference) {
            val draft=askState.toString()
            verifyMaterial(reference) {
                if(askState.toString()==draft)submitAsk(reference)
                else ui.notice(MoteI18n.text("草稿已保留，请确认当前内容后重新发送。"))
            }; return
        }
        val request = askState.optJSONObject("pending") ?: run {
            val text = question?.text?.toString()?.trim().orEmpty()
            if (text.isBlank()) { ui.notice(MoteI18n.text("请输入问题（最多 8000 字）")); return }
            ask.admission(text, java.time.ZoneId.systemDefault().id) ?: return
        }
        persistAsk(); controlsAsk()
        val snapshot = JSONObject(askState.toString())
        ui.work(MoteI18n.text("正在发送问题…"), {
            ask.persistNow(snapshot)
            // Retrying preserves the admission ID even when the first response was lost.
            try { AskAdmission(api.post("/api/query-runs", request).also { ask.validate(it,request.getString("id")) }) }
            catch(error:Exception) {
                if(error is CentralFailure && error.status in setOf(401,403))throw error
                if(error is CentralFailure && error.status==409 && error.code=="context_evidence_restricted" && ask.material(request.getJSONObject("input"))!=null) return@work AskAdmission(materialRejected=true)
                throw IllegalStateException(MoteI18n.text("请求尚未确认，可重试同一请求。")+"\n"+error.message.orEmpty(),error)
            }
        }) { admission ->
            if(admission.materialRejected) { ask.materialRejected(); controlsAsk(); ui.notice(MoteI18n.text("所选资料版本已变更或不可用。请清除参考或重新选择；草稿已保留。")) }
            else receiveRun(admission.run!!,request.getString("id"),request)
        }
    }
    fun pollAsk() {
        if (currentPage != "ask" || detailBack != null) return
        // Returning to a tab must not replay a completed run and clear the next unsent draft.
        if (!askState.has("pending") && askState.optString("runStatus") in setOf("completed", "cancelled", "failed")) return
        val id = ask.currentId()
        if (id.isBlank()) return
        val api = client
        ui.work(MoteI18n.text("正在读取回答进度…"), {
            try { api.get("/api/query-runs/" + encode(id)) } catch (error: CentralFailure) {
                if (error.status == 404) JSONObject().put("id", id).put("status", "missing") else throw error
            }
        }) { run ->
            if (run.optString("status") == "missing") {
                val retryable=ask.missingRun()
                persistAsk(); controlsAsk(); ui.notice(MoteI18n.text(if(retryable) "请求尚未确认，可重试同一请求。" else "请刷新检查结果，避免重复发送。"))
            } else receiveRun(run,id,askState.optJSONObject("pending"))
        }
    }
    private fun receiveRun(run: JSONObject, expected: String=ask.currentId(), admitted: JSONObject?=null) {
        clearOffline()
        val update = ask.receive(run, expected, admitted)
        val events = run.optJSONArray("events") ?: JSONArray()
        val latest = if (events.length() > 0) events.getJSONObject(events.length() - 1).optString("message") else ""
        runStatus?.visibility = android.view.View.VISIBLE
        runStatus?.text = when (update.status) {
            "running" -> latest.ifBlank { MoteI18n.text("中央正在回答…") }
            "completed" -> MoteI18n.text("回答已完成")
            "cancelled" -> MoteI18n.text("已停止回答")
            else -> MoteI18n.text("回答未完成")
        }
        if (update.clearDraft) question?.setText("")
        controlsAsk()
        if (update.status == "running") ui.scheduleAskPoll()
        else ui.requestedAskConversation()?.let { selectConversation(it,fromIntent=true) } ?: update.conversationId?.let { loadConversation(it) }
    }
    private fun loadConversation(id: String, cursor: String? = null, afterLoad: (() -> Unit)? = null) {
        val api = client
        ui.work(MoteI18n.text("正在读取对话…"), {
            val conversation = api.get("/api/conversations/" + encode(id) + "?limit=20" + (cursor?.let { "&cursor=" + encode(it) } ?: ""))
            val material = conversation.optJSONObject("scope")?.optString("anchorMaterialRef").orEmpty()
                .takeIf { it.matches(Regex("^material:mat_[a-f0-9]{64}@[a-f0-9]{64}$")) }
            val label = material?.let { reference ->
                val materialId = reference.substringAfter("material:").substringBefore('@')
                runCatching { api.get("/api/materials/" + encode(materialId)).optString("title") }.getOrNull()
            }
            conversation to label
        }) { (conversation, label) ->
            clearOffline()
            lastConversation = JSONObject(conversation.toString())
            lastConversationCursor = cursor
            renderConversation(conversation, label)
            afterLoad?.invoke()
        }
    }
    private fun renderConversation(conversation: JSONObject, materialLabel: String? = null) {
        val target = messages ?: return
        val id = conversation.getString("id")
        ask.restoreScope(conversation); ask.scopeLabel(materialLabel); persistAsk(); updateScope()
        target.removeAllViews(); askFailureAction = null
        runStatus = ui.text("", parent = target).apply { visibility = android.view.View.GONE; setPadding(0,0,0,0) }
        val turns = conversation.getJSONArray("turns")
        val citationNumbers = linkedMapOf<String, Int>()
        val shownCitationIds = mutableSetOf<String>()
        for (i in 0 until turns.length()) {
            val turn = turns.getJSONObject(i)
            questionBubble(target, turn.getString("question"))
            val presentation = ask.readTurn(turn)
            presentation.notice?.let { ui.text(it, NativeFontRole.SUPPORT, target) }
            presentation.result?.let { answer ->
                val sourceCitations = answer.optJSONArray("citations") ?: JSONArray()
                val citations = (0 until sourceCitations.length()).map { sourceCitations.getJSONObject(it) }.distinctBy { it.getString("id") }
                citations.forEach { citation -> val id = citation.getString("id"); if (id !in citationNumbers) citationNumbers[id] = citationNumbers.size + 1 }
                val display = ask.formatAnswer(answer.optString("answer"), citationNumbers.keys.toList())
                val styled = android.text.SpannableString(display.text)
                display.emphasis.forEach { span -> styled.setSpan(android.text.style.StyleSpan(if (span.bold) android.graphics.Typeface.BOLD else android.graphics.Typeface.ITALIC), span.start, span.end, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
                display.citations.forEach { span ->
                    styled.setSpan(CitationChipSpan(ui, span.number), span.start, span.end, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                var touchScroll: Int? = null
                val answerView = ui.text("", parent = target).apply {
                    tag = "ask-answer:" + turn.getString("id"); text = styled; MoteUi.type(this, 16); MoteUi.textColor(this, NativeColorRole.INK)
                    setLineSpacing(ui.moteDp(6).toFloat(), 1.35f)
                    setPadding(0,ui.moteDp(12),0,ui.moteDp(10)); setTextIsSelectable(true)
                    setOnTouchListener { view, event ->
                        when (event.actionMasked) {
                            android.view.MotionEvent.ACTION_DOWN -> touchScroll = ui.contentScroll()
                            android.view.MotionEvent.ACTION_CANCEL -> touchScroll = null
                            android.view.MotionEvent.ACTION_UP -> {
                                val start = touchScroll; touchScroll = null
                                val textView = view as TextView
                                val layout = textView.layout
                                if (layout != null && !ui.isWorking) {
                                    val offset = layout.getOffsetForHorizontal(
                                        layout.getLineForVertical((event.y - textView.totalPaddingTop + textView.scrollY).toInt().coerceAtLeast(0)),
                                        (event.x - textView.totalPaddingLeft + textView.scrollX).coerceAtLeast(0f),
                                    )
                                    display.citations.firstOrNull { offset in it.start until it.end }?.let { span ->
                                        val citation = citations.firstOrNull { it.optString("id") == span.id }
                                        openAskCitation(id, turn.getString("id"), span.id, start, citation?.let { ConversationCitationPresentation.read(it).excerpt })
                                    }
                                }
                            }
                        }
                        false
                    }
                }
                if (citations.isNotEmpty()) {
                    val newCitations = citations.filter { shownCitationIds.add(it.getString("id")) }
                    if (newCitations.isNotEmpty()) citationCards(target, newCitations, citationNumbers) { citation -> openAskCitation(id,turn.getString("id"),citation.getString("id")) }
                }
                val actions = LinearLayout(ui).apply { gravity = android.view.Gravity.START or android.view.Gravity.CENTER_VERTICAL; setPadding(0,ui.moteDp(4),0,ui.moteDp(20)) }.also(target::addView)
                val save = TextView(ui).apply {
                    text = MoteI18n.text("保存为记录"); contentDescription = text
                    MoteUi.type(this, 13); MoteUi.textColor(this, NativeColorRole.ACCENT)
                    setCompoundDrawablesWithIntrinsicBounds(MoteGlyph.MEMORY.drawable, 0, 0, 0)
                    compoundDrawablePadding = ui.moteDp(6)
                    setCompoundDrawableTintList(android.content.res.ColorStateList.valueOf(MoteUi.accent))
                    minHeight = ui.moteDp(44); gravity = android.view.Gravity.CENTER; isFocusable = true
                    setPadding(0, 0, ui.moteDp(14), 0)
                    setOnClickListener {
                        if (!ui.isWorking) {
                            val original = turn.getString("question") + "\n\n" + answer.optString("answer")
                            if (original.length > 100000) ui.notice(MoteI18n.text("文字目前最多 100000 字符。"))
                            else ui.recordConversation(original, id, turn.getString("id"), turn.getString("question"), citations.map { it.getString("id") })
                        }
                    }
                }
                actions.addView(save, LinearLayout.LayoutParams(-2, ui.moteDp(44)))
                actions.addView(MoteComponents.iconButton(ui, MoteGlyph.COPY, "复制", MoteIconButtonStyle.MUTED) {
                    if (!ui.isWorking) {
                        val clipboard = ui.getSystemService(android.content.ClipboardManager::class.java)
                        clipboard?.setPrimaryClip(android.content.ClipData.newPlainText(MoteI18n.text("回答"), answer.optString("answer")))
                    }
                }, LinearLayout.LayoutParams(ui.moteDp(44), ui.moteDp(44)))
                actions.addView(MoteComponents.iconButton(ui, MoteGlyph.MORE, "更多", MoteIconButtonStyle.MUTED) {
                    if (!ui.isWorking) showTurnDetails(id,turn.getString("id"),answer,citations)
                }, LinearLayout.LayoutParams(ui.moteDp(44), ui.moteDp(44)))
            }
            turn.optJSONObject("error")?.let { error ->
                ui.text(MoteI18n.text("回答未完成"),NativeFontRole.SUPPORT,target)
                conversationAction(target,"查看详情") { showAskFailureDetails(error) }.tag="ask-turn-error-details:"+turn.getString("id")
            }
        }
        next(conversation)?.let { older -> ui.button(MoteI18n.text("加载更早的对话"), parent = target) { loadConversation(id, older) } }
        if(askBusy())updateAskFailureAction()
    }
    private fun questionBubble(parent: LinearLayout, question: String) {
        val row = LinearLayout(ui).apply { gravity = android.view.Gravity.END; setPadding(0, ui.moteDp(6), 0, ui.moteDp(16)) }
        val maxWidth = (ui.resources.displayMetrics.widthPixels * 0.78f).toInt()
        row.addView(TextView(ui).apply {
            text = question; MoteUi.type(this, 15); MoteUi.textColor(this, NativeColorRole.INK)
            this.maxWidth = (maxWidth - ui.moteDp(40)).coerceAtLeast(ui.moteDp(120)); setPadding(ui.moteDp(15), ui.moteDp(10), ui.moteDp(15), ui.moteDp(10))
            NativePresentationStyles.bind(this, "ask-question-bubble") {
                it.background = MoteUi.shape(ui, NativeColorRole.SURFACE, 20, true, NativeColorRole.HAIR)
            }
        }, LinearLayout.LayoutParams(-2, -2))
        parent.addView(row, LinearLayout.LayoutParams(-1, -2))
    }
    private fun citationCards(parent: LinearLayout, citations: List<JSONObject>, numbers: Map<String, Int>, open: (JSONObject) -> Unit) {
        val group = MoteComponents.group(ui)
        citations.forEachIndexed { index, citation ->
            if (index > 0) group.addView(MoteComponents.divider(ui))
            val number = numbers[citation.getString("id")] ?: (index + 1)
            val presentation = ConversationCitationPresentation.read(citation)
            val name = presentation.name
            val row = LinearLayout(ui).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL
                minimumHeight = ui.moteDp(62); setPadding(ui.moteDp(14), ui.moteDp(9), ui.moteDp(14), ui.moteDp(9))
                isFocusable = true; contentDescription = MoteI18n.text("查看引用 {0}", number) + " · " + name
                background = MoteUi.clickable(ui, NativeColorRole.TRANSPARENT, 0, false)
                setOnClickListener { if (!ui.isWorking) open(citation) }
            }
            row.addView(TextView(ui).apply {
                text = number.toString(); gravity = android.view.Gravity.CENTER; MoteUi.type(this, 11, medium = true)
                MoteUi.textColor(this, NativeColorRole.ACCENT)
                background = MoteUi.shape(ui, NativeColorRole.TINT, NativeRadiusRole.PILL, false)
            }, LinearLayout.LayoutParams(ui.moteDp(24), ui.moteDp(24)).apply { marginEnd = ui.moteDp(12) })
            val labels = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
            labels.addView(TextView(ui).apply { text = name; MoteUi.type(this, 15); MoteUi.textColor(this, NativeColorRole.INK); maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END })
            labels.addView(TextView(ui).apply {
                text = presentation.detail; MoteUi.type(this, 13); MoteUi.textColor(this, NativeColorRole.MUTED)
                setPadding(0, ui.moteDp(2), 0, 0)
            })
            row.addView(labels, LinearLayout.LayoutParams(0, -2, 1f))
            group.addView(row, LinearLayout.LayoutParams(-1, -2))
        }
        parent.addView(group, LinearLayout.LayoutParams(-1, -2).apply { topMargin = ui.moteDp(2) })
    }
    private fun conversationAction(parent: LinearLayout, label: String, action: () -> Unit) = TextView(ui).apply {
        text = MoteI18n.text(label); contentDescription = text; MoteUi.type(this,NativeFontRole.SUPPORT); MoteUi.textColor(this,NativeColorRole.MUTED)
        minHeight = ui.moteDp(44); gravity = android.view.Gravity.CENTER; setPadding(ui.moteDp(10),0,ui.moteDp(10),0); isFocusable = true
        setOnClickListener { if (!ui.isWorking) action() }
    }.also { parent.addView(it,LinearLayout.LayoutParams(-2,-2)) }
    private fun citationRow(parent: LinearLayout, number: Int, citation: JSONObject, open: () -> Unit) {
        val row = LinearLayout(ui).apply { gravity = android.view.Gravity.CENTER_VERTICAL; minimumHeight = ui.moteDp(48); setPadding(0,ui.moteDp(7),0,ui.moteDp(7)); isFocusable = true; setOnClickListener { if (!ui.isWorking) open() } }
        val name = citation.optString("title").ifBlank { citation.optString("appName").ifBlank { MoteI18n.text("查看原文依据") } }
        row.contentDescription = MoteI18n.text("查看引用 {0}",number) + " · " + name
        row.addView(TextView(ui).apply { text = number.toString(); MoteUi.type(this,NativeFontRole.META); MoteUi.textColor(this,NativeColorRole.MUTED) },LinearLayout.LayoutParams(ui.moteDp(24),-2))
        val labels = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
        labels.addView(TextView(ui).apply { text = name; MoteUi.type(this,NativeFontRole.SUPPORT); MoteUi.textColor(this,NativeColorRole.INK) })
        citation.optString("capturedAt").takeIf { it.isNotBlank() }?.let { time -> labels.addView(TextView(ui).apply { text = runCatching { java.time.Instant.parse(time).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.SHORT).withLocale(MoteI18n.locale())) }.getOrDefault(time); MoteUi.type(this,NativeFontRole.META); MoteUi.textColor(this,NativeColorRole.MUTED) }) }
        row.addView(labels,LinearLayout.LayoutParams(0,-2,1f))
        row.addView(TextView(ui).apply { text = "↗"; MoteUi.type(this,NativeFontRole.SUPPORT); MoteUi.textColor(this,NativeColorRole.MUTED) },LinearLayout.LayoutParams(ui.moteDp(20),-2))
        parent.addView(row,LinearLayout.LayoutParams(-1,-2))
        parent.addView(android.view.View(ui).apply { MoteUi.backgroundColor(this,NativeColorRole.DIVIDER) },LinearLayout.LayoutParams(-1,ui.moteDp(1)))
    }
    private fun showTurnDetails(conversationId: String, turnId: String, answer: JSONObject, citations: List<JSONObject>) {
        val content = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL; setPadding(ui.moteDp(20),ui.moteDp(12),ui.moteDp(20),ui.moteDp(20)) }
        val usage = answer.optJSONObject("usage")
        fun fact(label: String, value: String) {
            val row = LinearLayout(ui).apply { tag = "turn-detail:$label"; setPadding(0,ui.moteDp(9),0,ui.moteDp(9)); gravity = android.view.Gravity.TOP; isBaselineAligned = false }
            row.addView(TextView(ui).apply { text = MoteI18n.text(label); MoteUi.type(this,NativeFontRole.SUPPORT); MoteUi.textColor(this,NativeColorRole.MUTED) },LinearLayout.LayoutParams(ui.moteDp(100),-2))
            row.addView(TextView(ui).apply { text = value; MoteUi.type(this,NativeFontRole.SUPPORT); MoteUi.textColor(this,NativeColorRole.INK) },LinearLayout.LayoutParams(0,-2,1f)); content.addView(row,LinearLayout.LayoutParams(-1,-2))
        }
        val actualModel = answer.optJSONObject("modelSelection")?.optString("model").orEmpty().ifBlank { usage?.optString("model").orEmpty() }.ifBlank { MoteI18n.text("未记录") }
        fact("使用模型", actualModel)
        fact("检索", if (citations.isEmpty()) MoteI18n.text("没有档案引用") else MoteI18n.text("{0} 份已引用资料",citations.size))
        val cost = usage?.opt("estimatedCost") as? Number
        val estimate = cost?.toDouble()?.takeIf { it.isFinite() && it >= 0 }
        fact("费用", if (estimate == null) MoteI18n.text("未提供估价") else java.text.NumberFormat.getNumberInstance(MoteI18n.locale()).apply { maximumFractionDigits = 6 }.format(estimate) + " " + usage.optString("currency"))
        val evidence = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL; visibility = android.view.View.GONE }
        var dialog: android.app.AlertDialog? = null
        conversationAction(content,"已读取的依据") { evidence.visibility = if (evidence.visibility == android.view.View.VISIBLE) android.view.View.GONE else android.view.View.VISIBLE }
        if (citations.isEmpty()) ui.text(MoteI18n.text("没有档案引用"),NativeFontRole.SUPPORT,evidence)
        citations.forEachIndexed { index, citation -> citationRow(evidence,index + 1,citation) { dialog?.dismiss(); openAskCitation(conversationId,turnId,citation.getString("id")) } }
        content.addView(evidence)
        dialog = MoteDialogBuilder(ui).setTitle(MoteI18n.text("本轮详情")).setView(ScrollView(ui).apply { addView(content) }).setPositiveButton(MoteI18n.text("关闭"),null).show()
    }
    private fun openAskCitation(conversationId: String, turnId: String, evidenceId: String, initialScroll: Int? = null, excerpt: String? = null) {
        val api = client; val cursor = lastConversationCursor; val scroll = initialScroll ?: ui.contentScroll()
        val selected = CentralAccess.resolve(ui); val expected = selected.server to selected.generation
        fun stillCurrent(): Boolean {
            val current = runCatching { CentralAccess.resolve(ui) }.getOrNull() ?: return false
            val page = lastConversation?.takeIf { it.optString("id") == conversationId } ?: return false
            val turns = page.optJSONArray("turns") ?: return false
            val turn = (0 until turns.length()).mapNotNull(turns::optJSONObject).singleOrNull { it.optString("id") == turnId } ?: return false
            val citations = turn.optJSONObject("result")?.optJSONArray("citations") ?: return false
            return currentPage == "ask" && ui.client === api && askState.optString("conversationId") == conversationId && (current.server to current.generation) == expected &&
                (0 until citations.length()).any { citations.optJSONObject(it)?.optString("id") == evidenceId }
        }
        if (!stillCurrent()) return
        // LinkMovementMethod can scroll its TextView while taking focus on ACTION_DOWN.
        // Keep the position from the user's tap even when the reference is unavailable.
        if (initialScroll != null) ui.restoreContentScroll(scroll)
        data class AvailableCitation(val available: Boolean, val excerpt: String?)
        ui.work(MoteI18n.text("正在读取…"), {
            val fresh = api.get("/api/conversations/" + encode(conversationId) + "?limit=20" + (cursor?.let { "&cursor=" + encode(it) } ?: ""))
            val turns = fresh.optJSONArray("turns") ?: JSONArray()
            val turn = if (fresh.optString("id") == conversationId) (0 until turns.length()).mapNotNull(turns::optJSONObject).singleOrNull { it.optString("id") == turnId } else null
            val citations = turn?.takeUnless { it.optBoolean("evidenceDeleted") }?.optJSONObject("result")?.optJSONArray("citations")
            val freshCitation = citations?.let { rows -> (0 until rows.length()).mapNotNull(rows::optJSONObject).firstOrNull { it.optString("id") == evidenceId } }
            val inTurn = freshCitation != null
            AvailableCitation(
                inTurn && CentralConversationReference.available(api,conversationId,evidenceId),
                freshCitation?.let { ConversationCitationPresentation.read(it).excerpt } ?: excerpt,
            )
        }) { result ->
            if (!stillCurrent()) return@work
            if (!result.available) { ui.restoreContentScroll(scroll); showUnavailableCitation(); return@work }
            library.captureEvidence(evidenceId,conversationId,scroll,excerpt = result.excerpt) {
                val current = runCatching { CentralAccess.resolve(ui) }.getOrNull()
                if (currentPage == "ask" && ui.client === api && askState.optString("conversationId") == conversationId && current != null && (current.server to current.generation) == expected) {
                    ui.restoreAskHeader(); buildAsk()
                    loadConversation(conversationId,cursor) { ui.restoreContentScroll(scroll) }
                } else refresh()
            }
        }
    }
    private fun showUnavailableCitation() {
        MoteDialogBuilder(ui).setTitle(MoteI18n.text("引用不可用")).setMessage(MoteI18n.text("引用原文已删除，历史问答仍保留。"))
            .setPositiveButton(MoteI18n.text("返回原对话"), null).show()
    }
    fun openConversationEvidence(conversationId: String, evidenceId: String, open: () -> Unit) {
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { CentralConversationReference.available(api, conversationId, evidenceId) }) { available ->
            if (available) open()
            else showUnavailableCitation()
        }
    }

    private fun loadNotes() {
        val api = client
        ui.work(MoteI18n.text("正在读取记录…"), {
            CentralDraftWrites.barrier { draftFailure.get()?.let { throw it }; noteStore.read() } to runCatching { api.get("/api/notes?limit=30") }
        }) { (state, history) ->
            noteDraft = state.getJSONObject("draft"); noteHistory = history.getOrDefault(JSONObject()); buildNotes(state, noteHistory)
            history.exceptionOrNull()?.let(ui::requestFailure)
        }
    }
    private fun persistNote() {
        noteDraft.put("text", noteText?.text?.toString() ?: noteDraft.optString("text"))
        noteDraft.put("mood", noteMood?.text?.toString() ?: noteDraft.optString("mood"))
        noteWriter.submit(JSONObject(noteDraft.toString()))
    }
    private fun buildNotes(state: JSONObject, history: JSONObject) {
        body.removeAllViews()
        ui.button(MoteI18n.text("记下"), true) { ui.recordNew() }
        val pending = state.getJSONArray("pending")
        if (pending.length() > 0) {
            ui.text(MoteI18n.text("待同步 {0} 条", pending.length()), NativeFontRole.SECTION)
            ui.button(MoteI18n.text("重试同步")) {
                syncNotes(enqueue = false)
            }
            for (i in 0 until pending.length()) ui.text(pending.getJSONObject(i).getString("text"))
        }
        ui.text(MoteI18n.text("已经留下的心绪与杂事"), NativeFontRole.SECTION)
        ui.button(MoteI18n.text("刷新")) { refresh() }
        val items = history.optJSONArray("items") ?: JSONArray()
        for (i in 0 until items.length()) {
            val note = items.getJSONObject(i); val card = ui.card()
            ui.text(note.optString("capturedAt"), NativeFontRole.SUPPORT, card); ui.text(note.optString("ocrText"), parent = card)
            ui.button(MoteI18n.text("查看原文"), parent = card) { library.captureEvidence(note.getString("id")) }
        }
        next(history)?.let { cursor -> ui.button(MoteI18n.text("加载更早的记录")) {
            val api = client
            ui.work(MoteI18n.text("正在读取记录…"), { api.get("/api/notes?limit=30&cursor=" + encode(cursor)) }) { noteHistory = it; buildNotes(state, it) }
        } }
    }

    private fun syncNotes(enqueue: Boolean) {
        val api = client
        ui.work(MoteI18n.text("正在保存记录…"), {
            val state = CentralDraftWrites.barrier {
                draftFailure.get()?.let { throw it }
                if (enqueue) noteStore.enqueue(Settings(ui).deviceId, Settings(ui).read().deviceName)
                noteStore.read()
            }
            val outcome = runCatching {
                val items = state.getJSONArray("pending")
                for (i in 0 until items.length()) {
                    val note = items.getJSONObject(i)
                    val response = api.post("/api/notes", note)
                    CentralDraftWrites.barrier { noteStore.acknowledge(note.getString("id"), response) }
                }
            }
            CentralDraftWrites.barrier { noteStore.read() } to outcome
        }) { (state, outcome) ->
            noteDraft = state.getJSONObject("draft"); buildNotes(state, noteHistory)
            outcome.onFailure(ui::requestFailure).onSuccess { refresh() }
        }
    }

    private fun renderAskImages() {
        val host=askImagesView ?: return;host.removeAllViews()
        val ready=askState.optJSONArray("attachments") ?: JSONArray()
        val pending=ask.pendingImages()
        fun row(item:JSONObject,upload:Boolean) {
            val id=item.getString(if(upload)"selectionId" else "id")
            val container=LinearLayout(ui).apply { orientation=LinearLayout.HORIZONTAL;gravity=android.view.Gravity.CENTER_VERTICAL;isBaselineAligned=false;background=MoteUi.shape(ui,NativeColorRole.SURFACE_RAISED,7,true);setPadding(ui.moteDp(8),ui.moteDp(8),ui.moteDp(8),ui.moteDp(8));tag="ask-image:$id" }
            host.addView(container,LinearLayout.LayoutParams(-1,-2).apply { bottomMargin=ui.moteDp(8) })
            val preview=ImageView(ui).apply { contentDescription=MoteI18n.text("图片")+" · "+item.optString("name");scaleType=ImageView.ScaleType.CENTER_CROP }
            item.optString("preview").takeIf(String::isNotBlank)?.let { encoded -> runCatching { android.util.Base64.decode(encoded,android.util.Base64.NO_WRAP).let { android.graphics.BitmapFactory.decodeByteArray(it,0,it.size) } }.getOrNull()?.let(preview::setImageBitmap) }
            container.addView(preview,LinearLayout.LayoutParams(ui.moteDp(52),ui.moteDp(52)).apply { marginEnd=ui.moteDp(8) })
            val copy=LinearLayout(ui).apply { orientation=LinearLayout.VERTICAL };container.addView(copy,LinearLayout.LayoutParams(0,-2,1f))
            ui.text(item.optString("name"),NativeFontRole.SUPPORT,copy)
            ui.text(MoteI18n.text(if(!upload)"已添加" else when(item.optString("status")){"uploading"->"正在上传";"failed"->"图片上传失败";else->"上传结果尚未确认"}),NativeFontRole.META,copy)
            val actions=LinearLayout(ui).apply { orientation=LinearLayout.HORIZONTAL;gravity=android.view.Gravity.CENTER_VERTICAL;isBaselineAligned=false };container.addView(actions)
            fun imageAction(label:String,tagValue:String,action:()->Unit)=MoteUi.action(Button(ui).apply {
                text=MoteI18n.text(label);tag=tagValue;contentDescription=if(label=="移除")MoteI18n.text("移除附件：{0}",item.optString("name")) else text
                setOnClickListener { if(!askBusy())action() }
            },MoteUi.ButtonRole.TEXT).also { actions.addView(it,LinearLayout.LayoutParams(-2,-2)) }
            if(upload && item.optString("status")!="uploading") imageAction("重试上传","ask-image-retry:$id") {
                if(!ui.isWorking){item.put("status","uploading");persistAsk();renderAskImages();uploadAskImages(listOf(JSONObject(item.toString())))}
            }
            imageAction("移除","ask-image-remove:$id") {
                if(upload)ask.removeImage(id)
                else ask.removeAttachment(id)
                persistAsk();renderAskImages();controlsAsk()
            }
        }
        for(i in 0 until ready.length())row(ready.getJSONObject(i),false)
        for(i in 0 until pending.length())row(pending.getJSONObject(i),true)
    }
    private fun uploadAskImages(selected:List<JSONObject>) {
        val api=client;val device=Settings(ui).deviceId
        controlsAsk()
        ui.work(MoteI18n.text("正在上传附件…"), { progress ->
            selected.map { selection -> ask.uploadImage(ui.contentResolver,selection,api,directory,device,resolveTime={ key ->
                CentralDraftWrites.barrier { val times=attachmentStore.read();if(!times.has(key)){times.put(key,System.currentTimeMillis());attachmentStore.write(times)};times.getLong(key) }
            }) { done,total -> progress.message=MoteI18n.text("正在上传附件 {0}/{1}",done,total) } }
        }) { results ->
            results.forEach { ask.mergeImage(it) };persistAsk();renderAskImages();controlsAsk()
            if(ask.pendingImages().length()>0 && results.any { it.optString("status")!="ready" })ui.notice(MoteI18n.text("请先重试或移除尚未上传完成的图片。"))
        }
    }
    fun addAttachments(uris: List<Uri>, chat: Boolean) {
        if(chat) {
            if(askBusy())return
            if(uris.isEmpty())return
            if(ask.imageCount()+uris.size>4){ui.notice(MoteI18n.text("最多添加 4 张图片"));return}
            // Reuse the exact URIs granted by this picker result. No broader or
            // persistent permission is requested; an expired grant requires reselection.
            val selected=runCatching { ask.stageImageReferences(uris.map(Uri::toString)) }.getOrElse { ui.notice(it.message.orEmpty());return };persistAsk();renderAskImages();uploadAskImages(selected);return
        }
        val api = client
        val previous = noteDraft.getJSONArray("attachments")
        if (previous.length() + uris.size > 10) { ui.notice(MoteI18n.text("最多 10 个附件")); return }
        val draftSnapshot = JSONObject(noteDraft.toString())
        ui.work(MoteI18n.text("正在上传附件…"), { progress -> runCatching {
            val settings = Settings(ui)
            for (uri in uris) {
                val mime = ui.contentResolver.getType(uri).orEmpty()
                val name = ui.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null } ?: "attachment"
                directory.mkdirs()
                val spool = File(directory, "attachment-" + UUID.randomUUID() + ".tmp")
                try {
                    ui.contentResolver.openInputStream(uri)!!.use { input -> spool.outputStream().use { output ->
                        val buffer = ByteArray(65536); var total = 0
                        while (true) { val n = input.read(buffer); if (n < 0) break; total += n
                            require(total <= CentralAttachments.MAX_BYTES) { MoteI18n.text("附件必须是图片或音频，且每个文件最多 50 MiB。") }
                            output.write(buffer, 0, n)
                        }
                    } }
                    // The original digest makes resuming an ambiguous upload idempotent.
                    val id = CentralAttachments.upload(api, spool, name, mime, settings.deviceId, resolveTime = { key ->
                        CentralDraftWrites.barrier {
                            val times = attachmentStore.read()
                            if (!times.has(key)) { times.put(key, System.currentTimeMillis()); attachmentStore.write(times) }
                            times.getLong(key)
                        }
                    }) { done, total ->
                        progress.message = MoteI18n.text("正在上传附件 {0}/{1}", done, total)
                    }
                    draftSnapshot.getJSONArray("attachments").put(id)
                    CentralDraftWrites.barrier { noteStore.edit(draftSnapshot.getString("text"), draftSnapshot.getString("mood"), draftSnapshot.getJSONArray("attachments")) }
                } finally { spool.delete() }
            }
        } }) { outcome ->
            noteDraft = draftSnapshot
            refresh(); outcome.exceptionOrNull()?.let(ui::requestFailure)
        }
    }

    fun importFile(uri: Uri) {
        val api = client; val instruction = importInstruction
        ui.work(MoteI18n.text("正在导入文件…"), { progress ->
            importStore.stage(ui, uri, instruction)
            importStore.send(api) { done, total -> progress.message = MoteI18n.text("正在上传附件 {0}/{1}", done, total) }
        }) { admin.importDetail(it.getString("id")) }
    }
    fun importPending(target: LinearLayout) {
        ui.work(MoteI18n.text("正在读取…"), { importStore.pending() }) { saved ->
            if (saved.has("manifest")) {
                ui.text(saved.getJSONObject("manifest").getString("name"), parent = target)
                ui.button(MoteI18n.text("重试同一请求"), parent = target) {
                    val api = client
                    ui.work(MoteI18n.text("正在导入文件…"), { progress ->
                        importStore.send(api) { done, total -> progress.message = MoteI18n.text("正在上传附件 {0}/{1}", done, total) }
                    }) { admin.importDetail(it.getString("id")) }
                }
                ui.button(MoteI18n.text("放弃待导入文件"), parent = target) {
                    confirm(MoteI18n.text("放弃待导入文件"), MoteI18n.text("中央已接收的原件仍保留。")) {
                        ui.work(MoteI18n.text("正在处理…"), { importStore.discard() }) { refresh() }
                    }
                }
            }
        }
    }
    fun playAudio(path: String, target: LinearLayout) {
        close(); val api = client; val revision = ui.navigationRevision
        ui.work(MoteI18n.text("正在读取录音…"), {
            val file = File.createTempFile("central-audio-", ".tmp", ui.cacheDir)
            audioFile = file
            try {
                file.outputStream().use { api.download(path, it, 256 * 1024 * 1024L) }
                check(!ui.isDestroyed && !ui.isFinishing && ui.navigationRevision == revision)
                file
            }
            catch (error: Throwable) { file.delete(); throw error }
        }) { file ->
            audioFile = file
            val current = android.media.MediaPlayer(); player = current
            var ready = false
            val toggle = ui.button(MoteI18n.text("播放或暂停"), parent = target) {
                if (player === current && ready) { if (current.isPlaying) current.pause() else current.start() }
            }.apply { isEnabled = false }
            val seek = SeekBar(ui).apply { max = 1000; contentDescription = MoteI18n.text("播放进度")
                isEnabled = false
                setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                    override fun onProgressChanged(bar: SeekBar?, value: Int, fromUser: Boolean) {
                        if (fromUser && player === current && ready) current.seekTo((current.duration.toLong() * value / 1000).toInt())
                    }
                    override fun onStartTrackingTouch(bar: SeekBar?) = Unit
                    override fun onStopTrackingTouch(bar: SeekBar?) = Unit
                })
            }; target.addView(seek)
            current.setOnPreparedListener { if (player === current) { ready = true; toggle.isEnabled = true; seek.isEnabled = true; it.start() } }
            current.setOnErrorListener { _, _, _ ->
                ready = false; toggle.isEnabled = false; seek.isEnabled = false
                ui.notice(MoteI18n.text("无法播放此录音")); if (player === current) close(); true
            }
            try { file.inputStream().use { current.setDataSource(it.fd) }; current.prepareAsync() }
            catch (error: Throwable) { close(); throw error }
        }
    }

    fun confirm(title: String, message: String, action: () -> Unit) =
        confirm(title, message, MoteI18n.text("确认"), action)
    fun confirm(title: String, message: String, positive: String, action: () -> Unit) {
        MoteDialogBuilder(ui).setTitle(title).setMessage(message).setNegativeButton(MoteI18n.text("取消"), null)
            .setPositiveButton(positive) { _, _ -> action() }.show()
    }
    companion object {
        fun encode(value: String): String = java.net.URLEncoder.encode(value, "UTF-8")
        fun next(value: JSONObject): String? = if (value.isNull("nextCursor") || !value.has("nextCursor")) null else value.opt("nextCursor").toString()
        val pages = listOf(
            "overview" to "中央工作台", "archive" to "资料库", MoteNavigation.SEARCH to "搜索资料", "ask" to "问一问", "conversations" to "对话", "activity" to "活动", "notes" to "记录",
            "materials" to "正式资料", "coding" to "Coding 会话同步状态", "timeline" to "片段", "files" to "文件与录音",
            "memories" to "记忆", "insights" to "洞察", "actions" to "行动", "agentView" to "Agent 视角",
            "sources" to "来源", "devices" to "设备", "connections" to "对外授权", "lark" to "飞书",
            "statistics" to "运行状态", "processing" to "处理任务", "plugins" to "插件", "settings" to "模型与服务",
            "usage" to "用量与费用", "vault" to "存储与索引", "developer" to "诊断与更新", "about" to "设置", "imports" to "导入", "help" to "帮助与反馈"
        )
    }
}

/** Draws the verified citation marker as a compact tint chip while the stored
 * answer keeps its exact `[n]` text for copy, save and accessibility. */
internal class CitationChipSpan(private val context: android.content.Context, private val number: Int) : ReplacementSpan() {
    private val density get() = context.resources.displayMetrics.density
    private var measured = 0f
    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        val oldSize = paint.textSize
        paint.textSize = 11f * density
        paint.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        measured = paint.measureText(number.toString()) + 10f * density
        paint.textSize = oldSize
        return kotlin.math.ceil(measured.toDouble()).toInt()
    }
    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, baseline: Int, bottom: Int, paint: Paint) {
        val oldSize = paint.textSize; val oldColor = paint.color; val oldTypeface = paint.typeface; val oldStyle = paint.style
        val label = number.toString()
        paint.textSize = 11f * density
        paint.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        paint.style = Paint.Style.FILL
        paint.color = MoteTheme.tint
        val height = 18f * density
        val chipTop = baseline - 14f * density
        canvas.drawRoundRect(x, chipTop, x + measured, chipTop + height, 9f * density, 9f * density, paint)
        paint.color = MoteTheme.accent
        canvas.drawText(label, x + (measured - paint.measureText(label)) / 2f, baseline - 2f * density, paint)
        paint.textSize = oldSize; paint.color = oldColor; paint.typeface = oldTypeface; paint.style = oldStyle
    }
}
