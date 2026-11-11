package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.View
import android.view.WindowManager
import android.widget.*
import dev.mote.collector.plugins.SourceProviderPlugin
import dev.mote.collector.ui.MoteComponents
import org.json.JSONObject
import java.util.concurrent.Executors

/** One opt-in task page for one-time file imports and persistent folder sources. */
class FileTaskActivity : MoteActivity() {
    companion object {
        const val ALL_EXTENSIONS = "md,txt,json,csv,ics,m4a,mp3,wav,aac,amr,ogg,flac,opus,jpg,png,pdf,docx"
        const val AUDIO_EXTENSIONS = "m4a,mp3,wav,aac,amr,ogg,flac,opus"
        private const val UNSELECTED = "content://mote-unselected"
    }
    private val worker = Executors.newSingleThreadExecutor()
    private val task by lazy { UiTask(this, worker, ownsExecutor = false) }
    private val owner by lazy { SourceProviderPlugin.owner(this) }
    private lateinit var body: LinearLayout
    private lateinit var status: TextView
    private lateinit var description: EditText
    private lateinit var name: EditText
    private lateinit var retention: Spinner
    private lateinit var initial: Spinner
    private lateinit var interval: EditText
    private lateinit var maximum: EditText
    private lateinit var extensions: EditText
    private lateinit var excludes: EditText
    private lateinit var enabled: CheckBox
    private lateinit var allowRead: CheckBox
    private lateinit var continuous: CheckBox
    private lateinit var presetHelp: TextView
    private lateinit var retentionHelp: TextView
    private lateinit var pickButton: Button
    private lateinit var confirm: Button
    private lateinit var metadataStatus: TextView
    private lateinit var selectedInfo: TextView
    private lateinit var advanced: LinearLayout
    private var source = LocalSource(name = "", kind = "local-files", uri = UNSELECTED)
    private var savedSource: LocalSource? = null
    private var selected = false
    private var building = false
    private var preset = "all"
    private var retentionEdited = false
    private var hasContextConflict = false
    private val grants = linkedSetOf<String>()
    private val presetButtons = linkedMapOf<String, Button>()
    private var draftKey = "FILE"
    private var restoredValues: JSONObject? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        val state = savedInstanceState
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        body = moteDetailPage(title = MoteI18n.text("导入文件")); status = TextView(this)
        val id = intent.getStringExtra("sourceId")
        draftKey = id ?: intent.getStringExtra("addAction").orEmpty().ifBlank { "FILE" }
        if (state?.containsKey("source") == true) {
            source = LocalSource.from(JSONObject(state.getString("source")!!))
            savedSource = state.getString("savedSource")?.let { LocalSource.from(JSONObject(it)) }
            selected = state.getBoolean("selected"); preset = state.getString("preset", "all"); retentionEdited = state.getBoolean("retentionEdited"); hasContextConflict = state.getBoolean("hasContextConflict")
            state.getStringArrayList("grants")?.let { grants.addAll(it) }
            restoredValues = JSONObject(state.getString("values", "{}")); showForm(); return
        }
        body.addView(status); MoteComponents.reading(status, MoteI18n.text("正在读取来源…"))
        task.start(MoteI18n.text("正在读取来源…"), MoteComponents.progress(status), {
            val existing = id?.let { key -> owner.source(key) ?: error(MoteI18n.text("所选文件不可用")) }
            Triple(existing, if (existing == null) owner.readDraft(draftKey) else null,
                existing?.let { owner.state(it).optString("status") == "context-conflict" } ?: false)
        }) { result ->
            result.onSuccess { (existing, draft, conflict) ->
                savedSource = existing
                hasContextConflict = conflict
                source = existing ?: LocalSource(name = MoteI18n.text(if (draftKey == "FOLDER") "选择的文件目录" else "选择的文件"), kind = "local-files", uri = UNSELECTED,
                    tree = draftKey == "FOLDER", syncContinuously = draftKey == "FOLDER", extensions = ALL_EXTENSIONS)
                selected = existing != null
                preset = when (source.extensions) { ALL_EXTENSIONS -> "all"; AUDIO_EXTENSIONS -> "audio"; else -> "custom" }
                if (draft != null) { restoredValues = draft.optJSONObject("values"); preset = draft.optString("preset", preset); retentionEdited = draft.optBoolean("retentionEdited") }
                showForm(); refreshCentralContext()
            }.onFailure { status.text = MoteI18n.text("来源配置不可读；请保留应用数据，检查存储状态。") }
        }
    }
    private fun values() = JSONObject().put("description", description.text.toString()).put("name", name.text.toString())
        .put("retention", retention.selectedItemPosition).put("initial", initial.selectedItemPosition).put("interval", interval.text.toString())
        .put("maximum", maximum.text.toString()).put("extensions", extensions.text.toString()).put("excludes", excludes.text.toString())
        .put("enabled", enabled.isChecked).put("allowRead", allowRead.isChecked).put("continuous", continuous.isChecked).put("advanced", advanced.visibility == View.VISIBLE)
    private fun persistDraft() {
        if (building || !::description.isInitialized || worker.isShutdown || savedSource != null) return
        // The private persisted draft contains no URI permission; reopening requires explicit selection.
        worker.execute { runCatching {
            owner.saveDraft(draftKey, values(), preset, retentionEdited)
        }.onFailure { runOnUiThread { if (!isDestroyed && !isFinishing) status.text = MoteI18n.text("无法保存本机草稿，请检查存储后重试。") } } }
    }
    override fun onSaveInstanceState(state: Bundle) {
        if (::description.isInitialized) {
            state.putString("source", source.json().toString()); state.putString("savedSource", savedSource?.json()?.toString())
            state.putBoolean("selected", selected); state.putString("preset", preset); state.putBoolean("retentionEdited", retentionEdited)
            state.putBoolean("hasContextConflict", hasContextConflict)
            state.putString("values", values().toString()); state.putStringArrayList("grants", ArrayList(grants))
        }
        super.onSaveInstanceState(state)
    }
    override fun onPause() { persistDraft(); super.onPause() }
    override fun onDestroy() {
        if (!isChangingConfigurations) { val uris = grants.toList(); worker.execute { uris.forEach { owner.releaseUnused(it) } } }
        worker.shutdown(); super.onDestroy()
    }
    private fun showForm() {
        building = true; body.removeAllViews(); presetButtons.clear()
        fun label(text: String, target: LinearLayout = body) = TextView(this).apply {
            this.text = MoteI18n.text(text); MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK); setPadding(0, moteDp(16), 0, moteDp(6)); target.addView(this)
        }
        fun hint(text: String, target: LinearLayout = body) = TextView(this).apply { this.text = MoteI18n.text(text); MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED); target.addView(this, LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(MoteTheme.spaceInline); bottomMargin = moteDp(MoteTheme.spaceInline) }) }
        fun field(value: String, tagValue: String, target: LinearLayout = body, numeric: Boolean = false, multiline: Boolean = false) = EditText(this).apply {
            tag = tagValue; MoteUi.textInput(this, if (numeric) InputType.TYPE_CLASS_NUMBER else InputType.TYPE_CLASS_TEXT, multiline); setText(value)
            isSaveEnabled = false; importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO; target.addView(this)
            addTextChangedListener(object : TextWatcher { override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { persistDraft() }
                override fun afterTextChanged(s: Editable?) {
                    if (!building && tagValue == "file-task:extensions") {
                        preset = when (s.toString()) { ALL_EXTENSIONS -> "all"; AUDIO_EXTENSIONS -> "audio"; else -> "custom" }
                        updatePreset()
                    }
                } })
        }
        window.decorView.findViewWithTag<TextView>("detail-title").text = MoteI18n.text(if (savedSource != null) "文件来源设置" else if (source.tree) "同步文件夹" else "导入文件")
        window.decorView.findViewWithTag<android.view.View>("detail-add-action")?.visibility = if (savedSource == null) View.VISIBLE else View.GONE
        status = TextView(this); body.addView(status)
        val selection = SecondaryUi.column(body, card = true)
        pickButton = Button(this).apply { tag = "file-task:pick"; setOnClickListener { pick() }; selection.addView(this) }
        selectedInfo = TextView(this).apply { MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(moteDp(12), moteDp(12), moteDp(12), moteDp(12)); selection.addView(this) }
        label("资料说明（选填）")
        description = field(source.description, "file-task:description", multiline = true).apply {
            minLines = 3; filters = arrayOf(android.text.InputFilter.LengthFilter(12000)); hint = MoteI18n.text("例如：这是我的日记，文件名是日期。")
        }
        hint(if (source.tree) "适用于这个文件夹的已有与后续资料。" else "仅适用于这份文件。")
        metadataStatus = TextView(this).apply { MoteUi.type(this, NativeFontRole.SUPPORT); body.addView(this) }
        if (savedSource != null) hint("修改说明适用于已有和未来资料；不会自动重新转写或重算历史记忆。")
        if (source.tree) {
            label("同步哪些文件")
            val choices = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }; body.addView(choices)
            listOf("all" to "支持的文件", "audio" to "音频文件", "custom" to "自定义").forEach { (key, text) ->
                val button = Button(this).apply { this.text = MoteI18n.text(text); tag = "file-task:preset:$key"; setOnClickListener { choosePreset(key) } }
                choices.addView(button, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = moteDp(4) }); presetButtons[key] = button
            }
            presetHelp = hint("文本、音频、图片和文档。")
        } else presetHelp = TextView(this)
        initial = Spinner(this).apply {
            adapter = MoteUi.choiceAdapter(this@FileTaskActivity, listOf(MoteI18n.text("一起导入已有文件"), MoteI18n.text("首次清点后，只同步新文件")))
            setSelection(if (source.initialSync == "new_only") 1 else 0); tag = "file-task:initial"
        }
        if (source.tree) { label("首次同步范围"); body.addView(initial) }
        else hint(if (source.syncContinuously) "持续同步这个文件的修改。" else "仅导入这一次，不跟踪后续修改。")
        label("中心保存方式")
        retention = Spinner(this).apply {
            adapter = MoteUi.choiceAdapter(this@FileTaskActivity, listOf(MoteI18n.text("仅保留提取内容"), MoteI18n.text("保留原件及提取内容"), MoteI18n.text("仅记录文件信息")))
            tag = "file-task:retention"; setSelection(listOf("snapshot", "archive", "reference").indexOf(source.retention))
            body.addView(this)
        }
        retentionHelp = TextView(this).apply { MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED); body.addView(this) }
        val destinationConfig = Settings(this).read()
        val destination = destinationConfig.server
        label("发送目的地")
        if (!destinationConfig.hasSyncConnection()) {
            hint("未连接中央：先保存本机任务，连接时确认发送范围。")
            if (destination.isNotBlank()) hint(MoteI18n.text("已填写的中央地址：{0}；连接并确认后才会发送。", destination))
        } else hint(MoteI18n.text("完整文件的发送目的地：{0}", destination))
        hint("上传后仅清理 Mote 暂存，保留手机原文件。")
        advanced = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        body.addView(Button(this).apply { text = MoteI18n.text("高级设置"); tag = "file-task:advanced"; setOnClickListener { advanced.visibility = if (advanced.visibility == View.VISIBLE) View.GONE else View.VISIBLE; persistDraft() } })
        body.addView(advanced)
        label("来源名称", advanced); name = field(source.name, "file-task:name", advanced)
        label("扫描间隔 / 分钟（15–1440，系统可能推迟）", advanced); interval = field(source.intervalMinutes.toString(), "file-task:interval", advanced, numeric = true).apply { isEnabled = source.tree || (savedSource != null && source.syncContinuously) }
        label("单文件上限（MiB，1–512）", advanced); maximum = field(source.maxFileMiB.toString(), "file-task:maximum", advanced, numeric = true)
        label("允许扩展名，逗号分隔", advanced); extensions = field(source.extensions, "file-task:extensions", advanced)
        label("排除相对路径：每行一项，* 表示任意字符；区分大小写", advanced); excludes = field(source.excluded, "file-task:excludes", advanced, multiline = true)
        allowRead = CheckBox(this).apply { text = MoteI18n.text("中央保留完整提取正文，供离线读取片段"); isChecked = source.allowRead; advanced.addView(this) }
        enabled = CheckBox(this).apply { text = MoteI18n.text("允许读取并按所选策略发送这个来源"); isChecked = source.enabled; if (savedSource != null) advanced.addView(this) }
        continuous = CheckBox(this).apply { text = MoteI18n.text("以后修改，也自动同步"); isChecked = source.syncContinuously; tag = "file-task:continuous"; if (savedSource != null && !source.tree) advanced.addView(this) }
        hint("更改选择、过滤或保留方式会清除这个来源的本机旧待发缓存，按新设置重新扫描；不会自动删除中央历史。停用仅暂停本机检查与同步，中央的启用状态与历史保持不变。移除只影响本机连接。", advanced)
        confirm = Button(this).apply { text = MoteI18n.text(if (savedSource != null) "保存修改" else if (source.tree) "添加同步文件夹" else "导入这份文件"); tag = "file-task:confirm"; setTag(R.id.mote_primary, true); setOnClickListener { save() }; body.addView(this) }
        if (hasContextConflict) body.addView(Button(this).apply { text = MoteI18n.text("解决资料说明冲突"); tag = "file-task:context-conflict"; setOnClickListener { resolveConflict() } })
        if (savedSource != null) body.addView(Button(this).apply { text = MoteI18n.text("移除连接"); setOnClickListener { remove() } })
        restoredValues?.let { v ->
            description.setText(v.optString("description", source.description)); name.setText(v.optString("name", source.name))
            retention.setSelection(v.optInt("retention", retention.selectedItemPosition)); initial.setSelection(v.optInt("initial", initial.selectedItemPosition))
            interval.setText(v.optString("interval", source.intervalMinutes.toString())); maximum.setText(v.optString("maximum", source.maxFileMiB.toString()))
            extensions.setText(v.optString("extensions", source.extensions)); excludes.setText(v.optString("excludes", source.excluded))
            enabled.isChecked = v.optBoolean("enabled", source.enabled); allowRead.isChecked = v.optBoolean("allowRead", source.allowRead); continuous.isChecked = v.optBoolean("continuous", source.syncContinuously)
            advanced.visibility = if (v.optBoolean("advanced")) View.VISIBLE else View.GONE
        }; restoredValues = null
        MoteUi.styleTree(body)
        updateSelection(); updatePreset(); updateRetention(); updateMetadataStatus()
        retention.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            private var first = true
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) { if (!first && !building) retentionEdited = true; first = false; updateRetention(); persistDraft() }
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }
        initial.onItemSelectedListener = object : AdapterView.OnItemSelectedListener { override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) { persistDraft() }; override fun onNothingSelected(parent: AdapterView<*>?) = Unit }
        listOf(allowRead, enabled, continuous).forEach { it.setOnCheckedChangeListener { _, _ -> persistDraft() } }
        building = false
    }
    private fun updateSelection() {
        pickButton.text = MoteI18n.text(if (selected) if (source.tree) "更换文件夹" else "更换文件" else if (source.tree) "选择文件夹" else "选择一个文件")
        selectedInfo.visibility = if (selected) View.VISIBLE else View.GONE
        selectedInfo.text = source.name + "\n" + source.uri.orEmpty()
        confirm.isEnabled = selected && !task.busy
    }
    private fun choosePreset(value: String) {
        preset = value
        if (value != "custom") extensions.setText(if (value == "audio") AUDIO_EXTENSIONS else ALL_EXTENSIONS)
        if (value == "audio" && savedSource == null && !retentionEdited) retention.setSelection(1)
        updatePreset(); updateRetention(); persistDraft()
    }
    private fun updatePreset() {
        presetButtons.forEach { (key, button) -> button.isSelected = key == preset; button.background = MoteUi.clickable(this, if (key == preset) MoteUi.tint else MoteTheme.surface, MoteUi.actionRadius, strokeColor = if (key == preset) MoteUi.accent else MoteUi.controlBorder) }
        presetHelp.text = MoteI18n.text(when (preset) { "audio" -> "音频预设默认保留中央原件，保存方式可修改。"; "custom" -> "只收集你指定扩展名的文件；请在高级设置中填写。"; else -> "文本、音频、图片和文档。" })
        if (preset == "custom") advanced.visibility = View.VISIBLE
    }
    private fun updateRetention() {
        retentionHelp.text = MoteI18n.text(when (retention.selectedItemPosition) { 1 -> "完整文件会发送到中央解析或转写，并保留中央原件；手机原文件保留。"; 2 -> "不读取或上传正文，也不会转写。"; else -> "完整文件会发送到中央解析或转写；处理后不保留中央原件，手机原文件保留。" })
        allowRead.visibility = if (retention.selectedItemPosition == 0) View.VISIBLE else View.GONE
    }
    private fun updateMetadataStatus() {
        metadataStatus.visibility = if (hasContextConflict || source.contextDirty || source.contextVersion > 0) View.VISIBLE else View.GONE
        metadataStatus.text = MoteI18n.text(if (hasContextConflict) "资料说明与中央版本冲突；请打开设置处理，文件保留待发。" else if (source.contextDirty) "资料说明保存在本机，等待中央确认。" else if (source.contextVersion > 0) "资料说明已获中央确认，版本 {0}。" else "资料说明会作为这个来源的背景保存。", source.contextVersion)
    }
    private fun pick() {
        if (task.busy) return
        persistDraft()
        val picker = if (source.tree) Intent(Intent.ACTION_OPEN_DOCUMENT_TREE) else Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        @Suppress("DEPRECATION") startActivityForResult(picker, 402)
    }
    @Deprecated("Platform document callback") override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 402 || resultCode != Activity.RESULT_OK) return
        val uri = data?.data ?: return
        if (task.busy) return
        // Remember selected grants before the provider read, including when recreation discards its UI callback.
        grants.add(uri.toString())
        val previousUri = source.uri
        task.start(MoteI18n.text("正在读取所选文件…"), MoteComponents.progress(status), {
            owner.select(uri.toString(), source.tree, savedSource)
        }) { result ->
            result.onSuccess { selectedSource ->
                val existing = selectedSource.existing
                if (existing != null) {
                    // A repeated selection reopens the existing source instead of applying a new preset.
                    val draftDescription = description.text.toString()
                    source = existing; savedSource = existing; selected = true
                    preset = when (existing.extensions) { ALL_EXTENSIONS -> "all"; AUDIO_EXTENSIONS -> "audio"; else -> "custom" }
                    hasContextConflict = selectedSource.contextConflict
                    restoredValues = if (draftDescription.isNotEmpty()) JSONObject().put("description", draftDescription) else null
                    showForm()
                } else {
                    if (savedSource == null && (!selected || name.text.toString() == source.name)) name.setText(selectedSource.displayName)
                    source = source.copy(uri = selectedSource.uri, name = if (savedSource == null) selectedSource.displayName else source.name); selected = true
                }
                if (previousUri != selectedSource.uri && previousUri != UNSELECTED) worker.execute { previousUri?.let { owner.releaseUnused(it) } }
                status.text = MoteI18n.text("文件已读取，请确认来源设置"); updateSelection(); persistDraft()
            }.onFailure { status.text = MoteI18n.text("无法读取文件或持久授权，请重新选择") }
        }
    }
    private fun releaseUnused(uri: String) = owner.releaseUnused(uri)
    private fun save() {
        if (task.busy || !selected) return
        try {
            val descriptionText = description.text.toString()
            val next = source.copy(name = name.text.toString(), description = descriptionText, contextDirty = source.contextDirty || descriptionText != source.description,
                retention = listOf("snapshot", "archive", "reference")[retention.selectedItemPosition], centralProcessingConsent = true,
                enabled = enabled.isChecked, allowRead = if (retention.selectedItemPosition == 0) allowRead.isChecked else if (listOf("snapshot", "archive", "reference")[retention.selectedItemPosition] == source.retention) source.allowRead else false,
                initialSync = if (source.tree && initial.selectedItemPosition == 1) "new_only" else "all", syncContinuously = if (source.tree) true else if (savedSource != null) continuous.isChecked else false,
                intervalMinutes = interval.text.toString().toInt(), maxFileMiB = maximum.text.toString().toInt(), extensions = extensions.text.toString(), excluded = excludes.text.toString())
            if (next.maxFileMiB !in 1..512) { advanced.visibility=View.VISIBLE;maximum.error=MoteI18n.text("单文件上限（MiB，1–512）");maximum.requestFocus();status.text=MoteI18n.text("单文件上限（MiB，1–512）");return }
            next.validate(); confirm.isEnabled = false; pickButton.isEnabled = false
            task.start(MoteI18n.text("正在保存来源设置…"), MoteComponents.progress(status, read = false), {
                owner.saveFile(next, savedSource, descriptionText, draftKey)
            }) { result ->
                confirm.isEnabled = true; pickButton.isEnabled = true
                result.onSuccess { source = it; savedSource = it; status.text = MoteI18n.text("来源已保存，正在等待后台扫描"); updateMetadataStatus(); finish() }
                    .onFailure { status.text = it.message ?: MoteI18n.text("保存或调度失败，请重试；已保存内容不会丢失") }
            }
        } catch (e: Exception) { status.text = e.message ?: MoteI18n.text("请检查来源设置") }
    }
    private fun refreshCentralContext() {
        val current = savedSource ?: return
        val config = Settings(this).read()
        if (!config.hasSyncConnection() || current.contextDirty || hasContextConflict) return
        // Reading metadata is independent of upload policies; unsupported older nodes preserve old settings.
        task.start(MoteI18n.text("正在读取资料说明…"), MoteComponents.progress(status), {
            runCatching { owner.remoteContext(current) }.getOrNull()
        }) { result ->
            result.getOrNull()?.takeIf { it.version > 0 }?.let { snapshot ->
                if (description.text.toString() == current.description) {
                    task.start(MoteI18n.text("正在保存来源设置…"), MoteComponents.progress(status, read = false), {
                        owner.confirmContext(current, snapshot)
                    }) { ack -> ack.getOrNull()?.let {
                        source = it; savedSource = it
                        // The metadata ACK can arrive after the user started typing in this still-editable field.
                        if (description.text.toString() == current.description) description.setText(it.description)
                        updateMetadataStatus()
                    } }
                }
            }
            status.text = ""
        }
    }
    private fun resolveConflict() {
        if (task.busy) return
        val config = Settings(this).read(); if (!config.hasSyncConnection()) { status.text = MoteI18n.text("等待网络/节点恢复"); return }
        task.start(MoteI18n.text("正在读取资料说明…"), MoteComponents.progress(status), {
            owner.remoteContext(source)
        }) { result ->
            result.onSuccess { remote ->
                MoteDialogBuilder(this).setTitle(MoteI18n.text("解决资料说明冲突"))
                    .setMessage(MoteI18n.text("中央说明（版本 {0}）：\n{1}\n\n本机说明：\n{2}", remote.version, remote.description, description.text.toString()))
                    .setPositiveButton(MoteI18n.text("以本机说明更新")) { _, _ ->
                        source = owner.applyContextChoice(source, remote, useRemote = false)
                        status.text = MoteI18n.text("请保存设置以确认本机说明。")
                    }.setNeutralButton(MoteI18n.text("使用中央说明")) { _, _ ->
                        source = owner.applyContextChoice(source, remote, useRemote = true)
                        description.setText(remote.description); status.text = MoteI18n.text("请保存设置以确认中央说明。")
                    }.setNegativeButton(MoteI18n.text("取消"), null).show()
            }.onFailure { status.text = MoteI18n.text("无法读取中央资料说明；本机草稿保留，请重试。") }
        }
    }
    private fun remove() {
        if (task.busy) return
        MoteDialogBuilder(this).setTitle(MoteI18n.text("移除连接")).setMessage(MoteI18n.text("移除这个来源和本机待发缓存；手机原文件与中央历史保留。"))
            .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("移除连接")) { _, _ ->
                task.start(MoteI18n.text("正在移除来源连接…"), MoteComponents.progress(status, read = false), {
                    owner.remove(source.id)
                }) { result -> result.onSuccess { finish() }.onFailure { status.text = MoteI18n.text("操作失败，请重试") } }
            }.show()
    }
}
