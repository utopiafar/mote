package dev.mote.collector

import android.app.DatePickerDialog
import android.graphics.BitmapFactory
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.ZoneId

/** Explicit API schemas choose views; titles and captured text never choose actions. */
internal class CentralLibrary(private val screens: CentralScreens) {
    private val ui get() = screens.ui
    private val body get() = screens.body
    private val client get() = screens.client
    private fun enc(value: String) = CentralScreens.encode(value)
    private var day = ""
    private var source = ""
    private var query = ""
    private var rawSource = ""
    private var memoryDeletionNotice: Pair<CentralClient, String>? = null

    fun show(page: String) {
        when (page) {
            "archive" -> archive()
            "timeline" -> sessions()
            "materials", "coding" -> materials(page == "coding")
            "files" -> files()
            "sources" -> sources()
            "memories" -> memories()
            "insights" -> insights()
        }
    }
    private fun archive() {
        val api = client
        val path = "/api/library/catalog?limit=24" + (if (source.isNotBlank()) "&sourceId=" + enc(source) else "")
        ui.work(MoteI18n.text("正在读取…"), { api.get(path) }) { result ->
            val descriptor = CentralCatalogDescriptor.read(result)
            ui.text(MoteI18n.text("全部资料"), NativeFontRole.TITLE_MOBILE)
            ui.text(MoteI18n.text("包括 Coding Agent 会话；可读内容不等待记忆整理。"))
            val filters = ui.card()
            val facets = result.optJSONArray("sources") ?: JSONArray()
            val choices = listOf("" to MoteI18n.text("全部来源")) + (0 until facets.length()).map { index ->
                facets.getJSONObject(index).let { it.getString("id") to it.getString("label") }
            }
            val selection = Spinner(ui).apply {
                adapter = ArrayAdapter(ui, android.R.layout.simple_spinner_dropdown_item, choices.map { it.second })
                setSelection(choices.indexOfFirst { it.first == source }.coerceAtLeast(0))
            }; filters.addView(selection)
            ui.button(MoteI18n.text("筛选"), parent = filters) { source = choices[selection.selectedItemPosition].first; screens.refresh() }
            ui.button(MoteI18n.text("原始采集记录"), parent = filters) { body.removeAllViews(); screens.setBack { screens.refresh() }; rawArchive() }
            ui.button(MoteI18n.text("上传与处理"), parent = filters) { body.removeAllViews(); screens.setBack { screens.refresh() }; codingStatus() }
            val target = ui.card()
            val render: (JSONObject, LinearLayout) -> Unit = { row, card ->
                val type = descriptor.type(row.optString("kind"), row.optInt("schemaVersion"))
                ui.text(row.getString("title"), NativeFontRole.ROW, card)
                ui.text(type?.let { MoteI18n.text(it.label) } ?: row.optString("kind"), parent = card)
                ui.text(row.optJSONObject("coverage")?.optString("state").orEmpty(), parent = card)
                ui.button(MoteI18n.text("查看原文"), parent = card) { material(row.getString("id"), row.getString("revision")) }
            }
            renderPage(path, target, null, result, render)
        }
    }
    private fun codingStatus() {
        ui.text(MoteI18n.text("上传与处理"), NativeFontRole.TITLE_MOBILE)
        ui.text(MoteI18n.text("接收成功表示原件已保留；正文发布、索引和记忆整理分别显示状态。"))
        paged("/api/coding/uploads?limit=20", ui.card()) { row, card ->
            val source = row.getJSONObject("source")
            ui.text(source.getString("name"), NativeFontRole.ROW, card)
            ui.text(MoteI18n.text("已接收事件") + ": " + row.getJSONObject("received").getInt("events"), parent = card)
            ui.text(MoteI18n.text("已发布资料") + ": " + row.getInt("materials"), parent = card)
            ui.text(MoteI18n.text("已索引资料") + ": " + row.getInt("indexedMaterials"), parent = card)
            ui.button(MoteI18n.text("查看聚合正文"), parent = card) { this.source = source.getString("id"); screens.refresh() }
        }
    }
    private fun rawArchive() {
        val filters = ui.card()
        val search = ui.field(MoteI18n.text("搜索原文"), query, parent = filters)
        ui.button(if (day.isBlank()) MoteI18n.text("全部日期") else day, parent = filters) {
            val date = day.takeIf { it.isNotBlank() }?.let(LocalDate::parse) ?: LocalDate.now()
            DatePickerDialog(ui, { _, year, month, dateOfMonth ->
                day = LocalDate.of(year, month + 1, dateOfMonth).toString(); body.removeAllViews(); rawArchive()
            }, date.year, date.monthValue - 1, date.dayOfMonth).show()
        }
        if (day.isNotBlank()) ui.button(MoteI18n.text("全部日期"), parent = filters) { day = ""; body.removeAllViews(); rawArchive() }
        val choices = listOf("" to "全部记录", "screen" to "截图", "ui_page" to "页面内容采集", "note" to "随手记", "notification" to "通知", "file" to "文件")
        val choice = Spinner(ui).apply { adapter = ArrayAdapter(ui, android.R.layout.simple_spinner_dropdown_item, choices.map { MoteI18n.text(it.second) })
            setSelection(choices.indexOfFirst { it.first == rawSource }.coerceAtLeast(0)) }; filters.addView(choice)
        ui.button(MoteI18n.text("搜索"), parent = filters) { query = search.text.toString(); rawSource = choices[choice.selectedItemPosition].first; body.removeAllViews(); rawArchive() }
        ui.button(MoteI18n.text("刷新"), parent = filters) { body.removeAllViews(); rawArchive() }
        ui.button(MoteI18n.text("应用活动与媒体")) { activity() }
        val list = ui.card()
        val params = mutableListOf("limit=24")
        if (rawSource.isNotBlank()) params.add("source=" + enc(rawSource))
        if (day.isNotBlank()) {
            val date = LocalDate.parse(day); val zone = ZoneId.systemDefault()
            params.add("after=" + enc(date.atStartOfDay(zone).toInstant().toString()))
            params.add("before=" + enc(date.plusDays(1).atStartOfDay(zone).toInstant().toString()))
        }
        if (query.isNotBlank()) {
            // Search is delegated to the server's evidence reader, with no local intent classifier.
            val path = "/api/context/search?" + params.filterNot { it.startsWith("source=") }.joinToString("&") + "&query=" + enc(query)
            paged(path, list) { row, card ->
                ui.text(row.optString("title"), NativeFontRole.ROW, card); ui.text(row.optString("snippet"), parent = card)
                ui.button(MoteI18n.text("查看原文"), parent = card) { evidence(row.getString("ref")) }
            }
        } else paged("/api/capture-browser?" + params.joinToString("&"), list) { row, card ->
            ui.text(row.optString("appName"), NativeFontRole.ROW, card); ui.text(row.optString("capturedAt"), NativeFontRole.SUPPORT, card)
            ui.text(row.optString("textPreview"), parent = card)
            ui.button(MoteI18n.text("查看原文"), parent = card) { capture(row.getString("id")) }
        }
    }
    private fun activity() {
        body.removeAllViews(); screens.setBack { ui.navigate("archive") }
        val params = if (day.isBlank()) "" else LocalDate.parse(day).let { date ->
            val zone = ZoneId.systemDefault()
            "?after=" + enc(date.atStartOfDay(zone).toInstant().toString()) + "&before=" + enc(date.plusDays(1).atStartOfDay(zone).toInstant().toString())
        }
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/activity" + params) to api.get("/api/media-activity" + params) }) { (apps, media) ->
            ui.text(MoteI18n.text("应用活动与媒体"), NativeFontRole.TITLE_MOBILE); values(apps, ui.card())
            ui.text(MoteI18n.text("媒体统计"), NativeFontRole.SECTION); values(media, ui.card())
        }
    }
    private fun sessions() {
        if (day.isBlank()) day = LocalDate.now().toString()
        ui.button(day) {
            val date = LocalDate.parse(day)
            DatePickerDialog(ui, { _, y, m, d -> day = LocalDate.of(y, m + 1, d).toString(); screens.refresh() }, date.year, date.monthValue - 1, date.dayOfMonth).show()
        }
        val date = LocalDate.parse(day); val zone = ZoneId.systemDefault()
        val path = "/api/capture-browser/sessions?limit=20&after=" + enc(date.atStartOfDay(zone).toInstant().toString()) +
            "&before=" + enc(date.plusDays(1).atStartOfDay(zone).toInstant().toString())
        paged(path, ui.card()) { row, card ->
            ui.text(row.optString("appName"), NativeFontRole.SECTION, card)
            ui.text(row.optString("firstAt") + " — " + row.optString("capturedAt"), parent = card)
            ui.button(MoteI18n.text("展开记录"), parent = card) {
                body.removeAllViews(); screens.setBack { ui.navigate("timeline") }
                paged(path + "&sessionId=" + enc(row.getString("id")) + "&deviceId=" + enc(row.getString("deviceId")), ui.card()) { item, child ->
                    ui.text(item.optString("capturedAt"), parent = child)
                    ui.button(MoteI18n.text("查看原文"), parent = child) { capture(item.getString("id")) }
                }
            }
        }
    }
    private fun materials(coding: Boolean) {
        if (coding) {
            paged("/api/coding/uploads?limit=30", ui.card()) { row, card ->
                val source = row.getJSONObject("source")
                ui.text(source.getString("name"), NativeFontRole.ROW, card); values(row, card)
                ui.button(MoteI18n.text("来源资料"), parent = card) {
                    body.removeAllViews(); screens.setBack { screens.refresh() }
                    paged("/api/materials?limit=20&sourceId=" + enc(source.getString("id")), ui.card()) { item, child ->
                        ui.button(item.getString("title"), parent = child) { material(item.getString("id"), item.getString("revision")) }
                    }
                }
            }
        } else paged("/api/materials?limit=20", ui.card()) { row, card ->
            ui.text(row.optString("title"), NativeFontRole.ROW, card); ui.text(row.optString("kind") + " · " + row.optJSONObject("coverage")?.optString("state"), parent = card)
            ui.button(MoteI18n.text("查看原文"), parent = card) { material(row.getString("id"), row.getString("revision")) }
        }
    }
    fun captureEvidence(id: String) = evidence(CentralEvidenceReference.capture(id))
    fun evidence(reference: String, offset: Int = 0) {
        require(reference.isNotBlank() && reference.length <= 4096)
        val materialRef = Regex("^material:(mat_[a-f0-9]{64})(?:@([a-f0-9]{64}))?$").matchEntire(reference)
        if (materialRef != null) { material(materialRef.groupValues[1], materialRef.groupValues[2].takeIf { it.isNotBlank() }); return }
        val captureId = CentralEvidenceReference.captureId(reference)
        if (captureId != null) { capture(captureId); return }
        val api = client
        ui.work(MoteI18n.text("正在读取原文…"), {
            api.post("/api/context/read", JSONObject().put("refs", JSONArray().put(reference)).put("offset", offset).put("length", 4000))
        }) { result ->
            body.removeAllViews(); screens.setBack { screens.refresh() }
            val item = result.optJSONArray("items")?.optJSONObject(0)
            if (item == null) { ui.text(MoteI18n.text("资料不存在或已删除。")); return@work }
            ui.text(item.optString("title"), NativeFontRole.TITLE_MOBILE); ui.text(item.optString("text"))
            val range = item.optJSONObject("textRange")
            if (range != null && !range.isNull("nextOffset")) ui.button(MoteI18n.text("继续展开")) { evidence(reference, range.getInt("nextOffset")) }
            val refs = item.optJSONArray("evidenceRefs") ?: JSONArray()
            for (i in 0 until refs.length()) ui.button(MoteI18n.text("查看原始记录") + " · " + refs.getString(i).takeLast(8)) { evidence(refs.getString(i)) }
        }
    }
    private fun capture(id: String, topicMemoryId: String? = null, accept: ((JSONObject) -> Boolean)? = null) {
        val api = client
        ui.work(MoteI18n.text("正在读取原文…"), {
            val row = api.get("/api/capture-browser/" + enc(id))
            row to topicMemoryId?.let { api.get("/api/memories/" + enc(it)) }
        }) { (row, memory) ->
            if (memory != null && accept != null && !accept(memory)) return@work
            body.removeAllViews(); screens.setBack { screens.refresh() }
            ui.text(row.optString("appName"), NativeFontRole.TITLE_MOBILE); ui.text(row.optString("capturedAt")); ui.text(row.optString("ocrText"))
            ui.button(MoteI18n.text("基于这条记录提问")) { screens.askAbout(id) }
            val metadata = row.optJSONObject("metadata")
            values(metadata ?: JSONObject(), ui.card())
            val attachments = metadata?.optJSONArray("attachments") ?: JSONArray()
            for (i in 0 until attachments.length()) ui.button(MoteI18n.text("附件") + " " + (i + 1)) { file(attachments.getString(i)) }
            if (row.optBoolean("hasImage") || !row.isNull("blobHash") && row.has("blobHash")) ui.button(MoteI18n.text("查看原图")) {
                image("/api/capture-browser/" + enc(id) + "/image", body)
            }
            ui.button(MoteI18n.text("删除记录")) {
                screens.confirm(MoteI18n.text("删除中央记录"), MoteI18n.text("删除中央保存的这条记录。不会删除本机副本或来源原件，也不会改变来源同步策略。删除后无法恢复。")) {
                    ui.work(MoteI18n.text("正在删除…"), { api.delete("/api/captures/" + enc(id)) }) { screens.refresh() }
                }
            }
            if (topicMemoryId != null) ui.scheduleMemoryTopicsPoll()
        }
    }
    private fun relationLabel(value: String): String = when (value) {
        "owner" -> MoteI18n.text("我的表达或经历")
        "third_party" -> MoteI18n.text("第三方内容")
        "mixed" -> MoteI18n.text("混合内容")
        else -> MoteI18n.text("归属未知")
    }
    private fun relationSelector(value: String, source: Boolean, card: LinearLayout): Pair<Spinner, List<String>> {
        val options = listOf("", "owner", "third_party", "mixed", "unknown")
        ui.text(MoteI18n.text("内容与我的关系"), parent = card)
        val selector = Spinner(ui).apply {
            adapter = ArrayAdapter(ui, android.R.layout.simple_spinner_dropdown_item, options.map { if (it.isEmpty()) { if (source) MoteI18n.text("不声明") else MoteI18n.text("跟随来源") } else relationLabel(it) })
            setSelection(options.indexOf(value).coerceAtLeast(0))
        }; card.addView(selector)
        ui.text(MoteI18n.text("声明帮助模型区分你的表达、第三方内容和混合引用；归属未知也能查询和整理。"), parent = card)
        return selector to options
    }
    private fun material(id: String, revision: String?, offset: Int = 0) {
        val api = client
        ui.work(MoteI18n.text("正在读取原文…"), {
            api.get("/api/materials/" + enc(id) + "/read?offset=$offset&length=4000" + (revision?.let { "&revision=" + enc(it) } ?: "")) to api.get("/api/materials/" + enc(id))
        }) { (value, current) ->
            body.removeAllViews(); screens.setBack { screens.refresh() }
            val item = value.getJSONObject("material"); ui.text(item.getString("title"), NativeFontRole.TITLE_MOBILE)
            ui.text(MoteI18n.text("版本 {0}", item.opt("sequence"))); ui.text(value.getString("text"))
            values(item.getJSONObject("origin"), ui.card())
            item.optJSONObject("attributionContext")?.let { context ->
                val card = ui.card(); ui.text(MoteI18n.text("内容与我的关系") + " · " + relationLabel(context.optString("ownerRelation")), parent = card)
                val basis = when (context.optString("basis")) {
                    "owner_material" -> MoteI18n.text("你对这份资料的声明")
                    "owner_source" -> MoteI18n.text("你对来源的声明")
                    "connector" -> MoteI18n.text("来源提供的上下文")
                    else -> MoteI18n.text("尚无归属声明")
                }; ui.text(MoteI18n.text("归属依据") + " · " + basis, parent = card)
                if (current.getString("revision") == item.getString("revision")) {
                    ui.text(MoteI18n.text("纠正内容归属（可选）"), parent = card)
                    val (choice, options) = relationSelector(context.optJSONObject("correction")?.optString("ownerRelation").orEmpty().let { if (it == "null") "" else it }, false, card)
                    ui.button(MoteI18n.text("保存归属声明"), true, parent = card) {
                        val relation = options[choice.selectedItemPosition]
                        ui.work(MoteI18n.text("正在保存…"), { api.patch("/api/materials/" + enc(id) + "/context", JSONObject().put("expectedRevision", item.getString("revision")).put("ownerRelation", relation.ifEmpty { null } ?: JSONObject.NULL)) }) { updated -> material(id, updated.getString("revision")) }
                    }
                } else ui.button(MoteI18n.text("查看当前版本"), parent = card) { material(id, current.getString("revision")) }
            }
            val range = value.getJSONObject("textRange")
            if (!range.isNull("nextOffset")) ui.button(MoteI18n.text("继续展开")) { material(id, revision, range.getInt("nextOffset")) }
            ui.button(MoteI18n.text("来源与处理")) {
                val target = ui.card()
                paged("/api/materials/" + enc(id) + "/members?limit=20" + (revision?.let { "&revision=" + enc(it) } ?: ""), target) { member, card ->
                    ui.button(member.optString("kind"), parent = card) { evidence(member.getString("ref")) }
                }
            }
        }
    }
    private fun files() {
        val search = ui.field(MoteI18n.text("文件名"), query)
        ui.button(MoteI18n.text("搜索")) { query = search.text.toString(); screens.refresh() }
        paged("/api/files?limit=30&query=" + enc(query), ui.card()) { row, card ->
            ui.text(row.getJSONObject("item").optString("title"), NativeFontRole.SECTION, card)
            ui.text(row.optJSONObject("job")?.optString("state").orEmpty(), parent = card)
            ui.button(MoteI18n.text("查看详情"), parent = card) { file(row.getString("captureId")) }
        }
        ui.button(MoteI18n.text("处理设置")) { CentralAdmin(screens).fileSettings() }
    }
    private fun file(id: String, offset: Int = 0) {
        val api = client
        ui.work(MoteI18n.text("正在读取文件…"), { api.get("/api/files/" + enc(id)) to api.get("/api/files/" + enc(id) + "/chunks?offset=$offset") }) { (row, chunks) ->
            body.removeAllViews(); screens.setBack { screens.refresh() }
            val item = row.getJSONObject("item")
            ui.text(item.optString("title"), NativeFontRole.TITLE_MOBILE); ui.text(item.optString("mimeType")); ui.text(item.optString("text"))
            val job = row.optJSONObject("job")
            val cancellation = row.optJSONObject("cancellation")
            val processing = ui.card()
            ui.text(MoteI18n.text("处理状态") + " · " + processingState(job?.optString("state").orEmpty(), job?.optString("error").orEmpty(), job == null), parent = processing)
            if (job != null) {
                ui.text(MoteI18n.text("阶段") + " · " + job.optString("stage"), parent = processing)
                ui.text(MoteI18n.text("摘要") + " · " + processingState(job.optString("summary_state"), job.optString("error")), parent = processing)
                if (!job.isNull("error") && job.optString("error").isNotBlank()) ui.text(job.getString("error"), parent = processing)
            }
            if (row.optBoolean("originMissing")) ui.text(MoteI18n.text(" · 来源已不可见，中央归档仍可使用").trim(), parent = processing)
            when (cancellation?.optString("wait")) {
                "running" -> ui.text(MoteI18n.text("外部结果尚未确认，停止请求不代表远端工作已结束。"), parent = processing)
                "unknown" -> ui.text(MoteI18n.text("上次处理是否结束未知，重试可能重复执行。请确认后继续。"), parent = processing)
            }
            if (job != null) ui.disclosure(MoteI18n.text("处理详情")) { target -> ui.text(job.toString(2), parent = target) }
            if (row.optBoolean("hasOriginal")) {
                if (item.optString("mimeType").startsWith("image/")) ui.button(MoteI18n.text("查看原图")) { image("/api/files/" + enc(id) + "/content", body) }
                if (item.optString("mimeType").startsWith("audio/")) ui.button(MoteI18n.text("播放录音")) { screens.playAudio("/api/files/" + enc(id) + "/content", body) }
                ui.button(MoteI18n.text("保存原件")) { ui.saveCentral("/api/files/" + enc(id) + "/content", item.optString("title", "mote-file"), item.optString("mimeType", "application/octet-stream")) }
            }
            ui.button(MoteI18n.text("导出")) { ui.saveCentral("/api/files/" + enc(id) + "/export", "mote-file.tar.gz", "application/gzip") }
            val items = chunks.optJSONArray("items") ?: JSONArray()
            for (i in 0 until items.length()) {
                val chunk = items.getJSONObject(i); val card = ui.card()
                ui.text(chunk.optString("ocrText"), parent = card)
                val fileEvidence = chunk.optJSONObject("fileEvidence")
                if (fileEvidence != null) ui.button(MoteI18n.text("纠正此段"), parent = card) {
                    val original = if (fileEvidence.optString("speaker").isNotBlank()) chunk.optString("ocrText").removePrefix("[" + fileEvidence.getString("speaker") + "] ") else chunk.optString("ocrText")
                    val text = ui.field(MoteI18n.text("校正此段文字"), original, multiline = true, parent = card)
                    ui.button(MoteI18n.text("保存校正"), true, parent = card) {
                        val value = text.text.toString()
                        ui.work(MoteI18n.text("正在保存…"), {
                            api.post("/api/files/" + enc(id) + "/corrections", JSONObject().put("artifactId", fileEvidence.getString("artifactId"))
                                .put("chunkId", chunk.getString("id")).put("originalText", original).put("correctedText", value))
                        }) { file(id, offset) }
                    }
                }
            }
            if (!chunks.isNull("nextOffset")) ui.button(MoteI18n.text("继续展开")) { file(id, chunks.getInt("nextOffset")) }
            if (cancellation?.optBoolean("canCancel") == true) ui.button(MoteI18n.text("停止处理")) {
                ui.work(MoteI18n.text("正在停止处理…"), { api.post("/api/files/" + enc(id) + "/cancel") }) { file(id, offset) }
            }
            if (cancellation?.optString("wait") != "running") listOf("transcribe" to "转写", "diarize" to "说话人分离", "summary" to "摘要").forEach { (stage, label) ->
                ui.button(MoteI18n.text("重试") + " · " + MoteI18n.text(label)) {
                    val retry = {
                        ui.work(MoteI18n.text("正在处理…"), { api.post("/api/files/" + enc(id) + "/retry", JSONObject().put("stage", stage).put("confirmUnknown", cancellation?.optString("wait") == "unknown")) }) { file(id, offset) }
                    }
                    if (cancellation?.optString("wait") == "unknown") screens.confirm(MoteI18n.text("确认重试"), MoteI18n.text("上次处理是否结束未知，重试可能重复执行。请确认后继续。"), retry) else retry()
                }
            }
            ui.button(MoteI18n.text("删除文件")) { screens.confirm(MoteI18n.text("删除中央文件"), MoteI18n.text("删除中央保存的这份文件。不会删除设备上的原件，也不会改变来源同步策略。删除后无法恢复。")) {
                ui.work(MoteI18n.text("正在删除…"), { api.delete("/api/files/" + enc(id)) }) { screens.refresh() }
            } }
        }
    }
    private fun processingState(state: String, reason: String = "", notScheduled: Boolean = false): String {
        val key = CentralProcessingPresentation.stateKey(state, reason, notScheduled) ?: when (state) {
            "waiting" -> "等待处理"
            "running" -> "运行中"
            "blocked" -> "受阻"
            "failed" -> "处理失败"
            "succeeded" -> "已完成"
            "cancelled" -> "已取消"
            "skipped" -> "已跳过"
            "stale" -> "来源变化待重验"
            else -> return state
        }
        return MoteI18n.text(key)
    }
    private fun sources() {
        ui.button(MoteI18n.text("本机来源")) { ui.startActivity(android.content.Intent(ui, SourcesActivity::class.java)) }
        ui.button(MoteI18n.text("连接更多来源")) { CentralAdmin(screens).connectors() }
        paged("/api/sources", ui.card()) { row, card ->
            ui.text(row.optString("name"), NativeFontRole.SECTION, card); ui.text(row.optString("kind") + " · " + row.optString("deviceId"), parent = card)
            ui.button(MoteI18n.text("编辑来源"), parent = card) {
                val name = ui.field(MoteI18n.text("名称"), row.optString("name"), parent = card)
                ui.text(MoteI18n.text("来源内容归属（可选）"), parent = card)
                ui.text(MoteI18n.text("来源声明应用于已有和新资料；单份资料的声明优先。"), parent = card)
                val (relation, relations) = relationSelector(row.optString("ownerRelation"), true, card)
                val enabled = CheckBox(ui).apply { text = MoteI18n.text("启用"); isChecked = row.optBoolean("enabled") }; card.addView(enabled)
                val policies = listOf("archive", "snapshot", "reference")
                val policy = Spinner(ui).apply { adapter = ArrayAdapter(ui, android.R.layout.simple_spinner_dropdown_item, policies)
                    setSelection(policies.indexOf(row.optString("retention")).coerceAtLeast(0)) }; card.addView(policy)
                ui.button(MoteI18n.text("保存设置"), true, parent = card) {
                    val api = client; val request = JSONObject().put("name", name.text.toString()).put("enabled", enabled.isChecked).put("retention", policies[policy.selectedItemPosition]).put("ownerRelation", relations[relation.selectedItemPosition].ifEmpty { null } ?: JSONObject.NULL)
                    ui.work(MoteI18n.text("正在保存…"), { api.patch("/api/sources/" + enc(row.getString("id")), request) }) { screens.refresh() }
                }
            }
            ui.button(MoteI18n.text("来源资料"), parent = card) {
                body.removeAllViews(); screens.setBack { screens.refresh() }
                paged("/api/sources/" + enc(row.getString("id")) + "/items?limit=30", ui.card()) { item, child ->
                    ui.text(item.optString("title"), NativeFontRole.ROW, child); ui.text(item.optString("text"), parent = child)
                    item.optString("captureId").takeIf { it.isNotBlank() }?.let { id -> ui.button(MoteI18n.text("查看原文"), parent = child) { captureEvidence(id) } }
                    ui.button(MoteI18n.text("历史版本"), parent = child) {
                        val api = client
                        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/sources/" + enc(row.getString("id")) + "/history?externalId=" + enc(item.getString("externalId"))) }) { history -> values(history, child) }
                    }
                }
            }
        }
    }
    private val topics by lazy { CentralMemoryTopics(screens, {
        memoryDeletionNotice?.takeIf { it.first === client }?.let { ui.text(it.second) }
        ui.button(MoteI18n.text("提取记忆")) { CentralAdmin(screens).memoryJobs() }
        ui.button(MoteI18n.text("记忆设置")) { CentralAdmin(screens).memorySettings() }
    }, ::memoryStatus) { id, back, accept -> memory(id, back, accept) } }
    private fun memories() = topics.show()
    fun saveTopics(out: android.os.Bundle) = topics.save(out)
    fun restoreTopics(value: android.os.Bundle) = topics.restore(value)
    fun pollTopics() = topics.poll()
    fun clearTopics() = topics.clear()
    private fun memoryStatus(row: JSONObject): String = when (row.optString("status")) {
                "proposed" -> MoteI18n.text("待重新处理")
                "published" -> when {
                    !row.isNull("supersededBy") && row.optString("supersededBy").isNotBlank() &&
                        (row.isNull("supersededAt") || java.time.Instant.parse(row.getString("supersededAt")).toEpochMilli() <= System.currentTimeMillis()) -> MoteI18n.text("已由新版本替代")
                    !row.isNull("validUntil") && java.time.Instant.parse(row.getString("validUntil")).toEpochMilli() <= System.currentTimeMillis() -> MoteI18n.text("已过期")
                    !row.isNull("validFrom") && java.time.Instant.parse(row.getString("validFrom")).toEpochMilli() > System.currentTimeMillis() -> MoteI18n.text("尚未生效")
                    else -> MoteI18n.text("已生效")
                }
                "stale" -> MoteI18n.text("需要重验")
                else -> row.optString("status")
    }
    private fun memory(id: String, returnTo: (() -> Unit)? = null, accept: ((JSONObject) -> Boolean)? = null) {
        val api = client
        ui.work(MoteI18n.text("正在读取记忆…"), { api.get("/api/memories/" + enc(id)) }) { row ->
            if (accept != null && !accept(row)) return@work
            body.removeAllViews(); screens.setBack { returnTo?.invoke() ?: screens.refresh() }
            val evidenceIds = row.optJSONArray("evidenceIds") ?: JSONArray()
            ui.text(row.getString("title"), NativeFontRole.TITLE_MOBILE)
            ui.text(memoryStatus(row) + " · " + evidenceIds.length() + " " + MoteI18n.text("条证据"))
            ui.text(row.optString("statement"))
            val facts = ui.card()
            ui.text(MoteI18n.text("版本 {0}", row.optInt("version", 1)), parent = facts)
            listOf("validFrom" to "生效于", "validUntil" to "失效于").forEach { (field, label) ->
                if (!row.isNull(field) && row.optString(field).isNotBlank()) ui.text(MoteI18n.text(label) + " · " + row.getString(field), parent = facts)
            }
            if (!row.isNull("correction") && row.has("correction")) ui.text(MoteI18n.text("这是用户主动纠正的版本，原始说明已保留。"), parent = facts)
            row.optJSONObject("admission")?.let { admission ->
                ui.text(MoteI18n.text(if (admission.optString("layer") == "memory") "精选记忆" else "事件与资料"), NativeFontRole.SECTION, facts)
                ui.text(admission.optString("reason"), parent = facts); ui.text(admission.optString("scope"), parent = facts)
                if (admission.optString("attribution").isNotBlank()) ui.text(admission.getString("attribution"), parent = facts)
            }
            // Applicability, relationships and evidence validity remain direct facts.
            listOf("coding", "scopeRefs", "relations", "supersededBy", "supersededAt", "staleReason").forEach { field ->
                if (!row.isNull(field) && row.has(field)) values(JSONObject().put(field, row.get(field)), facts)
            }
            ui.text(MoteI18n.text("不确定性"), NativeFontRole.SECTION, facts)
            ui.text(row.optString("uncertainty"), parent = facts)
            ui.disclosure(MoteI18n.text("元数据")) { target -> ui.text(row.toString(2), parent = target) }
            for (i in 0 until evidenceIds.length()) ui.button(MoteI18n.text("查看原文依据") + " " + (i + 1)) { if (returnTo != null) capture(evidenceIds.getString(i), id, accept) else captureEvidence(evidenceIds.getString(i)) }
            val statement = ui.field(MoteI18n.text("陈述"), row.optString("statement"), multiline = true)
            val title = ui.field(MoteI18n.text("标题"), row.optString("title"))
            val uncertainty = ui.field(MoteI18n.text("不确定性"), row.optString("uncertainty"), multiline = true)
            if (returnTo != null) {
                statement.tag = MemoryTopicEdit(MoteI18n.text("陈述"), statement.text.toString())
                title.tag = MemoryTopicEdit(MoteI18n.text("标题"), title.text.toString())
                uncertainty.tag = MemoryTopicEdit(MoteI18n.text("不确定性"), uncertainty.text.toString())
            }
            ui.button(MoteI18n.text("保存校正"), true) {
                val corrected = JSONObject().put("title", title.text.toString()).put("statement", statement.text.toString()).put("uncertainty", uncertainty.text.toString()).put("version", row.optInt("version", 1))
                ui.work(MoteI18n.text("正在保存…"), { api.post("/api/memories/" + enc(id) + "/correct", corrected) }) { memory(id, returnTo, accept) }
            }
            ui.button(MoteI18n.text("删除记忆")) { screens.confirm(MoteI18n.text("删除记忆"), MoteI18n.text("删除后无法恢复。")) {
                ui.work(MoteI18n.text("正在删除…"), { api.delete("/api/memories/" + enc(id)) }) { receipt ->
                    val message = when {
                        receipt.optString("externalErase") == "pending" -> MoteI18n.text("记忆已禁止使用；外部清除仍待确认。")
                        receipt.optString("externalErase") == "acknowledged" && !receipt.optBoolean("physicalEraseVerified") -> MoteI18n.text("记忆已禁止使用；外部已确认移除当前记录，物理擦除尚未核验。")
                        else -> MoteI18n.text("记忆已禁止使用。")
                    }
                    memoryDeletionNotice = api to message; returnTo?.invoke() ?: screens.refresh()
                }
            } }
            if (returnTo != null) ui.scheduleMemoryTopicsPoll()
        }
    }
    private fun insights() = screens.showInsights()
    private fun image(path: String, parent: LinearLayout) {
        val api = client
        ui.work(MoteI18n.text("正在读取原图…"), {
            val bytes = api.image(path)
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            require(bounds.outWidth > 0 && bounds.outHeight > 0)
            var sample = 1; while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2048) sample *= 2
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        }) { bitmap ->
            parent.addView(ImageView(ui).apply { adjustViewBounds = true; contentDescription = MoteI18n.text("当前选择的采集截图"); setImageBitmap(bitmap) }, LinearLayout.LayoutParams(-1, -2))
        }
    }
    fun paged(path: String, target: LinearLayout, cursor: String? = null, render: (JSONObject, LinearLayout) -> Unit) {
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get(path + (cursor?.let { (if (path.contains('?')) "&" else "?") + "cursor=" + enc(it) } ?: "")) }) { result ->
            renderPage(path, target, cursor, result, render)
        }
    }
    private fun renderPage(path: String, target: LinearLayout, cursor: String?, result: JSONObject, render: (JSONObject, LinearLayout) -> Unit) {
            target.removeAllViews()
            val items = result.optJSONArray("items") ?: result.optJSONArray("entries") ?: result.optJSONArray("jobs") ?: JSONArray()
            if (items.length() == 0) ui.text(MoteI18n.text("当前范围内暂无条目。没有列出不代表不存在。"), parent = target)
            for (i in 0 until items.length()) render(items.getJSONObject(i), ui.card(target))
            if (cursor != null) ui.button(MoteI18n.text("返回第一页"), parent = target) { paged(path, target, render = render) }
            CentralScreens.next(result)?.let { next -> ui.button(MoteI18n.text("下一页"), parent = target) { paged(path, target, next, render) } }
            if (!result.isNull("nextOffset") && result.has("nextOffset")) ui.button(MoteI18n.text("下一页"), parent = target) {
                val nextPath = if (Regex("[?&]offset=\\d+").containsMatchIn(path)) path.replace(Regex("offset=\\d+"), "offset=" + result.getInt("nextOffset"))
                    else path + (if (path.contains('?')) "&" else "?") + "offset=" + result.getInt("nextOffset")
                paged(nextPath, target, render = render)
            }
    }
    private fun values(value: JSONObject, target: LinearLayout) = CentralAdmin(screens).values(value, target)
}
