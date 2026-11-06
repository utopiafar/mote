package dev.mote.collector

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.*
import dev.mote.collector.plugins.NotesEditor
import dev.mote.collector.recording.RecordingPhase
import dev.mote.collector.recording.RecordingService
import dev.mote.collector.recording.RecordingSession
import dev.mote.collector.recording.mergeRecordedAttachments
import dev.mote.collector.plugins.NotesPlugin
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import dev.mote.collector.ui.MoteIconButtonStyle
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** One explicit Save boundary for all manual and shared records. */
open class RecordEditorActivity : MoteActivity() {
    private lateinit var field: EditText
    private lateinit var description: EditText
    private lateinit var describeToggle: TextView
    private lateinit var status: TextView
    private lateinit var attachmentsView: LinearLayout
    private lateinit var save: Button
    private lateinit var clearButton: Button
    private lateinit var microphone: ImageButton
    private lateinit var undoToast: View
    private val mediaActions = mutableListOf<ImageButton>()
    private lateinit var recordingPanel: LinearLayout
    private lateinit var recordingTools: LinearLayout
    private lateinit var recordingNotice: View
    private lateinit var recordingTime: TextView
    private lateinit var recordingWave: RecordingWave
    private lateinit var recordingPause: ImageButton
    private val recordingHandler = Handler(Looper.getMainLooper())
    private var editorStarted = false
    private var editorResumed = false
    private var pendingRecordingStart = false
    private var permissionRequested = false
    private var wasRecording = false
    private var refreshingRecording = false
    private var recordingRecoveryBlocked = false
    private var saveAfterRecording = false
    private val recordingObserver: () -> Unit = { renderRecording() }
    private val recordingTick = object : Runnable {
        override fun run() {
            if (!::recordingTime.isInitialized) return
            val elapsed = RecordingSession.snapshot().elapsedMs / 1000
            recordingTime.text = "%02d:%02d".format(elapsed / 60, elapsed % 60)
            recordingWave.invalidate()
            if (RecordingSession.snapshot().active && editorResumed) recordingHandler.postDelayed(this, 180)
        }
    }
    private var attachments = JSONArray()
    private var origin = JSONObject().put("kind", "manual")
    private var originPresentation: JSONObject? = null
    private var undoArmed = false
    @Volatile private var clearedSnapshot: JSONObject? = null
    private var ready = false
    private var describeExpanded = false
    private lateinit var notes: NotesEditor
    private val io get() = notes.io
    private lateinit var task: UiTask
    private lateinit var attachmentTask: UiTask
    private var player: MediaPlayer? = null
    private var cameraPath: String? = null
    private var cameraResultReady = false
    private val thumbnails = mutableMapOf<String, Bitmap>()
    private val audioMeta = mutableMapOf<String, String>()
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        notes = NotesPlugin.owner(applicationContext).view()
        cameraPath = state?.getString("cameraPath"); cameraResultReady = state?.getBoolean("cameraResultReady") ?: false
        pendingRecordingStart = state?.getBoolean("pendingRecordingStart")
            ?: (this is MicrophoneRecordEditorActivity && intent.getStringExtra("startMedia") == "audio")
        permissionRequested = state?.getBoolean("recordingPermissionRequested") ?: false
        saveAfterRecording = state?.getBoolean("saveAfterRecording") ?: false
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        task = UiTask(this, io, ownsExecutor = false)
        attachmentTask = UiTask(this, io, ownsExecutor = false)
        val root = NativeAppShell(this).apply { moteInsets() }

        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = moteDp(MoteTheme.controlHeight); setPadding(moteDp(6), 0, moteDp(12), 0) }
        header.addView(MoteComponents.iconButton(this, MoteGlyph.BACK) { finish() })
        header.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        clearButton = MoteComponents.button(this, MoteI18n.text("清空"), MoteUi.ButtonRole.TEXT) { clearDraft() }
        MoteUi.textColor(clearButton, NativeColorRole.MUTED)
        header.addView(clearButton)
        save = MoteComponents.button(this, MoteI18n.text("保存"), MoteUi.ButtonRole.PRIMARY) { submit() }
        MoteUi.type(save, 13, medium = true)
        NativePresentationStyles.bind(save, "record-save") { (it as Button).apply { minWidth = moteDp(58); minimumWidth = minWidth; minHeight = moteDp(34); minimumHeight = minHeight; setPadding(moteDp(12), 0, moteDp(12), 0) } }
        header.addView(save, LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(6) })
        root.header(header)

        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, moteDp(6), 0, moteDp(16)) }
        field = EditText(this).apply {
            hint = MoteI18n.text("记录"); contentDescription = MoteI18n.text("正在想什么")
            gravity = Gravity.TOP; inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
            filters = arrayOf(android.text.InputFilter.LengthFilter(100000)); MoteUi.field(this)
            NativePresentationStyles.bind(this, "record-editor-lines") { (it as EditText).apply { background = null; setPadding(0, moteDp(6), 0, 0) } }
        }
        body.addView(field, LinearLayout.LayoutParams(-1, -2).apply { leftMargin = moteDp(20); rightMargin = moteDp(20) })
        attachmentsView = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        body.addView(attachmentsView, LinearLayout.LayoutParams(-1, -2).apply { leftMargin = moteDp(16); rightMargin = moteDp(16); topMargin = moteDp(16) })
        status = TextView(this).apply { MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED) }
        body.addView(status, LinearLayout.LayoutParams(-1, -2).apply { leftMargin = moteDp(20); rightMargin = moteDp(20); topMargin = moteDp(10) })
        root.content(ScrollView(this).apply { isFillViewport = true; addView(body) })

        val footer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        undoToast = MoteComponents.toast(this, MoteI18n.text("已清空"), MoteI18n.text("撤销")) { undoClear() }
        footer.addView(undoToast, LinearLayout.LayoutParams(-1, -2).apply { leftMargin = moteDp(16); rightMargin = moteDp(16); bottomMargin = moteDp(12) })
        undoToast.visibility = View.GONE
        val tools = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; isBaselineAligned = false; setPadding(moteDp(8), moteDp(4), moteDp(8), moteDp(4)) }; recordingTools = tools
        fun tool(glyph: MoteGlyph, label: String, run: () -> Unit): ImageButton =
            MoteComponents.iconButton(this, glyph, label, MoteIconButtonStyle.PLAIN).also { button ->
                button.setOnClickListener { if (ready && !task.busy && !attachmentTask.busy && (!RecordingSession.snapshot().active || button === microphone)) run() }
                mediaActions.add(button); tools.addView(button)
            }
        tool(MoteGlyph.CAMERA, MoteI18n.text("拍照")) { if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) camera() else requestPermissions(arrayOf(Manifest.permission.CAMERA), 21) }
        tool(MoteGlyph.PHOTO, MoteI18n.text("照片")) { pick("image/*", 11) }
        microphone = tool(MoteGlyph.MIC, MoteI18n.text("录音")) { pendingRecordingStart = true; maybeStartRecording() }
        tool(MoteGlyph.FILE, MoteI18n.text("文件")) { pick("*/*", 12) }
        footer.addView(View(this).apply { MoteUi.backgroundColor(this, NativeColorRole.HAIR); layoutParams = LinearLayout.LayoutParams(-1, moteDp(MoteTheme.borderWidth)) })
        footer.addView(tools)
        recordingPanel = createRecordingPanel()
        footer.addView(recordingPanel)
        root.footer(footer)
        setContentView(root)

        description = EditText(this).apply {
            tag = "record-description"; hint = MoteI18n.text("资料说明"); contentDescription = MoteI18n.text("资料说明")
            MoteUi.textInput(this, android.text.InputType.TYPE_CLASS_TEXT, multiline = true); filters = arrayOf(android.text.InputFilter.LengthFilter(12000)); MoteUi.field(this); minLines = 3
        }
        describeToggle = TextView(this).apply {
            tag = "record-describe-toggle"
            text = MoteI18n.text("资料说明"); contentDescription = MoteI18n.text("资料说明")
            MoteUi.type(this, NativeFontRole.SUPPORT, medium = true); MoteUi.textColor(this, NativeColorRole.ACCENT)
            val icon = getDrawable(MoteGlyph.PLUS.drawable)!!.mutate().apply { setTint(NativeColorRole.ACCENT.color()); setBounds(0, 0, moteDp(16), moteDp(16)) }
            setCompoundDrawablesRelative(icon, null, null, null); compoundDrawablePadding = moteDp(6)
            minHeight = moteDp(48); gravity = Gravity.CENTER_VERTICAL; isFocusable = true
            background = MoteUi.clickable(this@RecordEditorActivity, NativeColorRole.TRANSPARENT, NativeRadiusRole.CONTAINER, false)
            setPadding(moteDp(4), 0, moteDp(8), 0)
            setOnClickListener { describeExpanded = true; renderDescribe() }
        }
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
        task.start("", {}, {
            val recovery = runCatching { RecordingService.recover(applicationContext) }
            notes.draft() to recovery.isFailure
        }) { outcome -> outcome.onSuccess { (draft, recoveryFailed) ->
            recordingRecoveryBlocked = recoveryFailed
            if (recoveryFailed) status.text = MoteI18n.text("本机存储恢复失败")
            attachments = draft.getJSONArray("attachments"); origin = draft.getJSONObject("origin"); originPresentation = draft.optJSONObject("originPresentation"); field.setText(draft.getString("text")); description.setText(draft.optString("description")); ready = true; enabled(!attachmentTask.busy); renderAttachments()
            if (cameraResultReady) stageCamera() else if (state == null) recoverPendingMedia()
            // Home and launcher quick records add media to the same draft; saving remains an explicit tap.
            if (state == null && !attachmentTask.busy) when (intent.getStringExtra("startMedia")) {
                "camera" -> if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) camera() else requestPermissions(arrayOf(Manifest.permission.CAMERA), 21)
                else -> Unit
            }
            maybeStartRecording()
            renderRecording()
            submitAfterRecordingIfReady()
        }.onFailure { status.text = it.message; enabled(false) } }
    }
    private fun enabled(value: Boolean) { field.isEnabled = value; description.isEnabled = value; save.isEnabled = value && canSubmit(); renderDraftState() }
    private fun hasContent() = field.text.isNotBlank() || attachments.length() > 0 || origin.optString("text").isNotBlank() || description.text.isNotBlank()
    private fun renderDraftState() {
        clearButton.visibility = if (hasContent() && !RecordingSession.snapshot().active) View.VISIBLE else View.GONE
        mediaActions.forEach { it.isEnabled = ready && !task.busy && !attachmentTask.busy && !recordingRecoveryBlocked && (!RecordingSession.snapshot().active || it === microphone) }
        if (::describeToggle.isInitialized) renderDescribe()
    }
    private fun renderDescribe() {
        val expanded = describeExpanded
        attachmentsView.removeView(describeToggle); attachmentsView.removeView(description)
        attachmentsView.addView(describeToggle, LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(if (attachmentsView.childCount == 0) 0 else 10) })
        attachmentsView.addView(description, LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(if (attachmentsView.childCount == 1) 0 else 10) })
        val recording = RecordingSession.snapshot().active
        describeToggle.visibility = if (!recording && !expanded && hasContent()) View.VISIBLE else View.GONE
        description.visibility = if (!recording && expanded) View.VISIBLE else View.GONE
    }
    private fun canSubmit(): Boolean {
        val phase = RecordingSession.snapshot().phase
        return !saveAfterRecording && !refreshingRecording && !recordingRecoveryBlocked && phase != RecordingPhase.STOPPING &&
            (phase != RecordingPhase.IDLE || field.text.isNotBlank() || attachments.length() > 0 || origin.optString("text").isNotBlank())
    }
    private fun persist() {
        if (undoArmed || clearedSnapshot != null) { undoArmed = false; clearedSnapshot = null; undoToast.visibility = View.GONE }
        val text = field.text.toString(); val files = JSONArray(attachments.toString()); val source = JSONObject(origin.toString()); val noteDescription = description.text.toString(); val presentation = originPresentation?.let { JSONObject(it.toString()) }
        save.isEnabled = canSubmit() && !task.busy && !attachmentTask.busy
        renderDraftState()
        val recordingIds = if (RecordingSession.snapshot().active || wasRecording || refreshingRecording) RecordingSession.segmentIds else null
        io.execute { runCatching {
            val merged = if (recordingIds == null) files else mergeRecordedAttachments(files, notes.draft().getJSONArray("attachments"), recordingIds)
            notes.edit(text, merged, source, noteDescription, presentation)
        }.onFailure { error -> runOnUiThread { status.text = error.message } } }
    }
    /** Clear is the only way the one draft ends; the toast offers the single undo restore. */
    private fun clearDraft() {
        if (!ready || task.busy || attachmentTask.busy || RecordingSession.snapshot().active || refreshingRecording || undoArmed || clearedSnapshot != null) return
        undoArmed = true
        ready = false
        field.setText(""); description.setText(""); attachments = JSONArray()
        origin = JSONObject().put("kind", "manual"); originPresentation = null; describeExpanded = false
        ready = true; renderAttachments(); renderDescribe(); undoToast.visibility = View.VISIBLE
        io.execute { runCatching { notes.clearDraft() }.onSuccess { removed -> runOnUiThread { clearedSnapshot = if (undoArmed) JSONObject(removed.toString()) else null } }.onFailure { error -> runOnUiThread { status.text = error.message } } }
    }
    private fun undoClear() {
        val snapshot = clearedSnapshot ?: return
        undoArmed = false; clearedSnapshot = null; undoToast.visibility = View.GONE
        ready = false
        field.setText(snapshot.optString("text")); description.setText(snapshot.optString("description"))
        attachments = JSONArray(snapshot.optJSONArray("attachments")?.toString() ?: "[]")
        origin = snapshot.optJSONObject("origin")?.let { JSONObject(it.toString()) } ?: JSONObject().put("kind", "manual")
        originPresentation = snapshot.optJSONObject("originPresentation")?.let { JSONObject(it.toString()) }
        describeExpanded = description.text.isNotBlank()
        ready = true; renderAttachments(); renderDescribe()
        io.execute { runCatching { notes.restoreDraft(snapshot) }.onFailure { error -> runOnUiThread { status.text = error.message } } }
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
    override fun onSaveInstanceState(out: Bundle) {
        cameraPath?.let { out.putString("cameraPath", it) }
        out.putBoolean("cameraResultReady", cameraResultReady)
        out.putBoolean("pendingRecordingStart", pendingRecordingStart); out.putBoolean("recordingPermissionRequested", permissionRequested)
        out.putBoolean("saveAfterRecording", saveAfterRecording)
        super.onSaveInstanceState(out)
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode == 22) permissionRequested = false
        if (results.firstOrNull() != PackageManager.PERMISSION_GRANTED) { pendingRecordingStart = false; status.text = MoteI18n.text("权限未授予"); return }
        if (requestCode == 21) camera() else if (requestCode == 22) maybeStartRecording()
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
    private fun attachmentLabel(item: JSONObject) = NativeRecordAttachmentLabels.generatedKind(item.getString("id"), item.getString("name"), item.getString("mime"))?.let { MoteI18n.text(it) } ?: item.getString("name")
    private fun loadThumbnail(id: String, view: ImageView) {
        thumbnails[id]?.let { view.setImageBitmap(it); return }
        io.execute {
            val bitmap = runCatching { notes.bytes(id).let { bytes -> BitmapFactory.decodeByteArray(bytes, 0, bytes.size) } }.getOrNull()
            if (bitmap != null) { thumbnails[id] = bitmap; runOnUiThread { view.setImageBitmap(bitmap) } }
        }
    }
    private fun loadAudioMeta(item: JSONObject, view: TextView) {
        val id = item.getString("id")
        audioMeta[id]?.let { view.text = it; return }
        io.execute {
            val duration = runCatching {
                val temp = File.createTempFile("record-meta-", ".audio", cacheDir)
                try { temp.writeBytes(notes.bytes(id)); MediaMetadataRetriever().apply { setDataSource(temp.absolutePath) }.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLong() } finally { temp.delete() }
            }.getOrNull()
            if (duration != null && duration > 0) {
                val label = "%d:%02d".format(duration / 60000, duration / 1000 % 60)
                audioMeta[id] = label; runOnUiThread { view.text = label }
            }
        }
    }
    private fun borderedRow(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
        minimumHeight = moteDp(56); setPadding(moteDp(6), moteDp(4), moteDp(4), moteDp(4))
        NativePresentationStyles.bind(this, "record-attachment-row") { it.background = MoteUi.shape(context, NativeColorRole.SURFACE, NativeRadiusRole.CONTAINER, true, NativeColorRole.HAIR) }
        outlineProvider = android.view.ViewOutlineProvider.BACKGROUND; clipToOutline = true
    }
    private fun renderAttachments() {
        save.isEnabled = ready && canSubmit() && !task.busy && !attachmentTask.busy
        renderDraftState()
        attachmentsView.removeAllViews()
        var siblings = 0
        fun gap() = LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(if (siblings++ == 0) 0 else 10) }
        val pending = notes.pendingMedia()
        for (index in 0 until pending.length()) {
            val item = pending.getJSONObject(index)
            attachmentsView.addView(borderedRow().apply {
                addView(MoteComponents.icon(context, MoteGlyph.FILE), LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(8); marginEnd = moteDp(8) })
                addView(TextView(context).apply { text = item.getString("name"); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK) }, LinearLayout.LayoutParams(0, -2, 1f))
                addView(MoteComponents.button(context, MoteI18n.text("重试附件"), MoteUi.ButtonRole.TEXT) { if (!attachmentTask.busy) stagePending(item) })
                addView(MoteComponents.button(context, MoteI18n.text("移除附件"), MoteUi.ButtonRole.TEXT) { File(item.getString("path")).delete(); io.execute { notes.finishMedia(item.getString("id")); runOnUiThread { renderAttachments() } } })
            }, gap())
        }
        for (index in 0 until attachments.length()) {
            val item = attachments.getJSONObject(index)
            val mime = item.getString("mime")
            when {
                mime.startsWith("image/") && NativeRecordAttachmentLabels.generatedKind(item.getString("id"), item.getString("name"), mime) == "照片" -> attachmentsView.addView(FrameLayout(this).apply {
                    NativePresentationStyles.bind(this, "record-photo") { it.background = MoteUi.shape(context, NativeColorRole.SURFACE, NativeRadiusRole.CONTROL, true, NativeColorRole.HAIR) }
                    outlineProvider = android.view.ViewOutlineProvider.BACKGROUND; clipToOutline = true
                    val image = ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP; contentDescription = attachmentLabel(item) }
                    addView(image, FrameLayout.LayoutParams(-1, -1)); loadThumbnail(item.getString("id"), image)
                    val remove = ImageButton(context).apply {
                        minimumWidth = moteDp(48); minimumHeight = moteDp(48)
                        scaleType = ImageView.ScaleType.FIT_CENTER; setPadding(moteDp(22), moteDp(10), moteDp(10), moteDp(22))
                        NativePresentationStyles.bind(this, "record-photo-remove") { button ->
                            (button as ImageButton).imageTintList = android.content.res.ColorStateList.valueOf(android.graphics.Color.WHITE)
                            button.background = android.graphics.drawable.LayerDrawable(arrayOf(
                                MoteUi.shape(context, android.graphics.Color.argb(158, 28, 27, 26), 12, false)
                            )).apply { setLayerInset(0, moteDp(18), moteDp(6), moteDp(6), moteDp(18)) }
                        }
                        setImageResource(MoteGlyph.CLOSE.drawable)
                        contentDescription = MoteI18n.text("移除"); setOnClickListener {
                            attachments = JSONArray((0 until attachments.length()).filter { it != index }.map { attachments.getJSONObject(it) }); persist(); renderAttachments()
                        }
                    }
                    addView(remove, FrameLayout.LayoutParams(moteDp(48), moteDp(48), Gravity.TOP or Gravity.END))
                }, LinearLayout.LayoutParams(moteDp(148), moteDp(112)).apply { topMargin = moteDp(if (siblings++ == 0) 0 else 10) })
                mime.startsWith("audio/") -> attachmentsView.addView(borderedRow().apply {
                    addView(MoteComponents.iconButton(context, MoteGlyph.PLAY, MoteI18n.text("播放"), MoteIconButtonStyle.PLAIN) { preview(item) })
                    addView(LinearLayout(context).apply {
                        orientation = LinearLayout.VERTICAL
                        addView(TextView(context).apply { text = attachmentLabel(item); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; MoteUi.type(this, NativeFontRole.BODY, medium = true); MoteUi.textColor(this, NativeColorRole.INK) })
                        addView(TextView(context).apply { text = " "; MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED); tag = "record-audio-duration"; loadAudioMeta(item, this) })
                    }, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = moteDp(8) })
                    addView(MoteComponents.iconButton(context, MoteGlyph.CLOSE, MoteI18n.text("移除"), MoteIconButtonStyle.MUTED) {
                        attachments = JSONArray((0 until attachments.length()).filter { it != index }.map { attachments.getJSONObject(it) }); persist(); renderAttachments()
                    })
                }, gap())
                else -> attachmentsView.addView(borderedRow().apply {
                    addView(MoteComponents.icon(context, MoteGlyph.FILE), LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(8); marginEnd = moteDp(8) })
                    addView(TextView(context).apply { text = attachmentLabel(item); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; MoteUi.type(this, NativeFontRole.BODY, medium = true); MoteUi.textColor(this, NativeColorRole.INK) }, LinearLayout.LayoutParams(0, -2, 1f))
                    addView(MoteComponents.iconButton(context, MoteGlyph.CLOSE, MoteI18n.text("移除"), MoteIconButtonStyle.MUTED) {
                        attachments = JSONArray((0 until attachments.length()).filter { it != index }.map { attachments.getJSONObject(it) }); persist(); renderAttachments()
                    })
                }, gap())
            }
        }
        renderDescribe()
    }
    private fun preview(item: JSONObject) {
        player?.release(); val temp = File.createTempFile("record-preview-", ".audio", cacheDir)
        runCatching { temp.writeBytes(notes.bytes(item.getString("id"))); player = MediaPlayer().apply { setDataSource(temp.absolutePath); setOnCompletionListener { release(); player = null; temp.delete() }; prepare(); start() }; temp.delete() }.onFailure { temp.delete(); status.text = it.message }
    }
    private fun maybeStartRecording() {
        if (!pendingRecordingStart || !editorResumed || !ready || notes.closed || isFinishing || RecordingSession.snapshot().active || recordingRecoveryBlocked || saveAfterRecording) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            if (!permissionRequested) { permissionRequested = true; requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 22) }
            return
        }
        pendingRecordingStart = false
        RecordingService.startFromEditor(this) { !notes.closed }
    }

    private fun createRecordingPanel(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(moteDp(20), moteDp(18), moteDp(20), moteDp(16))
        MoteUi.backgroundColor(this, NativeColorRole.SURFACE)
        recordingNotice = LinearLayout(context).apply {
            tag = "recording-paused-notice"; orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(moteDp(12), 0, moteDp(12), 0); minimumHeight = moteDp(48)
            NativePresentationStyles.bind(this, "recording-notice") { it.background = MoteUi.shape(context, NativeColorRole.SURFACE, NativeRadiusRole.PILL, true, NativeColorRole.BORDER) }
            addView(MoteComponents.icon(context, MoteGlyph.PAUSE), LinearLayout.LayoutParams(moteDp(20), moteDp(20)))
            addView(TextView(context).apply { text = MoteI18n.text("录音已暂停"); MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }, LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(12) })
        }
        addView(recordingNotice, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(16) })
        val meter = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        recordingTime = TextView(context).apply { tag = "recording-time"; MoteUi.type(this, 34, medium = true); MoteUi.textColor(this, NativeColorRole.INK); text = "00:00" }
        meter.addView(recordingTime, LinearLayout.LayoutParams(moteDp(104), -2))
        recordingWave = RecordingWave(context).apply { tag = "recording-wave" }
        meter.addView(recordingWave, LinearLayout.LayoutParams(0, moteDp(40), 1f).apply { marginStart = moteDp(16) })
        addView(meter)
        val actions = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val close = MoteComponents.iconButton(context, MoteGlyph.DOWN, MoteI18n.text("收起")) { finish() }
        actions.addView(close, LinearLayout.LayoutParams(moteDp(48), moteDp(64)))
        actions.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
        val stop = MoteComponents.iconButton(context, dev.mote.collector.ui.MoteIconButtonSpec(MoteGlyph.STOP, "停止录音", MoteIconButtonStyle.SOLID, 64)) { RecordingService.command(this@RecordEditorActivity, RecordingService.ACTION_STOP) }
        stop.tag = "recording-stop"; actions.addView(stop, LinearLayout.LayoutParams(moteDp(64), moteDp(64)))
        actions.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
        recordingPause = MoteComponents.iconButton(context, MoteGlyph.PAUSE, MoteI18n.text("暂停录音"), MoteIconButtonStyle.FILLED) {
            val action = if (RecordingSession.snapshot().phase == RecordingPhase.PAUSED) RecordingService.ACTION_RESUME else RecordingService.ACTION_PAUSE
            RecordingService.command(this@RecordEditorActivity, action)
        }
        recordingPause.tag = "recording-pause"; actions.addView(recordingPause, LinearLayout.LayoutParams(moteDp(48), moteDp(48)))
        addView(actions, LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(16) })
        visibility = View.GONE
    }

    private fun renderRecording() {
        if (!::recordingPanel.isInitialized) return
        val current = RecordingSession.snapshot()
        recordingPanel.visibility = if (current.active) View.VISIBLE else View.GONE
        if (wasRecording != current.active) {
            val recording = current.active
            NativePresentationStyles.bind(field, "recording-editor-type") { view ->
                (view as EditText).apply {
                    textSize = if (recording) 16f else NativeFontRole.BODY.size().toFloat()
                    setLineSpacing(0f, if (recording) 1.3f else MoteTheme.lineBody)
                }
            }
        }
        if (!wasRecording && current.active) {
            (getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).hideSoftInputFromWindow(field.windowToken, 0)
            field.clearFocus()
            description.clearFocus()
            recordingPanel.isFocusableInTouchMode = true
            recordingPanel.requestFocus()
        }
        if (wasRecording && !current.active && ready) {
            refreshingRecording = true
            io.execute {
                val recovery = runCatching { RecordingService.recover(applicationContext) }
                val loaded = runCatching { notes.draft().getJSONArray("attachments") }
                runOnUiThread {
                    refreshingRecording = false
                    recordingRecoveryBlocked = recovery.isFailure
                    if (recordingRecoveryBlocked) status.text = MoteI18n.text("本机存储恢复失败")
                    loaded.onSuccess { attachments = it; renderAttachments() }.onFailure { status.text = it.message }
                    if (loaded.isFailure || current.error != null) saveAfterRecording = false
                    enabled(!task.busy && !attachmentTask.busy)
                    submitAfterRecordingIfReady()
                    if (!editorStarted && !saveAfterRecording) RecordingSession.remove(recordingObserver)
                }
            }
        }
        wasRecording = current.active
        recordingTools.visibility = if (current.active) View.GONE else View.VISIBLE
        recordingNotice.visibility = if (current.phase == RecordingPhase.PAUSED) View.VISIBLE else View.GONE
        recordingPause.setImageResource(if (current.phase == RecordingPhase.PAUSED) MoteGlyph.PLAY.drawable else MoteGlyph.PAUSE.drawable)
        recordingPause.contentDescription = MoteI18n.text(if (current.phase == RecordingPhase.PAUSED) "继续录音" else "暂停录音")
        recordingPause.isEnabled = current.phase == RecordingPhase.RECORDING || current.phase == RecordingPhase.PAUSED
        current.error?.let { status.text = MoteI18n.text(it) }
        if (ready) { save.isEnabled = canSubmit() && !task.busy && !attachmentTask.busy; renderDraftState() }
        recordingHandler.removeCallbacks(recordingTick)
        if (current.active && editorResumed) recordingTick.run()
    }

    private class RecordingWave(context: android.content.Context) : View(context) {
        private val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
        override fun onDraw(canvas: android.graphics.Canvas) {
            super.onDraw(canvas)
            paint.strokeWidth = context.moteDp(3).toFloat(); paint.strokeCap = android.graphics.Paint.Cap.ROUND
            val step = context.moteDp(6).toFloat(); val center = height / 2f
            val levels = synchronized(RecordingSession.lock) { RecordingSession.levels.toList() }
            var x = paint.strokeWidth / 2; var index = 0
            while (x < width && index < 30) {
                val used = index < levels.size
                paint.color = if (used) NativeColorRole.INK.color() else NativeColorRole.BORDER.color()
                val half = context.moteDp(3) + (if (used) levels[index] * context.moteDp(15) else 0f)
                canvas.drawLine(x, center - half, x, center + half, paint)
                x += step; index++
            }
        }
    }
    private fun submitAfterRecordingIfReady() {
        if (!saveAfterRecording || !ready || notes.closed || task.busy || attachmentTask.busy || refreshingRecording || RecordingSession.snapshot().active) return
        saveAfterRecording = false
        if (!editorStarted) RecordingSession.remove(recordingObserver)
        enabled(true)
        if (recordingRecoveryBlocked || RecordingSession.snapshot().error != null) return
        submit()
    }

    private fun submit() {
        if (!ready || notes.closed || task.busy || attachmentTask.busy || refreshingRecording || recordingRecoveryBlocked) return
        if (RecordingSession.snapshot().active) {
            if (RecordingSession.snapshot().phase == RecordingPhase.STOPPING || saveAfterRecording) return
            saveAfterRecording = true
            save.isEnabled = false
            RecordingService.command(this, RecordingService.ACTION_STOP)
            return
        }
        if (notes.pendingMedia().length() > 0) { status.text = MoteI18n.text("请先处理未保存的附件"); return }
        val text = field.text.toString(); val files = JSONArray(attachments.toString()); val source = JSONObject(origin.toString()); val noteDescription = description.text.toString(); val presentation = originPresentation?.let { JSONObject(it.toString()) }; enabled(false)
        task.start("", {}, {
            notes.submit(text, files, source, noteDescription, presentation, intent.getBooleanExtra("firstUse", false))
        }) { result -> result.onSuccess {
            Toast.makeText(this, MoteI18n.text("已保存"), Toast.LENGTH_SHORT).show()
            setResult(RESULT_OK, Intent().putExtra("recordId", it)); finish()
        }.onFailure { enabled(true); status.text = it.message } }
    }
    override fun onStart() { super.onStart(); editorStarted = true; RecordingSession.observe(recordingObserver) }
    override fun onResume() { super.onResume(); editorResumed = true; maybeStartRecording(); renderRecording() }
    override fun onPause() { editorResumed = false; recordingHandler.removeCallbacks(recordingTick); player?.release(); player = null; super.onPause() }
    override fun onStop() { editorStarted = false; if (!saveAfterRecording) RecordingSession.remove(recordingObserver); super.onStop() }
    override fun onDestroy() { RecordingSession.remove(recordingObserver); recordingHandler.removeCallbacks(recordingTick); notes.close(); super.onDestroy() }
}
/** Internal entrypoints may request recording; exported sharing never starts the microphone. */
class MicrophoneRecordEditorActivity : RecordEditorActivity()
internal fun android.app.Activity.openRecordEditor(text: String? = null, conversationId: String? = null, turnId: String? = null, question: String? = null, citations: List<String>? = null, quoteOrigin: String? = null, media: String? = null) {
    val editor = when { text != null -> AnswerRecordActivity::class.java; media == "audio" -> MicrophoneRecordEditorActivity::class.java; else -> RecordEditorActivity::class.java }
    startActivity(Intent(this, editor).apply { putExtra("firstUse",(this@openRecordEditor as? MainActivity)?.isFirstUseRecordEntry() ?: this@openRecordEditor.intent.getBooleanExtra("firstUse",false)); text?.let { putExtra("recordText", it) }; conversationId?.let { putExtra("conversationId", it) }; turnId?.let { putExtra("turnId", it) }; question?.let { putExtra("quoteQuestion", it) }; citations?.let { putStringArrayListExtra("quoteCitations", ArrayList(it)) }; quoteOrigin?.let { putExtra("quoteOrigin",it) }; media?.let { putExtra("startMedia", it) } })
}
