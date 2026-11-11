package dev.mote.collector

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import dev.mote.collector.plugins.LibraryReader
import dev.mote.collector.plugins.NativeLibraryPlugin
import dev.mote.collector.ui.MoteComponents

/** Pinned original/Material reader. The plugin owns every lookup and access
 * check; this Activity only routes the intent, renders one returned page and
 * hands member/export actions back to the plugin. */
class LibrarySourceReaderActivity : MoteActivity() {
    companion object {
        internal fun open(context: Context, origin: String, type: String, source: String, external: String, device: String, revision: String, capture: String = "", local: Boolean = false) {
            context.startActivity(Intent(context, LibrarySourceReaderActivity::class.java).putExtra("origin", origin).putExtra("type", type).putExtra("source", source).putExtra("external", external).putExtra("device", device).putExtra("revision", revision).putExtra("capture", capture).putExtra("local", local))
        }
    }
    private lateinit var body: LinearLayout
    private val task by lazy { UiTask(this) }
    private val reader by lazy { NativeLibraryPlugin.owner(this).reader() }
    private var generation = 0
    private var offset = 0
    private var memberOffset = 0
    private var exportGeneration: Long? = null
    private var exportOrigin: String? = null
    private fun key(name: String) = intent.getStringExtra(name).orEmpty()
    private fun request() = LibraryReader.Request(
        origin = key("origin"), type = key("type"), source = key("source"), external = key("external"),
        device = key("device"), revision = key("revision"), capture = key("capture"),
        local = intent.getBooleanExtra("local", false),
    )
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
    private fun load() {
        if (task.busy) return
        val stamp = ++generation
        body.removeAllViews(); body.addView(MoteComponents.skeleton(this, MoteI18n.text("正在读取…")))
        task.start("", {}, { reader.open(request(), offset, memberOffset) }) { result ->
            if (stamp != generation) { load(); return@start }
            body.removeAllViews()
            // A result assembled under a selection that has since been revoked
            // never reaches the page: only the unreadable notice is published.
            if (reader.unreadable(request())) { unavailable(); return@start }
            when (result) {
                is LibraryReader.Unreadable -> unavailable()
                is LibraryReader.Failed -> { text(result.error.message ?: MoteI18n.text("内容暂不可读取，原数据保留。")); retry() }
                is LibraryReader.Available -> render(result.page)
            }
            MoteUi.styleTree(body)
        }
    }
    private fun render(page: LibraryReader.LibraryPage) {
        val type = key("type")
        text(page.item.optString("title", page.item.optString("windowTitle")), NativeFontRole.TITLE_MOBILE)
        text(MoteI18n.text(if (type == "material") "整理资料" else "原文与出处"), NativeFontRole.SECTION)
        if (type == "material") text(LocalContentPresentation.centralStatus(null, page.item))
        text(page.text.ifBlank { MoteI18n.text("此版本没有保存正文。") })
        page.item.optString("sourceDescription").takeIf(String::isNotBlank)?.let(::text)
        page.item.optJSONObject("attributionContext")?.let { context ->
            text(MoteI18n.text("内容与我的关系") + " · " + MoteI18n.text(when(context.optString("ownerRelation")) { "owner" -> "我的表达或经历"; "third_party" -> "第三方内容"; "mixed" -> "混合内容"; else -> "归属未知" }))
        }
        page.item.optJSONArray("evidenceRefs")?.let { refs -> repeat(refs.length()) { index -> button(MoteI18n.text("查看原始记录")) { openMember(refs.getString(index)) } } }
        page.nextOffset?.let { next -> button(MoteI18n.text("继续展开")) { offset = next; load() } }
        if (offset > 0) button(MoteI18n.text("返回原文开头")) { offset = 0; load() }
        val ref = page.item.optString("memoryMaterialRef")
        Regex("^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$").matchEntire(ref)?.let { match -> button(MoteI18n.text("整理资料")) { open(this, key("origin"), "material", match.groupValues[1], "", "", match.groupValues[2]) } }
        page.file?.let { file ->
            text(LocalContentPresentation.centralStatus(file, null))
            if (file.optBoolean("hasOriginal")) button(MoteI18n.text("保存原件")) {
                val selection = reader.selection()
                exportGeneration = selection.generation; exportOrigin = selection.server
                @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(file.optJSONObject("item")?.optString("mimeType") ?: "application/octet-stream").putExtra(Intent.EXTRA_TITLE, page.item.optString("windowTitle", "mote-file")), 812)
            }
        }
        page.members?.let { members ->
            text(MoteI18n.text("原始依据"), NativeFontRole.SECTION)
            val items = members.getJSONArray("items")
            repeat(items.length()) { index -> val memberRef = items.getJSONObject(index).getString("ref"); button(memberRef) { openMember(memberRef) } }
            if (!members.isNull("nextOffset")) button(MoteI18n.text("加载更多")) { memberOffset = members.getInt("nextOffset"); load() }
            if (memberOffset > 0) button(MoteI18n.text("返回")) { memberOffset = 0; load() }
        }
        page.history?.let { history ->
            text(MoteI18n.text("历史版本"), NativeFontRole.SECTION)
            repeat(history.length()) { index -> val version = history.getJSONObject(index)
                button(version.getString("revision")) { open(this, key("origin"), "original", key("source"), key("external"), key("device"), version.getString("revision"), version.getString("captureId")) }
            }
        }
    }
    private fun unavailable() {
        body.removeAllViews(); text(MoteI18n.text("内容暂不可读取，原数据保留。")); retry()
    }
    private fun retry() { button(MoteI18n.text("重试")) { load() }; MoteUi.styleTree(body) }
    private fun openMember(ref: String) {
        val stamp = generation
        task.start("", {}, { reader.member(ref) }) { result ->
            if (stamp != generation || reader.unreadable(request())) {
                if (!isFinishing && !isDestroyed) load()
                return@start
            }
            when (result) {
                is LibraryReader.MemberReference -> open(this, key("origin"), "evidence", result.reference, "", "", "")
                is LibraryReader.MemberCapture -> {
                    val record = result.record; val provenance = record.optJSONObject("provenance")
                    if (provenance != null) open(this, result.server, "original", provenance.getString("sourceId"), provenance.getString("externalId"), record.getString("deviceId"), provenance.getString("revision"), record.getString("id"))
                    else startActivity(Intent(this, CaptureRecordsActivity::class.java).putExtra("recordId", record.getString("id")).putExtra("recordRemote", true).putExtra("recordOrigin", result.server).putExtra("recordDeviceId", record.getString("deviceId")).putExtra("recordVersion", NativeLibraryPlugin.version(record)).putExtra("recordSource", record.getString("source")))
                }
                is LibraryReader.MemberUnreadable -> unavailable()
                is LibraryReader.MemberFailed -> { body.removeAllViews(); text(result.error.message.orEmpty()); retry() }
            }
        }
    }
    @Deprecated("Native export picker") override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 812) return
        val generation = exportGeneration; val origin = exportOrigin; exportGeneration = null; exportOrigin = null
        if (resultCode != RESULT_OK) return
        val destination = data?.data ?: return
        task.start("", {}, { reader.export(this, request(), generation, origin, destination) }) { result ->
            Toast.makeText(this, MoteI18n.text(if (result.isSuccess) "本机原件已导出" else "原件导出未完成，请重新打开内容后重试"), Toast.LENGTH_LONG).show()
            if (!isFinishing && !isDestroyed) load()
        }
    }
    private fun text(value: String, role: NativeFontRole = NativeFontRole.BODY) { body.addView(TextView(this).apply { text = value; setTextIsSelectable(true); MoteUi.type(this, role); MoteUi.textColor(this, NativeColorRole.INK); setPadding(0, moteDp(8), 0, moteDp(8)) }) }
    private fun button(value: String, action: () -> Unit) { body.addView(MoteUi.button(Button(this).apply { text = value; setOnClickListener { action() } })) }
}
