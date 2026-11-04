package dev.mote.collector.plugins

import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.View
import android.widget.*
import dev.mote.collector.CentralClient
import dev.mote.collector.CentralFailure
import dev.mote.collector.CentralScreens
import dev.mote.collector.MoteI18n
import dev.mote.collector.MoteUi
import dev.mote.collector.NativeFontRole
import dev.mote.collector.declarativePluginView
import dev.mote.collector.moteDp
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Settings plugin management stays in native controls. All lifecycle, progress,
 * capability and authority decisions come from the current owner API. */
internal class PluginCenterPlugin(private val screens: CentralScreens, private val registeredCapabilities: () -> Unit) {
    private val ui get() = screens.ui
    private val body get() = screens.body
    private val api get() = PluginControlClient(screens.client)
    private var inventory: PluginInventory? = null
    private var binding: MemoryBinding? = null
    private var tab = "installed"
    private var pending: PluginCommandIntent? = null
    private var retryPanel: LinearLayout? = null
    private var listVisible = false
    private val handler = Handler(Looper.getMainLooper())
    private var poll: Runnable? = null

    fun close() { poll?.let(handler::removeCallbacks); poll = null }
    fun clearPrivateState() { close(); inventory = null; binding = null; pending = null; retryPanel = null; listVisible = false }
    fun resume() { if (listVisible && inventory != null) load() }
    fun show() { clearPrivateState(); load() }
    private fun load() {
        close(); screens.clearBack(); val control = api
        ui.work(MoteI18n.text("正在读取…"), { runCatching { control.inventory() to if (tab == "memory") control.binding() else null } }) { result ->
            result.onSuccess { (packages, memory) -> inventory = packages; binding = memory; render() }
                .onFailure { failure -> readFailure(failure) }
        }
    }
    private fun readFailure(failure: Throwable) {
        if (failure is CentralFailure && failure.status in setOf(401, 403, 404, 410)) { clearPrivateState(); body.removeAllViews(); ui.button(MoteI18n.text("刷新")) { load() } }
        ui.requestFailure(failure)
    }
    private fun submit(intent: PluginCommandIntent, done: (JSONObject) -> Unit = { load() }) {
        close(); val control = api
        val previous = pending
        val request = if (previous != null && previous.path == intent.path && previous.method == intent.method && comparable(previous) == comparable(intent)) previous else intent
        pending = request; retryPanel?.let(body::removeView); retryPanel = null
        ui.work(MoteI18n.text("正在处理…"), { runCatching { control.execute(request) } }) { result ->
            result.onSuccess { pending = null; ui.notice(MoteI18n.text("请求已登记，运行状态以中央节点返回为准。")); done(it) }
                .onFailure { failure ->
                    if (failure is CentralFailure && failure.status in setOf(401, 403, 404, 410)) { readFailure(failure); return@onFailure }
                    ui.requestFailure(failure)
                    if (failure is CentralFailure && failure.status in setOf(409, 422)) {
                        pending = null
                        val card = ui.card(); retryPanel = card
                        ui.text(MoteI18n.text("配置或方案已变化；请读取当前状态后重新确认。"), parent = card)
                        ui.button(MoteI18n.text("重新读取配置并丢弃草稿"), parent = card) { screens.confirm(MoteI18n.text("重新读取"), MoteI18n.text("有未保存的修改。离开并丢弃修改？")) { load() } }
                    } else {
                        val card = ui.card(); retryPanel = card
                        ui.text(MoteI18n.text("请求结果尚未确认，请重试同一请求。"), parent = card)
                        ui.button(MoteI18n.text("重试同一请求"), parent = card) { submit(request, done) }
                    }
                }
        }
    }
    private fun comparable(intent: PluginCommandIntent) = intent.payload().apply { remove("operationId"); remove("expectedRevision") }.toString()
    private fun render() {
        body.removeAllViews(); retryPanel = null; listVisible = true
        ui.text(MoteI18n.text("管理安装、运行与记忆方案。资料连接仍在来源中管理。"))
        ui.button(MoteI18n.text("刷新")) { load() }
        val tabs = listOf("installed" to MoteI18n.text("已安装"), "discover" to MoteI18n.text("发现"), "memory" to MoteI18n.text("记忆方案"))
        val select = Spinner(ui).apply {
            contentDescription = MoteI18n.text("插件页面")
            adapter = ArrayAdapter(ui, android.R.layout.simple_spinner_dropdown_item, tabs.map { it.second })
            setSelection(tabs.indexOfFirst { it.first == tab }.coerceAtLeast(0))
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) { if (tabs[position].first != tab) { tab = tabs[position].first; load() } }
            }
        }; body.addView(select, LinearLayout.LayoutParams(-1, ui.moteDp(52)))
        when (tab) { "installed" -> installed(); "discover" -> discover(); "memory" -> memory() }
        ui.button(MoteI18n.text("查看运行记录")) { ui.navigate("processing") }
        ui.disclosure(MoteI18n.text("高级：已注册能力清单")) { target -> ui.button(MoteI18n.text("已注册能力"), parent = target) { close(); body.removeAllViews(); screens.setBack { load() }; registeredCapabilities() } }
        schedulePoll()
    }
    private fun schedulePoll() {
        val active = inventory?.packages?.any { it.state == "installing" } == true || binding?.admission?.optString("state") in setOf("draining", "stopping") || binding?.preparation?.optString("state") in setOf("waiting", "running")
        if (!active) return
        val revision = ui.navigationRevision
        val next = Runnable { if (!ui.isDestroyed && !ui.isFinishing && revision == ui.navigationRevision && !ui.isWorking) load() else close() }
        poll = next; handler.postDelayed(next, 3000)
    }
    private fun installed() {
        val data = inventory ?: return
        ui.text(MoteI18n.text("安装包、配置实例和当前方案分别管理。"))
        val builds = data.builds.filter { !it.retired }
        if (builds.isNotEmpty()) ui.disclosure(MoteI18n.text("插件构建")) { target ->
            builds.forEach { build ->
                val card = ui.card(target); ui.text(build.name + " · " + build.version, NativeFontRole.SECTION, card)
                ui.text((if (build.runtime == "worker") MoteI18n.text("中央 Worker") else MoteI18n.text("宿主构建")) + " · " + state(build.observed), parent = card)
                ui.text(MoteI18n.text("候选版本") + " · " + (build.desired?.optString("version") ?: MoteI18n.text("已选择停用")), parent = card)
                ui.text(MoteI18n.text("当前版本") + " · " + (build.active?.optString("version") ?: MoteI18n.text("没有正在运行的版本")), parent = card)
                build.blockers.forEach { ui.text(it, parent = card) }
                build.source?.let { source(it, card) }
                capabilities(build.capabilities, card)
            }
        }
        if (data.packages.isEmpty()) { ui.text(MoteI18n.text("还没有安装外部插件。")); ui.button(MoteI18n.text("从 GitHub 添加")) { tab = "discover"; load() } }
        data.packages.forEach { item ->
            val card = ui.card(); ui.text(item.name + " · " + item.version, NativeFontRole.ROW, card)
            ui.text(state(item.state) + " · " + state(item.observed), parent = card); source(item.source, card)
            ui.text(if (item.runtime == "worker") MoteI18n.text("中央 Worker") else MoteI18n.text("独立服务"), parent = card)
            item.issues.forEach { ui.text(it, parent = card) }
            if (item.state == "restart-required") ui.text(MoteI18n.text("此包需要节点重启。当前页面不会重启服务器。"), parent = card)
            if ("configure" in item.allowedActions) ui.button(MoteI18n.text("新增实例"), parent = card) { configuration(item, null) }
            val instances = data.instances.filter { it.packageId == item.id }
            if (instances.isEmpty()) ui.text(MoteI18n.text("此安装包尚无配置实例；没有运行，也没有绑定到记忆方案。"), parent = card)
            instances.forEach { instance ->
                val target = ui.card(card); ui.text(instance.name, NativeFontRole.SECTION, target)
                ui.text(instance.scope + " · " + MoteI18n.text("配置版本 {0}", instance.revision), parent = target)
                ui.text((if (instance.desired) MoteI18n.text("已选择启用") else MoteI18n.text("已选择停用")) + " · " + state(instance.observed), parent = target)
                capabilities(instance.capabilities, target); instance.issues.forEach { ui.text(it, parent = target) }
                if ("configure" in instance.allowedActions) ui.button(MoteI18n.text("配置"), parent = target) { configuration(item, instance) }
                // The instance command surface is delegated to the
                // schema-bound declarative runtime: only DOMAIN-allowed
                // actions are declared, and each fires the same precise
                // revision-carried PluginControlClient command.
                run {
                    val labels = mapOf("check" to MoteI18n.text("核验能力"), "enable" to MoteI18n.text("启用"), "disable" to MoteI18n.text("停用"))
                    val actions = labels.keys.filter { it in instance.allowedActions }
                    val spec = dev.mote.collector.plugins.DeclarativePluginView.parse(org.json.JSONObject().put("components", org.json.JSONArray().apply {
                        actions.forEach { action -> put(org.json.JSONObject().put("type", "action").put("command", action).put("labelKey", action)) }
                    }), actions.toSet())
                    target.addView(ui.declarativePluginView(spec, org.json.JSONObject(), { k -> labels[k] ?: k }, { ui.isWorking }, { action, _ -> submit(PluginControlClient.instanceAction(instance.id, action, instance.revision)) }))
                }
                ui.button(MoteI18n.text("查看记忆方案"), parent = target) { tab = "memory"; load() }
            }
            if ("uninstall" in item.allowedActions) ui.button(MoteI18n.text("卸载安装包"), parent = card) {
                screens.confirm(MoteI18n.text("卸载安装包"), MoteI18n.text("移除此安装包。已绑定、仍有历史读者或正在排空的包不能卸载，中央节点会再次核验。")) { submit(PluginControlClient.uninstall(item.id, data.revision)) }
            }
        }
    }
    private fun discover() {
        val data = inventory ?: return
        ui.text(MoteI18n.text("读取兼容发布包，预览版本、能力与访问范围后安装。GitHub 数据连接器仍在资料来源中管理。"))
        if (!data.installation.optBoolean("supported")) ui.text(data.installation.optString("reason", MoteI18n.text("当前节点不支持在线安装。")))
        val repository = ui.field(MoteI18n.text("GitHub 仓库")); val tag = ui.field(MoteI18n.text("发布标签（可选）"))
        ui.button(MoteI18n.text("预览发布包"), true) {
            val control = api; val selectedRepository = repository.text.toString().trim(); val selectedTag = tag.text.toString().trim()
            require(selectedRepository.isNotBlank()) { MoteI18n.text("请填写 GitHub 仓库。") }
            ui.work(MoteI18n.text("正在解析…"), { control.resolve(selectedRepository, selectedTag) }) { preview -> installation(preview, data.revision) }
        }.isEnabled = data.installation.optBoolean("supported")
        data.catalog.forEach { entry -> val target = ui.card(); ui.text(entry.getString("name"), NativeFontRole.SECTION, target); ui.text(entry.getString("description"), parent = target); ui.text(entry.getString("repository"), NativeFontRole.META, target); ui.button(MoteI18n.text("选择仓库"), parent = target) { repository.setText(entry.getString("repository")); tag.setText("") } }
    }
    private fun installation(preview: JSONObject, revision: Long) {
        close(); listVisible = false; body.removeAllViews(); screens.setBack { load() }
        ui.text(MoteI18n.text("安装预览"), NativeFontRole.TITLE_MOBILE); ui.text(preview.getString("name") + " · " + preview.getString("version"), NativeFontRole.ROW)
        val target = ui.card(); source(preview.getJSONObject("source"), target)
        ui.text((if (preview.getString("runtime") == "worker") MoteI18n.text("中央 Worker") else MoteI18n.text("独立服务")) + if (preview.getBoolean("restartRequired")) " · " + MoteI18n.text("安装后需重启") else "", parent = target)
        ui.text(MoteI18n.text("访问声明") + " · " + PluginControlProjection.strings(preview.getJSONArray("access")).joinToString(" · ").ifBlank { MoteI18n.text("没有访问声明") }, parent = target)
        ui.text(MoteI18n.text("依赖") + " · " + PluginControlProjection.strings(preview.getJSONArray("dependencies")).joinToString(" · ").ifBlank { MoteI18n.text("无声明依赖") }, parent = target)
        capabilities(PluginControlProjection.capabilities(preview.getJSONArray("capabilities")), target)
        ui.text(MoteI18n.text("可信插件代码拥有中央宿主权限；访问声明不是沙箱隔离。安装完成后仍需配置、启用与绑定。"), parent = target)
        PluginControlProjection.strings(preview.getJSONArray("issues")).forEach { ui.text(it, parent = target) }
        val intent = PluginControlClient.install(preview, revision)
        ui.button(MoteI18n.text("安装此版本"), true) { submit(intent) { tab = "installed"; load() } }.isEnabled = preview.getBoolean("installable") && inventory?.installation?.optBoolean("supported") == true
        ui.button(MoteI18n.text("取消")) { load() }
    }
    private fun configuration(item: PluginPackage, instance: PluginInstance?) {
        close(); val control = screens.client
        ui.work(MoteI18n.text("正在读取…"), { if ((instance?.fields ?: item.fields).any { it.type == "model-profile" }) control.get("/api/model-settings") else JSONObject() }) { models -> buildConfiguration(item, instance, models) }
    }
    private fun buildConfiguration(item: PluginPackage, instance: PluginInstance?, models: JSONObject) {
        body.removeAllViews(); listVisible = false; val fields = instance?.fields ?: item.fields; val initial = instance?.configuration ?: JSONObject()
        ui.text(MoteI18n.text("配置实例"), NativeFontRole.TITLE_MOBILE); ui.text(MoteI18n.text("配置实例与资料范围，再单独启用。启用不会自动替换当前记忆方案。"))
        val name = ui.field(MoteI18n.text("实例名称"), instance?.name ?: item.name); val scope = ui.field(MoteI18n.text("资料范围"), instance?.scope ?: "default")
        ui.text(MoteI18n.text("由中央节点核验授权范围；填写范围不会授予新的数据权限。"), NativeFontRole.META)
        val reads = linkedMapOf<String, () -> Any?>()
        fields.forEach { field ->
            when (field.type) {
                "boolean" -> { val toggle = CheckBox(ui).apply { text = field.label; isChecked = initial.optBoolean(field.id) }; body.addView(toggle); MoteUi.styleTree(toggle); reads[field.id] = { toggle.isChecked } }
                "select", "model-profile" -> {
                    val options = if (field.type == "model-profile") PluginControlProjection.objects(models.optJSONArray("profiles")).map { it.getString("id") to it.getString("name") } else field.options
                    val choices = listOf("" to MoteI18n.text("请选择")) + options
                    ui.text(field.label, NativeFontRole.SUPPORT)
                    val select = Spinner(ui).apply { contentDescription = field.label; adapter = ArrayAdapter(ui, android.R.layout.simple_spinner_dropdown_item, choices.map { it.second }); setSelection(choices.indexOfFirst { it.first == initial.optString(field.id) }.coerceAtLeast(0)) }; body.addView(select, LinearLayout.LayoutParams(-1, ui.moteDp(52))); reads[field.id] = { choices[select.selectedItemPosition].first }
                }
                "text", "secret-reference", "number" -> {
                    val input = ui.field(field.label, if (initial.has(field.id)) initial.opt(field.id)?.toString().orEmpty() else "")
                    if (field.type == "number") input.inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or InputType.TYPE_NUMBER_FLAG_SIGNED
                    reads[field.id] = { val text = input.text.toString(); if (field.type == "number" && text.isNotBlank()) text.toDoubleOrNull() ?: text else text }
                    if (field.type == "secret-reference") ui.text(MoteI18n.text("仅填写服务器保存的凭据引用，不填写凭据本身。") + if (instance?.secretStatus?.optBoolean(field.id) == true) " " + MoteI18n.text("服务器已配置凭据。") else "", NativeFontRole.META)
                }
                else -> ui.text(MoteI18n.text("此配置字段暂不支持：{0}", field.label))
            }
            if (field.description.isNotBlank()) ui.text(field.description, NativeFontRole.META)
        }
        if (instance == null && item.fields.isEmpty()) ui.text(MoteI18n.text("先创建实例，中央节点返回此插件的配置字段。"))
        fun collect() = JSONObject(initial.toString()).apply { reads.forEach { (id, read) -> val value = read(); if (value == null || value == "") remove(id) else put(id, value) } }
        fun dirty() = name.text.toString() != (instance?.name ?: item.name) || scope.text.toString() != (instance?.scope ?: "default") || collect().toString() != initial.toString()
        fun back() { if (dirty()) { screens.setBack { back() }; screens.confirm(MoteI18n.text("取消"), MoteI18n.text("有未保存的修改。离开并丢弃修改？")) { load() } } else load() }
        screens.setBack { back() }
        ui.button(if (instance == null) MoteI18n.text("创建实例") else MoteI18n.text("保存配置"), true) {
            val selectedConfiguration = collect(); val selectedName = name.text.toString().trim(); val selectedScope = scope.text.toString().trim()
            require(selectedName.isNotBlank() && selectedScope.isNotBlank() && PluginControlProjection.configured(fields, selectedConfiguration)) { MoteI18n.text("请检查必填字段与配置值。") }
            val intent = PluginControlClient.configure(item.id, instance?.id, instance?.revision ?: requireNotNull(inventory).revision, selectedName, selectedScope, selectedConfiguration)
            submit(intent) { result -> if (instance == null && item.fields.isEmpty()) configuration(item, PluginControlProjection.instance(result)) else load() }
        }
        ui.button(MoteI18n.text("取消")) { back() }
    }
    private fun memory() {
        val data = binding ?: return
        val admission = data.admission; val target = ui.card()
        ui.text(MoteI18n.text("自动记忆"), NativeFontRole.SECTION, target); ui.text(MoteI18n.text("控制自动提取与整合；原件、已有记忆与只读查询保留。独立回顾按自己的设置运行。"), parent = target)
        val desired = admission.getBoolean("desired"); var resetting = false
        val toggle = Switch(ui).apply {
            text = if (desired) MoteI18n.text("已选择启用") else MoteI18n.text("已选择暂停"); contentDescription = MoteI18n.text("自动记忆"); isChecked = desired; isEnabled = (if (desired) "pause" else "resume") in data.allowedActions
            setOnCheckedChangeListener { _, _ -> if (!resetting) { resetting = true; isChecked = desired; resetting = false; if (!ui.isWorking) submit(PluginControlClient.memoryAction(if (desired) "pause" else "resume", data.revision)) } }
        }; target.addView(toggle); MoteUi.styleTree(toggle)
        ui.text(admissionLabel(admission), parent = target)
        ui.text(MoteI18n.text("排队 {0} · 运行 {1} · 检查点 {2} · 结果待确认 {3}", admission.getInt("queued"), admission.getInt("running"), admission.getInt("checkpointed"), admission.getInt("resultUnknown")), NativeFontRole.SUPPORT, target)
        ui.text(MoteI18n.text("当前准入代次 {0} · 绑定代次 {1}", admission.getLong("generation"), data.generation), NativeFontRole.META, target)
        admission.optString("blockedReason").takeIf(String::isNotBlank)?.let { ui.text(it, parent = target) }
        if (!desired) ui.text(MoteI18n.text("暂停期间的新资料只归档。恢复只处理新资料，不会自动补跑暂停期间的历史。"), parent = target)
        if (admission.getString("state") == "draining") ui.text(MoteI18n.text("已停止新增自动任务；已授权任务保留原范围与代次，完成后停用。"), parent = target)
        if (admission.getInt("resultUnknown") > 0) ui.text(MoteI18n.text("外部结果尚未确认，停止请求不代表远端工作已结束。"), parent = target)
        if ("stop" in data.allowedActions) ui.button(MoteI18n.text("立即停止"), parent = target) { screens.confirm(MoteI18n.text("立即停止自动记忆"), MoteI18n.text("撤销旧任务继续写入的权限，并请求取消运行中的自动记忆任务。外部工作可能无法立刻停止，未确认结果会单独保留。")) { submit(PluginControlClient.memoryAction("stop", data.revision)) } }
        ui.text(MoteI18n.text("当前记忆方案") + " · " + data.activePlan.name, NativeFontRole.SECTION)
        ui.text(MoteI18n.text("准备与生效分开执行。只有范围、正文与索引核验通过后，才能切换写入与查询绑定。"))
        data.plans.forEach { plan -> val card = ui.card(); ui.text(plan.name, NativeFontRole.SECTION, card); ui.text(if (plan.mode == "engine") MoteI18n.text("完整引擎") else MoteI18n.text("模块组合"), parent = card); capabilities(plan.capabilities, card); if (plan.reason.isNotBlank()) ui.text(plan.reason, parent = card)
            if (plan.id == data.activePlan.id) ui.text(MoteI18n.text("当前"), parent = card)
            else ui.button(MoteI18n.text("预览更换"), parent = card) { prepare(plan, data) }.isEnabled = plan.available && "prepare" in plan.allowedActions && "prepare" in data.allowedActions
        }
        ui.disclosure(MoteI18n.text("高级：当前模块与绑定")) { card ->
            ui.text(MoteI18n.text("绑定版本") + " · " + data.revision, parent = card)
            data.modules.forEach { module -> ui.text(moduleLabel(module.getString("stage")) + " · " + module.getString("name") + " · " + capability(module.getString("state")), parent = card); module.optString("instanceId").takeIf(String::isNotBlank)?.let { ui.text(it, NativeFontRole.META, card) }; module.optString("reason").takeIf(String::isNotBlank)?.let { ui.text(it, parent = card) } }
            ui.text(MoteI18n.text("独立审查与授权由 Mote 保留。只展示实际注册与核验过的模块。"), parent = card)
        }
        data.preparation?.let { preparation(it, data) }
    }
    private fun prepare(plan: MemoryPlan, data: MemoryBinding) {
        close(); listVisible = false; body.removeAllViews(); screens.setBack { load() }
        ui.text(MoteI18n.text("更换方案预览"), NativeFontRole.TITLE_MOBILE); ui.text(data.activePlan.name + " → " + plan.name, NativeFontRole.SECTION)
        ui.text(MoteI18n.text("更换正文权威时须迁移记忆正文、修正与删除标记，再准备索引。同一正文权威只更换检索时可重建索引。准备完成不会自动生效。"))
        ui.text(MoteI18n.text("迁移全部 Mote 保留记忆正文及更正/替代状态。外部原生审计历史和引擎图保留在旧实例及运行备份中，不承诺跨引擎迁移。"))
        capabilities(plan.capabilities, ui.card()); val scope = ui.field(MoteI18n.text("历史授权范围"), "default")
        ui.text(MoteI18n.text("范围必须已获授权；准备不包含未授权历史或暂停期间的新提取。"), NativeFontRole.META)
        val fee = CheckBox(ui).apply { text = MoteI18n.text("已确认范围。真实接入可能产生模型与 Embedding 费用，费用以实际服务用量为准。") }; body.addView(fee); MoteUi.styleTree(fee)
        ui.text(MoteI18n.text("生效前会冻结旧方案新增写入，排空并核对尾部任务，验证新绑定；既有查询仍读取固定旧版本。"))
        val start = ui.button(MoteI18n.text("开始准备"), true) { val selectedScope = scope.text.toString().trim(); require(fee.isChecked && selectedScope.isNotBlank()); submit(PluginControlClient.prepare(plan.id, selectedScope, data.revision, fee.isChecked)) { load() } }.apply { isEnabled = false }
        fee.setOnCheckedChangeListener { _, checked -> start.isEnabled = checked }
        ui.button(MoteI18n.text("取消")) { load() }
    }
    private fun preparation(value: JSONObject, data: MemoryBinding) {
        val target = ui.card(); ui.text(MoteI18n.text("方案准备") + " · " + preparationState(value.getString("state")), NativeFontRole.SECTION, target)
        ui.text((if (value.getString("kind") == "content-migration") MoteI18n.text("正文迁移与索引准备") else MoteI18n.text("同一正文权威的索引准备")) + " · " + value.getString("scope"), parent = target)
        ui.text(MoteI18n.text("当前阶段：{0}", value.getString("phase")), parent = target)
        ui.text((if (value.getBoolean("oldAdmissionFrozen")) MoteI18n.text("旧方案已冻结新增写入，仍为既有查询提供读取。") else MoteI18n.text("当前方案继续按原绑定服务。")) + MoteI18n.text(" 待核对尾部任务：{0}", value.getInt("tail")), parent = target)
        capabilities(PluginControlProjection.capabilities(value.getJSONArray("checks")), target)
        if (value.getBoolean("usageUnknown")) ui.text(MoteI18n.text("实际模型与 Embedding 费用尚未确定，请查看服务用量。"), parent = target)
        value.optString("error").takeIf(String::isNotBlank)?.let { ui.text(it, parent = target) }
        val actions = PluginControlProjection.actions(value)
        listOf("retry" to MoteI18n.text("重试准备"), "cancel" to MoteI18n.text("取消准备"), "activate" to MoteI18n.text("设为当前方案")).forEach { (action, label) ->
            if (action in actions) ui.button(label, action == "activate", target) { submit(PluginControlClient.memoryAction(action, data.revision, value.getString("operationId"))) }.isEnabled = action != "activate" || value.getString("state") == "verified" && "activate" in data.allowedActions
        }
        ui.text(MoteI18n.text("准备失败或取消不会自动切换。历史范围的迁移不会授权新的自动提取。"), NativeFontRole.META, target)
    }
    private fun source(value: JSONObject, target: LinearLayout) { ui.text(value.getString("repository"), NativeFontRole.SUPPORT, target); ui.text(MoteI18n.text("固定版本") + " · " + value.getString("tag") + " · " + value.getString("commit"), NativeFontRole.META, target); ui.text(MoteI18n.text("完整性摘要") + " · " + value.getString("digest"), NativeFontRole.META, target) }
    private fun capabilities(values: List<PluginCapability>, target: LinearLayout) { values.forEach { ui.text(it.id + " · " + capability(it.state), NativeFontRole.SUPPORT, target); if (it.reason.isNotBlank()) ui.text(it.reason, NativeFontRole.META, target) } }
    private fun capability(state: String) = when (state) { "verified" -> MoteI18n.text("已核验"); "unsupported" -> MoteI18n.text("不支持"); else -> MoteI18n.text("尚未核验") }
    private fun moduleLabel(stage: String) = when (stage) { "extract" -> MoteI18n.text("记忆提取"); "review" -> MoteI18n.text("独立审查"); "integrate" -> MoteI18n.text("记忆整合"); "repository" -> MoteI18n.text("记忆正文"); "retrieval" -> MoteI18n.text("记忆检索"); else -> stage }
    private fun admissionLabel(value: JSONObject) = when (value.getString("state")) { "enabled" -> MoteI18n.text("自动记忆已启用"); "draining" -> MoteI18n.text("停用中：仍有 {0} 个已授权任务", value.getInt("queued") + value.getInt("running") + value.getInt("checkpointed")); "stopping" -> MoteI18n.text("正在立即停止"); "blocked" -> MoteI18n.text("需要处理"); else -> MoteI18n.text("自动记忆已暂停") }
    private fun preparationState(state: String) = when (state) { "waiting" -> MoteI18n.text("等待准备"); "running" -> MoteI18n.text("正在准备"); "blocked" -> MoteI18n.text("准备受阻"); "failed" -> MoteI18n.text("准备失败"); "verified" -> MoteI18n.text("核验通过 · 尚未生效"); "applied" -> MoteI18n.text("已生效"); "cancelled" -> MoteI18n.text("准备已取消"); else -> state }
    private fun state(state: String) = PluginCenterPresentation.packageState(state)

    companion object {
        const val CAPABILITY = "mote.plugin-center"
        const val API_VERSION = "1"

        fun provider(buildId: String) = NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId)
        fun requirement() = NativeRequirement(CAPABILITY, API_VERSION)
        fun availability(registry: NativePluginRegistry) = registry.availability(requirement())
    }
}

/** The build-native provider shipped with the plugin center controller. */
internal fun NativePluginRegistry.registerPluginCenter(buildId: String) {
    register(PluginCenterPlugin.provider(buildId))
}

/** User-visible labels for the control-plane and native availability facts.
 * Installation, requested/observed state and requires-build stay separate. */
internal object PluginCenterPresentation {
    fun packageState(state: String) = when (state) {
        "installed" -> MoteI18n.text("已安装")
        "installing" -> MoteI18n.text("正在安装")
        "failed" -> MoteI18n.text("安装失败")
        "restart-required" -> MoteI18n.text("等待节点重启")
        "requires-build", "requires_build" -> MoteI18n.text("需要构建")
        "enabled", "active" -> MoteI18n.text("已启用")
        "disabled", "stopped" -> MoteI18n.text("已停用")
        "unconfigured" -> MoteI18n.text("待配置")
        "queued" -> MoteI18n.text("等待启动")
        "starting" -> MoteI18n.text("正在启动")
        "restart_required" -> MoteI18n.text("等待节点重启")
        "draining" -> MoteI18n.text("停用中")
        "blocked" -> MoteI18n.text("需要处理")
        else -> state
    }

    fun availability(state: PluginAvailability) = when (state) {
        PluginAvailability.ACTIVE -> "active"
        PluginAvailability.REQUIRES_BUILD -> MoteI18n.text("需要构建")
        PluginAvailability.UNAVAILABLE -> "unavailable"
        PluginAvailability.UNSUPPORTED -> "unsupported"
        PluginAvailability.REVOKED -> "revoked"
        PluginAvailability.WAITING_DEVICE -> "waiting-device"
    }
}

/** Native projection of the shared owner control-plane contract. No query tool
 * can reach these commands; authorization is enforced by CentralClient/server. */
internal data class PluginCommandIntent(val path: String, val method: String, val body: String) {
    fun payload() = JSONObject(body)
}
internal data class PluginCapability(val id: String, val state: String, val reason: String)
internal data class PluginField(val id: String, val label: String, val type: String, val required: Boolean, val options: List<Pair<String, String>>, val description: String)
internal data class PluginInstance(val id: String, val packageId: String, val name: String, val revision: Long, val scope: String, val configuration: JSONObject, val fields: List<PluginField>, val capabilities: List<PluginCapability>, val desired: Boolean, val observed: String, val issues: List<String>, val allowedActions: Set<String>, val secretStatus: JSONObject)
internal data class PluginPackage(val id: String, val name: String, val version: String, val source: JSONObject, val runtime: String, val state: String, val observed: String, val issues: List<String>, val allowedActions: Set<String>, val fields: List<PluginField> = emptyList())
/** Native and worker builds share one projection: identity, candidate/active
 * selection, observed state, blockers, source, configuration and capabilities. */
internal data class PluginBuild(val id: String, val packageId: String, val installationId: String, val name: String, val version: String, val revision: Long, val runtime: String, val retired: Boolean, val observed: String, val desired: JSONObject?, val active: JSONObject?, val blockers: List<String>, val issues: List<String>, val source: JSONObject?, val configuration: JSONObject, val capabilities: List<PluginCapability>)
internal data class PluginInventory(val revision: Long, val installation: JSONObject, val packages: List<PluginPackage>, val instances: List<PluginInstance>, val builds: List<PluginBuild>, val catalog: List<JSONObject>)
internal data class MemoryPlan(val id: String, val name: String, val mode: String, val available: Boolean, val reason: String, val modules: List<JSONObject>, val capabilities: List<PluginCapability>, val allowedActions: Set<String>)
internal data class MemoryBinding(val revision: Long, val generation: Long, val mode: String, val activePlan: MemoryPlan, val plans: List<MemoryPlan>, val modules: List<JSONObject>, val admission: JSONObject, val preparation: JSONObject?, val allowedActions: Set<String>)

internal object PluginControlProjection {
    fun objects(value: JSONArray?) = value?.let { array -> (0 until array.length()).map { array.getJSONObject(it) } }.orEmpty()
    fun strings(value: JSONArray?) = value?.let { array -> (0 until array.length()).map { array.getString(it) } }.orEmpty()
    fun actions(value: JSONObject) = strings(value.optJSONArray("allowedActions")).toSet()
    fun capabilities(value: JSONArray?) = objects(value).map { PluginCapability(it.getString("id"), it.getString("state"), it.optString("reason")) }
    fun fields(value: JSONArray?) = objects(value).map { field ->
        PluginField(field.getString("id"), field.getString("label"), field.getString("type"), field.optBoolean("required"), objects(field.optJSONArray("options")).map { it.getString("value") to it.getString("label") }, field.optString("description"))
    }
    fun instance(value: JSONObject) = PluginInstance(value.getString("id"), value.getString("packageId"), value.getString("name"), value.getLong("revision"), value.getString("scope"), value.getJSONObject("configuration"), fields(value.getJSONArray("configurationSchema")), capabilities(value.getJSONArray("capabilities")), value.getBoolean("desired"), value.getString("observed"), strings(value.getJSONArray("issues")), actions(value), value.getJSONObject("secretStatus"))
    fun build(value: JSONObject) = PluginBuild(value.getString("id"), value.getString("packageId"), value.getString("installationId"), value.optString("name", value.getString("id")), value.optString("version"), value.getLong("revision"), value.optString("runtime", "host"), value.optBoolean("retired"), value.getString("observed"), value.optJSONObject("desired"), value.optJSONObject("active"), strings(value.optJSONArray("blockers")), strings(value.optJSONArray("issues")), value.optJSONObject("source"), value.optJSONObject("configuration") ?: JSONObject(), capabilities(value.optJSONArray("capabilities")))
    fun inventory(value: JSONObject) = PluginInventory(value.getLong("revision"), value.getJSONObject("installation"), objects(value.getJSONArray("packages")).map { PluginPackage(it.getString("id"), it.getString("name"), it.getString("version"), it.getJSONObject("source"), it.getString("runtime"), it.getString("state"), it.getString("observed"), strings(it.getJSONArray("issues")), actions(it), fields(it.optJSONArray("configurationSchema"))) }, objects(value.getJSONArray("instances")).map(::instance), objects(value.optJSONArray("builds")).map(::build), objects(value.getJSONArray("catalog")))
    fun plan(value: JSONObject) = MemoryPlan(value.getString("id"), value.getString("name"), value.getString("mode"), value.getBoolean("available"), value.optString("reason"), objects(value.getJSONArray("modules")), capabilities(value.getJSONArray("capabilities")), actions(value))
    fun binding(value: JSONObject) = MemoryBinding(value.getLong("revision"), value.getLong("generation"), value.getString("mode"), plan(value.getJSONObject("activePlan")), objects(value.getJSONArray("plans")).map(::plan), objects(value.getJSONArray("modules")), value.getJSONObject("admission"), value.optJSONObject("preparation"), actions(value))
    fun configured(fields: List<PluginField>, configuration: JSONObject): Boolean = fields.all { field ->
        val value = configuration.opt(field.id)
        val absent = value == null || value == JSONObject.NULL || value == ""
        if (absent) !field.required else when (field.type) {
            "boolean" -> value is Boolean
            "number" -> value is Number && value.toDouble().isFinite()
            "select" -> value is String && field.options.any { it.first == value }
            "text", "model-profile", "secret-reference" -> value is String
            else -> false
        }
    }
}

internal class PluginControlClient(private val client: CentralClient) {
    fun inventory() = PluginControlProjection.inventory(client.get("/api/plugins"))
    fun binding() = PluginControlProjection.binding(client.get(BINDING))
    fun resolve(repository: String, tag: String = "") = client.post("/api/plugins/resolve", JSONObject().put("repository", repository).apply { if (tag.isNotBlank()) put("tag", tag) })
    fun execute(intent: PluginCommandIntent): JSONObject = when (intent.method) {
        "POST" -> client.post(intent.path, intent.payload())
        "PATCH" -> client.patch(intent.path, intent.payload())
        else -> error("Unsupported plugin command method")
    }
    companion object {
        const val BINDING = "/api/memory-spaces/default/binding"
        fun intent(path: String, revision: Long, payload: JSONObject = JSONObject(), method: String = "POST", operationId: String = UUID.randomUUID().toString()) =
            PluginCommandIntent(path, method, JSONObject(payload.toString()).put("expectedRevision", revision).put("operationId", operationId).toString())
        fun install(preview: JSONObject, revision: Long) = intent("/api/plugins/install", revision, JSONObject().put("previewId", preview.getString("id")))
        fun configure(packageId: String, instanceId: String?, revision: Long, name: String, scope: String, configuration: JSONObject) = intent(
            if (instanceId == null) "/api/plugin-instances" else "/api/plugin-instances/" + CentralScreens.encode(instanceId), revision,
            JSONObject().put("name", name).put("scope", scope).put("configuration", configuration).apply { if (instanceId == null) put("packageId", packageId) }, if (instanceId == null) "POST" else "PATCH")
        fun instanceAction(id: String, action: String, revision: Long): PluginCommandIntent {
            require(action in setOf("check", "enable", "disable"))
            return intent("/api/plugin-instances/" + CentralScreens.encode(id) + "/" + action, revision)
        }
        fun memoryAction(action: String, revision: Long, preparationId: String? = null): PluginCommandIntent {
            require(action in setOf("pause", "resume", "stop", "activate", "retry", "cancel"))
            return intent(BINDING + "/" + action, revision, JSONObject().apply { preparationId?.let { put("preparationId", it) } })
        }
        fun prepare(planId: String, scope: String, revision: Long, feeAcknowledged: Boolean): PluginCommandIntent {
            require(feeAcknowledged && scope.isNotBlank())
            return intent(BINDING + "/prepare", revision, JSONObject().put("targetPlanId", planId).put("scope", scope).put("feeAcknowledged", true))
        }
        fun uninstall(id: String, revision: Long) = intent("/api/plugins/" + CentralScreens.encode(id) + "/uninstall", revision)
    }
}
