package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.*
import org.json.JSONObject
import java.io.File
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
        body = moteDetailPage(); status = TextView(this)
        val id = intent.getStringExtra("sourceId")
        draftKey = id ?: intent.getStringExtra("addAction").orEmpty().ifBlank { "FILE" }
        if (state?.containsKey("source") == true) {
            source = LocalSource.from(JSONObject(state.getString("source")!!))
            savedSource = state.getString("savedSource")?.let { LocalSource.from(JSONObject(it)) }
            selected = state.getBoolean("selected"); preset = state.getString("preset", "all"); retentionEdited = state.getBoolean("retentionEdited"); hasContextConflict = state.getBoolean("hasContextConflict")
            state.getStringArrayList("grants")?.let { grants.addAll(it) }
            restoredValues = JSONObject(state.getString("values", "{}")); showForm(); return
        }
        body.addView(status); status.text = MoteI18n.text("正在读取来源…")
        task.start(MoteI18n.text("正在读取来源…"), { status.text = it }, {
            val existing = id?.let { key -> localSources().sources().find { it.id == key } ?: error(MoteI18n.text("所选文件不可用")) }
            Triple(existing, if (existing == null) readDraft() else null, existing?.let { localSources().state(it.id).optString("status") == "context-conflict" } ?: false)
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
    private fun readDraft(): JSONObject? {
        val file = draftFile()
        return if (file.exists()) JSONObject(String(localContentCipher().open(file.readBytes()), Charsets.UTF_8)) else null
    }
    private fun draftFile() = File(noBackupFilesDir, "file-task-${SourceRules.hash(draftKey)}.enc")
    private fun values() = JSONObject().put("description", description.text.toString()).put("name", name.text.toString())
        .put("retention", retention.selectedItemPosition).put("initial", initial.selectedItemPosition).put("interval", interval.text.toString())
        .put("maximum", maximum.text.toString()).put("extensions", extensions.text.toString()).put("excludes", excludes.text.toString())
        .put("enabled", enabled.isChecked).put("allowRead", allowRead.isChecked).put("continuous", continuous.isChecked).put("advanced", advanced.visibility == View.VISIBLE)
    private fun persistDraft() {
        if (building || !::description.isInitialized || worker.isShutdown || savedSource != null) return
        // The private persisted draft contains no URI permission; reopening requires explicit selection.
        val draft = JSONObject().put("values", values()).put("preset", preset).put("retentionEdited", retentionEdited)
        worker.execute { runCatching {
            val file = draftFile(); val temp = File(file.parentFile, file.name + ".tmp")
            try {
                java.io.FileOutputStream(temp).use { it.write(localContentCipher().seal(draft.toString().toByteArray(Charsets.UTF_8))); it.fd.sync() }
                check(temp.renameTo(file))
            } finally { temp.delete() }
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
        if (!isChangingConfigurations) { val uris = grants.toList(); worker.execute { uris.forEach(::releaseUnused) } }
        worker.shutdown(); super.onDestroy()
    }
    private fun showForm() {
        building = true; body.removeAllViews(); presetButtons.clear()
        fun label(text: String, target: LinearLayout = body) = TextView(this).apply {
            this.text = MoteI18n.text(text); textSize = 15f; setPadding(0, moteDp(16), 0, moteDp(6)); target.addView(this)
        }
        fun hint(text: String, target: LinearLayout = body) = TextView(this).apply { this.text = MoteI18n.text(text); textSize = 13f; target.addView(this) }
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
        body.addView(TextView(this).apply { text = MoteI18n.text(if (savedSource != null) "文件来源设置" else if (source.tree) "同步文件夹" else "导入文件"); textSize = 28f })
        hint(if (source.tree) "持续收集文件夹中的新增文件和修改。" else if (source.syncContinuously) "持续同步这个文件的修改。" else "导入一次，不跟踪后续修改。")
        status = TextView(this); body.addView(status)
        pickButton = Button(this).apply { tag = "file-task:pick"; setOnClickListener { pick() }; body.addView(this) }
        selectedInfo = TextView(this).apply { textSize = 13f; setPadding(moteDp(12), moteDp(12), moteDp(12), moteDp(12)); background = MoteUi.shape(this@FileTaskActivity); body.addView(this) }
        if (source.tree) {
            label("收集哪些文件")
            val choices = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }; body.addView(choices)
            listOf("all" to "支持的文件", "audio" to "音频文件", "custom" to "自定义").forEach { (key, text) ->
                val button = Button(this).apply { this.text = MoteI18n.text(text); tag = "file-task:preset:$key"; setOnClickListener { choosePreset(key) } }
                choices.addView(button, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = moteDp(4) }); presetButtons[key] = button
            }
            presetHelp = hint("文本、音频、图片和文档。")
        } else presetHelp = TextView(this)
        label("资料说明（选填）")
        description = field(source.description, "file-task:description", multiline = true).apply {
            minLines = 3; hint = MoteI18n.text("例如：这是我的通话录音，我通常是其中一方；对方的表达属于对方。")
        }
        hint(if (source.tree) "用于理解这个来源的背景、作者和内容归属。" else "可说明格式、时间、作者，以及哪些内容属于你。")
        metadataStatus = TextView(this).apply { textSize = 13f; body.addView(this) }
        if (savedSource != null) hint("修改说明适用于已有和未来资料；不会自动重新转写或重算历史记忆。")
        initial = Spinner(this).apply {
            adapter = ArrayAdapter(this@FileTaskActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("一起导入已有文件"), MoteI18n.text("首次清点后，只同步新文件")))
            setSelection(if (source.initialSync == "new_only") 1 else 0); tag = "file-task:initial"
        }
        if (source.tree) { label("已有文件"); body.addView(initial) }
        label("中央保存方式")
        retention = Spinner(this).apply {
            adapter = ArrayAdapter(this@FileTaskActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("仅保留提取内容"), MoteI18n.text("保留原件及提取内容"), MoteI18n.text("仅记录文件信息")))
            tag = "file-task:retention"; setSelection(listOf("snapshot", "archive", "reference").indexOf(source.retention))
            body.addView(this)
        }
        retentionHelp = TextView(this).apply { textSize = 13f; body.addView(this) }
        advanced = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        body.addView(Button(this).apply { text = MoteI18n.text("高级设置"); tag = "file-task:advanced"; setOnClickListener { advanced.visibility = if (advanced.visibility == View.VISIBLE) View.GONE else View.VISIBLE; persistDraft() } })
        body.addView(advanced)
        label("来源名称", advanced); name = field(source.name, "file-task:name", advanced)
        label("扫描间隔 / 分钟（15–1440，系统可能推迟）", advanced); interval = field(source.intervalMinutes.toString(), "file-task:interval", advanced, numeric = true)
        label("单文件上限（MiB，1–512）", advanced); maximum = field(source.maxFileMiB.toString(), "file-task:maximum", advanced, numeric = true)
        label("允许扩展名，逗号分隔", advanced); extensions = field(source.extensions, "file-task:extensions", advanced)
        label("排除相对路径：每行一项，* 表示任意字符；区分大小写", advanced); excludes = field(source.excluded, "file-task:excludes", advanced, multiline = true)
        allowRead = CheckBox(this).apply { text = MoteI18n.text("中央保留完整提取正文，供离线读取片段"); isChecked = source.allowRead; advanced.addView(this) }
        enabled = CheckBox(this).apply { text = MoteI18n.text("允许读取并按所选策略发送这个来源"); isChecked = source.enabled; if (savedSource != null) advanced.addView(this) }
        continuous = CheckBox(this).apply { text = MoteI18n.text("以后修改，也自动同步"); isChecked = source.syncContinuously; tag = "file-task:continuous"; if (savedSource != null && !source.tree) advanced.addView(this) }
        hint("更改选择、过滤或保留方式会清除这个来源的本机旧待发缓存，按新设置重新扫描；不会自动删除中央历史。停用仅暂停本机检查与同步，中央的启用状态与历史保持不变。移除只影响本机连接。", advanced)
        val destination = Settings(this).read().server
        label("发送目的地")
        hint(if (destination.isBlank()) "未连接中央：先保存本机任务，连接时确认发送范围。" else MoteI18n.text("完整文件的发送目的地：{0}", destination))
        hint("上传后仅清理 Mote 暂存，保留手机原文件。")
        confirm = Button(this).apply { text = MoteI18n.text(if (savedSource != null) "保存来源设置" else if (source.tree) "开始同步" else "确认导入"); tag = "file-task:confirm"; setTag(R.id.mote_primary, true); setOnClickListener { save() }; body.addView(this) }
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
        presetButtons.forEach { (key, button) -> button.isSelected = key == preset; button.background = MoteUi.clickable(this, if (key == preset) MoteUi.tint else android.graphics.Color.WHITE, 24) }
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
        task.start(MoteI18n.text("正在读取所选文件…"), { status.text = it }, {
            contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            try {
                val document = if (source.tree) DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri)) else uri
                val display = contentResolver.query(document, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
                val existing = if (savedSource == null) localSources().sources().find { it.kind == "local-files" && it.uri == uri.toString() } else null
                Triple(uri.toString(), (display ?: MoteI18n.text(if (source.tree) "选择的文件目录" else "选择的文件")).take(200),
                    existing to (existing?.let { localSources().state(it.id).optString("status") == "context-conflict" } ?: false))
            } catch (e: Exception) { releaseUnused(uri.toString()); throw e }
        }) { result ->
            result.onSuccess { (location, display, saved) ->
                val (existing, conflict) = saved
                if (existing != null) {
                    // A repeated selection reopens the existing source instead of applying a new preset.
                    val draftDescription = description.text.toString()
                    source = existing; savedSource = existing; selected = true
                    preset = when (existing.extensions) { ALL_EXTENSIONS -> "all"; AUDIO_EXTENSIONS -> "audio"; else -> "custom" }
                    hasContextConflict = conflict
                    restoredValues = if (draftDescription.isNotEmpty()) JSONObject().put("description", draftDescription) else null
                    showForm()
                } else {
                    if (savedSource == null && (!selected || name.text.toString() == source.name)) name.setText(display)
                    source = source.copy(uri = location, name = if (savedSource == null) display else source.name); selected = true
                }
                if (previousUri != location && previousUri != UNSELECTED) worker.execute { previousUri?.let(::releaseUnused) }
                status.text = MoteI18n.text("文件已读取，请确认来源设置"); updateSelection(); persistDraft()
            }.onFailure { status.text = MoteI18n.text("无法读取文件或持久授权，请重新选择") }
        }
    }
    private fun releaseUnused(uri: String) {
        runCatching { if (localSources().sources().none { it.uri == uri }) contentResolver.releasePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }
    private fun save() {
        if (task.busy || !selected) return
        try {
            val descriptionText = description.text.toString()
            val next = source.copy(name = name.text.toString(), description = descriptionText, contextDirty = source.contextDirty || descriptionText != source.description,
                retention = listOf("snapshot", "archive", "reference")[retention.selectedItemPosition], centralProcessingConsent = true,
                enabled = enabled.isChecked, allowRead = if (retention.selectedItemPosition == 0) allowRead.isChecked else if (listOf("snapshot", "archive", "reference")[retention.selectedItemPosition] == source.retention) source.allowRead else false,
                initialSync = if (source.tree && initial.selectedItemPosition == 1) "new_only" else "all", syncContinuously = if (source.tree) true else if (savedSource != null) continuous.isChecked else false,
                intervalMinutes = interval.text.toString().toInt(), maxFileMiB = maximum.text.toString().toInt(), extensions = extensions.text.toString(), excluded = excludes.text.toString())
            next.validate(); confirm.isEnabled = false; pickButton.isEnabled = false
            task.start(MoteI18n.text("正在保存来源设置…"), { status.text = it }, {
                val store = localSources()
                val latest = store.sources().find { it.id == next.id }
                val original = savedSource
                val acknowledgedOnly = original != null && latest != null && latest.copy(contextVersion = original.contextVersion, contextDirty = original.contextDirty, contextTarget = original.contextTarget) == original
                check(latest == original || acknowledgedOnly) { MoteI18n.text("来源已在后台更新，请重新打开设置；当前草稿仍在页面中。") }
                val saved = if (acknowledgedOnly && source.contextVersion == original.contextVersion && source.contextTarget == original.contextTarget)
                    next.copy(contextVersion = latest.contextVersion, contextTarget = latest.contextTarget, contextDirty = latest.contextDirty || descriptionText != latest.description) else next
                store.save(saved); SourceWork.schedule(applicationContext, true); draftFile().delete()
                savedSource?.uri?.takeIf { it != next.uri }?.let(::releaseUnused)
                saved
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
        task.start(MoteI18n.text("正在读取资料说明…"), { status.text = it }, {
            val (code, value) = HttpJson.get(config.server.trimEnd('/') + "/api/sources/${current.id}/context", config.connectionToken())
            if (code !in 200..299 || value == null) null else SourceContextSnapshot.from(value, current.id)
        }) { result ->
            result.getOrNull()?.takeIf { it.version > 0 }?.let { snapshot ->
                if (description.text.toString() == current.description) {
                    task.start(MoteI18n.text("正在保存来源设置…"), { status.text = it }, {
                        localSources().confirmContext(current, SourceRules.target(config.server, config.token), snapshot)
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
        task.start(MoteI18n.text("正在读取资料说明…"), { status.text = it }, {
            val (code, body) = HttpJson.get(config.server.trimEnd('/') + "/api/sources/${source.id}/context", config.connectionToken())
            check(code in 200..299 && body != null); SourceContextSnapshot.from(body!!, source.id)
        }) { result ->
            result.onSuccess { remote ->
                MoteDialogBuilder(this).setTitle(MoteI18n.text("解决资料说明冲突"))
                    .setMessage(MoteI18n.text("中央说明（版本 {0}）：\n{1}\n\n本机说明：\n{2}", remote.version, remote.description, description.text.toString()))
                    .setPositiveButton(MoteI18n.text("以本机说明更新")) { _, _ ->
                        source = source.copy(contextVersion = remote.version, contextTarget = SourceRules.target(config.server, config.token), contextDirty = true)
                        status.text = MoteI18n.text("请保存设置以确认本机说明。")
                    }.setNeutralButton(MoteI18n.text("使用中央说明")) { _, _ ->
                        source = source.copy(contextVersion = remote.version, description = remote.description, contextTarget = SourceRules.target(config.server, config.token), contextDirty = false)
                        description.setText(remote.description); status.text = MoteI18n.text("请保存设置以确认中央说明。")
                    }.setNegativeButton(MoteI18n.text("取消"), null).show()
            }.onFailure { status.text = MoteI18n.text("无法读取中央资料说明；本机草稿保留，请重试。") }
        }
    }
    private fun remove() {
        if (task.busy) return
        MoteDialogBuilder(this).setTitle(MoteI18n.text("移除连接")).setMessage(MoteI18n.text("移除只影响本机连接，中央历史保留。"))
            .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("移除连接")) { _, _ ->
                task.start(MoteI18n.text("正在移除来源连接…"), { status.text = it }, {
                    localSources().remove(source.id); fileArchives().remove(source.id); source.uri?.let(::releaseUnused); SourceWork.schedule(applicationContext)
                }) { result -> result.onSuccess { finish() }.onFailure { status.text = MoteI18n.text("操作失败，请重试") } }
            }.show()
    }
}
