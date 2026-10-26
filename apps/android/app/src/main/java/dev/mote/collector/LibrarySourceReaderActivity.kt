package dev.mote.collector

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject

/** Pinned original/Material reader. Intent and Bundle carry keys only, never private bodies. */
class LibrarySourceReaderActivity : MoteActivity() {
    companion object {
        internal fun open(context: Context, origin: String, type: String, source: String, external: String, device: String, revision: String, capture: String = "", local: Boolean = false) {
            context.startActivity(Intent(context, LibrarySourceReaderActivity::class.java).putExtra("origin", origin).putExtra("type", type).putExtra("source", source).putExtra("external", external).putExtra("device", device).putExtra("revision", revision).putExtra("capture", capture).putExtra("local", local))
        }
    }
    private lateinit var body: LinearLayout
    private val task by lazy { UiTask(this) }
    private var generation = 0
    private var offset = 0
    private var memberOffset = 0
    private var exportGeneration: Long? = null
    private var exportOrigin: String? = null
    private fun key(name: String) = intent.getStringExtra(name).orEmpty()
    override fun onCreate(state: Bundle?) {
        super.onCreate(state); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        offset = state?.getInt("offset") ?: 0; memberOffset = state?.getInt("members") ?: 0
        exportGeneration = state?.getLong("exportGeneration")?.takeIf { it >= 0 }; exportOrigin = state?.getString("exportOrigin")
        body = moteDetailPage()
    }
    override fun onResume() { super.onResume(); load() }
    override fun onPause() { generation++; body.removeAllViews(); super.onPause() }
    override fun onDestroy() { task.close(); super.onDestroy() }
    override fun onSaveInstanceState(state: Bundle) { state.putInt("offset", offset); state.putInt("members", memberOffset); state.putLong("exportGeneration", exportGeneration ?: -1); state.putString("exportOrigin", exportOrigin); super.onSaveInstanceState(state) }
    private data class Read(val item: JSONObject, val text: String, val next: Int?, val members: JSONObject? = null, val file: JSONObject? = null, val history: JSONArray? = null)
    private fun load() {
        if (task.busy) return
        val stamp = ++generation; val access = CentralAccess.resolve(this)
        body.removeAllViews(); text(MoteI18n.text("正在读取…"))
        task.start("", {}, {
            if (intent.getBooleanExtra("local", false)) {
                val source = localSources().sources().firstOrNull { it.id == key("source") } ?: error(MoteI18n.text("此版本已变化，请返回资料列表重新选择。"))
                val state = localSources().state(source.id); val current = state.optJSONObject("current")?.optJSONObject(key("external"))?.optJSONObject("body")
                val pending = state.optJSONArray("pending") ?: JSONArray()
                val item = (listOfNotNull(current) + (0 until pending.length()).map { pending.getJSONObject(it) }).firstOrNull { it.optString("externalId") == key("external") && it.optString("revision") == key("revision") } ?: error(MoteI18n.text("此版本已变化，请返回资料列表重新选择。"))
                val content = if (item.optString("layer") == "reference") "" else item.optString("text")
                Read(JSONObject(item.toString()).put("sourceDescription", source.description), content.drop(offset).take(4000), if (content.length > offset + 4000) offset + 4000 else null)
            } else {
                check(access.server == key("origin")) { MoteI18n.text("内容暂不可读取，原数据保留。") }; val api = access.client ?: error(MoteI18n.text("请先登录中央节点，各页面会共用这次登录。"))
                if (key("type") == "evidence") {
                    val result = api.post("/api/context/read", JSONObject().put("refs", JSONArray().put(key("source"))).put("offset", offset).put("length", 4000))
                    val item = result.getJSONArray("items").optJSONObject(0) ?: error(MoteI18n.text("资料不存在或已删除。"))
                    val range = item.optJSONObject("textRange")
                    Read(item, item.optString("text"), if (range == null || range.isNull("nextOffset")) null else range.getInt("nextOffset"))
                } else if (key("type") == "material") {
                    val path = "/api/materials/" + android.net.Uri.encode(key("source")); val revision = android.net.Uri.encode(key("revision"))
                    val read = api.get("$path/read?revision=$revision&offset=$offset&length=4000")
                    val item = read.getJSONObject("material"); check(item.getString("ref") == "material:${key("source")}@${key("revision")}") { MoteI18n.text("此版本已变化，请返回资料列表重新选择。") }
                    val members = api.get("$path/members?revision=$revision&offset=$memberOffset&limit=20")
                    val range = read.getJSONObject("textRange")
                    Read(item, read.getString("text"), if (range.isNull("nextOffset")) null else range.getInt("nextOffset"), members)
                } else {
                    val record = api.get("/api/capture-browser/" + android.net.Uri.encode(key("capture")))
                    val p = record.getJSONObject("provenance")
                    check(record.getString("id") == key("capture") && record.getString("deviceId") == key("device") && p.getString("sourceId") == key("source") && p.getString("externalId") == key("external") && p.getString("revision") == key("revision")) { MoteI18n.text("此版本已变化，请返回资料列表重新选择。") }
                    val file = if (record.has("fileArchive")) api.get("/api/files/" + android.net.Uri.encode(key("capture"))).also { check(it.getString("captureId") == key("capture")) } else null
                    val history = api.get("/api/sources/" + android.net.Uri.encode(key("source")) + "/history?externalId=" + android.net.Uri.encode(key("external"))).getJSONArray("items")
                    val content = record.optString("ocrText"); Read(record, content.drop(offset).take(4000), if (content.length > offset + 4000) offset + 4000 else null, file = file, history = history)
                }
            }
        }) { result ->
            if (stamp != generation) { load(); return@start }
            body.removeAllViews()
            if (!intent.getBooleanExtra("local", false) && CentralAccess.resolve(this).let { it.generation != access.generation || it.server != access.server }) { text(MoteI18n.text("内容暂不可读取，原数据保留。")); return@start }
            result.onSuccess { data ->
                text(data.item.optString("title", data.item.optString("windowTitle")), NativeFontRole.TITLE_MOBILE)
                text(MoteI18n.text(if (key("type") == "material") "整理资料" else "原文与出处"), NativeFontRole.SECTION)
                text(data.text.ifBlank { MoteI18n.text("此版本没有保存正文。") })
                data.item.optString("sourceDescription").takeIf(String::isNotBlank)?.let(::text)
                data.item.optJSONObject("attributionContext")?.let { context ->
                    text(MoteI18n.text("内容与我的关系") + " · " + MoteI18n.text(when(context.optString("ownerRelation")) { "owner" -> "我的表达或经历"; "third_party" -> "第三方内容"; "mixed" -> "混合内容"; else -> "归属未知" }))
                }
                data.item.optJSONArray("evidenceRefs")?.let { refs -> repeat(refs.length()) { index -> button(MoteI18n.text("查看原始记录")) { openMember(refs.getString(index), access) } } }
                data.next?.let { next -> button(MoteI18n.text("继续展开")) { offset = next; load() } }
                if (offset > 0) button(MoteI18n.text("返回原文开头")) { offset = 0; load() }
                val ref = data.item.optString("memoryMaterialRef")
                Regex("^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$").matchEntire(ref)?.let { match -> button(MoteI18n.text("整理资料")) { open(this, access.server, "material", match.groupValues[1], "", "", match.groupValues[2]) } }
                data.file?.let { file ->
                    text(LocalContentPresentation.centralStatus(file, null))
                    if (file.optBoolean("hasOriginal")) button(MoteI18n.text("保存原件")) {
                        exportGeneration = access.generation; exportOrigin = access.server
                        @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(file.optJSONObject("item")?.optString("mimeType") ?: "application/octet-stream").putExtra(Intent.EXTRA_TITLE, data.item.optString("windowTitle", "mote-file")), 812)
                    }
                }
                data.members?.let { page ->
                    text(MoteI18n.text("原始依据"), NativeFontRole.SECTION)
                    val items = page.getJSONArray("items")
                    repeat(items.length()) { index -> val member = items.getJSONObject(index); val memberRef = member.getString("ref")
                        button(memberRef) { openMember(memberRef, access) }
                    }
                    if (!page.isNull("nextOffset")) button(MoteI18n.text("加载更多")) { memberOffset = page.getInt("nextOffset"); load() }
                    if (memberOffset > 0) button(MoteI18n.text("返回")) { memberOffset = 0; load() }
                }
                data.history?.let { history ->
                    text(MoteI18n.text("历史版本"), NativeFontRole.SECTION)
                    repeat(history.length()) { index -> val version = history.getJSONObject(index)
                        button(version.getString("revision")) { open(this, access.server, "original", key("source"), key("external"), key("device"), version.getString("revision"), version.getString("captureId")) }
                    }
                }
            }.onFailure { text(it.message ?: MoteI18n.text("内容暂不可读取，原数据保留。")) }
            button(MoteI18n.text("重试")) { load() }; MoteUi.styleTree(body)
        }
    }
    private fun openMember(ref: String, access: CentralAccess.Selection) {
        if (!ref.startsWith("capture:")) { open(this, access.server, "evidence", ref, "", "", ""); return }
        val stamp = generation
        task.start("", {}, { requireNotNull(access.client).get("/api/capture-browser/" + android.net.Uri.encode(ref.removePrefix("capture:"))) }) { result ->
            if (stamp != generation || CentralAccess.resolve(this).generation != access.generation) return@start
            result.onSuccess { record -> val p = record.optJSONObject("provenance")
                if (p != null) open(this, access.server, "original", p.getString("sourceId"), p.getString("externalId"), record.getString("deviceId"), p.getString("revision"), record.getString("id"))
                else startActivity(Intent(this, CaptureRecordsActivity::class.java).putExtra("recordId", record.getString("id")).putExtra("recordRemote", true).putExtra("recordOrigin", access.server).putExtra("recordDeviceId", record.getString("deviceId")).putExtra("recordVersion", record.getString("libraryVersion")).putExtra("recordSource", record.getString("source")))
            }.onFailure { body.removeAllViews(); text(it.message.orEmpty()); button(MoteI18n.text("重试")) { load() } }
        }
    }
    @Deprecated("Native export picker") override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 812) return
        val generation = exportGeneration; val origin = exportOrigin; exportGeneration = null; exportOrigin = null
        if (resultCode != RESULT_OK) return
        val destination = data?.data ?: return
        task.start("", {}, {
            val access = CentralAccess.resolve(this); check(access.generation == generation && access.server == origin)
            contentResolver.openOutputStream(destination)?.use { requireNotNull(access.client).download("/api/files/" + android.net.Uri.encode(key("capture")) + "/content", it) } ?: error("Destination unavailable")
        }) { result -> Toast.makeText(this, MoteI18n.text(if (result.isSuccess) "本机原件已导出" else "原件导出未完成，请重新打开内容后重试"), Toast.LENGTH_LONG).show() }
    }
    private fun text(value: String, role: NativeFontRole = NativeFontRole.BODY) { body.addView(TextView(this).apply { text = value; setTextIsSelectable(true); MoteUi.type(this, role); MoteUi.textColor(this, NativeColorRole.INK); setPadding(0, moteDp(8), 0, moteDp(8)) }) }
    private fun button(value: String, action: () -> Unit) { body.addView(MoteUi.button(Button(this).apply { text = value; setOnClickListener { action() } })) }
}
