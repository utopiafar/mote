package dev.mote.collector

import android.content.Intent
import android.net.Uri
import android.text.InputType
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID

/** Management uses native controls and explicit endpoint contracts, never a web fallback. */
internal class CentralAdmin(private val screens: CentralScreens) {
    private val ui get() = screens.ui
    private val body get() = screens.body
    private val client get() = screens.client
    private fun enc(value: String) = CentralScreens.encode(value)
    private val library = CentralLibrary(screens)

    fun show(page: String) {
        ui.button(MoteI18n.text("刷新")) { screens.refresh() }
        when (page) {
            "devices" -> devices()
            "connections" -> connections()
            "actions" -> actions()
            "settings" -> settings()
            "statistics" -> read("/api/storage-statistics")
            "processing" -> processing()
            "extensions" -> extensions()
            "usage" -> usage()
            "vault" -> vault()
            "developer" -> diagnostics()
            "agentView" -> agent()
            "lark" -> lark()
            "imports" -> imports()
            "about" -> { preferences(); ui.text(ui.server); softwareUpdate(); ui.button(MoteI18n.text("连接设置")) { ui.startActivity(Intent(ui, MainActivity::class.java).putExtra("page", "CONNECTION")) } }
            "help" -> {
                ui.text(MoteI18n.text("检查连接、权限与处理状态，或提交问题反馈。"))
                ui.button(MoteI18n.text("反馈问题")) { ui.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/utopiafar/mote/issues/new"))) }
                ui.button(MoteI18n.text("诊断与更新")) { ui.navigate("developer") }
                ui.button(MoteI18n.text("关于与更新")) { ui.startActivity(Intent(ui, AppUpdatesActivity::class.java)) }
            }
            else -> ui.text(MoteI18n.text("资料不存在或已删除。"))
        }
    }
    private fun preferences() {
        val choices = listOf("system" to MoteI18n.text("跟随系统"), "zh-CN" to "简体中文", "en" to "English")
        ui.button(MoteI18n.text("界面语言")) {
            MoteDialogBuilder(ui).setTitle(MoteI18n.text("界面语言")).setItems(choices.map { it.second }.toTypedArray()) { _, index ->
                ui.work(MoteI18n.text("正在保存…"), { MoteI18n.select(ui, choices[index].first) }) { ui.recreate() }
            }.setNegativeButton(MoteI18n.text("取消"), null).show()
        }
    }
    fun values(value: Any?, target: LinearLayout, depth: Int = 0) {
        if (value == null || value == JSONObject.NULL || depth > 6) return
        when (value) {
            is JSONObject -> value.keys().forEach { key ->
                val next = value.opt(key)
                if (next == null || next == JSONObject.NULL) return@forEach
                if (next is JSONObject || next is JSONArray) {
                    val group = ui.card(target); ui.text(label(key), 17f, group); values(next, group, depth + 1)
                } else ui.text(label(key) + " · " + next.toString(), parent = target)
            }
            is JSONArray -> for (i in 0 until minOf(value.length(), 100)) values(value.opt(i), target, depth + 1)
            else -> ui.text(value.toString(), parent = target)
        }
    }
    fun items(result: JSONObject, target: LinearLayout, select: (JSONObject) -> Unit) {
        val items = result.optJSONArray("items") ?: JSONArray()
        if (items.length() == 0) ui.text(MoteI18n.text("暂无记录"), parent = target)
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i); val card = ui.card(target)
            ui.text(item.optString("title", item.optString("kind", item.optString("id"))), 18f, card)
            ui.text(item.optString("state", item.optString("status")), parent = card)
            ui.button(MoteI18n.text("查看详情"), parent = card) { select(item) }
        }
    }
    private fun read(path: String, target: LinearLayout = ui.card()) {
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get(path) }) { values(it, target) }
    }
    private fun action(path: String, payload: JSONObject = JSONObject(), done: (JSONObject) -> Unit = { screens.refresh() }) {
        val api = client
        ui.work(MoteI18n.text("正在处理…"), { api.post(path, payload) }, done)
    }

    /** Primitive fields are native inputs; complex policy arrays retain the existing advanced JSON editor. */
    private fun form(value: JSONObject, target: LinearLayout, readOnly: Set<String> = setOf("revision")): () -> JSONObject {
        val reads = linkedMapOf<String, () -> Any>()
        for (key in value.keys()) {
            val raw = value.get(key); val caption = label(key)
            if (key in readOnly || key == "backupAudio") { reads[key] = { raw }; continue }
            if (key in setOf("headers", "extraBody") && raw == JSONObject.NULL) {
                val field = ui.field(caption + " · " + MoteI18n.text("高级 JSON"), multiline = true, parent = target)
                val clear = CheckBox(ui).apply { text = MoteI18n.text("清除已保存的值") }; target.addView(clear)
                reads[key] = { if (clear.isChecked) JSONObject.NULL else field.text.toString().takeIf { it.isNotBlank() }?.let(::JSONObject) ?: KeepValue }
                continue
            }
            when (raw) {
                is Boolean -> {
                    val field = CheckBox(ui).apply { text = caption; isChecked = raw }; target.addView(field); MoteUi.styleTree(field); reads[key] = { field.isChecked }
                }
                is JSONObject -> {
                    if (key in setOf("sourceProfiles", "typeProfiles", "headers", "extraBody", "parameters")) {
                        val field = ui.field(caption + " · " + MoteI18n.text("高级 JSON"), raw.toString(2), multiline = true, parent = target)
                        reads[key] = { JSONObject(field.text.toString()) }
                    } else {
                        ui.text(caption, 18f, target); val nested = form(raw, ui.card(target), emptySet()); reads[key] = nested
                    }
                }
                is JSONArray -> {
                    val field = ui.field(caption + " · " + MoteI18n.text("高级 JSON"), raw.toString(2), multiline = true, parent = target)
                    reads[key] = { JSONArray(field.text.toString()) }
                }
                else -> {
                    val choices = enums[key]
                    if (choices != null) {
                        ui.text(caption, 13f, target)
                        val spinner = Spinner(ui).apply { adapter = ArrayAdapter(ui, android.R.layout.simple_spinner_dropdown_item, if (key == "serviceTier") choices.map { if (it == "fast") "Fast" else "Standard" } else choices)
                            setSelection(choices.indexOf(raw.toString()).coerceAtLeast(0)) }; target.addView(spinner)
                        reads[key] = { choices[spinner.selectedItemPosition] }; continue
                    }
                    val nullableNumber = key in setOf("dailyTokens", "dailyCost", "operationTokens", "operationCost", "modelRequestTimeoutMs", "agentTimeoutMs", "speakerCount")
                    val field = ui.field(caption, if (raw == JSONObject.NULL) "" else raw.toString(),
                        multiline = key in setOf("description", "instruction", "prompt"), password = key in secrets, parent = target)
                    if (raw is Number || nullableNumber) field.inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or InputType.TYPE_NUMBER_FLAG_SIGNED
                    val clear = if (key in setOf("apiKey", "localModelApiKey", "localWorkerApiKey")) CheckBox(ui).apply { text = MoteI18n.text("清除已保存的密钥") }.also(target::addView) else null
                    reads[key] = {
                        val input = field.text.toString()
                        if (clear?.isChecked == true) JSONObject.NULL
                        else if (input.isBlank() && nullableNumber) JSONObject.NULL
                        else if (raw is Number || nullableNumber) input.toLongOrNull() ?: input.toDouble()
                        else input
                    }
                }
            }
        }
        return { JSONObject().apply { reads.forEach { (key, read) ->
            val next = read(); if (next !== KeepValue && (key !in secrets || next.toString().isNotBlank())) put(key, next)
        }; if (has("protocol") && optString("protocol") != "codex-app-server") remove("serviceTier") } }
    }
    private fun edit(title: String, path: String, value: JSONObject, method: String = "PUT", back: () -> Unit = { screens.refresh() }, completed: (JSONObject) -> Unit = { screens.refresh() }) {
        body.removeAllViews(); screens.setBack(back); ui.text(title, 23f)
        val collect = form(value, ui.card())
        ui.button(MoteI18n.text("保存设置"), true) {
            val payload = collect(); val api = client
            ui.work(MoteI18n.text("正在保存…"), {
                if (method == "POST") api.post(path, payload) else if (method == "PATCH") api.patch(path, payload) else api.put(path, payload)
            }, completed)
        }
    }
    private fun configuration(title: String, path: String, writePath: String = path, select: (JSONObject) -> JSONObject = { it }) {
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get(path) }) { edit(title, writePath, select(it)) }
    }
    private fun settings() {
        ui.button(MoteI18n.text("模型配置")) { models() }
        ui.button(MoteI18n.text("并发与执行设置")) { configuration(MoteI18n.text("并发与执行设置"), "/api/execution-settings") { pick(it, "interactiveConcurrency", "agentConcurrency", "llmConcurrency", "memoryConcurrency") } }
        ui.button(MoteI18n.text("模型预算")) { configuration(MoteI18n.text("模型预算"), "/api/model-budgets") { pick(it, "revision", "limits") } }
        ui.button(MoteI18n.text("处理设置")) { fileSettings() }
        ui.button(MoteI18n.text("记忆设置")) { memorySettings() }
        ui.button(MoteI18n.text("来源与外部应用")) { connectors() }
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/configuration") }) { configuration ->
            val groups = configuration.optJSONArray("groups") ?: JSONArray()
            for (i in 0 until groups.length()) {
                val group = groups.getJSONObject(i)
                ui.disclosure(group.optString("title")) { card ->
                    ui.text(group.optString("description"), parent = card)
                    val fields = group.optJSONArray("fields") ?: JSONArray()
                    for (j in 0 until fields.length()) {
                        val field = fields.getJSONObject(j)
                        ui.text(field.optString("label") + " · " + field.opt("value"), parent = card)
                        ui.text(field.optString("description"), 13f, card)
                    }
                }
            }
        }
    }
    private fun models() {
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/model-settings") }) { value ->
            body.removeAllViews(); screens.setBack { screens.refresh() }
            ui.text(MoteI18n.text("模型配置"), 24f)
            ui.button(MoteI18n.text("功能默认模型")) { modelDefaults(value) }
            val profiles = value.getJSONArray("profiles")
            val choice = Spinner(ui).apply {
                contentDescription = MoteI18n.text("Provider 预设")
                adapter = ArrayAdapter(ui, android.R.layout.simple_spinner_dropdown_item,
                    (0 until profiles.length()).map { profiles.getJSONObject(it).optString("name") })
            }
            body.addView(choice, LinearLayout.LayoutParams(-1, ui.moteDp(52)))
            val selected = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
            body.addView(selected)
            fun renderProfile(i: Int) {
                selected.removeAllViews()

                val profile = profiles.getJSONObject(i); val id = profile.getString("id"); val card = ui.card(selected)
                ui.text(profile.optString("name") + " · " + profile.getJSONObject("settings").optString("model"), 19f, card)
                if (!profile.optBoolean("readOnly")) {
                    ui.button(MoteI18n.text("编辑"), parent = card) {
                        val settings = cleanSettings(profile.getJSONObject("settings")).put("apiKey", "").put("headers", JSONObject.NULL).put("extraBody", JSONObject.NULL)
                        val request = JSONObject().put("revision", value.getLong("revision")).put("settings", settings)
                        request.put("name", profile.getString("name"))
                        edit(MoteI18n.text("模型配置"), "/api/model-settings/profiles/" + enc(id), request, back = { models() })
                    }
                    ui.button(MoteI18n.text("删除"), parent = card) { screens.confirm(MoteI18n.text("删除"), MoteI18n.text("删除后无法恢复。")) {
                        ui.work(MoteI18n.text("正在删除…"), { api.delete("/api/model-settings/profiles/" + enc(id), JSONObject().put("revision", value.getLong("revision"))) }) { models() }
                    } }
                }
                ui.button(MoteI18n.text("复制为新预设"), parent = card) {
                    edit(MoteI18n.text("复制为新预设"), "/api/model-settings/profiles/" + enc(id) + "/copy",
                        JSONObject().put("revision", value.getLong("revision")).put("id", "preset-" + UUID.randomUUID().toString().take(8)).put("name", profile.optString("name") + " copy").put("includeCredentials", true), "POST", back = { models() })
                }
                ui.button(MoteI18n.text("测试连接"), parent = card) {
                    action("/api/model-settings/profiles/" + enc(id) + "/test", JSONObject().put("revision", value.getLong("revision")).put("settings", cleanSettings(profile.getJSONObject("settings")))) { values(it, card) }
                }
                ui.button(MoteI18n.text("可用模型"), parent = card) { read("/api/model-settings/profiles/" + enc(id) + "/models", card) }
            }
            choice.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) { renderProfile(position) }
            }
        }
    }
    private fun cleanSettings(value: JSONObject) = pick(value, "provider", "protocol", "baseUrl", "model", "reasoningEffort", "serviceTier", "maxTokens", "modelRequestTimeoutMs", "agentTimeoutMs", "allowUnauthenticatedLocal").apply {
        if (getString("protocol") == "codex-app-server") require(getString("serviceTier") in setOf("default", "fast"))
    }
    private fun modelDefaults(value: JSONObject) {
        body.removeAllViews(); screens.setBack { models() }
        val profiles = value.getJSONArray("profiles"); val ids = (0 until profiles.length()).map { profiles.getJSONObject(it).getString("id") }
        val names = (0 until profiles.length()).map { profiles.getJSONObject(it).getString("name") }
        val defaults = value.getJSONObject("defaults"); val models = value.getJSONObject("defaultModels")
        val fields = linkedMapOf<String, Pair<Spinner, EditText>>()
        for (feature in defaults.keys()) {
            ui.text(label(feature), 19f)
            val choice = Spinner(ui).apply {
                adapter = ArrayAdapter(ui, android.R.layout.simple_spinner_dropdown_item, names)
                setSelection(ids.indexOf(defaults.getString(feature)).coerceAtLeast(0))
            }; body.addView(choice)
            fields[feature] = choice to ui.field(MoteI18n.text("模型 ID（可选覆盖）"), models.optString(feature))
        }
        ui.button(MoteI18n.text("保存设置"), true) {
            val selections = JSONObject(); val overrides = JSONObject()
            fields.forEach { (feature, inputs) ->
                selections.put(feature, ids[inputs.first.selectedItemPosition])
                inputs.second.text.toString().trim().takeIf(String::isNotBlank)?.let { overrides.put(feature, it) }
            }
            val api = client
            ui.work(MoteI18n.text("正在保存…"), {
                api.put("/api/model-settings/defaults", JSONObject().put("revision", value.getLong("revision")).put("defaults", selections).put("defaultModels", overrides))
            }) { models() }
        }
    }
    fun fileSettings() {
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/file-processing") }) { value ->
            val settings = JSONObject(value.getJSONObject("settings").toString())
            listOf("apiKeyConfigured", "localModelApiKeyConfigured", "localWorkerApiKeyConfigured").forEach(settings::remove)
            val payload = JSONObject().put("revision", value.getString("revision")).put("settings", settings)
            listOf("apiKey", "localModelApiKey", "localWorkerApiKey").forEach { settings.put(it, "") }
            if (value.optBoolean("policyConfigured")) payload.put("policy", value.getJSONObject("policy"))
            edit(MoteI18n.text("处理设置"), "/api/file-processing", payload)
        }
    }
    fun memorySettings() {
        body.removeAllViews(); screens.setBack { screens.refresh() }
        ui.button(MoteI18n.text("记忆自动处理")) { configuration(MoteI18n.text("记忆自动处理"), "/api/memory-settings") { it.getJSONObject("settings") } }
        ui.button(MoteI18n.text("记忆提取配方")) {
            recipeSettings(false)
        }
        ui.button(MoteI18n.text("记忆整合")) { recipeSettings(true) }
        read("/api/memory-settings")
    }
    private fun recipeSettings(integration: Boolean) {
        val api = client; val path = if (integration) "/api/memory-integration-settings" else "/api/memory-recipe-settings"
        ui.work(MoteI18n.text("正在读取…"), {
            api.get(path) to api.get(if (integration) "/api/memory-integration-recipes" else "/api/memory-recipes")
        }) { (selection, catalog) ->
            body.removeAllViews(); screens.setBack { memorySettings() }
            val current = if (integration) listOfNotNull(selection.optJSONObject("binding")?.optJSONObject("recipe"))
                else selection.getJSONArray("items").let { items -> (0 until items.length()).map { items.getJSONObject(it).getJSONObject("binding").getJSONObject("recipe") } }
            val choices = catalog.getJSONArray("items"); val selected = mutableListOf<JSONObject>()
            val fields = mutableListOf<Pair<CheckBox, JSONObject>>()
            for (i in 0 until choices.length()) {
                val recipe = choices.getJSONObject(i); val ref = pick(recipe, "id", "version")
                val check = CheckBox(ui).apply {
                    text = recipe.optString("name", recipe.optString("id")) + " · " + recipe.optString("version")
                    isChecked = current.any { it.optString("id") == ref.optString("id") && it.optString("version") == ref.optString("version") }
                }; fields.add(check to ref); body.addView(check)
                if (integration) check.setOnCheckedChangeListener { _, checked -> if (checked) fields.filter { it.first !== check }.forEach { it.first.isChecked = false } }
            }
            ui.button(MoteI18n.text("保存设置"), true) {
                selected.clear(); fields.filter { it.first.isChecked }.forEach { selected.add(it.second) }
                val payload = if (integration) JSONObject().put("recipe", selected.firstOrNull() ?: JSONObject.NULL)
                    else JSONObject().put("recipes", JSONArray(selected))
                ui.work(MoteI18n.text("正在保存…"), { api.put(path, payload) }) { memorySettings() }
            }
        }
    }
    fun memoryJobs() {
        body.removeAllViews(); screens.setBack { screens.refresh() }
        ui.button(MoteI18n.text("开始提取"), true) { action("/api/memory-jobs") { run("/api/memory-jobs", it.getString("id")) } }
        library.paged("/api/memory-jobs", ui.card()) { row, card ->
            ui.text(row.optString("state", row.optString("status")), parent = card)
            ui.button(MoteI18n.text("查看详情"), parent = card) { run("/api/memory-jobs", row.getString("id")) }
        }
    }
    fun run(path: String, id: String) {
        body.removeAllViews(); screens.setBack { screens.refresh() }
        read(path + "/" + enc(id))
        ui.button(MoteI18n.text("刷新")) { run(path, id) }
        val controls = if (path == "/api/memory-jobs") listOf("pause" to "暂停", "resume" to "继续", "cancel" to "取消", "retry" to "重试") else listOf("cancel" to "停止")
        controls.forEach { (command, label) -> ui.button(MoteI18n.text(label)) { action(path + "/" + enc(id) + "/" + command) { run(path, id) } } }
    }
    private fun devices() {
        library.paged("/api/devices", ui.card()) { row, card -> values(row, card) }
        ui.button(MoteI18n.text("生成设备连接邀请")) { invitation() }
    }
    private fun invitation() {
        edit(MoteI18n.text("生成设备连接邀请"), "/api/connections/invitations",
            JSONObject().put("serverUrl", ui.server).put("label", "Android"), "POST", completed = ::credentialResult)
    }
    private fun credentialResult(value: JSONObject) {
        body.removeAllViews(); screens.setBack { screens.refresh() }
        ui.text(MoteI18n.text("授权已创建"), 24f); values(value, ui.card())
        val uri = value.optString("uri")
        if (uri.isNotBlank()) {
            val matrix = com.google.zxing.MultiFormatWriter().encode(uri, com.google.zxing.BarcodeFormat.QR_CODE, 512, 512)
            val bitmap = android.graphics.Bitmap.createBitmap(512, 512, android.graphics.Bitmap.Config.ARGB_8888)
            for (y in 0 until 512) for (x in 0 until 512) bitmap.setPixel(x, y, if (matrix[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
            body.addView(ImageView(ui).apply { setImageBitmap(bitmap); contentDescription = MoteI18n.text("设备连接邀请二维码") })
            value.optJSONObject("invitation")?.let { invitation -> ui.button(MoteI18n.text("取消邀请")) {
                action("/api/connections/invitations/revoke", JSONObject().put("code", invitation.getString("code")))
            } }
        }
    }
    private fun processingSettings() = configuration(MoteI18n.text("处理设置"), "/api/processing", "/api/processing/settings") { it.getJSONObject("settings") }
    private fun connections() {
        ui.button(MoteI18n.text("生成设备连接邀请")) { invitation() }
        ui.button(MoteI18n.text("创建 MCP 授权")) {
            edit(MoteI18n.text("创建 MCP 授权"), "/api/connections/mcp", JSONObject().put("serverUrl", ui.server).put("label", "MCP").put("access", "read"), "POST", completed = ::credentialResult)
        }
        library.paged("/api/connections", ui.card()) { row, card ->
            values(row, card)
            if (row.isNull("revokedAt") || !row.has("revokedAt")) ui.button(MoteI18n.text("撤销授权"), parent = card) {
                screens.confirm(MoteI18n.text("撤销授权"), row.optString("label")) {
                    val api = client; ui.work(MoteI18n.text("正在撤销…"), { api.delete("/api/connections/" + enc(row.getString("id"))) }) { screens.refresh() }
                }
            }
        }
    }
    private fun actions() {
        ui.button(MoteI18n.text("日程建议")) { ui.startActivity(Intent(ui, CalendarActionsActivity::class.java)) }
        ui.button(MoteI18n.text("行动设置")) {
            configuration(MoteI18n.text("行动设置"), "/api/actions", "/api/actions/settings") { it.getJSONObject("settings") }
        }
        val todo = ui.field(MoteI18n.text("待办标题"))
        ui.button(MoteI18n.text("添加待办")) {
            action("/api/todos", JSONObject().put("id", UUID.randomUUID().toString()).put("title", todo.text.toString()).put("description", "").put("dueAt", JSONObject.NULL).put("evidenceIds", JSONArray()))
        }
        library.paged("/api/todos?limit=30", ui.card()) { row, card ->
            ui.text(row.getString("title"), 20f, card); ui.text(row.optString("description"), parent = card); ui.text(row.optString("status"), parent = card)
            if (row.optString("status") == "open") ui.button(MoteI18n.text("标记完成"), parent = card) {
                val api = client
                ui.work(MoteI18n.text("正在保存…"), { api.patch("/api/todos/" + enc(row.getString("id")), JSONObject().put("version", row.getInt("version")).put("status", "completed")) }) { screens.refresh() }
            }
            val refs = row.optJSONArray("evidenceIds") ?: JSONArray()
            for (i in 0 until refs.length()) ui.button(MoteI18n.text("查看原文依据"), parent = card) { library.captureEvidence(refs.getString(i)) }
        }
    }
    private val operationStates = listOf("" to "全部", "waiting" to "等待处理", "running" to "运行中", "blocked" to "受阻", "failed" to "失败", "succeeded" to "完成", "cancelled" to "已取消", "stale" to "来源变化待重验", "skipped" to "未安排")
    private fun stateLabel(state: String) = MoteI18n.text(operationStates.firstOrNull { it.first == state }?.second ?: state)
    private fun operationTitle(kind: String) = MoteI18n.text(mapOf("file" to "文件处理", "capture" to "截图处理", "memory" to "记忆整理", "workflow" to "上下文处理", "import" to "资料导入", "query" to "问答", "insight" to "洞察", "embedding" to "检索向量计算", "material-index" to "资料检索索引")[kind] ?: "上下文处理")
    private fun processing(cursors: List<Long?> = listOf(null), state: String = "") {
        body.removeAllViews()
        ui.button(MoteI18n.text("刷新")) { processing(cursors, state) }
        val choice = Spinner(ui).apply {
            contentDescription = MoteI18n.text("任务状态")
            adapter = ArrayAdapter(ui, android.R.layout.simple_spinner_dropdown_item, operationStates.map { MoteI18n.text(it.second) })
            setSelection(operationStates.indexOfFirst { it.first == state }.coerceAtLeast(0))
        }
        body.addView(choice, LinearLayout.LayoutParams(-1, ui.moteDp(52)))
        choice.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) {
                val selected = operationStates[position].first
                if (selected != state) processing(state = selected)
            }
        }
        val target = ui.card(); val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/operations?limit=10" + (if (state.isEmpty()) "" else "&state=" + enc(state)) + (cursors.last()?.let { "&cursor=$it" } ?: "")) }) { result ->
            val items = result.optJSONArray("items") ?: JSONArray()
            if (items.length() == 0) ui.text(MoteI18n.text("没有符合条件的任务"), parent = target)
            for (i in 0 until items.length()) {
                val row = items.getJSONObject(i)
                ui.selectRow(operationTitle(row.optString("kind")) + " · " + stateLabel(row.optString("state")), row.getString("id"), target) {
                    operation(row.getString("id"), returnTo = { processing(cursors, state) })
                }.apply { tag = "operation:" + row.getString("id"); contentDescription = MoteI18n.text("查看任务 {0} 的详情", row.getString("id")) }
            }
            pageButtons(cursors, result, items.length(), target) { processing(it, state) }
        }
        ui.button(MoteI18n.text("处理设置")) { processingSettings() }
    }
    private fun pageButtons(cursors: List<Long?>, result: JSONObject, count: Int, target: LinearLayout, load: (List<Long?>) -> Unit) {
        ui.text(MoteI18n.text("第 {0} 页 · {1} 条", cursors.size, count), 13f, target)
        val paging = LinearLayout(ui).apply { orientation = LinearLayout.HORIZONTAL }
        target.addView(paging)
        ui.button(MoteI18n.text("上一页"), parent = paging) { load(cursors.dropLast(1)) }.apply {
            isEnabled = cursors.size > 1; layoutParams = LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = ui.moteDp(4) }
        }
        val next = result.optLong("nextCursor").takeIf { it > 0 }
        ui.button(MoteI18n.text("下一页"), parent = paging) { next?.let { load(cursors + it) } }.apply {
            isEnabled = next != null; layoutParams = LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = ui.moteDp(4) }
        }
    }
    fun operation(id: String, cursors: List<Long?> = listOf(null), returnTo: () -> Unit = { screens.refresh() }) {
        body.removeAllViews(); screens.setBack(returnTo)
        ui.text(MoteI18n.text("任务详情"), 23f)
        ui.button(MoteI18n.text("刷新")) { operation(id, cursors, returnTo) }
        val target = ui.card(); val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/operations/" + enc(id) + "?limit=10" + (cursors.last()?.let { "&cursor=$it" } ?: "")) }) { result ->
            val operation = result.getJSONObject("operation")
            ui.text(operationTitle(operation.optString("kind")) + " · " + stateLabel(operation.optString("state")), 18f, target)
            ui.text(id, 13f, target)
            val steps = result.optJSONArray("steps") ?: JSONArray()
            for (i in 0 until steps.length()) {
                val step = steps.getJSONObject(i)
                ui.disclosure(step.optString("kind") + " · " + stateLabel(step.optString("state")), target) { values(step, it) }
            }
            pageButtons(cursors, result, steps.length(), target) { operation(id, it, returnTo) }
        }
    }
    private fun extensions() {
        read("/api/features")
        ui.button(MoteI18n.text("处理设置")) { processingSettings() }
        ui.button(MoteI18n.text("文字识别设置")) { configuration(MoteI18n.text("文字识别设置"), "/api/perception") { it.getJSONObject("settings") } }
        library.paged("/api/processing?limit=20", ui.card()) { row, card ->
            values(row, card)
            ui.button(MoteI18n.text("重试"), parent = card) { action("/api/processing/" + enc(row.getString("id")) + "/retry") }
            ui.button(MoteI18n.text("取消"), parent = card) { action("/api/processing/" + enc(row.getString("id")) + "/cancel") }
        }
    }
    private fun usage() {
        val from = ui.field(MoteI18n.text("开始日期"), LocalDate.now().minusDays(7).toString())
        val to = ui.field(MoteI18n.text("结束日期"), LocalDate.now().toString())
        val target = ui.card()
        fun load() {
            val start = LocalDate.parse(from.text.toString()); val end = LocalDate.parse(to.text.toString())
            target.removeAllViews()
            read("/api/usage?from=$start&to=$end&timeZone=" + enc(ZoneId.systemDefault().id), target)
        }
        ui.button(MoteI18n.text("查询")) { load() }; load()
    }
    private fun vault() {
        read("/api/status")
        ui.button(MoteI18n.text("重新建立索引")) { action("/api/index/retry") }
        ui.button(MoteI18n.text("中央元数据导出")) { ui.saveCentral("/api/export-bundle?mode=metadata", "mote-central-metadata.tar.gz", "application/gzip") }
        ui.button(MoteI18n.text("中央资料与附件导出")) { ui.saveCentral("/api/export-bundle?mode=data", "mote-central-data.tar.gz", "application/gzip") }
        ui.button(MoteI18n.text("导入")) { ui.navigate("imports") }
    }
    private fun diagnostics() {
        ui.button(MoteI18n.text("诊断设置")) { configuration(MoteI18n.text("诊断设置"), "/api/diagnostics-settings") }
        read("/api/diagnostics")
        ui.button(MoteI18n.text("查看日志")) { read("/api/diagnostics/log-pages?page=1&pageSize=100") }
        ui.button(MoteI18n.text("导出支持包")) { ui.saveCentral("/api/support-bundle", "mote-central-support.json", "application/json") }
        softwareUpdate()
    }
    private fun softwareUpdate() {
        val target = ui.card(); read("/api/software-update", target)
        ui.button(MoteI18n.text("检查更新")) { action("/api/software-update/check") { target.removeAllViews(); values(it, target) } }
    }
    private fun agent(path: String = "/context") {
        body.removeAllViews(); screens.setBack { screens.refresh() }
        listOf("/context", "/context/memory", "/context/episodes", "/context/sources").forEach { folder ->
            ui.button(folder) { agent(folder) }
        }
        library.paged("/api/agent-view/catalog?path=" + enc(path) + "&limit=12", ui.card()) { row, card ->
            ui.text(row.optString("title", row.optString("path", row.optString("id"))), 19f, card); ui.text(row.optString("preview"), parent = card)
            ui.button(MoteI18n.text("展开"), parent = card) {
                if (row.has("path")) agent(row.getString("path"))
                else if (row.optString("expand") == "source_items") {
                    library.paged("/api/agent-view/source-items?sourceId=" + enc(row.getString("id")) + "&limit=12", card) { item, child ->
                        ui.text(item.optString("title"), parent = child); ui.button(MoteI18n.text("查看原文"), parent = child) { library.evidence(item.getString("ref")) }
                    }
                } else agentDetail(row, path)
            }
        }
        ui.button(MoteI18n.text("实际读取记录")) { read("/api/agent-view/events?afterSeq=0") }
        val question = ui.field(MoteI18n.text("你的问题"), multiline = true)
        ui.button(MoteI18n.text("首次上下文")) { action("/api/agent-view/startup", JSONObject().put("question", question.text.toString()).put("timeZone", ZoneId.systemDefault().id)) { values(it, ui.card()) } }
    }
    private fun agentDetail(row: JSONObject, path: String, offset: Int = 0) {
        val kind = row.optString("expand")
        val endpoint = when (kind) { "memories" -> "memories"; "segments" -> "segments"; else -> "evidence" }
        val id = if (kind == "segments") row.getString("ref") else row.optString("id", row.optString("ref"))
        val extra = if (kind == "memories") "&includeEvidence=true" else if (endpoint == "evidence") "&offset=$offset" else ""
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/agent-view/$endpoint?id=" + enc(id) + extra) }) { result ->
            body.removeAllViews(); screens.setBack { agent(path) }; values(result, ui.card())
            val items = result.optJSONArray("items") ?: JSONArray()
            for (i in 0 until items.length()) {
                val item = items.getJSONObject(i)
                val evidence = item.optJSONArray("evidence") ?: JSONArray()
                for (j in 0 until evidence.length()) ui.button(MoteI18n.text("查看原文依据")) { library.captureEvidence(evidence.getJSONObject(j).getString("id")) }
                val members = item.optJSONArray("members") ?: JSONArray()
                for (j in 0 until members.length()) ui.button(MoteI18n.text("查看原文依据") + " " + (j + 1)) { library.captureEvidence(members.getString(j)) }
                item.optJSONObject("textRange")?.let { range ->
                    if (!range.isNull("nextOffset")) ui.button(MoteI18n.text("下一页")) { agentDetail(row, path, range.getInt("nextOffset")) }
                }
            }
        }
    }
    fun connectors() {
        body.removeAllViews(); screens.setBack { screens.refresh() }
        listOf("google" to "Google 日历", "gmail" to "Gmail").forEach { (provider, title) ->
            ui.text(MoteI18n.text(title), 20f)
            ui.button(MoteI18n.text("连接")) { action("/api/connectors/$provider/start") { value ->
                val url = Uri.parse(value.getString("authorizationUrl"))
                require(url.scheme == "https" && url.host == "accounts.google.com")
                ui.startActivity(Intent(Intent.ACTION_VIEW, url))
            } }
            ui.button(MoteI18n.text("立即同步")) { action("/api/connectors/$provider/sync") }
            ui.button(MoteI18n.text("断开连接")) { val api = client; ui.work(MoteI18n.text("正在处理…"), { api.delete("/api/connectors/$provider") }) { screens.refresh() } }
        }
        ui.button(MoteI18n.text("选择 Google 日历")) { calendarSelection(false) }
        ui.button(MoteI18n.text("录音归档")) { recordings() }
        read("/api/connectors/status")
        ui.button(MoteI18n.text("飞书")) { ui.navigate("lark") }
        val endpoint = ui.field(MoteI18n.text("MCP 地址"))
        val token = ui.field(MoteI18n.text("访问令牌（可选）"), password = true)
        ui.button(MoteI18n.text("发现 MCP 资源")) {
            val payload = JSONObject().put("url", endpoint.text.toString())
            token.text.toString().takeIf { it.isNotBlank() }?.let { payload.put("token", it) }
            action("/api/connectors/mcp/discover", payload) { value ->
                val resources = value.optJSONArray("resources") ?: JSONArray(); val selected = mutableListOf<String>()
                for (i in 0 until resources.length()) {
                    val resource = resources.getJSONObject(i); val choice = CheckBox(ui).apply { text = resource.optString("name"); setOnCheckedChangeListener { _, checked -> if (checked) selected.add(resource.getString("uri")) else selected.remove(resource.getString("uri")) } }; body.addView(choice)
                }
                val name = ui.field(MoteI18n.text("来源名称"), "MCP")
                ui.button(MoteI18n.text("导入所选资源")) {
                    require(selected.isNotEmpty()) { MoteI18n.text("请选择资源") }
                    importMcp(payload, name.text.toString(), JSONObject().put("resourceUris", JSONArray(selected)))
                }
                val tools = value.optJSONArray("tools") ?: JSONArray()
                for (i in 0 until tools.length()) {
                    val tool = tools.getJSONObject(i); val card = ui.card()
                    ui.text(tool.getString("name"), 19f, card); ui.text(tool.optString("description"), parent = card)
                    val args = ui.field(MoteI18n.text("工具参数 JSON"), "{}", multiline = true, parent = card)
                    val approved = CheckBox(ui).apply { text = MoteI18n.text("我确认此工具只读") }; card.addView(approved)
                    ui.button(MoteI18n.text("导入工具结果"), parent = card) {
                        require(approved.isChecked) { MoteI18n.text("请确认工具只读后再执行") }
                        importMcp(payload, name.text.toString(), JSONObject().put("tool", JSONObject().put("name", tool.getString("name"))
                            .put("arguments", JSONObject(args.text.toString())).put("confirmedReadOnly", true)))
                    }
                }
            }
        }
    }
    private fun lark() {
        val target = ui.card(); read("/api/connectors/lark", target)
        listOf("check" to "检查状态", "install" to "安装 CLI", "setup" to "开始配置", "login" to "登录", "sync" to "立即同步", "cancel" to "取消").forEach { (command, label) ->
            ui.button(MoteI18n.text(label)) { action("/api/connectors/lark/$command") { target.removeAllViews(); values(it, target) } }
        }
        ui.button(MoteI18n.text("选择日历")) {
            calendarSelection(true)
        }
        ui.button(MoteI18n.text("配置应用凭据")) {
            edit(MoteI18n.text("配置应用凭据"), "/api/connectors/lark/configure", JSONObject().put("appId", "").put("secret", "").put("brand", "feishu"), "POST")
        }
        ui.button(MoteI18n.text("查看授权进度")) {
            val api = client
            ui.work(MoteI18n.text("正在读取…"), { api.get("/api/connectors/lark") }) { value ->
                target.removeAllViews(); values(value, target)
                value.optJSONObject("job")?.optString("authorizationUrl")?.takeIf { it.isNotBlank() }?.let { url ->
                    val parsed = Uri.parse(url); val host = parsed.host.orEmpty()
                    if (parsed.scheme == "https" && parsed.userInfo == null && parsed.port == -1 &&
                        listOf("feishu.cn", "larksuite.com", "larkoffice.com").any { host == it || host.endsWith(".$it") })
                        ui.button(MoteI18n.text("打开授权页面"), parent = target) { ui.startActivity(Intent(Intent.ACTION_VIEW, parsed)) }
                }
            }
        }
        ui.button(MoteI18n.text("断开连接")) { val api = client; ui.work(MoteI18n.text("正在处理…"), { api.delete("/api/connectors/lark") }) { screens.refresh() } }
    }
    private fun importMcp(target: JSONObject, name: String, request: JSONObject) {
        val api = client; val sourceId = "mcp-" + UUID.randomUUID().toString()
        ui.work(MoteI18n.text("正在导入…"), {
            api.post("/api/sources", JSONObject().put("id", sourceId).put("name", name).put("kind", "mcp")
                .put("deviceId", "mcp").put("platform", "import").put("retention", "snapshot").put("enabled", true))
            val payload = JSONObject(target.toString()).put("sourceId", sourceId)
            request.keys().forEach { payload.put(it, request.get(it)) }
            api.post("/api/connectors/mcp/import", payload)
        }) { values(it, ui.card()) }
    }
    private fun calendarSelection(lark: Boolean) {
        val api = client; val path = if (lark) "/api/connectors/lark" else "/api/connectors/google"
        ui.work(MoteI18n.text("正在读取…"), {
            api.get(path + "/calendars") to if (lark) api.get(path).getJSONObject("selection") else JSONObject()
        }) { (result, current) ->
            body.removeAllViews(); screens.setBack { screens.refresh() }
            val calendars = result.getJSONArray("calendars"); val selected = current.optJSONArray("calendarIds") ?: JSONArray()
            val ids = (0 until selected.length()).map { selected.getString(it) }.toSet()
            val fields = mutableListOf<Pair<CheckBox, String>>()
            for (i in 0 until calendars.length()) {
                val item = calendars.getJSONObject(i); val id = item.getString("id")
                val check = CheckBox(ui).apply { text = item.optString("summary", item.optString("title", id)); isChecked = if (lark) id in ids else item.optBoolean("selected") }
                fields.add(check to id); body.addView(check)
            }
            val collect = if (lark) form(pick(current, "documents", "pastDays", "futureDays", "timeZone", "autoSync"), ui.card()) else ({ JSONObject() })
            ui.button(MoteI18n.text("保存设置")) {
                val payload = collect().put("calendarIds", JSONArray(fields.filter { it.first.isChecked }.map { it.second }))
                ui.work(MoteI18n.text("正在保存…"), { api.put(path + if (lark) "/selection" else "/calendars", payload) }) { screens.refresh() }
            }
        }
    }
    private fun recordings() {
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/connectors/status") }) { registry ->
            body.removeAllViews(); screens.setBack { screens.refresh() }
            for (key in registry.keys()) {
                val value = registry.optJSONObject(key) ?: continue
                if (value.optString("category") != "recordings") continue
                val provider = value.getString("provider"); require(Regex("^[a-z][a-z0-9-]{0,79}$").matches(provider))
                val path = "/api/connectors/$provider-recordings"; val card = ui.card()
                ui.text(value.optString("label", provider), 20f, card); values(value, card)
                ui.button(MoteI18n.text("连接已授权账号"), parent = card) { action(path + "/connect") { recordings() } }
                ui.button(MoteI18n.text("同步范围"), parent = card) {
                    val selection = JSONObject(value.getJSONObject("selection").toString()).put("backupAudio", true)
                    edit(MoteI18n.text("同步范围"), path + "/selection", selection)
                }
                ui.button(MoteI18n.text("立即同步"), parent = card) { action(path + "/sync") { recordings() } }
                ui.button(MoteI18n.text("重试失败步骤"), parent = card) { action(path + "/retry") { recordings() } }
                ui.button(MoteI18n.text("断开连接"), parent = card) { ui.work(MoteI18n.text("正在处理…"), { api.delete(path) }) { recordings() } }
                ui.button(MoteI18n.text("最近归档的录音"), parent = card) {
                    library.paged(path + "/items", card) { item, child ->
                        ui.button(item.optString("title"), parent = child) { library.captureEvidence(item.getString("captureId")) }
                        item.optJSONObject("audio")?.let { audio -> ui.button(MoteI18n.text("播放录音"), parent = child) {
                            screens.playAudio("/api/archived-files/" + enc(audio.getString("id")) + "/content", child)
                        } }
                    }
                }
            }
        }
    }
    private fun imports() {
        val instruction = ui.field(MoteI18n.text("导入要求（可选）"), screens.importInstruction, multiline = true)
        ui.button(MoteI18n.text("选择文件导入")) { screens.importInstruction = instruction.text.toString(); ui.pickImport() }
        screens.importPending(ui.card())
        library.paged("/api/imports", ui.card()) { row, card ->
            ui.text(row.optString("name") + " · " + row.optString("status"), 19f, card)
            ui.button(MoteI18n.text("查看预览"), parent = card) { importDetail(row.getString("id")) }
        }
        read("/api/import-capabilities")
    }
    fun importDetail(id: String) {
        body.removeAllViews(); screens.setBack { screens.refresh() }
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/imports/" + enc(id)) }) { row ->
            values(row, ui.card())
            val commands = when (row.optString("status")) {
                "awaiting_confirmation" -> listOf("confirm" to "确认导入", "prepare" to "重新解析", "cancel" to "取消")
                "failed", "cancelled" -> listOf("retry" to "重试")
                "completed" -> emptyList()
                else -> listOf("cancel" to "取消")
            }
            commands.forEach { (command, label) -> ui.button(MoteI18n.text(label)) {
                if (command == "confirm") screens.confirm(MoteI18n.text("确认导入"), MoteI18n.text("请核对预览后再确认。")) { action("/api/imports/" + enc(id) + "/confirm") { importDetail(id) } }
                else action("/api/imports/" + enc(id) + "/" + command) { importDetail(id) }
            } }
            ui.button(MoteI18n.text("刷新")) { importDetail(id) }
        }
    }
    private fun label(key: String): String = MoteI18n.text(labels[key] ?: key)
    companion object {
        private object KeepValue
        private val secrets = setOf("apiKey", "token", "secret", "clientSecret", "localModelApiKey", "localWorkerApiKey")
        private val enums = mapOf("protocol" to listOf("deepseek", "openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "codex-app-server"),
            "reasoningEffort" to listOf("auto", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"),
            "serviceTier" to listOf("default", "fast"),
            "level" to listOf("debug", "info", "warn", "error", "silent"), "currency" to listOf("USD", "CNY"), "access" to listOf("read", "write"), "brand" to listOf("feishu", "lark"))
        fun pick(value: JSONObject, vararg keys: String) = JSONObject().apply { keys.forEach { key -> if (value.has(key)) put(key, value.get(key)) } }
        private val labels = mapOf(
            "title" to "标题", "name" to "名称", "description" to "描述", "enabled" to "启用", "status" to "状态", "state" to "状态",
            "provider" to "服务商", "protocol" to "协议", "baseUrl" to "服务地址", "model" to "模型", "reasoningEffort" to "推理强度",
            "serviceTier" to "速度模式",
            "maxTokens" to "最大生成 token", "apiKey" to "API Key（留空保留）", "modelRequestTimeoutMs" to "模型请求超时（毫秒）",
            "agentTimeoutMs" to "Agent 超时（毫秒）", "interactiveConcurrency" to "交互并发", "agentConcurrency" to "Agent 并发",
            "llmConcurrency" to "模型并发", "memoryConcurrency" to "记忆并发", "enabled" to "启用", "debug" to "调试日志",
            "traceEnabled" to "记录 Agent 读取", "level" to "日志级别", "dailyTokens" to "每日 token 上限", "dailyCost" to "每日费用上限",
            "operationTokens" to "每次任务 token 上限", "operationCost" to "每次任务费用上限", "currency" to "币种",
            "deviceId" to "设备 ID", "deviceName" to "设备名称", "platform" to "平台", "serverUrl" to "节点地址", "label" to "名称"
        )
    }
}
