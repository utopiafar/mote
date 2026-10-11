package dev.mote.collector

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import org.json.JSONObject

/** One file detail joins the saved version, exact central receipt, original evidence and processing. */
class FileContentActivity : MoteActivity() {
    private lateinit var content: LinearLayout
    private val task by lazy { UiTask(this) }
    private var viewGeneration = 0L
    private var offset = 0
    private var exportVersion: Triple<String, String, String>? = null
    private data class Detail(val source: LocalSource, val row: JSONObject, val item: JSONObject, val access: CentralAccess.Selection,
        val capture: JSONObject?, val file: JSONObject?, val material: JSONObject?, val read: String?, val nextOffset: Int?,
        val total: Int?, val localPreview: Pair<String, Boolean>?, val failed: Boolean)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        offset = savedInstanceState?.getInt("offset", 0) ?: 0
        savedInstanceState?.getString("exportRevision")?.let { revision -> exportVersion = Triple(savedInstanceState.getString("exportSource", ""), savedInstanceState.getString("exportExternal", ""), revision) }
        content = moteDetailPage()
    }
    override fun onSaveInstanceState(state: Bundle) {
        state.putInt("offset", offset); exportVersion?.let { (source, external, revision) -> state.putString("exportSource", source); state.putString("exportExternal", external); state.putString("exportRevision", revision) }
        super.onSaveInstanceState(state)
    }
    override fun onResume() { super.onResume(); load() }
    override fun onPause() { viewGeneration++; content.removeAllViews(); super.onPause() }
    private fun load() {
        if (task.busy) return
        val generation = ++viewGeneration
        val sourceId = intent.getStringExtra("sourceId") ?: return
        val external = intent.getStringExtra("externalId") ?: return
        val pageOffset = offset
        content.removeAllViews(); text(MoteI18n.text("正在读取内容…"))
        task.start(MoteI18n.text("正在读取内容…"), {}, {
            val source = localSources().sources().first { it.id == sourceId }
            val row = fileArchives().rows(sourceId).first { it.getJSONObject("candidate").getString("externalId") == external }
            val item = row.optJSONObject("pending")?.optJSONObject("manifest")?.optJSONObject("item") ?: row.getJSONObject("candidate")
            val local = if (row.has("pending")) runCatching { fileArchives().pendingPreview(sourceId, external, item.getString("revision")) }.getOrNull() else null
            val access = CentralAccess.resolve(this)
            var capture: JSONObject? = null; var file: JSONObject? = null; var material: JSONObject? = null; var read: String? = null; var next: Int? = null; var total: Int? = null; var failed = false
            // A pending newer version must not be represented by the previous version's receipt.
            val id = LocalContentPresentation.currentReceipt(row).orEmpty()
            if (id.isNotBlank() && access.client != null) {
                runCatching {
                    val record = access.client.get("/api/capture-browser/" + android.net.Uri.encode(id))
                    val provenance = record.optJSONObject("provenance")
                    check(record.optString("id") == id && record.optString("deviceId") == Settings(this).deviceId && provenance?.optString("sourceId") == sourceId && provenance.optString("externalId") == external && provenance.optString("revision") == row.optString("revision"))
                    capture = record
                    file = access.client.get("/api/files/" + android.net.Uri.encode(id))
                    check(file?.optString("captureId") == id)
                    val ref = record.optString("memoryMaterialRef")
                    val match = Regex("^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$").matchEntire(ref)
                    if (match != null) {
                        val materialId = match.groupValues[1]; val revision = match.groupValues[2]
                        val head = access.client.get("/api/materials/" + android.net.Uri.encode(materialId))
                        if (head.optString("ref") == ref) {
                            material = head
                            val page = access.client.get("/api/materials/" + android.net.Uri.encode(materialId) + "/read?offset=$pageOffset&length=4000&revision=" + android.net.Uri.encode(revision))
                            check(page.getJSONObject("material").optString("ref") == ref)
                            read = page.optString("text")
                            page.optJSONObject("textRange")?.let { range -> total = range.optInt("total"); if (!range.isNull("nextOffset")) next = range.getInt("nextOffset") }
                        }
                    }
                    if (read == null) {
                        val page = access.client.get("/api/files/" + android.net.Uri.encode(id) + "/chunks?offset=$pageOffset")
                        val chunks = page.optJSONArray("items") ?: org.json.JSONArray()
                        read = (0 until chunks.length()).joinToString("\n\n") { chunks.getJSONObject(it).optString("ocrText") }
                        if (!page.isNull("nextOffset")) next = page.getInt("nextOffset")
                    }
                }.onFailure { error ->
                    failed = true
                    if (error is CentralFailure && error.status in setOf(401, 403)) { capture = null; file = null; material = null; read = null; next = null; total = null }
                }
            }
            Detail(source, row, item, access, capture, file, material, read, next, total, local, failed)
        }) { result ->
            if (generation != viewGeneration || (result.isSuccess && CentralSession.get(this).generation != result.getOrThrow().access.generation)) { if (!isFinishing) load(); return@start }
            content.removeAllViews()
            result.onSuccess(::render).onFailure { text(MoteI18n.text("内容暂不可读取，原数据保留。")); button(MoteI18n.text("重试")) { load() } }
        }
    }
    private fun render(detail: Detail) {
        val row = detail.row; val item = detail.item
        text(item.optString("title"), 27f)
        text(MoteI18n.text("来源：{0}", detail.source.name), 13f)
        text(item.optString("observedAt"), 12f)
        text(LocalContentPresentation.fileStatus(row), 15f)
        if (detail.capture != null) text(LocalContentPresentation.centralStatus(detail.file, detail.material), 15f)
        if (detail.failed) text(MoteI18n.text("中央暂不可用 · 保留本机状态，恢复连接后重试"), 13f)
        if (!row.has("pending") && row.optString("captureId").isNotBlank() && detail.access.client == null) {
            text(MoteI18n.text("登录中央后，可在这里读取原文与整理状态。"), 13f)
            button(MoteI18n.text("连接或登录中央")) { startActivity(Intent(this, CentralActivity::class.java).putExtra("page", "archive")) }
        }
        text(MoteI18n.text("原文与出处"), 20f)
        val local = detail.localPreview
        val original = if (local != null) local.first.drop(offset).take(4000) else detail.read?.takeIf { it.isNotBlank() } ?: detail.capture?.optString("ocrText")?.takeIf { it.isNotBlank() } ?: item.optString("text")
        if (original.isNotBlank()) text(original, 16f)
        else text(MoteI18n.text("本机保留文件信息与待发原始字节；正文由中央整理后显示。"), 13f)
        if (local != null) {
            text(MoteI18n.text(if (local.second && offset + 4000 >= local.first.length) "已显示本机保存原文的最后一页" else "正在预览本机保存的原文，尚未显示完整内容"), 12f)
            if (offset + 4000 < local.first.length) button(MoteI18n.text("继续展开")) { offset += 4000; load() }
        } else {
            detail.total?.let { text(MoteI18n.text("原文范围：{0}–{1} / {2} 字符", offset, offset + original.length, it), 12f) }
            detail.nextOffset?.let { next -> button(MoteI18n.text("继续展开")) { offset = next; load() } }
        }
        if (offset > 0) button(MoteI18n.text("返回原文开头")) { offset = 0; load() }
        if (row.optJSONObject("pending")?.optJSONObject("manifest")?.has("sha256") == true) button(MoteI18n.text("导出本机保存的完整原件")) {
            exportVersion = Triple(detail.source.id, item.getString("externalId"), item.getString("revision"))
            @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(item.optString("mimeType", "application/octet-stream")).putExtra(Intent.EXTRA_TITLE, item.optString("title", "Mote")), 801)
        }
        text(item.optString("uri", item.optString("externalId")), 12f)
        text(MoteI18n.text(if (detail.source.syncContinuously) "以后修改会自动同步" else "本次导入一次，不监控以后修改"), 13f)
        text(MoteI18n.text(when (detail.source.retention) { "archive" -> "中央保留完整原件"; "reference" -> "仅发送文件信息，不读取正文"; else -> "完整文件发送到中央提取正文，处理后不保留中央原件" }), 13f)
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
    private fun text(value: String, size: Float = 14f) = content.addView(TextView(this).apply { text = value; textSize = size; setTextIsSelectable(true); setPadding(0, moteDp(8), 0, moteDp(8)) })
    private fun button(value: String, action: () -> Unit) = content.addView(MoteUi.button(Button(this).apply { text = value; setOnClickListener { action() } }))
}
