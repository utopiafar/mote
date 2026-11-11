package dev.mote.collector

import android.app.Activity
import android.content.res.ColorStateList
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*
import dev.mote.collector.plugins.SystemEntriesPlugin
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph

/** One list/detail surface. All edits write into the owning page's existing configuration draft. */
internal class AppCaptureEditor(
    private val activity: Activity,
    private val snapshot: () -> AppCapturePresentation.Snapshot?,
    private val change: (String, AppCollectionMode?) -> Unit,
    private val preview: (String) -> Unit,
    private val editRule: (String, String) -> Unit,
    private val loadRules: (String, String) -> Unit,
    private val importRules: (String, String) -> Unit,
    private val detailChanged: (Boolean) -> Unit,
    private val availability: () -> SystemEntriesPlugin.Availability,
) : LinearLayout(activity) {
    data class State(val selected: String? = null, val query: String = "", val scope: AppCapturePresentation.Scope = AppCapturePresentation.Scope.ALL, val rulesExpanded: Boolean = false)
    private var state = State()
    private var apps = emptyList<AppCapturePresentation.App>()
    private var ready = false
    private val loader = UiTask(activity)
    private var synchronizing = false
    private val listSurface = LinearLayout(activity).apply { orientation = VERTICAL }
    private val detailSurface = LinearLayout(activity).apply { orientation = VERTICAL; visibility = GONE }
    private val unavailable = label("", NativeFontRole.SUPPORT, NativeColorRole.WARNING).apply { visibility = GONE; tag = "app-capture-unavailable" }
    private val status = label("", NativeFontRole.SUPPORT, NativeColorRole.MUTED)
    private val rows = ListView(activity).apply {
        NativePresentationStyles.bind(this,"app-list-divider") { (it as ListView).divider = android.graphics.drawable.ColorDrawable(MoteUi.divider) }
        dividerHeight = activity.moteDp(1); tag = "app-capture-list"
    }
    private val scopeButtons = linkedMapOf<AppCapturePresentation.Scope, Button>()
    private val filters = LinearLayout(activity).apply { orientation = VERTICAL }
    private val search = MoteUi.field(EditText(activity)).apply { hint = MoteI18n.text("搜索应用"); setSingleLine(); contentDescription = MoteI18n.text("搜索应用") }
    private var shown = emptyList<AppCapturePresentation.App>()

    init {
        orientation = VERTICAL; tag = "app-capture-editor"
        listSurface.addView(search, LayoutParams(-1, -2))
        val scopeLabels = listOf("全部应用", "单独设置", "字段规则", "需处理")
        AppCapturePresentation.Scope.entries.chunked(2).forEach { scopes ->
            val line = LinearLayout(activity).apply { orientation = HORIZONTAL }
            scopes.forEach { scope ->
                val action = MoteUi.button(Button(activity)).apply {
                    text = MoteI18n.text(scopeLabels[scope.ordinal]); tag = "app-scope:${scope.name}"
                    setOnClickListener { state = state.copy(scope = scope); refreshList() }
                }
                scopeButtons[scope] = action
                line.addView(action, LayoutParams(0, -2, 1f).apply { setMargins(0, dp(4), dp(4), 0) })
            }
            filters.addView(line)
        }
        listSurface.addView(status, LayoutParams(-1, -2).apply { topMargin = dp(8); bottomMargin = dp(8) })
        listSurface.addView(rows, LayoutParams(-1, dp(360)))
        addView(listSurface); addView(unavailable); addView(detailSurface)
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) { state = state.copy(query = s.toString()); refreshList() }
        })
        rows.setOnItemClickListener { _, _, position, _ -> select(shown[position].id) }
        refresh()
        loadApps()
    }

    fun state() = state
    /** Existing advanced filters remain available in the owning page's disclosure. */
    fun advancedFilters(): View = filters
    override fun onDetachedFromWindow() { loader.close(); super.onDetachedFromWindow() }
    fun restore(value: State?) {
        if (value == null) return
        state = value; search.setText(value.query); refresh()
    }
    fun backToList(): Boolean {
        if (state.selected == null) return false
        state = state.copy(selected = null, rulesExpanded = false); refresh(); return true
    }
    fun select(id: String) {
        state = state.copy(selected = id, rulesExpanded = state.selected == id && state.rulesExpanded)
        search.clearFocus()
        (activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager)
            .hideSoftInputFromWindow(search.windowToken, 0)
        refresh()
        post { requestRectangleOnScreen(android.graphics.Rect(0, 0, width, dp(120)), true) }
    }

    private fun loadApps() {
        if (!availability().active) { renderUnavailable(availability()); return }
        val current = snapshot() ?: return
        val configured = current.collection.apps.keys + current.excluded + runCatching { current.ruleCatalog.keys }.getOrDefault(emptySet())
        loader.start(MoteI18n.text("正在读取已安装应用…"), MoteComponents.progress(status).let { show -> { message: String -> if (!ready) show(message) } }, {
            InstalledApps.load(activity.packageManager, configured).map { (id, name) ->
                @Suppress("DEPRECATION") val version = runCatching { activity.packageManager.getPackageInfo(id, 0).versionName.orEmpty() }.getOrDefault("")
                AppCapturePresentation.App(id, name, version)
            }
        }) { result ->
            result.onSuccess { apps = it; ready = true; refresh() }
                .onFailure { status.visibility = VISIBLE; status.text = MoteI18n.text("应用列表读取失败，请重试"); button(listSurface, MoteI18n.text("重试")) { loadApps() } }
        }
    }

    private fun catalog(current: AppCapturePresentation.Snapshot): List<AppCapturePresentation.App> {
        val known = apps.associateBy { it.id }.toMutableMap()
        val ids = current.collection.apps.keys + current.excluded + current.ruleCatalog.keys
        ids.forEach { id -> if (id !in known) {
            @Suppress("DEPRECATION") val name = runCatching { activity.packageManager.getApplicationInfo(id, 0).loadLabel(activity.packageManager).toString() }.getOrDefault(id)
            @Suppress("DEPRECATION") val version = runCatching { activity.packageManager.getPackageInfo(id, 0).versionName.orEmpty() }.getOrDefault("")
            known[id] = AppCapturePresentation.App(id, name, version)
        } }
        return known.values.sortedWith(compareBy<AppCapturePresentation.App> { it.label.lowercase() }.thenBy { it.id })
    }

    fun refresh() {
        if (synchronizing) return
        val gate = availability()
        if (!gate.active) { renderUnavailable(gate); return }
        unavailable.visibility = GONE
        search.isEnabled = true
        scopeButtons.values.forEach { it.isEnabled = true }
        val current = snapshot() ?: run { status.text = MoteI18n.text("手工规则格式有误，请展开高级规则修正。"); return }
        runCatching {
            refreshList(current)
            val selected = state.selected
            detailChanged(selected != null)
            listSurface.visibility = if (selected == null) VISIBLE else GONE
            detailSurface.visibility = if (selected == null) GONE else VISIBLE
            if (selected != null) catalog(current).firstOrNull { it.id == selected }?.let { renderDetail(current, it) }
        }.onFailure { status.visibility = VISIBLE; status.text = MoteI18n.text("请先修正页面规则 JSON"); listSurface.visibility = VISIBLE; detailSurface.visibility = GONE; detailChanged(false) }
    }

    private fun renderUnavailable(gate: SystemEntriesPlugin.Availability) {
        listSurface.visibility = GONE
        detailSurface.visibility = GONE
        detailSurface.removeAllViews()
        unavailable.text = gate.reason ?: MoteI18n.text("快捷入口不可用")
        unavailable.visibility = VISIBLE
        search.isEnabled = false
        scopeButtons.values.forEach { it.isEnabled = false }
        detailChanged(false)
    }

    private fun refreshList(current: AppCapturePresentation.Snapshot? = snapshot()) {
        if (current == null) return
        if (!availability().active) { renderUnavailable(availability()); return }
        runCatching {
            val all = catalog(current)
            shown = AppCapturePresentation.visible(current, all, state.scope, state.query)
            if (ready) { status.text = if (shown.isEmpty()) MoteI18n.text("没有匹配的应用") else "" } else MoteComponents.reading(status, MoteI18n.text("正在读取已安装应用…"))
            status.visibility = if (status.text.isEmpty()) GONE else VISIBLE
            scopeButtons.forEach { (scope, button) ->
                val count = AppCapturePresentation.visible(current, all, scope, "").size
                val name = listOf("全部应用", "单独设置", "字段规则", "需处理")[scope.ordinal]
                button.text = MoteI18n.text("{0} {1}", MoteI18n.text(name), count)
                button.isSelected = scope == state.scope
                MoteUi.action(button, if (scope == state.scope) MoteUi.ButtonRole.PRIMARY else MoteUi.ButtonRole.SECONDARY)
            }
            rows.adapter = object : BaseAdapter() {
                override fun getCount() = shown.size
                override fun getItem(position: Int) = shown[position]
                override fun getItemId(position: Int) = position.toLong()
                override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                    val app = getItem(position)
                    val mode = AppCapturePresentation.mode(current, app.id)
                    return LinearLayout(activity).apply {
                        orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; tag = "app-capture:${app.id}"; setPadding(0, dp(18), 0, dp(18))
                        background = MoteUi.clickable(activity,NativeColorRole.BACKGROUND,0,false)
                        contentDescription = MoteI18n.text("{0}，{1}，{2}，点击更改", app.label, app.id, modeLabel(mode))
                        addView(label(app.label.take(1),NativeFontRole.ACTION,NativeColorRole.MUTED).apply {
                            gravity = Gravity.CENTER; background = MoteUi.shape(activity,NativeColorRole.SURFACE,4,true)
                        },LayoutParams(dp(30),dp(32)).apply { marginEnd = dp(12) })
                        addView(LinearLayout(activity).apply {
                            orientation = VERTICAL
                            addView(label(app.label,NativeFontRole.ACTION))
                            addView(label((if (AppCapturePresentation.configured(current,app.id)) MoteI18n.text("单独设置") else MoteI18n.text("沿用默认")) + " · " + modeLabel(mode),NativeFontRole.META,NativeColorRole.MUTED))
                            if (needsWarning(current,app)) addView(label(capability(current,app),NativeFontRole.META,NativeColorRole.WARNING))
                        },LayoutParams(0,-2,1f))
                        addView(MoteComponents.icon(activity, MoteGlyph.CHEV, NativeColorRole.MUTED, 20), LayoutParams(dp(20), dp(20)))
                        setOnClickListener { select(app.id) }
                    }
                }
            }
        }.onFailure { status.visibility = VISIBLE; status.text = MoteI18n.text("请先修正页面规则 JSON") }
    }

    private fun renderDetail(current: AppCapturePresentation.Snapshot, app: AppCapturePresentation.App) {
        detailSurface.removeAllViews()
        button(detailSurface, MoteI18n.text("返回应用列表")) { backToList() }
        detailSurface.addView(label(app.label, NativeFontRole.SECTION))
        detailSurface.addView(label(MoteI18n.text("{0}\n安装版本：{1}", app.id, app.version.ifBlank { MoteI18n.text("不可读取") }), NativeFontRole.SUPPORT, NativeColorRole.MUTED))
        detailSurface.addView(badge(MoteI18n.text("时长 · 前台观察")))
        detailSurface.addView(badge(MoteI18n.text("截图 · 受系统权限与页面限制")))
        detailSurface.addView(badge(capability(current, app), needsWarning(current, app)))
        val inherited = !AppCapturePresentation.configured(current, app.id)
        val mode = AppCapturePresentation.mode(current, app.id)
        val choices = mutableListOf<CheckBox>()
        val follow = choice(MoteI18n.text("沿用默认设置"), inherited).apply { tag = "app-inherit:${app.id}" }
        detailSurface.addView(follow)
        listOf(MoteI18n.text("应用时长") to mode.duration, MoteI18n.text("截图") to mode.screenshots, MoteI18n.text("结构化内容") to mode.structured).forEachIndexed { index, (name, checked) ->
            val field = choice(name, checked).apply { tag = "app-channel:${app.id}:$index"; isEnabled = !inherited }
            choices.add(field); detailSurface.addView(field)
            field.setOnCheckedChangeListener { _, _ ->
                synchronizing = true
                try { change(app.id, AppCollectionMode.fromChoices(choices[0].isChecked, choices[1].isChecked, choices[2].isChecked)) } finally { synchronizing = false }
                refreshRuleSummary(snapshot() ?: current, app)
                refreshList()
            }
        }
        follow.setOnCheckedChangeListener { _, checked ->
            synchronizing = true
            try { change(app.id, if (checked) null else current.collection.defaultMode) } finally { synchronizing = false }
            refresh()
        }
        detailSurface.addView(label(MoteI18n.text("全部取消勾选即不采集。修改形成草稿，保存配置后生效。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED))
        val ruleSummary = LinearLayout(activity).apply { orientation = VERTICAL; tag = "app-rule-summary" }
        detailSurface.addView(ruleSummary)
        button(detailSurface, MoteI18n.text("预览此应用的记录格式")) { preview(app.id) }
        val advanced = LinearLayout(activity).apply { orientation = VERTICAL; tag = "app-rule-settings"; visibility = if (state.rulesExpanded) VISIBLE else GONE }
        button(detailSurface, MoteI18n.text("高级设置") + " · " + MoteI18n.text("结构化规则")) {
            state = state.copy(rulesExpanded = !state.rulesExpanded)
            advanced.visibility = if (state.rulesExpanded) VISIBLE else GONE
            (detailSurface.findViewWithTag<View>("app-rule-settings-toggle")).isSelected = state.rulesExpanded
        }.apply { tag = "app-rule-settings-toggle"; isSelected = state.rulesExpanded }
        detailSurface.addView(advanced)
        val ruleDetails = LinearLayout(activity).apply { orientation = VERTICAL; tag = "app-rule-details" }
        advanced.addView(ruleDetails)
        button(advanced, MoteI18n.text("配置当前版本的文章或商品字段")) { editRule(app.id, app.version) }
        button(advanced, MoteI18n.text("载入当前版本内置字段规则")) { loadRules(app.id, app.version) }
        button(advanced, MoteI18n.text("导入当前版本的字段规则")) { importRules(app.id, app.version) }
        advanced.addView(label(MoteI18n.text("规则配置与应用内容授权分开。修改只形成草稿，返回后保存生效；保存不会开始采集。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED))
        advanced.addView(label(MoteI18n.text("字段配置匹配不代表已经通过真机验证。截图按独立选择执行；隐私拒绝时不采集。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED))
        refreshRuleSummary(current, app)
    }

    private fun refreshRuleSummary(current: AppCapturePresentation.Snapshot, app: AppCapturePresentation.App) {
        val host = detailSurface.findViewWithTag<LinearLayout>("app-rule-summary") ?: return
        val details = detailSurface.findViewWithTag<LinearLayout>("app-rule-details") ?: return
        host.removeAllViews(); host.addView(label(MoteI18n.text("结构化规则"), NativeFontRole.SECTION))
        details.removeAllViews()
        val mode = AppCapturePresentation.mode(current, app.id)
        if (!mode.structured) host.addView(label(MoteI18n.text("此应用未选择结构化内容，字段规则不会运行"), NativeFontRole.SUPPORT, NativeColorRole.MUTED))
        if (current.projection) host.addView(label(MoteI18n.text("投屏模式不支持结构化内容"), NativeFontRole.SUPPORT, NativeColorRole.WARNING))
        val rules = current.ruleCatalog[app.id].orEmpty()
        if (rules.isEmpty()) host.addView(label(MoteI18n.text("当前版本未配置字段规则；截图仍按独立选择执行"), NativeFontRole.SUPPORT, NativeColorRole.MUTED))
        rules.forEach { rule ->
            val matched = app.version.isNotBlank() && app.version == rule.appVersion
            val kind = when (rule.kind) { "article" -> MoteI18n.text("文章"); "product" -> MoteI18n.text("商品"); else -> rule.kind }
            host.addView(label(MoteI18n.text("已配置 {0} · {1}；实际页面仍需匹配", kind, rule.fields.joinToString("、") { fieldLabel(it) }), NativeFontRole.SUPPORT))
            host.addView(badge(if (matched) MoteI18n.text("当前版本有规则") else MoteI18n.text("规则版本不符"), !matched))
            details.addView(label(MoteI18n.text("规则 {0} · 版本 {1}\n适用应用版本：{2}\n来源：本机规则配置", rule.id, rule.version, rule.appVersion), NativeFontRole.SUPPORT, NativeColorRole.MUTED))
        }
        if (current.ocr && mode.structured && !current.projection) host.addView(label(MoteI18n.text("本机 OCR 补充已选择；字段规则与 OCR 分别记录来源。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED))
    }

    private fun capability(current: AppCapturePresentation.Snapshot, app: AppCapturePresentation.App): String {
        if (current.projection) return MoteI18n.text("结构化 · 投屏模式不可用")
        val rules = current.ruleCatalog[app.id].orEmpty()
        return when {
            app.version.isBlank() -> MoteI18n.text("结构化 · 应用版本不可读取")
            AppCapturePresentation.matching(rules, app.version).isNotEmpty() -> MoteI18n.text("结构化 · 当前版本有规则")
            rules.isNotEmpty() -> MoteI18n.text("结构化 · 规则版本不符")
            current.ocr -> MoteI18n.text("结构化 · 可使用本机 OCR 补充")
            else -> MoteI18n.text("结构化 · 暂无字段规则")
        }
    }
    private fun needsWarning(current: AppCapturePresentation.Snapshot, app: AppCapturePresentation.App) = AppCapturePresentation.needsAttention(current, app, current.ruleCatalog[app.id].orEmpty())
    private fun modeLabel(mode: AppCollectionMode): String = listOfNotNull(if (mode.duration) MoteI18n.text("应用时长") else null, if (mode.screenshots) MoteI18n.text("截图") else null, if (mode.structured) MoteI18n.text("结构化内容") else null).joinToString(" · ").ifBlank { MoteI18n.text("不采集") }
    private fun fieldLabel(field: String) = when (field) { "title" -> MoteI18n.text("标题"); "author" -> MoteI18n.text("作者"); "body" -> MoteI18n.text("正文"); "url" -> MoteI18n.text("链接"); "item_id" -> MoteI18n.text("商品 ID"); else -> field }
    private fun label(value: String, role: NativeFontRole, color: NativeColorRole = NativeColorRole.INK) = TextView(activity).apply {
        text = value; MoteUi.type(this, role); MoteUi.textColor(this, color); setPadding(0, dp(4), 0, dp(4))
    }
    private fun badge(value: String, warning: Boolean = false) = label(value, NativeFontRole.SUPPORT, if (warning) NativeColorRole.WARNING else NativeColorRole.ACCENT).apply {
        background = MoteUi.shape(activity, NativeColorRole.TINT, NativeRadiusRole.INDICATOR, false)
        setPadding(dp(8), dp(4), dp(8), dp(4)); layoutParams = LayoutParams(-2, -2).apply { topMargin = dp(4); bottomMargin = dp(4) }
    }
    private fun choice(value: String, checked: Boolean) = CheckBox(activity).apply {
        text = value; isChecked = checked; MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK)
        buttonTintList = ColorStateList.valueOf(MoteUi.accent); minHeight = dp(48)
    }
    private fun button(host: LinearLayout, value: String, action: () -> Unit) = MoteUi.button(Button(activity)).apply {
        text = value; setOnClickListener { action() }; host.addView(this, LayoutParams(-1, -2).apply { topMargin = dp(8) })
    }
    private fun dp(value: Int) = activity.moteDp(value)
}
