package dev.mote.collector

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.widget.*
import dev.mote.collector.plugins.FileDetail
import dev.mote.collector.plugins.SourceProviderPlugin
import org.json.JSONObject

/** One file detail joins the saved version, exact central receipt, original evidence and processing. */
class FileContentActivity : MoteActivity() {
    private lateinit var content: LinearLayout
    private val task by lazy { UiTask(this) }
    private val owner by lazy { SourceProviderPlugin.owner(this) }
    private var viewGeneration = 0L
    private val handler = Handler(Looper.getMainLooper())
    private var resumed = false
    private var loadedIdentity: String? = null
    private var loadedAccessGeneration = -1L
    private var centralPending = false
    private var lastCentralCheck = 0L
    private var loadedPresentation: String? = null
    private var transportStatus: TextView? = null
    private var folderProgress: TextView? = null
    private val refresh = object : Runnable {
        override fun run() {
            if (!resumed) return
            refreshLocal()
            handler.postDelayed(this, 2500)
        }
    }
    private fun identity(row: JSONObject) = owner.fileIdentity(row)

    private var offset = 0
    // The offset belongs to this exact derived reader, not the latest Material head.
    private var derivedReader: String? = null
    private var derivedCapture: String? = null
    private var derivedOrigin: String? = null
    private var exportVersion: Triple<String, String, String>? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        offset = savedInstanceState?.getInt("offset", 0) ?: 0
        derivedReader = savedInstanceState?.getString("derivedReader")
        derivedCapture = savedInstanceState?.getString("derivedCapture")
        derivedOrigin = savedInstanceState?.getString("derivedOrigin")
        savedInstanceState?.getString("exportRevision")?.let { revision -> exportVersion = Triple(savedInstanceState.getString("exportSource", ""), savedInstanceState.getString("exportExternal", ""), revision) }
        content = moteDetailPage().apply { background = MoteUi.shape(this@FileContentActivity, NativeColorRole.SURFACE, NativeRadiusRole.READING) }
    }
    override fun onSaveInstanceState(state: Bundle) {
        state.putString("derivedReader", derivedReader); state.putString("derivedCapture", derivedCapture); state.putString("derivedOrigin", derivedOrigin)
        state.putInt("offset", offset); exportVersion?.let { (source, external, revision) -> state.putString("exportSource", source); state.putString("exportExternal", external); state.putString("exportRevision", revision) }
        super.onSaveInstanceState(state)
    }
    override fun onResume() { super.onResume(); resumed = true; load(); handler.removeCallbacks(refresh); handler.postDelayed(refresh, 2500) }
    override fun onPause() { resumed = false; handler.removeCallbacks(refresh); viewGeneration++; content.removeAllViews(); super.onPause() }
    private fun refreshLocal() {
        if (task.busy || loadedIdentity == null) return
        val generation = viewGeneration
        val sourceId = intent.getStringExtra("sourceId") ?: return
        val external = intent.getStringExtra("externalId") ?: return
        task.start("", {}, {
            owner.fileRefresh(sourceId, external)
        }) { result ->
            if (!resumed || generation != viewGeneration) return@start
            result.onSuccess { refresh ->
                if (refresh.accessGeneration != loadedAccessGeneration) {
                    content.removeAllViews(); loadedPresentation = null; load(); return@onSuccess
                }
                transportStatus?.text = LocalContentPresentation.fileStatus(refresh.row)
                folderProgress?.text = refresh.folderSummary
                if (identity(refresh.row) != loadedIdentity || (centralPending && System.currentTimeMillis() - lastCentralCheck >= 5000)) load(automatic = true)
            }
        }
    }
    private fun load(automatic: Boolean = false) {
        if (task.busy) return
        val generation = ++viewGeneration
        val sourceId = intent.getStringExtra("sourceId") ?: return
        val external = intent.getStringExtra("externalId") ?: return
        val pageOffset = offset; val pinnedReader = derivedReader; val pinnedCapture = derivedCapture; val pinnedOrigin = derivedOrigin
        if (!automatic) { content.removeAllViews(); text(MoteI18n.text("正在读取内容…")) }
        task.start(MoteI18n.text("正在读取内容…"), {}, {
            owner.loadFile(sourceId, external, pageOffset, pinnedReader, pinnedCapture, pinnedOrigin,
                intent.getStringExtra("sourceRevision"))
        }) { result ->
            if (generation != viewGeneration || (result.isSuccess && CentralSession.get(this).generation != result.getOrThrow().access.generation)) { if (!isFinishing) load(); return@start }
            result.onSuccess { detail ->
                if (detail.selectedReader != null) {
                    derivedReader = detail.selectedReader; derivedCapture = LocalContentPresentation.currentReceipt(detail.row); derivedOrigin = detail.access.server
                }
                loadedIdentity = identity(detail.row)
                lastCentralCheck = System.currentTimeMillis()
                loadedAccessGeneration = detail.access.generation
                centralPending = detail.retryRead || detail.file?.optJSONObject("job")?.optString("state") in setOf("waiting", "running") || detail.material?.optJSONObject("indexing")?.optString("state") in setOf("pending", "running")
                val presentation = listOf(loadedIdentity, detail.capture?.toString(), detail.file?.toString(), detail.material?.toString(), detail.read, detail.nextOffset, detail.total, detail.localPreview, detail.failed, detail.access.generation, pageOffset).joinToString("|")
                if (!automatic || presentation != loadedPresentation) {
                    val scroll = content.parent as? ScrollView
                    val previousScroll = if (automatic) scroll?.scrollY ?: 0 else 0
                    content.removeAllViews(); render(detail)
                    if (automatic) scroll?.post { scroll.scrollTo(0, previousScroll) }
                    loadedPresentation = presentation
                } else {
                    transportStatus?.text = LocalContentPresentation.fileStatus(detail.row)
                    folderProgress?.text = detail.folderSummary
                }
            }.onFailure { if (!automatic) { content.removeAllViews(); text(MoteI18n.text("内容暂不可读取，原数据保留。")); button(MoteI18n.text("重试")) { load() } } }
        }
    }
    private fun render(detail: FileDetail) {
        val row = detail.row; val item = detail.item
        text(item.optString("title"), MoteTheme.fontTitleMobile.toFloat()).apply { MoteUi.type(this, NativeFontRole.TITLE_MOBILE, medium = true) }
        text(MoteI18n.text("来源：{0}", detail.source.name), MoteTheme.fontSupport.toFloat()).apply { MoteUi.textColor(this, NativeColorRole.MUTED) }
        text(item.optString("observedAt"), MoteTheme.fontMeta.toFloat()).apply { MoteUi.textColor(this, NativeColorRole.MUTED) }
        transportStatus = text(LocalContentPresentation.fileStatus(row), MoteTheme.fontBody.toFloat())
        folderProgress = if (detail.folderSummary.isNotBlank()) text(detail.folderSummary, MoteTheme.fontSupport.toFloat()) else null
        if (detail.capture != null) text(LocalContentPresentation.centralStatus(detail.file, detail.material), 15f)
        if (detail.failed) text(MoteI18n.text("中央暂不可用 · 保留本机状态，恢复连接后重试"), MoteTheme.fontSupport.toFloat())
        if (!row.has("pending") && row.optString("captureId").isNotBlank() && detail.access.client == null) {
            text(MoteI18n.text("登录中央后，可在这里读取原文与整理状态。"), MoteTheme.fontSupport.toFloat())
            button(MoteI18n.text("连接或登录中央")) { startActivity(Intent(this, CentralActivity::class.java).putExtra("page", "archive")) }
        }
        text(MoteI18n.text("原文与出处"), MoteTheme.fontSection.toFloat())
        val local = detail.localPreview
        val original = if (local != null) local.first.drop(offset).take(4000) else detail.capture?.optString("ocrText")?.takeIf { it.isNotBlank() } ?: item.optString("text")
        if (original.isNotBlank()) text(original, 16f)
        else text(MoteI18n.text("本机保留文件信息与待发原始字节；正文由中央整理后显示。"), MoteTheme.fontSupport.toFloat())
        if (detail.source.description.isNotBlank()) {
            text(MoteI18n.text("资料说明"), MoteTheme.fontSupport.toFloat())
            text(detail.source.description, MoteTheme.fontBody.toFloat())
        }
        if (local != null) {
            text(MoteI18n.text(if (local.second && offset + 4000 >= local.first.length) "已显示本机保存原文的最后一页" else "正在预览本机保存的原文，尚未显示完整内容"), 12f)
            if (offset + 4000 < local.first.length) button(MoteI18n.text("继续展开")) { offset += 4000; load() }
        }
        if (!detail.read.isNullOrBlank()) {
            text(MoteI18n.text(if (detail.material != null) "整理资料" else "提取的正文"), MoteTheme.fontSection.toFloat())
            text(detail.read, 16f)
            detail.material?.let { material -> button(MoteI18n.text("原始依据")) {
                LibrarySourceReaderActivity.open(this, detail.access.server, "material", material.getString("id"), "", "", material.getString("revision"))
            } }
            detail.total?.let { text(MoteI18n.text("衍生内容范围：{0}–{1} / {2} 字符", offset, offset + detail.read.length, it), 12f) }
            detail.nextOffset?.let { next -> button(MoteI18n.text("继续展开")) { offset = next; load() } }
        }
        if (offset > 0) button(MoteI18n.text(if (detail.read.isNullOrBlank()) "返回原文开头" else "返回衍生内容开头")) { offset = 0; load() }
        if (row.optJSONObject("pending")?.optJSONObject("manifest")?.has("sha256") == true) button(MoteI18n.text("导出本机保存的完整原件")) {
            exportVersion = Triple(detail.source.id, item.getString("externalId"), item.getString("revision"))
            @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(item.optString("mimeType", "application/octet-stream")).putExtra(Intent.EXTRA_TITLE, item.optString("title", "Mote")), 801)
        }
        text(item.optString("uri", item.optString("externalId")), 12f)
        text(MoteI18n.text(if (detail.source.syncContinuously) "以后修改会自动同步" else "本次导入一次，不监控以后修改"), MoteTheme.fontSupport.toFloat())
        text(MoteI18n.text(when (detail.source.retention) { "archive" -> "中央保留完整原件"; "reference" -> "仅发送文件信息，不读取正文"; else -> "完整文件发送到中央提取正文，处理后不保留中央原件" }), MoteTheme.fontSupport.toFloat())
        button(MoteI18n.text("管理这个来源")) { startActivity(Intent(this, SourcesActivity::class.java).putExtra("sourceId", detail.source.id)) }
        button(MoteI18n.text("刷新状态")) { load() }
        MoteUi.styleTree(content)
    }
    @Deprecated("Native export picker") override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 801 || resultCode != RESULT_OK) return
        val destination = data?.data ?: return; val selected = exportVersion ?: return; exportVersion = null
        task.start(MoteI18n.text("正在导出原件…"), {}, {
            contentResolver.openOutputStream(destination)?.use { output -> owner.exportPending(selected.first, selected.second, selected.third, output) } ?: error("Destination unavailable")
        }) { result -> Toast.makeText(this, MoteI18n.text(if (result.isSuccess) "本机原件已导出" else "原件导出未完成，请重新打开内容后重试"), Toast.LENGTH_LONG).show(); load() }
    }
    private fun text(value: String, size: Float = MoteTheme.fontBody.toFloat()) = TextView(this).apply { text = value; MoteUi.type(this, size.toInt()); MoteUi.textColor(this, NativeColorRole.INK); setTextIsSelectable(true); setPadding(0, moteDp(8), 0, moteDp(8)) }.also(content::addView)
    private fun button(value: String, action: () -> Unit) = content.addView(MoteUi.button(Button(this).apply { text = value; setOnClickListener { action() } }))
}
