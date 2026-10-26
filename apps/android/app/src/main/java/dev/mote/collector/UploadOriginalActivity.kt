package dev.mote.collector

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import org.json.JSONObject

/** Resolves metadata again on every read/export; never keeps historical body copies. */
class UploadOriginalActivity : MoteActivity() {
    private val task by lazy { UiTask(this) }
    private lateinit var body: LinearLayout
    private lateinit var status: TextView
    private var resumed = false
    private var readGeneration = 0L
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        body = moteDetailPage(primary = MotePrimaryTab.SOURCES, title = MoteI18n.text("查看原件"))
    }
    override fun onResume() { super.onResume(); resumed = true; load() }
    override fun onPause() { resumed = false; readGeneration++; body.removeAllViews(); super.onPause() }
    private fun find(): HistoryItem = UploadHistoryModel.read(applicationContext).single { it.id == intent.getStringExtra("batchId") }.items.single { it.key == intent.getStringExtra("itemKey") }
    private fun load() {
        val generation = ++readGeneration
        val batchId = intent.getStringExtra("batchId"); val itemKey = intent.getStringExtra("itemKey")
        body.removeAllViews(); status = TextView(this).apply { text = MoteI18n.text("正在读取原文…") }.also(body::addView)
        // UiTask retains a paused completion. Its invalidated callback will start the fresh read.
        if (task.busy) return
        val access = CentralAccess.resolve(applicationContext)
        val scope = CaptureUploadReceipt.scope(access.server, Settings(this).deviceId)
        fun current(): Boolean = resumed && generation == readGeneration &&
            intent.getStringExtra("batchId") == batchId && intent.getStringExtra("itemKey") == itemKey &&
            CentralAccess.resolve(applicationContext).let { it.server == access.server && it.generation == access.generation }
        task.start(MoteI18n.text("正在读取原文…"), { if (resumed && generation == readGeneration) status.text = it }, {
            val item = find()
            check(item.key == itemKey && item.identity?.scope == scope && item.identity.origin == access.server)
            item to HistoryOriginal.read(applicationContext, item)
        }) { result ->
            if (!current()) { if (resumed) load(); return@start }
            result.onSuccess { (_, content) ->
            status.text = content
            body.addView(Button(this).apply { text = MoteI18n.text("保存原件"); setOnClickListener {
                startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, "mote-original"), 812)
            } })
        }.onFailure { status.text = if (it is CentralFailure) it.message else MoteI18n.text("历史版本暂不可读取：原件可能已更新、不可用或当前离线。请重试。") }
            body.addView(Button(this).apply { text = MoteI18n.text("刷新"); setOnClickListener { load() } }); MoteUi.styleTree(body)
        }
    }
    @Deprecated("Activity result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode,resultCode,data)
        if(requestCode != 812 || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        task.start(MoteI18n.text("正在读取原文…"), {}, {
            val item = find()
            contentResolver.openOutputStream(uri)?.use { HistoryOriginal.export(applicationContext,item,it) } ?: error("Destination unavailable")
        }) { result -> Toast.makeText(this, if(result.isSuccess) MoteI18n.text("已保存") else MoteI18n.text("历史版本暂不可读取：原件可能已更新、不可用或当前离线。请重试。"), Toast.LENGTH_LONG).show(); if (resumed) load() }
    }
}

internal object HistoryOriginal {
    fun exactBody(identity: ItemUploadIdentity, state: JSONObject): JSONObject? {
        val pending = state.optJSONArray("pending") ?: org.json.JSONArray()
        val bodies = (0 until pending.length()).map { pending.getJSONObject(it) } + listOfNotNull(state.optJSONObject("current")?.optJSONObject(identity.externalId)?.optJSONObject("body"))
        return bodies.firstOrNull { it.optString("externalId")==identity.externalId && it.optString("revision")==identity.revision && SourceRules.hash(SourceRules.canonical(it))==identity.fingerprint }
    }
    fun verify(identity: ItemUploadIdentity, captureId: String, row: JSONObject) {
        val provenance = row.optJSONObject("provenance")
        check(row.optString("id")==captureId && row.optString("deviceId")==identity.deviceId && provenance?.optString("sourceId")==identity.sourceId && provenance.optString("externalId")==identity.externalId && provenance.optString("revision")==identity.revision)
    }
    fun verifyFile(identity: ItemUploadIdentity, captureId: String, file: JSONObject) {
        val item=file.getJSONObject("item")
        check(file.optString("captureId")==captureId && file.optString("sourceId")==identity.sourceId && item.optString("externalId")==identity.externalId && item.optString("revision")==identity.revision)
        check(file.optBoolean("hasOriginal") && file.optString("sha256")==identity.sha256 && file.optLong("sizeBytes",-1)==identity.sizeBytes)
    }
    private fun local(context: android.content.Context, item: HistoryItem): ByteArray? {
        val i = requireNotNull(item.identity)
        check(Settings(context).dataOrigin().trimEnd('/') == i.origin)
        return when(i.kind) {
            "source-item" -> exactBody(i,context.localSources().state(i.sourceId))?.getString("text")?.toByteArray(Charsets.UTF_8)
            "attachment" -> runCatching { context.recordDraftStore().bytes(i.attachmentId) }.getOrNull()?.takeIf { it.size.toLong()==i.sizeBytes && FileSnapshotMetadata.hash(it)==i.sha256 }
            else -> null
        }
    }
    private fun remote(context: android.content.Context, item: HistoryItem): Pair<CentralClient,JSONObject> {
        val i = requireNotNull(item.identity); check(item.captureId.isNotBlank())
        val access = CentralAccess.resolve(context); check(access.server.trimEnd('/')==i.origin)
        val client = requireNotNull(access.client)
        val row = client.get("/api/capture-browser/" + android.net.Uri.encode(item.captureId)); verify(i,item.captureId,row)
        if(i.kind != "source-item") {
            val file=client.get("/api/files/" + android.net.Uri.encode(item.captureId))
            verifyFile(i,item.captureId,file)
        }
        check(CentralAccess.resolve(context).generation==access.generation)
        return client to row
    }
    fun read(context: android.content.Context, item: HistoryItem): String {
        val i = requireNotNull(item.identity)
        local(context,item)?.let { return if(i.kind=="source-item") String(it,Charsets.UTF_8) else MoteI18n.text("原件版本已核验，可保存原件。") }
        if(i.kind=="file") {
            val row=context.fileArchives().row(i.sourceId,i.externalId)
            val manifest=row.optJSONObject("pending")?.optJSONObject("manifest")
            if(manifest!=null && manifest.has("sha256") && SourceRules.hash(SourceRules.canonical(manifest))==i.fingerprint) {
                return context.fileArchives().pendingPreview(i.sourceId,i.externalId,i.revision)?.first ?: MoteI18n.text("原件版本已核验，可保存原件。")
            }
        }
        val (_,row)=remote(context,item)
        return if(i.kind=="source-item") row.optString("ocrText") else MoteI18n.text("原件版本已核验，可保存原件。")
    }
    fun export(context: android.content.Context, item: HistoryItem, output: java.io.OutputStream) {
        val i=requireNotNull(item.identity)
        local(context,item)?.let { output.write(it); return }
        if(i.kind=="file") {
            val manifest=context.fileArchives().row(i.sourceId,i.externalId).optJSONObject("pending")?.optJSONObject("manifest")
            if(manifest!=null && manifest.has("sha256") && SourceRules.hash(SourceRules.canonical(manifest))==i.fingerprint) { context.fileArchives().exportPending(i.sourceId,i.externalId,i.revision,output); return }
        }
        val (client,row)=remote(context,item)
        if(i.kind=="source-item") output.write(row.optString("ocrText").toByteArray(Charsets.UTF_8))
        else client.download("/api/files/" + android.net.Uri.encode(item.captureId) + "/content",output,i.sizeBytes)
    }
}
