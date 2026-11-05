package dev.mote.collector

import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.text.format.Formatter
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import dev.mote.collector.plugins.NotesEditor
import dev.mote.collector.plugins.NotesPlugin
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream

open class ShareRecordActivity : MoteActivity() {
    private lateinit var notes: NotesEditor
    private lateinit var task: UiTask
    private lateinit var save: Button
    private lateinit var note: EditText
    private lateinit var description: EditText
    private lateinit var descriptionToggle: View
    private lateinit var status: TextView
    private lateinit var preview: LinearLayout
    private lateinit var panel: View
    private lateinit var done: View
    private var request: ShareRecordRequest? = null
    private var attachments = JSONArray()
    private var saved = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        notes = NotesPlugin.owner(applicationContext).view()
        task = UiTask(this, notes.io, ownsExecutor = false)
        val initialError = runCatching { request = parseIntent(intent) }.exceptionOrNull()?.message
        attachments = state?.getString("attachments")?.let(::JSONArray) ?: JSONArray()
        saved = state?.getBoolean("saved") ?: false
        buildSheet(initialError)
        if (state != null) {
            note.setText(state.getString("note").orEmpty()); description.setText(state.getString("description").orEmpty())
            val expanded = state.getBoolean("descriptionExpanded")
            description.visibility = if (expanded) View.VISIBLE else View.GONE
            descriptionToggle.visibility = if (expanded) View.GONE else View.VISIBLE
        }
        if (saved) showSaved(true)
        else if (state == null && request?.streamUris?.isNotEmpty() == true) stageUris(request!!.streamUris)
        else updateSubmit()
    }

    private fun parseIntent(value: Intent): ShareRecordRequest {
        if (this is AnswerRecordActivity) {
            return ShareRecordRequest.answer(
                value.getStringExtra("recordText").orEmpty(), value.getStringExtra("conversationId"), value.getStringExtra("turnId"),
                value.getStringExtra("quoteQuestion"), value.getStringArrayListExtra("quoteCitations"), value.getStringExtra("quoteOrigin"),
            )
        }
        @Suppress("DEPRECATION") val uris = if (value.action == Intent.ACTION_SEND_MULTIPLE) {
            value.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
        } else listOfNotNull(value.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        return ShareRecordRequest.share(
            value.action.orEmpty(), value.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(), value.getStringExtra(Intent.EXTRA_TITLE),
            uris.map(Uri::toString), value.dataString, callingPackage,
        )
    }

    private fun buildSheet(initialError: String?) {
        val root = FrameLayout(this)
        val container = FrameLayout(this)
        panel = MoteComponents.sheet(this).apply { tag = "share-panel" }
        container.addView(panel, FrameLayout.LayoutParams(-1, -2))
        root.addView(container, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        val sheet = panel as LinearLayout
        val current = request
        val title = MoteI18n.text(if (this is AnswerRecordActivity) "保存为记录" else "保存到 Mote")
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
            setPadding(moteDp(8), 0, moteDp(12), 0)
        }
        bar.addView(TextView(this).apply {
            text = MoteI18n.text("取消"); contentDescription = text; tag = "share-cancel"; gravity = Gravity.CENTER
            minWidth = moteDp(64); minHeight = moteDp(48); isFocusable = true
            MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.MUTED)
            background = MoteUi.clickable(this@ShareRecordActivity, NativeColorRole.TRANSPARENT, NativeRadiusRole.PILL, false)
            setOnClickListener { finish() }
        })
        bar.addView(TextView(this).apply {
            text = title; tag = "share-title"; gravity = Gravity.CENTER
            MoteUi.type(this, 16, medium = true); MoteUi.textColor(this, NativeColorRole.INK)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        save = MoteComponents.button(this, MoteI18n.text("保存"), MoteUi.ButtonRole.PRIMARY) { submit() }.apply {
            tag = "share-save"; contentDescription = MoteI18n.text("保存"); minimumHeight = moteDp(48); minHeight = minimumHeight
            setPadding(moteDp(16), 0, moteDp(16), 0)
        }
        bar.addView(save)
        sheet.addView(bar, LinearLayout.LayoutParams(-1, -2))

        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(moteDp(16), moteDp(12), moteDp(16), moteDp(16))
        }
        preview = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        body.addView(preview)
        note = EditText(this).apply {
            tag = "share-note"; hint = MoteI18n.text(if (current?.answer == true) "我的补充" else "备注")
            contentDescription = hint; gravity = Gravity.TOP; minHeight = moteDp(96); minLines = 3
            MoteUi.textInput(this, InputType.TYPE_CLASS_TEXT, multiline = true)
            filters = arrayOf(android.text.InputFilter.LengthFilter(100000)); MoteUi.field(this)
        }
        body.addView(note, LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(12) })
        description = EditText(this).apply {
            tag = "record-description"; hint = MoteI18n.text("资料说明"); contentDescription = hint
            gravity = Gravity.TOP; minHeight = moteDp(76); minLines = 2; visibility = View.GONE
            MoteUi.textInput(this, InputType.TYPE_CLASS_TEXT, multiline = true)
            filters = arrayOf(android.text.InputFilter.LengthFilter(12000)); MoteUi.field(this)
        }
        descriptionToggle = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = moteDp(48)
            contentDescription = MoteI18n.text("资料说明"); isFocusable = true; tag = "share-description-toggle"
            background = MoteUi.clickable(this@ShareRecordActivity, NativeColorRole.TRANSPARENT, NativeRadiusRole.CONTROL, false)
            addView(MoteComponents.icon(context, MoteGlyph.PLUS, NativeColorRole.ACCENT, 18))
            addView(TextView(context).apply {
                text = MoteI18n.text("资料说明"); MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.ACCENT)
            }, LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(10) })
            setOnClickListener {
                // The canvas shows the quiet "资料说明" action only while the field is folded away.
                description.visibility = View.VISIBLE
                visibility = View.GONE
            }
        }
        body.addView(descriptionToggle, LinearLayout.LayoutParams(-2, -2))
        body.addView(description, LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(4) })
        status = TextView(this).apply {
            tag = "share-status"; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED)
            visibility = View.GONE; accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        body.addView(status)
        sheet.addView(ScrollView(this).apply { addView(body) }, LinearLayout.LayoutParams(-1, -2))
        sheet.addView(View(this), LinearLayout.LayoutParams(1, moteDp(44)))
        done = savedView().apply { visibility = View.GONE; tag = "share-done" }
        container.addView(done, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
        window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        window.attributes = window.attributes.apply {
            dimAmount = 0.35f; gravity = Gravity.BOTTOM; width = ViewGroup.LayoutParams.MATCH_PARENT; height = ViewGroup.LayoutParams.WRAP_CONTENT
        }
        renderPreview()
        initialError?.let(::showError)
        note.addTextChangedListener(submitWatcher)
        description.addTextChangedListener(submitWatcher)
    }

    private fun savedView(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
        val radius = resources.displayMetrics.density * MoteTheme.radiusPanelMobile
        NativePresentationStyles.bind(this, "share-done") {
            it.background = android.graphics.drawable.GradientDrawable().apply {
                setColor(NativeColorRole.SURFACE_RAISED.color()); cornerRadii = floatArrayOf(radius, radius, radius, radius, 0f, 0f, 0f, 0f)
            }
        }
        addView(FrameLayout(context).apply {
            NativePresentationStyles.bind(this, "share-done-icon") {
                it.background = MoteUi.shape(context, NativeColorRole.SUCCESS_TINT, NativeRadiusRole.PILL, false)
            }
            addView(MoteComponents.icon(context, MoteGlyph.CHECK, NativeColorRole.SUCCESS, 28), FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        }, LinearLayout.LayoutParams(moteDp(52), moteDp(52)))
        addView(TextView(context).apply {
            text = MoteI18n.text("已保存"); MoteUi.type(this, 16, medium = true); MoteUi.textColor(this, NativeColorRole.INK)
        }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = moteDp(12) })
    }

    private fun renderPreview() {
        preview.removeAllViews()
        val current = request ?: return
        if (current.answer) {
            preview.addView(TextView(this).apply {
                tag = "record-origin-fulltext"; text = current.quote(); setTextIsSelectable(true)
                setPadding(moteDp(14), moteDp(12), moteDp(14), moteDp(12))
                MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK)
                NativePresentationStyles.bind(this, "share-quote") {
                    it.background = MoteUi.shape(context, NativeColorRole.SURFACE_SUNKEN, NativeRadiusRole.CONTROL, false)
                }
            })
            return
        }
        current.link?.let { link ->
            preview.addView(previewRow(MoteGlyph.LINK, link.title, link.domain, "share-link-preview"))
        }
        val images = (0 until attachments.length()).map { attachments.getJSONObject(it) }.filter { it.getString("mime").startsWith("image/") }
        if (images.isNotEmpty()) {
            val group = MoteComponents.group(this).apply { tag = "share-images-preview" }
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; setPadding(moteDp(12), moteDp(12), moteDp(12), moteDp(12))
            }
            images.forEachIndexed { index, item ->
                row.addView(ImageView(this).apply {
                    contentDescription = item.getString("name"); scaleType = ImageView.ScaleType.CENTER_CROP
                    background = MoteUi.shape(context, NativeColorRole.FILL, NativeRadiusRole.CONTROL, true, NativeColorRole.HAIR)
                    outlineProvider = android.view.ViewOutlineProvider.BACKGROUND; clipToOutline = true
                    val uri = current.streamUris.getOrNull(index) ?: current.streamUris.firstOrNull()
                    uri?.let { setImageURI(Uri.parse(it)) } ?: setImageResource(MoteGlyph.PHOTO.drawable)
                }, LinearLayout.LayoutParams(moteDp(72), moteDp(72)).apply { if (index > 0) marginStart = moteDp(8) })
            }
            group.addView(row); preview.addView(group)
        }
        (0 until attachments.length()).map { attachments.getJSONObject(it) }.filter { !it.getString("mime").startsWith("image/") }.forEach { item ->
            preview.addView(previewRow(MoteGlyph.FILE, item.getString("name"), Formatter.formatShortFileSize(this, item.getLong("size")), "share-file-preview"))
        }
    }

    private fun previewRow(glyph: MoteGlyph, title: String, subtitle: String, identity: String): View {
        val group = MoteComponents.group(this).apply { tag = identity }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = moteDp(64)
            setPadding(moteDp(14), moteDp(10), moteDp(14), moteDp(10))
        }
        row.addView(FrameLayout(this).apply {
            background = MoteUi.shape(context, NativeColorRole.FILL, NativeRadiusRole.CONTROL, false)
            addView(MoteComponents.icon(context, glyph, NativeColorRole.MUTED, 22), FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        }, LinearLayout.LayoutParams(moteDp(40), moteDp(40)).apply { marginEnd = moteDp(12) })
        row.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(context).apply {
                text = title; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
                MoteUi.type(this, NativeFontRole.BODY, medium = true); MoteUi.textColor(this, NativeColorRole.INK)
            })
            addView(TextView(context).apply {
                text = subtitle; maxLines = 1; MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED)
            })
        }, LinearLayout.LayoutParams(0, -2, 1f))
        group.addView(row)
        return group
    }

    private val submitWatcher = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
        override fun afterTextChanged(s: Editable?) = updateSubmit()
    }

    private fun updateSubmit() {
        if (!::save.isInitialized) return
        val origin = request?.origin
        save.isEnabled = !saved && !task.busy && origin != null &&
            (note.text.isNotBlank() || attachments.length() > 0 || origin.optString("text").isNotBlank() || origin.optString("url").isNotBlank())
    }

    private fun stageUris(uris: List<String>) {
        save.isEnabled = false
        task.start("", {}, {
            val added = JSONArray()
            uris.forEach { value ->
                val uri = Uri.parse(value)
                require(uri.scheme == "content")
                var name = "attachment"
                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                    if (it.moveToFirst()) name = it.getString(0) ?: name
                }
                val bytes = contentResolver.openInputStream(uri)!!.use(::readBounded)
                added.put(notes.stage(bytes, name, contentResolver.getType(uri) ?: "application/octet-stream"))
            }
            added
        }) { result ->
            result.onSuccess { attachments = it; renderPreview(); updateSubmit() }.onFailure { showError(it.message); updateSubmit() }
        }
    }

    private fun readBounded(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream(); val buffer = ByteArray(65536)
        while (true) {
            val count = input.read(buffer); if (count < 0) break
            require(out.size() + count <= CentralAttachments.MAX_BYTES); out.write(buffer, 0, count)
        }
        return out.toByteArray()
    }

    private fun submit() {
        val current = request ?: return
        if (saved || task.busy || !save.isEnabled) return
        save.isEnabled = false
        val text = note.text.toString(); val files = JSONArray(attachments.toString())
        val origin = JSONObject(current.origin.toString()); val presentation = current.presentation?.let { JSONObject(it.toString()) }
        val noteDescription = description.text.toString()
        task.start("", {}, {
            notes.submitStandalone(text, files, origin, noteDescription, presentation)
        }) { result ->
            result.onSuccess {
                setResult(RESULT_OK, Intent().putExtra("recordId", it)); saved = true; showSaved(true)
            }.onFailure { showError(it.message); updateSubmit() }
        }
    }

    private fun showSaved(close: Boolean) {
        panel.visibility = View.INVISIBLE; done.visibility = View.VISIBLE
        if (close) done.postDelayed({ finish() }, 800)
    }

    private fun showError(message: String?) {
        status.text = message.orEmpty(); status.visibility = if (message.isNullOrBlank()) View.GONE else View.VISIBLE
    }

    override fun onSaveInstanceState(out: Bundle) {
        out.putString("attachments", attachments.toString()); out.putString("note", note.text.toString())
        out.putString("description", description.text.toString()); out.putBoolean("descriptionExpanded", description.visibility == View.VISIBLE); out.putBoolean("saved", saved)
        super.onSaveInstanceState(out)
    }

    override fun onDestroy() { notes.close(); super.onDestroy() }
}

class AnswerRecordActivity : ShareRecordActivity()
