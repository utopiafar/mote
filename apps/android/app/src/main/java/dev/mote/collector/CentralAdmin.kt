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

/** Publication outcomes describe the current result; persisted status still owns scheduling. */
internal object CentralMemoryJobPresentation {
    private val controls = listOf("pause" to "暂停", "resume" to "继续", "cancel" to "取消", "retry" to "重试")
    fun invalidated(job: JSONObject) = job.optString("outcome") == "input_invalidated"
    fun status(job: JSONObject) = if (invalidated(job)) MoteI18n.text("资料已更新，本次结果失效") else job.optString("state", job.optString("status"))
    fun notice(job: JSONObject): String? = if (invalidated(job)) MoteI18n.text("历史结果保留；请查看当前资料版本。失效输入不能直接重试。") else null
    fun controls(job: JSONObject) = if (invalidated(job)) emptyList() else controls
}

/** Management uses native controls and explicit endpoint contracts, never a web fallback. */
internal class CentralAdmin(private val screens: CentralScreens) {
    private val ui get() = screens.ui
    private val body get() = screens.body
    private val client get() = screens.client
    private fun enc(value: String) = CentralScreens.encode(value)
    private val library = CentralLibrary(screens)
    private val plugins = CentralPlugins(screens) { extensions() }
    fun close() = plugins.close()
    fun clearPrivateState() = plugins.clearPrivateState()
    fun resume() = plugins.resume()

    fun show(page: String) {
        ui.button(MoteI18n.text("刷新")) { screens.refresh() }
        when (page) {
            "devices" -> devices()
            "connections" -> connections()
            "actions" -> actions()
            "settings" -> settings()
            "statistics" -> read("/api/storage-statistics")
            "processing" -> processing()
            "plugins", "extensions" -> plugins.show()
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
        val choices = listOf("system" to MoteI18n.text("跟随系统"), "zh-CN" to "简体中文", "en" to "English", "ja" to "日本語", "fr" to "Français", "de" to "Deutsch", "es" to "Español", "ru" to "Русский")
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
                    val group = ui.card(target); ui.text(label(key), NativeFontRole.SECTION, group); values(next, group, depth + 1)
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
            ui.text(item.optString("title", item.optString("kind", item.optString("id"))), NativeFontRole.SECTION, card)
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
                        ui.text(caption, NativeFontRole.SECTION, target); val nested = form(raw, ui.card(target), if (key == "extraction") setOf("enabled") else emptySet()); reads[key] = nested
                    }
                }
                is JSONArray -> {
                    val field = ui.field(caption + " · " + MoteI18n.text("高级 JSON"), raw.toString(2), multiline = true, parent = target)
                    reads[key] = { JSONArray(field.text.toString()) }
                }
                else -> {
                    val choices = enums[key]
                    if (choices != null) {
                        ui.text(caption, NativeFontRole.SUPPORT, target)
                        val spinner = Spinner(ui).apply { adapter = ArrayAdapter(ui, android.R.layout.simple_spinner_dropdown_item, if (key == "serviceTier") choices.map { if (it == "fast") "Fast" else "Standard" } else choices)
                            setSelection(choices.indexOf(raw.toString()).coerceAtLeast(0)) }; target.addView(spinner)
                        reads[key] = { choices[spinner.selectedItemPosition] }; continue
                    }
                    val nullableNumber = key in setOf("modelRequestTimeoutMs", "agentTimeoutMs", "speakerCount", "speakerMin", "speakerMax")
                    val field = ui.field(caption, if (raw == JSONObject.NULL) "" else raw.toString(),
                        multiline = key in setOf("description", "instruction", "prompt"), password = key in secrets, parent = target)
                    if (raw is Number || nullableNumber) field.inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or InputType.TYPE_NUMBER_FLAG_SIGNED
                    val clear = if (key in setOf("apiKey", "localWorkerApiKey")) CheckBox(ui).apply { text = MoteI18n.text("清除已保存的密钥") }.also(target::addView) else null
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
        body.removeAllViews(); screens.setBack(back); ui.text(title, NativeFontRole.TITLE_MOBILE)
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
                        ui.text(field.optString("description"), NativeFontRole.SUPPORT, card)
                    }
                }
            }
        }
    }
    private fun models() {
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/model-settings") }) { value ->
            body.removeAllViews(); screens.setBack { screens.refresh() }
            ui.text(MoteI18n.text("模型配置"), NativeFontRole.TITLE_MOBILE)
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
                ui.text(profile.optString("name") + " · " + profile.getJSONObject("settings").optString("model"), NativeFontRole.ROW, card)
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
            ui.text(label(feature), NativeFontRole.ROW)
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
            listOf("apiKeyConfigured", "localWorkerApiKeyConfigured").forEach(settings::remove)
            val payload = JSONObject().put("revision", value.getString("revision")).put("settings", settings)
            listOf("apiKey", "localWorkerApiKey").forEach { settings.put(it, "") }
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
    private fun recipeSettings(integration: Boolean, scope: String? = null) {
        val api = client; val path = if (integration) "/api/memory-integration-settings" else "/api/memory-recipe-settings"
        ui.work(MoteI18n.text("正在读取…"), {
            api.get(path + (scope?.let { "?scope=" + enc(it) } ?: "")) to api.get(if (integration) "/api/memory-integration-recipes" else "/api/memory-recipes")
        }) { (selection, catalog) ->
            body.removeAllViews(); screens.setBack { memorySettings() }; if (!integration) ui.text(MoteI18n.text("这些提取门槛与最大等待时间只控制历史资料的窗口处理。已授权且内容就绪的新资料直接进入自动记忆队列，按可用名额持续处理。"))
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
                if (!integration) check.setOnCheckedChangeListener { _, checked -> if (!checked && fields.none { it.first.isChecked }) check.isChecked = true }
                if (integration) check.setOnCheckedChangeListener { _, checked -> if (checked) fields.filter { it.first !== check }.forEach { it.first.isChecked = false } }
            }
            ui.button(MoteI18n.text("保存设置"), true) {
                selected.clear(); fields.filter { it.first.isChecked }.forEach { selected.add(it.second) }
                if (!integration && selected.isEmpty()) return@button
                val payload = if (integration) JSONObject().put("recipe", selected.firstOrNull() ?: JSONObject.NULL)
                    else JSONObject().put("recipes", JSONArray(selected))
                if (scope != null) payload.put("scope", scope)
                ui.work(MoteI18n.text("正在保存…"), { api.put(path, payload) }) { memorySettings() }
            }
        }
    }
    fun memoryJobs() {
        body.removeAllViews(); screens.setBack { screens.refresh() }
        ui.button(MoteI18n.text("开始提取"), true) { action("/api/memory-jobs") { run("/api/memory-jobs", it.getString("id")) } }
        library.paged("/api/memory-jobs", ui.card()) { row, card ->
            ui.text(CentralMemoryJobPresentation.status(row), parent = card)
            ui.button(MoteI18n.text("查看详情"), parent = card) { run("/api/memory-jobs", row.getString("id")) }
        }
    }
    fun run(path: String, id: String) {
        body.removeAllViews(); screens.setBack { screens.refresh() }
        if (path == "/api/memory-jobs") {
            val target = ui.card(); val api = client
            ui.work(MoteI18n.text("正在读取…"), { api.get(path + "/" + enc(id)) }) { job ->
                if (CentralMemoryJobPresentation.invalidated(job)) {
                    ui.text(CentralMemoryJobPresentation.status(job), 18f, target)
                    CentralMemoryJobPresentation.notice(job)?.let { ui.text(it, parent = target) }
                    ui.disclosure(MoteI18n.text("查看详情"), target) { values(job, it) }
                } else values(job, target)
                CentralMemoryJobPresentation.controls(job).forEach { (command, label) -> ui.button(MoteI18n.text(label), parent = target) { action(path + "/" + enc(id) + "/" + command) { run(path, id) } } }
            }
        } else read(path + "/" + enc(id))
        ui.button(MoteI18n.text("刷新")) { run(path, id) }
        if (path != "/api/memory-jobs") ui.button(MoteI18n.text("停止")) { action(path + "/" + enc(id) + "/cancel") { run(path, id) } }
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
        ui.text(MoteI18n.text("授权已创建"), NativeFontRole.TITLE_MOBILE); values(value, ui.card())
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
        ui.button(MoteI18n.text("添加待办"), true) {
            action("/api/todos", JSONObject().put("id", UUID.randomUUID().toString()).put("title", todo.text.toString()).put("description", "").put("dueAt", JSONObject.NULL).put("evidenceIds", JSONArray()))
        }
        library.paged("/api/todos?limit=30", ui.card()) { row, card ->
            ui.text(row.getString("title"), NativeFontRole.SECTION, card); ui.text(row.optString("description"), parent = card); ui.text(row.optString("status"), parent = card)
            if (row.optString("status") == "open") ui.button(MoteI18n.text("标记完成"), true, parent = card) {
                val api = client
                ui.work(MoteI18n.text("正在保存…"), { api.patch("/api/todos/" + enc(row.getString("id")), JSONObject().put("version", row.getInt("version")).put("status", "completed")) }) { screens.refresh() }
            }
            val refs = row.optJSONArray("evidenceIds") ?: JSONArray()
            for (i in 0 until refs.length()) ui.button(MoteI18n.text("查看原文依据"), parent = card) { library.captureEvidence(refs.getString(i)) }
        }
    }
    private val operationStates = listOf("" to "全部", "waiting" to "等待处理", "running" to "运行中", "blocked" to "受阻", "failed" to "失败", "succeeded" to "完成", "cancelled" to "已取消", "stale" to "来源变化待重验", "skipped" to "未安排")
    private fun stateLabel(state: String) = MoteI18n.text(operationStates.firstOrNull { it.first == state }?.second ?: state)
    private fun operationState(row: JSONObject): String {
        val label = CentralProcessingPresentation.stateKey(row.optString("state"), row.optString("waitingReason", row.optString("reason")), row.optBoolean("notScheduled"))
        return if (label != null) MoteI18n.text(label) else stateLabel(row.optString("state"))
    }
    private fun operationTitle(kind: String) = MoteI18n.text(mapOf("recording-sync" to "录音同步", "material-organizer" to "资料整理", "memory-provider-reconcile" to "记忆供应商核对", "file" to "文件处理", "capture" to "截图处理", "memory" to "记忆整理", "workflow" to "上下文处理", "import" to "资料导入", "query" to "问答", "insight" to "洞察", "embedding" to "检索向量计算", "material-index" to "资料检索索引")[kind] ?: "上下文处理")
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
                ui.selectRow(operationTitle(row.optString("kind")) + " · " + operationState(row), row.getString("id"), target) {
                    operation(row.getString("id"), returnTo = { processing(cursors, state) })
                }.apply { tag = "operation:" + row.getString("id"); contentDescription = MoteI18n.text("查看任务 {0} 的详情", row.getString("id")) }
            }
            pageButtons(cursors, result, items.length(), target) { processing(it, state) }
        }
        ui.button(MoteI18n.text("处理设置")) { processingSettings() }
    }
    private fun pageButtons(cursors: List<Long?>, result: JSONObject, count: Int, target: LinearLayout, load: (List<Long?>) -> Unit) {
        ui.text(MoteI18n.text("第 {0} 页 · {1} 条", cursors.size, count), NativeFontRole.SUPPORT, target)
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
        ui.text(MoteI18n.text("任务详情"), NativeFontRole.TITLE_MOBILE)
        ui.button(MoteI18n.text("刷新")) { operation(id, cursors, returnTo) }
        val target = ui.card(); val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/operations/" + enc(id) + "?limit=10" + (cursors.last()?.let { "&cursor=$it" } ?: "")) }) { result ->
            val operation = result.getJSONObject("operation")
            ui.text(operationTitle(operation.optString("kind")) + " · " + operationState(operation), NativeFontRole.SECTION, target)
            ui.text(id, NativeFontRole.SUPPORT, target)
            val steps = result.optJSONArray("steps") ?: JSONArray()
            for (i in 0 until steps.length()) {
                val step = steps.getJSONObject(i)
                ui.disclosure(step.optString("kind") + " · " + operationState(step), target) { values(step, it) }
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
        ui.button(MoteI18n.text("重新建立索引"), true) { action("/api/index/retry") }
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
            ui.text(row.optString("title", row.optString("path", row.optString("id"))), NativeFontRole.ROW, card); ui.text(row.optString("preview"), parent = card)
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
        ui.button(MoteI18n.text("首次上下文"), true) { action("/api/agent-view/startup", JSONObject().put("question", question.text.toString()).put("timeZone", ZoneId.systemDefault().id)) { values(it, ui.card()) } }
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
            ui.text(MoteI18n.text(title), NativeFontRole.SECTION)
            ui.button(MoteI18n.text("连接")) { action("/api/connectors/$provider/start") { value ->
                val url = Uri.parse(value.getString("authorizationUrl"))
                require(url.scheme == "https" && url.host == "accounts.google.com")
                ui.startActivity(Intent(Intent.ACTION_VIEW, url))
            } }
            ui.button(MoteI18n.text("立即同步"), true) { action("/api/connectors/$provider/sync") }
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
                ui.button(MoteI18n.text("导入所选资源"), true) {
                    require(selected.isNotEmpty()) { MoteI18n.text("请选择资源") }
                    importMcp(payload, name.text.toString(), JSONObject().put("resourceUris", JSONArray(selected)))
                }
                val tools = value.optJSONArray("tools") ?: JSONArray()
                for (i in 0 until tools.length()) {
                    val tool = tools.getJSONObject(i); val card = ui.card()
                    ui.text(tool.getString("name"), NativeFontRole.ROW, card); ui.text(tool.optString("description"), parent = card)
                    val args = ui.field(MoteI18n.text("工具参数 JSON"), "{}", multiline = true, parent = card)
                    val approved = CheckBox(ui).apply { text = MoteI18n.text("我确认此工具只读") }; card.addView(approved)
                    ui.button(MoteI18n.text("导入工具结果"), true, parent = card) {
                        require(approved.isChecked) { MoteI18n.text("请确认工具只读后再执行") }
                        importMcp(payload, name.text.toString(), JSONObject().put("tool", JSONObject().put("name", tool.getString("name"))
                            .put("arguments", JSONObject(args.text.toString())).put("confirmedReadOnly", true)))
                    }
                }
            }
        }
    }
    private fun lark() {
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/connectors/lark") to api.get("/api/sources") }) { (value, sourceList) ->
            body.removeAllViews(); screens.setBack { screens.refresh() }
            ui.button(MoteI18n.text("刷新")) { lark() }
            ui.text(MoteI18n.text("飞书文档与日历"), DesignTokens.fontTitleMobile.toFloat())
            ui.text(MoteI18n.text("照常在飞书写日记、会议纪要和方案。中央节点归档文档与活动线索，供回顾、问答和 Memory 使用。"))
            ui.text(MoteI18n.text("打开、编辑等线索单独保存；打开不代表读完、认同或当时看到的版本。"))
            val account = ui.card()
            ui.text(if (value.optBoolean("connected")) MoteI18n.text("已连接") else MoteI18n.text("尚未授权"), DesignTokens.fontSection.toFloat(), account)
            if (value.optString("accountName").isNotBlank()) ui.text(value.optString("accountName"), parent = account)
            listOf("check" to "检查状态", "install" to "安装 CLI", "setup" to "开始配置", "login" to "扫码登录并授权只读权限").forEach { (command, label) ->
                ui.button(MoteI18n.text(label), parent = account) { action("/api/connectors/lark/$command") { lark() } }
            }
            ui.button(MoteI18n.text("配置应用凭据"), parent = account) {
                edit(MoteI18n.text("配置应用凭据"), "/api/connectors/lark/configure", JSONObject().put("appId", "").put("secret", "").put("brand", "feishu"), "POST")
            }
            value.optJSONObject("job")?.let { job ->
                ui.text(if (job.optString("state") == "completed") MoteI18n.text("已完成") else stateLabel(job.optString("state")), parent = account)
                if (job.optString("error").isNotBlank()) ui.text(CentralLarkSelection.failure(job.getString("error")), parent = account)
                if (job.optString("state") in listOf("waiting", "running")) ui.button(MoteI18n.text("取消当前操作"), parent = account) { action("/api/connectors/lark/cancel") { lark() } }
                job.optString("authorizationUrl").takeIf(String::isNotBlank)?.let { url ->
                    val parsed = Uri.parse(url); val host = parsed.host.orEmpty()
                    if (parsed.scheme == "https" && parsed.userInfo == null && parsed.port == -1 &&
                        listOf("feishu.cn", "larksuite.com", "larkoffice.com").any { host == it || host.endsWith(".$it") })
                        ui.button(MoteI18n.text("打开授权页面"), parent = account) { ui.startActivity(Intent(Intent.ACTION_VIEW, parsed)) }
                }
            }
            ui.button(MoteI18n.text("查看授权进度"), parent = account) { lark() }
            val selection = value.optJSONObject("selection") ?: JSONObject()
            val selected = CentralLarkSelection.discovery(selection)
            val range = ui.card()
            ui.text(MoteI18n.text("选择同步范围"), DesignTokens.fontSection.toFloat(), range)
            ui.text(MoteI18n.text("首次回溯 {0} 天；之后随你的新活动归档。指定文档、文件夹和知识库分支持续跟踪。", selected.optInt("firstSyncDays", 30)), parent = range)
            ui.button(MoteI18n.text("选择文档与活动范围"), parent = range) { larkSelection() }
            ui.text(MoteI18n.text("需要日历时，先单独授权日历读取，再加载并选择日历。授权本身不会开始收集日程。"), parent = range)
            ui.button(MoteI18n.text("授权日历读取"), parent = range) { action("/api/connectors/lark/login", JSONObject().put("calendar", true)) { lark() } }
            ui.button(MoteI18n.text("选择日历"), parent = range) { calendarSelection(true) }
            ui.button(MoteI18n.text("飞书文档默认组合"), parent = range) { recipeSettings(false, "lark-docs") }
            ui.text(MoteI18n.text("中央节点每 {0} 分钟检查；关闭页面后继续运行。", value.optInt("syncIntervalSeconds", 900) / 60), parent = range)
            val sync = value.optJSONObject("documentSync")
            val sourceId = sync?.optString("sourceId")?.takeIf(String::isNotBlank)
            val sourceRows = sourceList.optJSONArray("items") ?: JSONArray()
            val source = (0 until sourceRows.length()).map { sourceRows.getJSONObject(it) }.firstOrNull { it.optString("id") == sourceId }
            val paused = source?.optBoolean("enabled") == false
            if (sourceId != null && source != null) {
                ui.button(MoteI18n.text(if (paused) "恢复接入" else "暂停接入")) {
                    ui.work(MoteI18n.text("正在保存…"), { api.patch("/api/sources/" + enc(sourceId), JSONObject().put("enabled", paused)) }) { lark() }
                }
                ui.button(MoteI18n.text("资料说明（选填）")) { larkSourceDescription(sourceId) }
            }
            if (paused) ui.text(MoteI18n.text("此文档来源已暂停；保存范围或重新授权不会恢复接入。"))
            ui.button(MoteI18n.text("预览文档范围")) { action("/api/connectors/lark/preview") { lark() } }
            sync?.optJSONArray("preview")?.let { preview ->
                val card = ui.card(); ui.text(MoteI18n.text("实际发现的文档"), DesignTokens.fontSection.toFloat(), card)
                ui.text(MoteI18n.text("下列为可用文档标题与引用，尚未因预览读取正文。归档时保存当前版本及可获得的活动线索。"), parent = card)
                ui.text(MoteI18n.text("发现 {0} 篇文档，以下显示 {1} 篇。", sync.optInt("previewTotal", preview.length()), preview.length()), parent = card)
                for (i in 0 until preview.length()) { val document = preview.getJSONObject(i); ui.text(document.optString("title", document.optString("reference")), parent = card) }
                if (preview.length() == 0) ui.text(MoteI18n.text("本次范围内没有发现文档。"), parent = card)
                ui.text(MoteI18n.text("预览最多显示 50 篇；同步会分页处理全部选定范围。"), parent = card)
            }
            if (!paused && (sync?.optBoolean("confirmed") == true || sync?.has("preview") == true || sync == null && (selection.optJSONArray("calendarIds")?.length() ?: 0) > 0))
                ui.button(if (sync != null && !sync.optBoolean("confirmed")) MoteI18n.text("确认并开始归档") else MoteI18n.text("立即同步"), true) { action("/api/connectors/lark/sync") { lark() } }
            sync?.let {
                ui.text(MoteI18n.text("已归档 {0} 篇文档 · {1} 条活动线索 · {2} 项待处理 · {3} 项失败", it.optInt("documents"), it.optInt("activities"), it.optInt("pending"), it.optInt("failed")))
                val failures = it.optJSONArray("errors") ?: JSONArray()
                for (i in 0 until failures.length()) {
                    val failure = failures.getJSONObject(i); val card = ui.card()
                    ui.text(failure.optString("reference"), parent = card)
                    val archiveRequired = failure.optString("code") == "lark_document_archive_required"
                    ui.text(CentralLarkSelection.failure(failure.optString("code")), parent = card)
                    if (!paused) ui.button(MoteI18n.text(if (archiveRequired) "为此来源保留完整正文并重试" else "重试此文档"), parent = card) {
                        if (archiveRequired && sourceId != null) ui.work(MoteI18n.text("正在处理…"), {
                            api.patch("/api/sources/" + enc(sourceId), JSONObject().put("retention", "archive"))
                            api.post("/api/connectors/lark/sync", JSONObject().put("document", failure.getString("reference")))
                        }) { lark() }
                        else action("/api/connectors/lark/sync", JSONObject().put("document", failure.getString("reference"))) { lark() }
                    }
                }
            }
            ui.text(MoteI18n.text("同步归档完成后，Memory 会按现有设置继续处理；并非每篇文档都会生成精选记忆。"))
            ui.button(MoteI18n.text("查看来源与归档")) { ui.navigate("sources") }
            ui.button(MoteI18n.text("断开连接")) { screens.confirm(MoteI18n.text("断开连接"), MoteI18n.text("断开会停止读取并暂停这些来源，保留已归档资料。飞书端授权及 CLI 凭据仍保留，可在飞书中单独撤销。")) {
                ui.work(MoteI18n.text("正在处理…"), { api.delete("/api/connectors/lark") }) { lark() }
            } }
        }
    }
    private fun larkSourceDescription(sourceId: String) {
        val api = client; val path = "/api/sources/" + enc(sourceId) + "/context"
        ui.work(MoteI18n.text("正在读取资料说明…"), { api.get(path) }) { current ->
            body.removeAllViews(); screens.setBack { lark() }
            ui.text(MoteI18n.text("资料说明（选填）"), DesignTokens.fontTitleMobile.toFloat())
            val description = ui.field(MoteI18n.text("可说明格式、时间、作者，以及哪些内容属于你。"), current.optString("description"), multiline = true)
            ui.text(MoteI18n.text("用于理解这个来源的背景、作者和内容归属。"))
            ui.text(MoteI18n.text("修改说明适用于已有和未来资料；不会自动重新转写或重算历史记忆。"))
            ui.button(MoteI18n.text("保存说明"), true) {
                val payload = JSONObject().put("expectedVersion", current.getInt("version")).put("description", description.text.toString())
                ui.work(MoteI18n.text("正在保存…"), { api.patch(path, payload) }) { lark() }
            }
        }
    }
    private fun larkSelection() {
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/connectors/lark").getJSONObject("selection") }) { current ->
            body.removeAllViews(); screens.setBack { lark() }
            ui.text(MoteI18n.text("选择文档与活动范围"), DesignTokens.fontTitleMobile.toFloat())
            val card = ui.card(); val discovery = CentralLarkSelection.discovery(current)
            ui.text(MoteI18n.text("自动发现我的文档活动"), DesignTokens.fontSection.toFloat(), card)
            fun choice(label: String, checked: Boolean) = CheckBox(ui).apply { text = MoteI18n.text(label); isChecked = checked }.also { card.addView(it) }
            val created = choice("我创建的", discovery.optBoolean("created")); val edited = choice("我编辑过的", discovery.optBoolean("edited")); val opened = choice("我打开过的", discovery.optBoolean("opened"))
            ui.text(MoteI18n.text("活动来自飞书可提供的最近记录，可能只有时间范围；不保证逐次操作日志或阅读时长。"), parent = card)
            val days = ui.field(MoteI18n.text("首次回溯天数"), discovery.optInt("firstSyncDays", 30).toString(), parent = card).apply { inputType = InputType.TYPE_CLASS_NUMBER }
            ui.text(MoteI18n.text("明确选定的范围会持续检查当前版本，包括其他协作者的后续修改。每行填写一个链接或 token。"), parent = card)
            val documents = ui.field(MoteI18n.text("指定文档（每行一个）"), CentralLarkSelection.text(current, "documents"), multiline = true, parent = card)
            val folders = ui.field(MoteI18n.text("文件夹（每行一个）"), CentralLarkSelection.text(current, "folders"), multiline = true, parent = card)
            val wikiRoots = ui.field(MoteI18n.text("知识库分支（每行一个）"), CentralLarkSelection.text(current, "wikiRoots"), multiline = true, parent = card)
            val exclusions = ui.field(MoteI18n.text("不再读取的文档（每行一个）"), CentralLarkSelection.text(current, "excludedDocuments"), multiline = true, parent = card)
            ui.text(MoteI18n.text("排除优先于自动发现和指定范围；已有归档保留。"), parent = card)
            val autoSync = choice("在后台定期同步选中内容", current.optBoolean("autoSync"))
            ui.text(MoteI18n.text("保存范围或重新授权不会恢复已暂停的来源。停止同步和移除范围会保留已有归档。"), parent = card)
            ui.button(MoteI18n.text("保存同步范围"), true) {
                val selections = Triple(created.isChecked, edited.isChecked, opened.isChecked)
                val firstSyncDays = days.text.toString(); val documentText = documents.text.toString(); val folderText = folders.text.toString()
                val wikiText = wikiRoots.text.toString(); val exclusionText = exclusions.text.toString(); val background = autoSync.isChecked
                ui.work(MoteI18n.text("正在保存…"), {
                    api.put("/api/connectors/lark/selection", CentralLarkSelection.payload(current, selections.first, selections.second, selections.third,
                        firstSyncDays, documentText, folderText, wikiText, exclusionText, background))
                }) { lark() }
            }
        }
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
                val check = CheckBox(ui).apply { text = item.optString("name", item.optString("summary", item.optString("title", id))); isChecked = if (lark) id in ids else item.optBoolean("selected") }
                fields.add(check to id); body.addView(check)
            }
            val collect = if (lark) form(pick(current, "pastDays", "futureDays", "timeZone"), ui.card()) else ({ JSONObject() })
            ui.button(MoteI18n.text("保存设置"), true) {
                val edited = collect(); val payload = JSONObject(current.toString())
                edited.keys().forEach { payload.put(it, edited.get(it)) }
                payload.put("calendarIds", JSONArray(fields.filter { it.first.isChecked }.map { it.second }))
                ui.work(MoteI18n.text("正在保存…"), { api.put(path + if (lark) "/selection" else "/calendars", payload) }) { screens.refresh() }
            }
        }
    }
    private fun recordingSteps(path: String, cursors: List<Long?> = listOf(null)) {
        body.removeAllViews(); screens.setBack { recordings() }
        ui.text(MoteI18n.text("同步步骤与状态"), NativeFontRole.TITLE_MOBILE)
        val target = ui.card(); val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get(path + "/steps?limit=20" + (cursors.last()?.let { "&cursor=$it" } ?: "")) }) { page ->
            val items = page.optJSONArray("items") ?: JSONArray()
            for (i in 0 until items.length()) {
                val step = items.getJSONObject(i)
                ui.disclosure(step.optString("title") + " · " + stateLabel(step.optString("state")), target) { child ->
                    values(step, child)
                    if (step.optString("state") == "failed") ui.text(MoteI18n.text("自动重试已停止，请核对原因后手动重试"), parent = child)
                }
            }
            pageButtons(cursors, page, items.length(), target) { recordingSteps(path, it) }
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
                ui.text(value.optString("label", provider), NativeFontRole.SECTION, card); values(value, card)
                val empty = value.optJSONObject("counts")?.optInt("empty") ?: 0
                if (empty > 0) ui.text(MoteI18n.text("采集完成，暂无文字：{0} 条", empty), parent = card)
                ui.button(MoteI18n.text("同步步骤与状态"), parent = card) { recordingSteps(path) }
                ui.button(MoteI18n.text("连接已授权账号"), true, parent = card) { action(path + "/connect") { recordings() } }
                ui.button(MoteI18n.text("同步范围"), parent = card) {
                    val selection = JSONObject(value.getJSONObject("selection").toString()).put("backupAudio", true)
                    edit(MoteI18n.text("同步范围"), path + "/selection", selection)
                }
                ui.button(MoteI18n.text("立即同步"), true, parent = card) { action(path + "/sync") { recordings() } }
                ui.button(MoteI18n.text("重试失败步骤"), parent = card) { action(path + "/retry") { recordings() } }
                ui.button(MoteI18n.text("断开连接"), parent = card) { ui.work(MoteI18n.text("正在处理…"), { api.delete(path) }) { recordings() } }
                ui.button(MoteI18n.text("最近归档的录音"), parent = card) {
                    library.paged(path + "/items?includeExports=true", card) { item, child ->
                        val captureId = item.optString("captureId").takeIf { it.isNotEmpty() && it != "null" }
                        if (captureId != null) ui.button(item.optString("title"), parent = child) { library.captureEvidence(captureId) }
                        else ui.text(item.optString("title"), parent = child)
                        if (item.optBoolean("empty")) ui.text(MoteI18n.text("采集完成，暂无文字"), parent = child)
                        if (item.optBoolean("unsupported")) ui.text(MoteI18n.text("厂商转写格式尚不支持"), parent = child)
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
            ui.text(row.optString("name") + " · " + row.optString("status"), NativeFontRole.ROW, card)
            ui.button(MoteI18n.text("查看预览"), parent = card) { importDetail(row.getString("id")) }
        }
        read("/api/import-capabilities")
    }
    fun importDetail(id: String) {
        body.removeAllViews(); screens.setBack { screens.refresh() }
        val api = client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/imports/" + enc(id)) }) { row ->
            values(row, ui.card())
            row.optJSONObject("memoryProgress")?.let { progress ->
                val card = ui.card()
                ui.text(MoteI18n.text("自动记忆进度"), NativeFontRole.ROW, card)
                ui.text(MoteI18n.text("按本次新记录接收时选中的配方处理；进度按记录汇总。"), parent = card)
                ui.text(MoteI18n.text("完成 {0} / {1} · 处理中 {2} · 等待内容或名额 {3}", progress.optInt("completed"), progress.optInt("total"), progress.optInt("running"), progress.optInt("pending")), parent = card)
                ui.text(MoteI18n.text("失败 {0} · 等待模型 {1} · 暂停 {2} · 已取消 {3} · 未启用 {4} · 输入已变更或不可用 {5}", progress.optInt("failed"), progress.optInt("waitingForModel"), progress.optInt("paused"), progress.optInt("cancelled"), progress.optInt("disabled"), progress.optInt("unavailable")), parent = card)
            }
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
        private val secrets = setOf("apiKey", "token", "secret", "clientSecret", "localWorkerApiKey")
        private val enums = mapOf("protocol" to listOf("deepseek", "openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "codex-app-server"),
            "reasoningEffort" to listOf("auto", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"),
            "serviceTier" to listOf("default", "fast"),
            "level" to listOf("debug", "info", "warn", "error", "silent"), "access" to listOf("read", "write"), "brand" to listOf("feishu", "lark"))
        fun pick(value: JSONObject, vararg keys: String) = JSONObject().apply { keys.forEach { key -> if (value.has(key)) put(key, value.get(key)) } }
        private val labels = mapOf(
            "title" to "标题", "name" to "名称", "description" to "描述", "enabled" to "启用", "status" to "状态", "state" to "状态",
            "provider" to "服务商", "protocol" to "协议", "baseUrl" to "服务地址", "model" to "模型", "reasoningEffort" to "推理强度",
            "serviceTier" to "速度模式",
            "maxTokens" to "最大生成 token", "apiKey" to "API Key（留空保留）", "modelRequestTimeoutMs" to "模型请求超时（毫秒）",
            "agentTimeoutMs" to "Agent 超时（毫秒）", "interactiveConcurrency" to "交互并发", "agentConcurrency" to "Agent 并发",
            "llmConcurrency" to "模型并发", "memoryConcurrency" to "记忆并发", "enabled" to "启用", "debug" to "调试日志",
            "traceEnabled" to "记录 Agent 读取", "level" to "日志级别",
            "deviceId" to "设备 ID", "deviceName" to "设备名称", "platform" to "平台", "serverUrl" to "节点地址", "label" to "名称"
        )
    }
}
