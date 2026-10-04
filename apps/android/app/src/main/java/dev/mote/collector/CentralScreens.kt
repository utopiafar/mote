package dev.mote.collector

import android.net.Uri
import android.provider.OpenableColumns
import android.text.Editable
import android.text.InputFilter
import android.text.TextWatcher
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors

internal class CentralStateFile(private val directory: File, private val name: String, private val cipher: ByteCipher) {
    private val file = File(directory, name + ".enc")
    @Synchronized fun read(): JSONObject = if (file.exists()) JSONObject(String(cipher.open(file.readBytes()), Charsets.UTF_8)) else JSONObject()
    @Synchronized fun write(value: JSONObject) {
        directory.mkdirs(); val temp = File(directory, name + ".tmp")
        try { FileOutputStream(temp).use { it.write(cipher.seal(value.toString().toByteArray())); it.fd.sync() }; check(temp.renameTo(file)) }
        finally { temp.delete() }
    }
}

/** Writes are serialized across Activity recreation; UI threads never wait for storage. */
internal object CentralDraftWrites {
    val executor = Executors.newSingleThreadExecutor()
    fun <T> barrier(work: () -> T): T = executor.submit<T> { work() }.get()
}

internal class CentralScreens(val ui: CentralContent, val body: LinearLayout, private val directory: File) {
    val client get() = requireNotNull(ui.client)
    private val cipher = SecretBox()
    private val askStore = CentralStateFile(directory, "ask", cipher)
    private val noteStore = CentralNoteStore(directory, cipher)
    private val importStore = CentralImports(File(directory, "import-pending"), cipher)
    private val attachmentStore = CentralStateFile(directory, "attachment-times", cipher)
    private val insightStore = CentralStateFile(directory, "insight-request", cipher)
    private val draftFailure = java.util.concurrent.atomic.AtomicReference<Throwable?>(null)
    var importInstruction = ""
    private var player: android.media.MediaPlayer? = null
    @Volatile private var audioFile: File? = null
    fun close() { player?.release(); player = null; audioFile?.delete(); audioFile = null }
    private var askState = JSONObject()
    private val askWriter = LatestWriter<JSONObject>(CentralDraftWrites.executor) {
        runCatching { askStore.write(it) }.onSuccess { draftFailure.set(null) }.onFailure(draftFailure::set)
    }
    private val noteWriter = LatestWriter<JSONObject>(CentralDraftWrites.executor) {
        runCatching { noteStore.edit(it.getString("text"), it.getString("mood"), it.getJSONArray("attachments")) }
            .onSuccess { draftFailure.set(null) }.onFailure(draftFailure::set)
    }
    private var currentPage = "ask"
    private var question: EditText? = null
    private var preset: Spinner? = null
    private var model: EditText? = null
    private var modelSettings = JSONObject()
    private var messages: LinearLayout? = null
    private var runStatus: TextView? = null
    private var send: Button? = null
    private var stop: Button? = null
    private var noteText: EditText? = null
    private var noteMood: EditText? = null
    private var noteDraft = JSONObject().put("text", "").put("mood", "").put("attachments", JSONArray())
    private var detailBack: (() -> Unit)? = null
    private var noteHistory = JSONObject()
    private val library = CentralLibrary(this)
    private val admin = CentralAdmin(this)

    fun show(page: String) {
        currentPage = page; detailBack = null; question = null; messages = null; noteText = null; noteMood = null
        when (page) {
            "ask" -> loadAsk()
            "notes" -> loadNotes()
            "overview" -> overview()
            "archive", "timeline", "materials", "coding", "files", "memories", "insights", "sources" -> library.show(page)
            else -> admin.show(page)
        }
    }
    fun back(): Boolean = detailBack?.let { detailBack = null; it(); true } ?: false
    fun setBack(action: () -> Unit) { ui.enterDetail(); detailBack = action; question = null; messages = null; close() }
    fun clearPrivateState() { askState = JSONObject(); question = null; messages = null; noteText = null; noteMood = null; body.removeAllViews() }
    fun refresh() { ui.navigate(currentPage) }
    fun insightRequest(prompt: String): JSONObject = CentralDraftWrites.barrier {
        val saved = insightStore.read()
        if (saved.has("requestId")) saved else JSONObject().put("requestId", UUID.randomUUID().toString())
            .put("timeZone", java.time.ZoneId.systemDefault().id).apply { if (prompt.isNotBlank()) put("prompt", prompt) }
            .also(insightStore::write)
    }
    fun insightAccepted() = CentralDraftWrites.barrier { insightStore.write(JSONObject()) }
    private fun persistAsk() = askWriter.submit(JSONObject(askState.toString()))
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
        ui.work(MoteI18n.text("正在连接中央节点…"), {
            listOf(api.get("/api/status"), api.get("/api/devices"), api.get("/api/operations?limit=5"))
        }) { data ->
            val status = data[0]
            ui.text(MoteI18n.text("中央工作台"), 24f, target)
            val agent = status.getJSONObject("agent")
            ui.text(if (agent.optBoolean("configured")) MoteI18n.text("模型已配置") else MoteI18n.text("请先配置模型服务"), parent = target)
            ui.text(agent.optString("model"), parent = target)
            admin.values(status.optJSONObject("storage") ?: JSONObject(), target)
            ui.text(MoteI18n.text("设备"), 20f, target)
            val devices = data[1].optJSONArray("items") ?: JSONArray()
            for (i in 0 until devices.length()) {
                val device = devices.getJSONObject(i)
                ui.text(device.optString("deviceName") + " · " + device.optString("lastSeenAt"), parent = target)
            }
            ui.text(MoteI18n.text("处理任务"), 20f, target)
            admin.items(data[2], target) { row -> admin.operation(row.optString("id")) }
        }
        ui.button(MoteI18n.text("中央资料库")) { ui.navigate("archive") }
        ui.button(MoteI18n.text("日程建议")) {
            ui.startActivity(android.content.Intent(ui, CalendarActionsActivity::class.java))
        }
        ui.button(MoteI18n.text("Agent 视角")) { ui.navigate("agentView") }
    }

    private fun loadAsk() {
        val api = client
        ui.work(MoteI18n.text("正在读取对话…"), {
            val state = CentralDraftWrites.barrier { draftFailure.get()?.let { throw it }; askStore.read() }
            val runs = api.get("/api/query-runs").optJSONArray("items") ?: JSONArray()
            if (!state.has("runId") && !state.has("pending")) {
                val recent = (0 until runs.length()).map { runs.getJSONObject(it) }.firstOrNull { it.optString("status") == "running" }
                recent?.let { state.put("runId", it.getString("id")); if (it.has("conversationId")) state.put("conversationId", it.getString("conversationId")) }
            }
            Triple(state, api.get("/api/conversations?limit=30"), api.get("/api/model-settings"))
        }) { (state, history, settings) ->
            askState = state; modelSettings = settings; buildAsk(history)
            val conversationId = askState.optString("conversationId")
            if (conversationId.isNotBlank()) loadConversation(conversationId)
            if (askState.has("runId") || askState.has("pending")) ui.scheduleAskPoll()
        }
    }
    private fun buildAsk(history: JSONObject) {
        body.removeAllViews()
        ui.text(MoteI18n.text("回答和历史对话保存在中央，离开页面后回答仍继续。"))
        ui.button(MoteI18n.text("新对话")) {
            if (askState.has("pending") || askState.optString("runStatus") == "running") { ui.notice(MoteI18n.text("请先等待当前回答完成，或停止回答。")); return@button }
            askState.remove("runId"); askState.remove("conversationId"); askState.remove("runStatus"); askState.put("question", ""); persistAsk(); refresh()
        }
        ui.button(MoteI18n.text("刷新")) { refresh() }
        messages = ui.card()
        runStatus = ui.text("", parent = messages!!)
        question = ui.field(MoteI18n.text("你的问题"), askState.optString("question"), multiline = true).apply {
            filters = arrayOf(InputFilter.LengthFilter(8000)); minLines = 4
        }
        watch(question!!) { askState.put("question", question!!.text.toString()); persistAsk() }
        val profiles = modelSettings.getJSONArray("profiles")
        val ids = listOf("") + (0 until profiles.length()).map { profiles.getJSONObject(it).getString("id") }
        val names = listOf(MoteI18n.text("跟随功能默认")) + (0 until profiles.length()).map { profiles.getJSONObject(it).getString("name") }
        ui.text(MoteI18n.text("模型预设"), 13f)
        preset = Spinner(ui).apply {
            adapter = ArrayAdapter(ui, android.R.layout.simple_spinner_dropdown_item, names)
            setSelection(ids.indexOf(askState.optString("modelProfileId")).coerceAtLeast(0))
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) {
                    askState.put("modelProfileId", ids[position]); persistAsk()
                }
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            }
        }; body.addView(preset)
        model = ui.field(MoteI18n.text("模型 ID（留空跟随预设）"), askState.optString("modelOverride")).apply { filters = arrayOf(InputFilter.LengthFilter(512)) }
        watch(model!!) { askState.put("modelOverride", model!!.text.toString()); persistAsk() }
        ui.button(MoteI18n.text("添加图片")) {
            if (askState.has("pending") || askState.optString("runStatus") == "running") return@button
            ui.pickAttachment(chat = true)
        }
        val attachments = askState.optJSONArray("attachments") ?: JSONArray()
        for (i in 0 until attachments.length()) {
            val attachment = attachments.getJSONObject(i)
            ui.button(MoteI18n.text("移除附件：{0}", attachment.optString("name"))) {
                if (askState.has("pending") || askState.optString("runStatus") == "running") return@button
                attachments.remove(i); askState.put("attachments", attachments); persistAsk(); refresh()
            }
        }
        send = ui.button(MoteI18n.text("发送"), true) { submitAsk() }
        stop = ui.button(MoteI18n.text("停止回答")) {
            val id = askState.optString("runId"); if (id.isBlank()) return@button
            val api = client
            ui.work(MoteI18n.text("正在停止回答…"), { api.post("/api/query-runs/" + encode(id) + "/cancel") }) { run -> receiveRun(run) }
        }
        controlsAsk()
        ui.text(MoteI18n.text("对话历史"), 21f)
        val items = history.optJSONArray("items") ?: JSONArray()
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            ui.button(item.optString("title") + "\n" + item.optString("updatedAt")) {
                if (askState.has("pending") || askState.optString("runStatus") == "running") { ui.notice(MoteI18n.text("请先等待当前回答完成，或停止回答。")); return@button }
                askState.put("conversationId", item.getString("id")); askState.remove("runId"); persistAsk(); loadConversation(item.getString("id"))
            }
        }
        next(history)?.let { cursor ->
            ui.button(MoteI18n.text("加载更早的对话")) {
                val api = client
                ui.work(MoteI18n.text("正在读取对话…"), { api.get("/api/conversations?limit=30&cursor=" + encode(cursor)) }) { buildAsk(it) }
            }
        }
    }
    private fun controlsAsk() {
        val busy = askState.has("pending") || askState.optString("runStatus") == "running"
        question?.isEnabled = !busy
        preset?.isEnabled = !busy; model?.isEnabled = !busy
        send?.isEnabled = !busy || askState.has("pending")
        send?.text = if (askState.has("pending")) MoteI18n.text("重试同一请求") else MoteI18n.text("发送")
        stop?.visibility = if (askState.optString("runStatus") == "running") android.view.View.VISIBLE else android.view.View.GONE
    }
    private fun submitAsk() {
        val api = client
        val request = askState.optJSONObject("pending") ?: run {
            val text = question?.text?.toString()?.trim().orEmpty()
            if (text.isBlank()) { ui.notice(MoteI18n.text("请输入问题（最多 8000 字）")); return }
            val input = JSONObject().put("question", text).put("timeZone", java.time.ZoneId.systemDefault().id)
            askState.optString("modelProfileId").takeIf { it.isNotBlank() }?.let { input.put("modelProfileId", it) }
            askState.optString("modelOverride").trim().takeIf { it.isNotBlank() }?.let { input.put("modelOverride", it) }
            askState.optString("conversationId").takeIf { it.isNotBlank() }?.let { input.put("conversationId", it) }
            val attachments = askState.optJSONArray("attachments") ?: JSONArray()
            if (attachments.length() > 0) input.put("attachmentIds", JSONArray((0 until attachments.length()).map { attachments.getJSONObject(it).getString("id") }))
            JSONObject().put("id", UUID.randomUUID().toString()).put("input", input)
        }
        askState.put("pending", request); persistAsk(); controlsAsk()
        val snapshot = JSONObject(askState.toString())
        ui.work(MoteI18n.text("正在发送问题…"), {
            CentralDraftWrites.barrier { askStore.write(snapshot); draftFailure.set(null) }
            // Retrying preserves the admission ID even when the first response was lost.
            api.post("/api/query-runs", request)
        }) { run -> askState.remove("pending"); receiveRun(run) }
    }
    fun pollAsk() {
        if (currentPage != "ask" || detailBack != null) return
        // Returning to a tab must not replay a completed run and clear the next unsent draft.
        if (!askState.has("pending") && askState.optString("runStatus") in setOf("completed", "cancelled", "failed")) return
        val id = askState.optString("runId").ifBlank { askState.optJSONObject("pending")?.optString("id").orEmpty() }
        if (id.isBlank()) return
        val api = client
        ui.work(MoteI18n.text("正在读取回答进度…"), {
            try { api.get("/api/query-runs/" + encode(id)) } catch (error: CentralFailure) {
                if (error.status == 404) JSONObject().put("id", id).put("status", "missing") else throw error
            }
        }) { run ->
            if (run.optString("status") == "missing") {
                if (askState.has("pending")) { controlsAsk(); ui.notice(MoteI18n.text("请求尚未确认，可重试同一请求。")) }
                else { askState.remove("runId"); askState.remove("runStatus"); persistAsk(); controlsAsk(); ui.notice(MoteI18n.text("对话或运行记录已删除。")) }
            } else { askState.remove("pending"); receiveRun(run) }
        }
    }
    private fun receiveRun(run: JSONObject) {
        askState.put("runId", run.getString("id")).put("runStatus", run.getString("status"))
        run.optString("conversationId").takeIf { it.isNotBlank() }?.let { askState.put("conversationId", it) }
        val events = run.optJSONArray("events") ?: JSONArray()
        val latest = if (events.length() > 0) events.getJSONObject(events.length() - 1).optString("message") else ""
        runStatus?.text = when (run.getString("status")) {
            "running" -> latest.ifBlank { MoteI18n.text("中央节点正在回答…") }
            "completed" -> MoteI18n.text("回答已完成")
            "cancelled" -> MoteI18n.text("已停止回答")
            else -> run.optJSONObject("error")?.optString("message") ?: MoteI18n.text("回答未完成")
        }
        if (run.getString("status") == "completed") { askState.put("question", "").put("attachments", JSONArray()); question?.setText("") }
        persistAsk(); controlsAsk()
        if (run.getString("status") == "running") ui.scheduleAskPoll()
        else askState.optString("conversationId").takeIf { it.isNotBlank() }?.let { loadConversation(it) }
    }
    private fun loadConversation(id: String, cursor: String? = null) {
        val api = client
        ui.work(MoteI18n.text("正在读取对话…"), { api.get("/api/conversations/" + encode(id) + "?limit=20" + (cursor?.let { "&cursor=" + encode(it) } ?: "")) }) { conversation ->
            val target = messages ?: return@work
            target.removeAllViews(); runStatus = ui.text("", parent = target)
            val turns = conversation.getJSONArray("turns")
            for (i in 0 until turns.length()) {
                val turn = turns.getJSONObject(i)
                ui.text(turn.getString("question"), 18f, target)
                turn.optJSONObject("result")?.let { answer ->
                    ui.text(answer.optString("answer"), parent = target)
                    val citations = answer.optJSONArray("citations") ?: JSONArray()
                    for (j in 0 until citations.length()) {
                        val citation = citations.getJSONObject(j)
                        ui.text(citation.optString("excerpt"), parent = target)
                        ui.button(MoteI18n.text("查看原文依据") + " · " + citation.optString("appName"), parent = target) { library.captureEvidence(citation.getString("id")) }
                    }
                }
                turn.optJSONObject("error")?.let { ui.text(it.optString("message"), parent = target) }
            }
            next(conversation)?.let { older -> ui.button(MoteI18n.text("加载更早的对话"), parent = target) { loadConversation(id, older) } }
            if (askState.optString("runStatus") != "running") ui.button(MoteI18n.text("删除对话"), parent = target) {
                confirm(MoteI18n.text("删除对话"), MoteI18n.text("删除后无法恢复。")) {
                    ui.work(MoteI18n.text("正在删除…"), { api.delete("/api/conversations/" + encode(id)) }) {
                        askState.remove("conversationId"); askState.remove("runId"); persistAsk(); refresh()
                    }
                }
            }
        }
    }

    private fun loadNotes() {
        val api = client
        ui.work(MoteI18n.text("正在读取随手记…"), {
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
        noteText = ui.field(MoteI18n.text("此刻想留下什么？"), noteDraft.optString("text"), multiline = true).apply {
            filters = arrayOf(InputFilter.LengthFilter(100000)); minLines = 5
        }
        noteMood = ui.field(MoteI18n.text("心情（可选）"), noteDraft.optString("mood")).apply { filters = arrayOf(InputFilter.LengthFilter(80)) }
        watch(noteText!!) { persistNote() }; watch(noteMood!!) { persistNote() }
        ui.button(MoteI18n.text("图片与语音附件")) { ui.pickAttachment() }
        val attachments = noteDraft.getJSONArray("attachments")
        ui.text(MoteI18n.text("已添加 {0} 个附件", attachments.length()))
        for (i in 0 until attachments.length()) ui.button(MoteI18n.text("移除附件：{0}", i + 1)) {
            attachments.remove(i); persistNote(); refresh()
        }
        ui.button(MoteI18n.text("保存并同步"), true) {
            persistNote()
            syncNotes(enqueue = true)
        }
        ui.text(MoteI18n.text("图片和录音会先归档。是否提取文字或转写录音取决于中央处理设置；请在资料库查看状态。每个附件最多 50 MiB。"))
        val pending = state.getJSONArray("pending")
        if (pending.length() > 0) {
            ui.text(MoteI18n.text("待同步 {0} 条", pending.length()), 20f)
            ui.button(MoteI18n.text("重试同步")) {
                syncNotes(enqueue = false)
            }
            for (i in 0 until pending.length()) ui.text(pending.getJSONObject(i).getString("text"))
        }
        ui.text(MoteI18n.text("已经留下的心绪与杂事"), 21f)
        ui.button(MoteI18n.text("刷新")) { refresh() }
        val items = history.optJSONArray("items") ?: JSONArray()
        for (i in 0 until items.length()) {
            val note = items.getJSONObject(i); val card = ui.card()
            ui.text(note.optString("capturedAt"), 13f, card); ui.text(note.optString("ocrText"), parent = card)
            ui.button(MoteI18n.text("查看原文"), parent = card) { library.captureEvidence(note.getString("id")) }
        }
        next(history)?.let { cursor -> ui.button(MoteI18n.text("加载更早的随手记")) {
            val api = client
            ui.work(MoteI18n.text("正在读取随手记…"), { api.get("/api/notes?limit=30&cursor=" + encode(cursor)) }) { noteHistory = it; buildNotes(state, it) }
        } }
    }

    private fun syncNotes(enqueue: Boolean) {
        val api = client
        ui.work(MoteI18n.text("正在保存随手记…"), {
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

    fun addAttachments(uris: List<Uri>, chat: Boolean) {
        if (chat && (askState.has("pending") || askState.optString("runStatus") == "running")) return
        val api = client
        val previous = if (chat) askState.optJSONArray("attachments") ?: JSONArray() else noteDraft.getJSONArray("attachments")
        val max = if (chat) 4 else 10
        if (previous.length() + uris.size > max) { ui.notice(if (chat) MoteI18n.text("最多添加 4 张图片") else MoteI18n.text("最多 10 个附件")); return }
        val draftSnapshot = JSONObject(noteDraft.toString())
        val askSnapshot = JSONObject(askState.toString())
        ui.work(MoteI18n.text("正在上传附件…"), { progress -> runCatching {
            val settings = Settings(ui)
            for (uri in uris) {
                val mime = ui.contentResolver.getType(uri).orEmpty()
                require(!chat || mime in listOf("image/png", "image/jpeg", "image/webp")) { MoteI18n.text("请选择 PNG、JPEG 或 WebP 图片。") }
                val name = ui.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null } ?: "attachment"
                directory.mkdirs()
                val spool = File(directory, "attachment-" + UUID.randomUUID() + ".tmp")
                try {
                    ui.contentResolver.openInputStream(uri)!!.use { input -> spool.outputStream().use { output ->
                        val buffer = ByteArray(65536); var total = 0
                        while (true) { val n = input.read(buffer); if (n < 0) break; total += n
                            require(total <= if (chat) 8 * 1024 * 1024 else CentralAttachments.MAX_BYTES) { MoteI18n.text("附件必须是图片或音频，且每个文件最多 50 MiB。") }
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
                    if (chat) {
                        val attachments = askSnapshot.optJSONArray("attachments") ?: JSONArray()
                        attachments.put(JSONObject().put("id", id).put("name", name)); askSnapshot.put("attachments", attachments)
                        CentralDraftWrites.barrier { askStore.write(askSnapshot) }
                    } else {
                        draftSnapshot.getJSONArray("attachments").put(id)
                        CentralDraftWrites.barrier { noteStore.edit(draftSnapshot.getString("text"), draftSnapshot.getString("mood"), draftSnapshot.getJSONArray("attachments")) }
                    }
                } finally { spool.delete() }
            }
        } }) { outcome ->
            askState = askSnapshot; noteDraft = draftSnapshot
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

    fun confirm(title: String, message: String, action: () -> Unit) {
        MoteDialogBuilder(ui).setTitle(title).setMessage(message).setNegativeButton(MoteI18n.text("取消"), null)
            .setPositiveButton(MoteI18n.text("确认")) { _, _ -> action() }.show()
    }
    companion object {
        fun encode(value: String): String = java.net.URLEncoder.encode(value, "UTF-8")
        fun next(value: JSONObject): String? = if (value.isNull("nextCursor") || !value.has("nextCursor")) null else value.opt("nextCursor").toString()
        val pages = listOf(
            "overview" to "中央工作台", "archive" to "中央资料库", "ask" to "问一问", "notes" to "随手记",
            "materials" to "正式资料", "coding" to "Coding Agent 上传", "timeline" to "片段", "files" to "文件与录音",
            "memories" to "记忆", "insights" to "洞察", "actions" to "行动", "agentView" to "Agent 视角",
            "sources" to "来源", "devices" to "设备", "connections" to "对外授权", "lark" to "飞书",
            "statistics" to "运行状态", "processing" to "处理任务", "extensions" to "扩展能力", "settings" to "模型与服务",
            "usage" to "用量与费用", "vault" to "存储与索引", "developer" to "诊断与更新", "about" to "设置", "imports" to "导入", "help" to "帮助与反馈"
        )
    }
}
