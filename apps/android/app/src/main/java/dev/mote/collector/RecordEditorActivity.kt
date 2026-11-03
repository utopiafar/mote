package dev.mote.collector

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.WindowManager
import android.widget.*
import dev.mote.collector.plugins.NotesEditor
import dev.mote.collector.plugins.NotesPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** One explicit Save boundary for all manual and shared records. */
open class RecordEditorActivity : MoteActivity() {
    private lateinit var field: EditText
    private lateinit var description: EditText
    private lateinit var status: TextView
    private lateinit var attachmentsView: LinearLayout
    private lateinit var originView: LinearLayout
    private lateinit var save: Button
    private lateinit var microphone: Button
    private val mediaActions = mutableListOf<Button>()
    private lateinit var draftState: TextView
    private lateinit var recordingNote: TextView
    private var attachments = JSONArray()
    private var origin = JSONObject().put("kind", "manual")
    private var originPresentation: JSONObject? = null
    private var ready = false
    private var originExpanded = true
    private lateinit var notes: NotesEditor
    private val io get() = notes.io
    private lateinit var task: UiTask
    private lateinit var attachmentTask: UiTask
    private var recorder: MediaRecorder? = null
    private var recordingFile: File? = null
    private var player: MediaPlayer? = null
    private var cameraPath: String? = null
    private var cameraResultReady = false
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        notes = NotesPlugin.owner(applicationContext).view()
        cameraPath = state?.getString("cameraPath"); cameraResultReady = state?.getBoolean("cameraResultReady") ?: false
        originExpanded = state?.getBoolean("originExpanded",true) ?: true
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        task = UiTask(this, io, ownsExecutor = false)
        attachmentTask = UiTask(this, io, ownsExecutor = false)
        save = MoteUi.button(Button(this).apply { text = MoteI18n.text("保存"); setOnClickListener { submit() } }, true)
        NativePresentationStyles.bind(save, "record-save") { (it as Button).apply { minWidth = moteDp(58); minimumWidth = minWidth; minHeight = moteDp(36); minimumHeight = minHeight; textSize = 11f; setPadding(moteDp(10),0,moteDp(10),0); background = MoteUi.clickable(this@RecordEditorActivity, NativeColorRole.INK, 6, false) } }
        MoteUi.textColor(save, NativeColorRole.BACKGROUND)
        val body = moteDetailPage(primary = null, title = MoteI18n.text("随手记"), headerAction = save)
        body.setPadding(moteDp(20), moteDp(25), moteDp(20), moteDp(32))
        val meta = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        draftState = TextView(this).apply { text = MoteI18n.text("文字、照片或录音"); MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED); tag = "record-draft-state" }
        meta.addView(draftState, LinearLayout.LayoutParams(0,-2,1f))
        meta.addView(TextView(this).apply { text = MoteI18n.text("保存到此手机"); MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED) })
        body.addView(meta)
        val form = body
        originView = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; form.addView(originView)
        field = EditText(this).apply {
            hint = MoteI18n.text("记下此刻的想法…"); contentDescription = MoteI18n.text("正在想什么")
            gravity = Gravity.TOP; inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
            filters = arrayOf(android.text.InputFilter.LengthFilter(100000)); MoteUi.field(this); minLines = 8
            NativePresentationStyles.bind(this, "record-editor-lines") { (it as EditText).apply { minLines = 8; background = null; setPadding(0, moteDp(24), 0, moteDp(20)) } }
        }; form.addView(field)
        attachmentsView = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; form.addView(attachmentsView)
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }; form.addView(actions)
        fun action(symbol: String, label: String, run: () -> Unit): Button = MoteUi.action(Button(this).apply {
            text = symbol + "\n" + MoteI18n.text(label); contentDescription = MoteI18n.text(label)
            setOnClickListener { if (ready && !task.busy && !attachmentTask.busy && (recorder == null || label == "录音")) run() }
        }, MoteUi.ButtonRole.TEXT).also { button ->
            NativePresentationStyles.bind(button, "record-media-action") { (it as Button).apply { minHeight = moteDp(78); textSize = 11f; setPadding(0, moteDp(8),0,moteDp(8)) } }
            mediaActions.add(button)
            actions.addView(button, LinearLayout.LayoutParams(0, -2, 1f))
        }
        action("▣", "拍照") { if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) camera() else requestPermissions(arrayOf(Manifest.permission.CAMERA), 21) }
        action("▧", "相册") { pick("image/*", 11) }
        microphone = action("♩", "录音") { if (recorder != null) stopRecording() else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startRecording() else requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 22) }
        action("⌕", "文件") { pick("*/*", 12) }
        val explanation = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = android.view.View.GONE }
        description = EditText(this).apply {
            tag = "record-description"; hint = MoteI18n.text("例如：这是我的日记，记录我自己的经历。"); contentDescription = MoteI18n.text("资料说明")
            MoteUi.textInput(this, android.text.InputType.TYPE_CLASS_TEXT, multiline = true); filters = arrayOf(android.text.InputFilter.LengthFilter(12000)); MoteUi.field(this); minLines = 3
        }
        explanation.addView(description)
        explanation.addView(TextView(this).apply { text = MoteI18n.text("仅用于理解这条记录。"); MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED) })
        form.addView(TextView(this).apply {
            text = "▸ " + MoteI18n.text("资料说明（选填）"); contentDescription = MoteI18n.text("资料说明（选填）"); MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED)
            minHeight = moteDp(48); gravity = Gravity.CENTER_VERTICAL; isFocusable = true
            setOnClickListener { val expanded = explanation.visibility != android.view.View.VISIBLE; explanation.visibility = if (expanded) android.view.View.VISIBLE else android.view.View.GONE; text = (if (expanded) "▾ " else "▸ ") + MoteI18n.text("资料说明（选填）") }
        }, LinearLayout.LayoutParams(-1,-2).apply { topMargin = moteDp(20) })
        form.addView(explanation)
        recordingNote = TextView(this).apply { text = MoteI18n.text("离开页面会停止录音，并保留草稿。"); MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED); visibility = android.view.View.GONE; tag = "record-leave-notice" }; form.addView(recordingNote)
        status = TextView(this).apply { MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED) }; form.addView(status)
        description.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) { if (ready) persist() }
        })
        field.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) { if (ready) persist() }
        })
        enabled(false)
        task.start("", {}, { notes.draft() }) { outcome -> outcome.onSuccess { draft ->
            attachments = draft.getJSONArray("attachments"); origin = draft.getJSONObject("origin"); originPresentation = draft.optJSONObject("originPresentation"); field.setText(draft.getString("text")); description.setText(draft.optString("description")); ready = true; enabled(!attachmentTask.busy); renderAttachments()
            if (state == null) importIntent(intent)
            if (cameraResultReady) stageCamera() else if (state == null) recoverPendingMedia()
            // Home and launcher quick records add media to the same draft; saving remains an explicit tap.
            if (state == null && !attachmentTask.busy) when (intent.getStringExtra("startMedia")) {
                "camera" -> if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) camera() else requestPermissions(arrayOf(Manifest.permission.CAMERA), 21)
                "audio" -> if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startRecording() else requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 22)
                else -> Unit
            }
        }.onFailure { status.text = it.message; enabled(false) } }
    }
    private fun enabled(value: Boolean) { field.isEnabled = value; description.isEnabled = value; save.isEnabled = value && canSubmit(); renderDraftState() }
    private fun renderDraftState() {
        draftState.text = MoteI18n.text(if (field.text.isNotBlank() || attachments.length() > 0 || origin.optString("text").isNotBlank() || description.text.isNotBlank()) "未保存的草稿" else "文字、照片或录音")
        recordingNote.visibility = if (recorder != null) android.view.View.VISIBLE else android.view.View.GONE
        mediaActions.forEach { it.isEnabled = ready && !task.busy && !attachmentTask.busy && (recorder == null || it === microphone) }
    }
    private fun canSubmit() = recorder == null && (field.text.isNotBlank() || attachments.length() > 0 || origin.optString("text").isNotBlank())
    private fun persist() {
        val text = field.text.toString(); val files = JSONArray(attachments.toString()); val source = JSONObject(origin.toString()); val noteDescription = description.text.toString(); val presentation = originPresentation?.let { JSONObject(it.toString()) }
        save.isEnabled = canSubmit() && !task.busy && !attachmentTask.busy
        renderDraftState()
        io.execute { runCatching { notes.edit(text, files, source, noteDescription, presentation) }.onFailure { error -> runOnUiThread { status.text = error.message } } }
    }
    private fun pick(mime: String, request: Int) {
        @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true), request)
    }
    private fun camera() {
        runCatching {
            val directory = File(filesDir, "record-pending").apply { mkdirs() }
            val file = File.createTempFile("photo-", ".jpg", directory); cameraPath = file.absolutePath
            val descriptor = mediaDescriptor(file, "image/jpeg")
            task.start("", {}, { notes.holdMedia(descriptor) }) { outcome -> outcome.onSuccess {
                val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.record-files", file)
                @Suppress("DEPRECATION") startActivityForResult(Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION), 13)
            }.onFailure { file.delete(); status.text = it.message } }
        }.onFailure { cameraPath?.let { File(it).delete() }; cameraPath = null; status.text = it.message }
    }
    override fun onSaveInstanceState(out: Bundle) { cameraPath?.let { out.putString("cameraPath", it) }; out.putBoolean("cameraResultReady", cameraResultReady); out.putBoolean("originExpanded",originExpanded); super.onSaveInstanceState(out) }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (results.firstOrNull() != PackageManager.PERMISSION_GRANTED) { status.text = MoteI18n.text("权限未授予"); return }
        if (requestCode == 21) camera() else if (requestCode == 22) startRecording()
    }
    @Suppress("DEPRECATION") override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK) { if (requestCode == 13) { cameraPath?.let { path -> File(path).delete(); io.execute { notes.finishMedia(mediaDescriptor(File(path), "image/jpeg").getString("id")) } }; cameraPath = null }; return }
        if (requestCode == 13) {
            cameraResultReady = true; stageCamera()
        } else if (requestCode == 11 || requestCode == 12) {
            val uris = data?.clipData?.let { clip -> (0 until clip.itemCount).map { clip.getItemAt(it).uri } } ?: listOfNotNull(data?.data)
            stageUris(uris)
        }
    }
    private fun mediaDescriptor(file: File, mime: String) = JSONObject().put("id", UUID.nameUUIDFromBytes(file.name.toByteArray()).toString()).put("path", file.absolutePath).put("name", file.name).put("mime", mime)
    private fun stageCamera() { cameraPath?.let(::File)?.takeIf { it.isFile }?.let { stagePending(mediaDescriptor(it, "image/jpeg")) } }
    private fun stagePending(item: JSONObject) {
        val file = File(item.getString("path"))
        require(file.canonicalFile.parentFile == File(filesDir, "record-pending").canonicalFile)
        stage({ file.inputStream().use(::readBounded) }, item.getString("name"), item.getString("mime"), attachmentId = item.getString("id"), onStored = {
            file.delete(); notes.finishMedia(item.getString("id"))
            runOnUiThread { if (cameraPath == file.absolutePath) { cameraPath = null; cameraResultReady = false } }
        })
    }
    private fun recoverPendingMedia() {
        val pending = notes.pendingMedia()
        if (!attachmentTask.busy && pending.length() > 0) {
            val first = pending.getJSONObject(0)
            if (File(first.getString("path")).length() > 0) stagePending(first)
        }
    }
    private fun stageUris(uris: List<Uri>) {
        if (uris.isEmpty()) return
        enabled(false)
        attachmentTask.start("", {}, {
            require(uris.size <= 10 - notes.draft().getJSONArray("attachments").length())
            val added = uris.map { uri ->
                require(uri.scheme == "content")
                var name = "attachment"; contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) name = it.getString(0) ?: name }
                val bytes = contentResolver.openInputStream(uri)!!.use { input -> readBounded(input) }
                notes.stage(bytes, name, contentResolver.getType(uri) ?: "application/octet-stream")
            }
            val draft = notes.draft(); val files = draft.getJSONArray("attachments"); require(files.length() + added.size <= 10); added.forEach { files.put(it) }; notes.edit(draft.getString("text"), files, draft.getJSONObject("origin"), draft.optString("description"), draft.optJSONObject("originPresentation")); files
        }) { result -> enabled(true); result.onSuccess { items -> attachments = items; renderAttachments() }.onFailure { status.text = it.message } }
    }
    private fun readBounded(input: java.io.InputStream): ByteArray {
        val out = java.io.ByteArrayOutputStream(); val buffer = ByteArray(65536)
        while (true) { val n = input.read(buffer); if (n < 0) break; require(out.size() + n <= CentralAttachments.MAX_BYTES); out.write(buffer, 0, n) }; return out.toByteArray()
    }
    private fun stage(bytes: () -> ByteArray, name: String, mime: String, attachmentId: String? = null, onStored: () -> Unit = {}): Boolean {
        enabled(false); return attachmentTask.start("", {}, { val added = notes.stage(bytes(), name, mime, attachmentId); val draft = notes.draft(); val files = draft.getJSONArray("attachments"); if ((0 until files.length()).none { files.getJSONObject(it).getString("id") == added.getString("id") }) { require(files.length() < 10); files.put(added) }; notes.edit(draft.getString("text"), files, draft.getJSONObject("origin"), draft.optString("description"), draft.optJSONObject("originPresentation")); onStored(); files }) { result -> enabled(true); result.onSuccess { attachments = it; renderAttachments(); recoverPendingMedia() }.onFailure { status.text = it.message; renderAttachments() } }
    }
    private fun renderAttachments() {
        save.isEnabled = ready && canSubmit() && !task.busy && !attachmentTask.busy
        renderDraftState()
        attachmentsView.removeAllViews()
        originView.removeAllViews()
        val hasOrigin = origin.optString("text").isNotBlank()
        field.hint = MoteI18n.text(if(hasOrigin) "我的补充" else "记下此刻的想法…")
        (window.decorView.findViewWithTag<android.view.View>("detail-title") as? TextView)?.text = MoteI18n.text(if(hasOrigin) if(origin.optString("kind")=="conversation") "保存为记录" else "保存分享" else "随手记")
        if (origin.optString("text").isNotBlank()) {
            val title = MoteI18n.text(if (origin.optString("kind") == "conversation") "对话摘录" else "引用原文")
            val quote = TextView(this).apply { tag = "record-origin-fulltext"; text = NativeConversationQuote.display(origin, originPresentation); MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this,NativeColorRole.INK); setTextIsSelectable(true); visibility = if(originExpanded) android.view.View.VISIBLE else android.view.View.GONE }
            val separation = TextView(this).apply { text = MoteI18n.text("引用与我的补充分开保存"); MoteUi.type(this,NativeFontRole.META); MoteUi.textColor(this,NativeColorRole.MUTED); visibility = quote.visibility }
            originView.addView(TextView(this).apply {
                tag = "record-origin-toggle"; text = title + if(originExpanded) " ▾" else " ▸"; contentDescription = title
                MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED)
                minHeight = moteDp(48); gravity = Gravity.CENTER_VERTICAL; isFocusable = true
                setOnClickListener { originExpanded = !originExpanded; quote.visibility = if (originExpanded) android.view.View.VISIBLE else android.view.View.GONE; separation.visibility = quote.visibility; text = title + if (originExpanded) " ▾" else " ▸" }
            })
            originView.addView(quote)
            originView.addView(separation)
        }
        val pending = notes.pendingMedia()
        for (index in 0 until pending.length()) {
            val item = pending.getJSONObject(index)
            attachmentsView.addView(MoteUi.button(Button(this).apply { text = MoteI18n.text("重试附件") + " · " + item.getString("name"); setOnClickListener { if (!attachmentTask.busy) stagePending(item) } }))
            attachmentsView.addView(MoteUi.button(Button(this).apply { text = MoteI18n.text("移除附件"); setOnClickListener { File(item.getString("path")).delete(); io.execute { notes.finishMedia(item.getString("id")); runOnUiThread { renderAttachments() } } } }))
        }
        for (index in 0 until attachments.length()) {
            val item = attachments.getJSONObject(index)
            val row = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
            row.addView(TextView(this).apply { text = NativeRecordAttachmentLabels.generatedKind(item.getString("id"), item.getString("name"), item.getString("mime"))?.let { MoteI18n.text(it) } ?: item.getString("name"); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; MoteUi.type(this, NativeFontRole.BODY) }, LinearLayout.LayoutParams(0, -2, 1f))
            if (item.getString("mime").startsWith("audio/")) row.addView(MoteUi.button(Button(this).apply { text = MoteI18n.text("播放"); setOnClickListener { preview(item) } }))
            row.addView(MoteUi.button(Button(this).apply { text = MoteI18n.text("移除"); setOnClickListener { attachments = JSONArray((0 until attachments.length()).filter { it != index }.map { attachments.getJSONObject(it) }); persist(); renderAttachments() } }))
            attachmentsView.addView(row)
        }
    }
    private fun preview(item: JSONObject) {
        player?.release(); val temp = File.createTempFile("record-preview-", ".audio", cacheDir)
        runCatching { temp.writeBytes(notes.bytes(item.getString("id"))); player = MediaPlayer().apply { setDataSource(temp.absolutePath); setOnCompletionListener { release(); player = null; temp.delete() }; prepare(); start() }; temp.delete() }.onFailure { temp.delete(); status.text = it.message }
    }
    @Suppress("DEPRECATION") private fun startRecording() {
        runCatching {
            val directory = File(filesDir, "record-pending").apply { mkdirs() }; val file = File.createTempFile("record-microphone-", ".m4a", directory); recordingFile = file
            notes.holdMedia(mediaDescriptor(file, "audio/mp4"))
            recorder = MediaRecorder().apply { setAudioSource(MediaRecorder.AudioSource.MIC); setOutputFormat(MediaRecorder.OutputFormat.MPEG_4); setAudioEncoder(MediaRecorder.AudioEncoder.AAC); setMaxFileSize(CentralAttachments.MAX_BYTES.toLong()); setOutputFile(file.absolutePath); prepare(); start() }
            microphone.text = "■\n" + MoteI18n.text("停止录音"); microphone.contentDescription = MoteI18n.text("停止录音"); save.isEnabled = false
            renderDraftState()
        }.onFailure { recorder?.release(); recorder = null; recordingFile?.delete(); recordingFile = null; status.text = it.message }
    }
    private fun stopRecording() {
        val active = recorder ?: return; recorder = null
        val file = recordingFile; recordingFile = null
        val stopped = runCatching { active.stop() }; active.release(); microphone.text = "♩\n" + MoteI18n.text("录音"); microphone.contentDescription = MoteI18n.text("录音"); save.isEnabled = ready && canSubmit()
        renderDraftState()
        if (file == null) return
        if (stopped.isSuccess && file.length() > 0) stagePending(mediaDescriptor(file, "audio/mp4")) else { file.delete(); io.execute { notes.finishMedia(mediaDescriptor(file, "audio/mp4").getString("id")) } }
    }
    private fun importIntent(value: Intent, replaceExisting: Boolean = false) {
        val conversation = this is ConversationRecordEditorActivity && value.hasExtra("recordText")
        if (!conversation && value.action !in setOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) return
        if (conversation && value.getStringExtra("recordText").orEmpty().length > 100000) {
            status.text = MoteI18n.text("文字目前最多 100000 字符。"); return
        }
        if (conversation && listOf(value.getStringExtra("conversationId"), value.getStringExtra("turnId")).any { it.isNullOrBlank() || it.length > 200 }) {
            status.text = MoteI18n.text("请求的资源不存在或已删除。"); return
        }
        if (conversation && (value.getStringExtra("quoteOrigin").isNullOrBlank() || value.getStringExtra("quoteQuestion") == null || value.getStringArrayListExtra("quoteCitations") == null || !value.getStringExtra("recordText").orEmpty().startsWith(value.getStringExtra("quoteQuestion").orEmpty() + "\n\n"))) {
            status.text = MoteI18n.text("请求的资源不存在或已删除。"); return
        }
        val existing = field.text.isNotBlank() || description.text.isNotBlank() || attachments.length() > 0 || origin.optString("text").isNotBlank()
        if (existing && !replaceExisting) {
            MoteDialogBuilder(this).setTitle(MoteI18n.text("已有未保存草稿"))
                .setNegativeButton(MoteI18n.text("继续编辑"), null)
                .setPositiveButton(MoteI18n.text("替换草稿")) { _, _ -> importIntent(value, true) }.show()
            return
        }
        ready = false; attachments = JSONArray(); originPresentation = null; originExpanded = true; field.setText(""); description.setText(""); ready = true
        val text = if (conversation) value.getStringExtra("recordText").orEmpty() else value.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty()
        if (conversation) {
            origin = JSONObject().put("kind", "conversation").put("text", text).put("conversationId", value.getStringExtra("conversationId"))
            origin.put("messageIds", JSONArray().put(value.getStringExtra("turnId")))
            val question = value.getStringExtra("quoteQuestion")
            val citations = value.getStringArrayListExtra("quoteCitations")
            if (question != null && citations != null && text.startsWith(question + "\n\n")) originPresentation = NativeConversationQuote.snapshot(text, question, citations, origin.getString("conversationId"), origin.getJSONArray("messageIds").getString(0), requireNotNull(value.getStringExtra("quoteOrigin")))
            field.setText("")
        } else {
            origin = JSONObject().put("kind", "share").put("text", text.take(100000))
            callingPackage?.let { origin.put("app", it.take(300)) }
            value.data?.takeIf { it.scheme in setOf("http", "https") }?.let { origin.put("url", it.toString().take(4000)) }
        }
        persist(); renderAttachments()
        @Suppress("DEPRECATION") val uris = if (value.action == Intent.ACTION_SEND_MULTIPLE) value.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty() else listOfNotNull(value.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        stageUris(uris)
    }
    private fun submit() {
        if (!ready || task.busy || attachmentTask.busy || recorder != null) return
        if (notes.pendingMedia().length() > 0) { status.text = MoteI18n.text("请先处理未保存的附件"); return }
        val text = field.text.toString(); val files = JSONArray(attachments.toString()); val source = JSONObject(origin.toString()); val noteDescription = description.text.toString(); val presentation = originPresentation?.let { JSONObject(it.toString()) }; enabled(false)
        task.start("", {}, {
            notes.submit(text, files, source, noteDescription, presentation, intent.getBooleanExtra("firstUse", false))
        }) { result -> result.onSuccess { setResult(RESULT_OK, Intent().putExtra("recordId", it)); finish() }.onFailure { enabled(true); status.text = it.message } }
    }
    override fun onPause() { if (recorder != null) stopRecording(); player?.release(); player = null; super.onPause() }
    override fun onDestroy() { notes.close(); super.onDestroy() }
}
/** Only the app can launch a conversation-origin editor; system sharing uses the exported base activity. */
class ConversationRecordEditorActivity : RecordEditorActivity()
internal fun android.app.Activity.openRecordEditor(text: String? = null, conversationId: String? = null, turnId: String? = null, question: String? = null, citations: List<String>? = null, quoteOrigin: String? = null, media: String? = null) {
    val editor = if (text == null) RecordEditorActivity::class.java else ConversationRecordEditorActivity::class.java
    startActivity(Intent(this, editor).apply { putExtra("firstUse",(this@openRecordEditor as? MainActivity)?.isFirstUseRecordEntry() ?: this@openRecordEditor.intent.getBooleanExtra("firstUse",false)); text?.let { putExtra("recordText", it) }; conversationId?.let { putExtra("conversationId", it) }; turnId?.let { putExtra("turnId", it) }; question?.let { putExtra("quoteQuestion", it) }; citations?.let { putStringArrayListExtra("quoteCitations", ArrayList(it)) }; quoteOrigin?.let { putExtra("quoteOrigin",it) }; media?.let { putExtra("startMedia", it) } })
}
