package dev.mote.collector

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.widget.*
import org.json.JSONObject

/** One file detail joins the saved version, exact central receipt, original evidence and processing. */
class FileContentActivity : MoteActivity() {
    private lateinit var content: LinearLayout
    private val task by lazy { UiTask(this) }
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
    private fun identity(row: JSONObject) = SourceRules.fileSignature(row.getJSONObject("candidate")) + ":" + row.optJSONObject("pending")?.optJSONObject("manifest")?.optJSONObject("item")?.optString("revision").orEmpty() + ":" + LocalContentPresentation.currentReceipt(row).orEmpty()

    private var offset = 0
    // The offset belongs to this exact derived reader, not the latest Material head.
    private var derivedReader: String? = null
    private var derivedCapture: String? = null
    private var derivedOrigin: String? = null
    private var exportVersion: Triple<String, String, String>? = null
    private data class Detail(val source: LocalSource, val row: JSONObject, val item: JSONObject, val access: CentralAccess.Selection,
        val capture: JSONObject?, val file: JSONObject?, val material: JSONObject?, val read: String?, val nextOffset: Int?,
        val total: Int?, val selectedReader: String?, val localPreview: Pair<String, Boolean>?, val failed: Boolean, val retryRead: Boolean, val folderSummary: String)
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
            val source = localSources().sources().first { it.id == sourceId }
            val queue = fileArchives()
            Triple(queue.presentationRow(source, queue.row(sourceId, external)), if (source.tree) LocalContentPresentation.folderStatus(this, source) else "", CentralAccess.resolve(this).generation)
        }) { result ->
            if (!resumed || generation != viewGeneration) return@start
            result.onSuccess { (row, summary, accessGeneration) ->
                if (accessGeneration != loadedAccessGeneration) {
                    content.removeAllViews(); loadedPresentation = null; load(); return@onSuccess
                }
                transportStatus?.text = LocalContentPresentation.fileStatus(row)
                folderProgress?.text = summary
                if (identity(row) != loadedIdentity || (centralPending && System.currentTimeMillis() - lastCentralCheck >= 5000)) load(automatic = true)
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
            val source = localSources().sources().first { it.id == sourceId }
            val row = fileArchives().let { it.presentationRow(source, it.row(sourceId, external)) }
            val item = row.optJSONObject("pending")?.optJSONObject("manifest")?.optJSONObject("item") ?: row.getJSONObject("candidate")
            intent.getStringExtra("sourceRevision")?.let { selected ->
                val actual = row.optJSONObject("pending")?.optJSONObject("manifest")?.optJSONObject("item")?.optString("revision")
                    ?: if (LocalContentPresentation.currentReceipt(row) != null) row.optString("revision") else "candidate:" + SourceRules.fileSignature(row.getJSONObject("candidate"))
                check(selected == actual) { MoteI18n.text("此版本已变化，请返回资料列表重新选择。") }
            }
            val local = if (row.has("pending")) runCatching { fileArchives().pendingPreview(sourceId, external, item.getString("revision")) }.getOrNull() else null
            val access = CentralAccess.resolve(this)
            var capture: JSONObject? = null; var file: JSONObject? = null; var material: JSONObject? = null; var read: String? = null; var next: Int? = null; var total: Int? = null; var failed = false; var retryRead = false
            // A pending newer version must not be represented by the previous version's receipt.
            val id = LocalContentPresentation.currentReceipt(row).orEmpty()
            var selectedReader = pinnedReader
            if (pinnedReader != null) check(id == pinnedCapture && access.server == pinnedOrigin) { MoteI18n.text("此版本已变化，请返回资料列表重新选择。") }
            if (id.isNotBlank() && access.client != null) {
                runCatching {
                    val record = access.client.get("/api/capture-browser/" + android.net.Uri.encode(id))
                    val provenance = record.optJSONObject("provenance")
                    check(record.optString("id") == id && record.optString("deviceId") == Settings(this).deviceId && provenance?.optString("sourceId") == sourceId && provenance.optString("externalId") == external && provenance.optString("revision") == row.optString("revision"))
                    capture = record
                    file = access.client.get("/api/files/" + android.net.Uri.encode(id))
                    check(file?.optString("captureId") == id)
                    val ref = pinnedReader ?: record.optString("memoryMaterialRef").takeIf { Regex("^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$").matches(it) } ?: "chunks"
                    selectedReader = ref
                    val match = Regex("^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$").matchEntire(ref)
                    if (match != null) {
                        val materialId = match.groupValues[1]; val revision = match.groupValues[2]
                        val page = access.client.get("/api/materials/" + android.net.Uri.encode(materialId) + "/read?offset=$pageOffset&length=4000&revision=" + android.net.Uri.encode(revision))
                        check(page.getJSONObject("material").optString("ref") == ref)
                        material = page.getJSONObject("material")
                        read = page.optString("text")
                        page.optJSONObject("textRange")?.let { range -> total = range.optInt("total"); if (!range.isNull("nextOffset")) next = range.getInt("nextOffset") }
                    }
                    if (ref == "chunks") {
                        val page = access.client.get("/api/files/" + android.net.Uri.encode(id) + "/chunks?offset=$pageOffset")
                        val chunks = page.optJSONArray("items") ?: org.json.JSONArray()
                        read = (0 until chunks.length()).joinToString("\n\n") { chunks.getJSONObject(it).optString("ocrText") }
                        if (!page.isNull("nextOffset")) next = page.getInt("nextOffset")
                    }
                }.onFailure { error ->
                    failed = true
                    retryRead = error !is CentralFailure || error.status !in setOf(401, 403)
                    if (error is CentralFailure && error.status in setOf(401, 403, 404, 409, 410)) { capture = null; file = null; material = null; read = null; next = null; total = null }
                }
            }
            Detail(source, row, item, access, capture, file, material, read, next, total, selectedReader, local, failed, retryRead, if (source.tree) LocalContentPresentation.folderStatus(this, source) else "")
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
    private fun render(detail: Detail) {
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
            contentResolver.openOutputStream(destination)?.use { output -> fileArchives().exportPending(selected.first, selected.second, selected.third, output) } ?: error("Destination unavailable")
        }) { result -> Toast.makeText(this, MoteI18n.text(if (result.isSuccess) "本机原件已导出" else "原件导出未完成，请重新打开内容后重试"), Toast.LENGTH_LONG).show(); load() }
    }
    private fun text(value: String, size: Float = MoteTheme.fontBody.toFloat()) = TextView(this).apply { text = value; MoteUi.type(this, size.toInt()); MoteUi.textColor(this, NativeColorRole.INK); setTextIsSelectable(true); setPadding(0, moteDp(8), 0, moteDp(8)) }.also(content::addView)
    private fun button(value: String, action: () -> Unit) = content.addView(MoteUi.button(Button(this).apply { text = value; setOnClickListener { action() } }))
}
