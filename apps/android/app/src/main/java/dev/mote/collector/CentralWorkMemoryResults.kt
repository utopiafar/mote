package dev.mote.collector

import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import org.json.JSONObject

/** Work receipts contain IDs only; every listed and opened Memory is owner-read again. */
internal class CentralWorkMemoryResults(
    private val screens: CentralScreens,
    private val isCurrentWork: (String) -> Boolean,
    private val refreshWork: (String) -> Unit,
) {
    private val ui get()=screens.ui
    private var workId: String? = null
    private val cursors=mutableListOf<String?>(null)
    private var selected: String? = null
    private var returnScroll=0
    private var pendingScroll: Int? = null
    private var identity: String? = null
    private var retryingReader=false
    private var retryDrafts=emptyList<Pair<MemoryTopicEdit,String>>()
    private var readerPendingScroll: Int? = null
    private var memoryScroll=0
    private var restoringSelection=false
    private var live=false
    private fun current(work: String, cursor: String?) = workId==work && cursors.lastOrNull()==cursor && isCurrentWork(work)
    private fun path(work: String, cursor: String?) = "/api/work-activity/"+CentralScreens.encode(work)+"/memory-results?limit=20"+(cursor?.let{"&cursor="+CentralScreens.encode(it)}?:"")
    private fun read(api: CentralClient, work: String, cursor: String?) = WorkMemoryPage.read(api.get(path(work,cursor)),cursor)
    private fun contains(api: CentralClient, work: String, cursor: String?, id: String) = id in read(api,work,cursor).ids
    private fun identity(id: String, row: JSONObject) = WorkMemoryReference.identity(id,row)
    private fun children(view: View): List<View> = listOf(view)+if(view is ViewGroup)(0 until view.childCount).flatMap{children(view.getChildAt(it))}else emptyList()
    private fun draftKey(): WorkMemoryDrafts.Key? {
        val work=workId?:return null;val id=selected?:return null;val snapshot=identity?:return null
        return WorkMemoryDrafts.Key(ui.server,ui.currentAccessGeneration,work,id,snapshot)
    }
    fun rememberDrafts() {
        val key=draftKey()?:return
        val fields=children(screens.body).filterIsInstance<EditText>().mapNotNull { field -> (field.tag as? MemoryTopicEdit)?.let { it to field.text.toString() } }
        if(fields.isEmpty())return
        memoryScroll=ui.contentScroll()
        WorkMemoryDrafts.remember(key,fields.filter { (edit,value)->edit.forceDirty||edit.initial!=value }.associate { (edit,value)->edit.key to value },memoryScroll)
    }
    fun clear() { draftKey()?.let(WorkMemoryDrafts::take);workId=null;cursors.clear();cursors.add(null);selected=null;returnScroll=0;pendingScroll=null;identity=null;retryingReader=false;retryDrafts=emptyList();readerPendingScroll=null;memoryScroll=0;restoringSelection=false;live=false }
    fun save(out: Bundle) {
        rememberDrafts();out.putString("memoryResultWork",workId);out.putString("memoryResultSelected",selected);out.putInt("memoryResultScroll",returnScroll)
        out.putString("memoryResultSnapshot",identity);out.putInt("memoryResultDetailScroll",memoryScroll)
        out.putStringArrayList("memoryResultCursors",ArrayList(cursors.map{it.orEmpty()}))
    }
    fun restore(out: Bundle) {
        clear();val work=out.getString("memoryResultWork")?.takeIf{it.isNotBlank()&&it.length<=512}?:return
        val values=out.getStringArrayList("memoryResultCursors")?:return
        if(values.isEmpty()||values.size>100||values.first().isNotEmpty()||values.drop(1).any{!WorkMemoryPage.validId(it)}||values.distinct().size!=values.size)return
        workId=work;cursors.clear();cursors.addAll(values.map{it.takeIf(String::isNotBlank)});selected=out.getString("memoryResultSelected")?.takeIf(WorkMemoryPage::validId);returnScroll=out.getInt("memoryResultScroll").coerceAtLeast(0)
        identity=out.getString("memoryResultSnapshot")?.takeIf{it.matches(Regex("^[a-f0-9]{64}$"))};memoryScroll=out.getInt("memoryResultDetailScroll").coerceAtLeast(0);restoringSelection=selected!=null && identity!=null
    }
    fun hasSelection(work: String) = workId==work && selected!=null
    fun showSelected(work: String) {
        val id=selected?.takeIf{current(work,cursors.last())}?:return
        val api=screens.client
        // A restored reader never passed through render(): refresh the work state before
        // deciding whether its polling re-arms, then run the normal fresh open reads.
        ui.work("", { runCatching { api.get("/api/work-activity/"+CentralScreens.encode(work)+"?limit=1&cursor=0").getString("state") } }) { result ->
            if(!current(work,cursors.last())||selected!=id||screens.client!==api)return@work
            result.onSuccess { live=WorkPolling.live(it) }
            open(work,id,cursors.last(),returnScroll,preserveIdentity=restoringSelection)
        }
    }
    fun restoreAfterReader(work: String, scroll: Int) { if(hasSelection(work)){readerPendingScroll=scroll;poll(work)} else { screens.body.removeAllViews();screens.body.visibility=View.VISIBLE } }
    fun render(work: String, target: LinearLayout, previousScroll: Int, live: Boolean) {
        if(workId!=work){clear();workId=work}
        this.live=live
        val cursor=cursors.last();val api=screens.client
        target.removeAllViews()
        ui.work(MoteI18n.text("正在读取…"), { runCatching {
            val page=read(api,work,cursor)
            val rows=page.ids.map { id ->
                val value=runCatching { api.get("/api/memories/"+CentralScreens.encode(id)).also { row->check(row.getString("id")==id);row.getString("title") } }
                value.exceptionOrNull()?.let { error->if(error is CentralFailure && error.status in setOf(401,403))throw error }
                id to value.getOrNull()
            }
            check(read(api,work,cursor)==page)
            page to rows
        } }) { result ->
            if(!current(work,cursor)||selected!=null||screens.client!==api)return@work
            target.removeAllViews()
            result.onSuccess { (page,rows) ->
                if(rows.isEmpty())ui.text(MoteI18n.text("没有符合条件的内容"),parent=target)
                rows.forEach { (id,row) ->
                    if(row==null){ui.text(MoteI18n.text("暂不可用"),parent=target);ui.button(MoteI18n.text("重试"),parent=target){refreshWork(work)}}
                    else {
                        var touchScroll: Int?=null
                        val item=ui.selectRow(row.getString("title"),MoteI18n.text("查看详情"),target) { val position=touchScroll?:ui.contentScroll();touchScroll=null;open(work,id,cursor,position) }
                        item.tag="work-memory:$id"
                        item.setOnTouchListener { view,event -> when(event.actionMasked){MotionEvent.ACTION_DOWN->touchScroll=ui.contentScroll();MotionEvent.ACTION_CANCEL->touchScroll=null;MotionEvent.ACTION_UP->view.post{touchScroll=null}};false }
                    }
                }
                if(cursors.size>1)ui.button(MoteI18n.text("上一页"),parent=target){cursors.removeAt(cursors.lastIndex);pendingScroll=0;refreshWork(work)}
                page.next?.let { next->ui.button(MoteI18n.text("下一页"),parent=target){if(next !in cursors){cursors.add(next);pendingScroll=0;refreshWork(work)}} }
                ui.restoreContentScroll(pendingScroll ?: previousScroll);pendingScroll=null
            }.onFailure { error ->
                ui.text(if(error is CentralFailure) error.message.orEmpty() else MoteI18n.text("中央响应格式无效，请刷新后重试。"),parent=target)
                ui.button(MoteI18n.text("重试"),parent=target){refreshWork(work)}
            }
            if(live)ui.scheduleActivityPoll()
        }
    }
    private fun open(work: String, id: String, cursor: String?, scroll: Int, preserveIdentity: Boolean = false) {
        if(!current(work,cursor)||!WorkMemoryPage.validId(id))return
        selected=id;returnScroll=scroll;if(!preserveIdentity)identity=null
        screens.openWorkMemory(id, { back(work) }, { row ->
            if(!current(work,cursor)||selected!=id)false
            else {
                val value=identity(id,row)
                if(value==null || identity!=null&&identity!=value){unavailable(work);false}else{identity=value;true}
            }
        }, { api -> contains(api,work,cursor,id) }, { if(current(work,cursor)&&selected==id)identity?.let { WorkMemoryReference(work,cursor,id,it) } else null }, {
            if(retryingReader) {
                children(screens.body).filterIsInstance<EditText>().forEach { field -> retryDrafts.firstOrNull { it.first.key==(field.tag as? MemoryTopicEdit)?.key }?.let { field.setText(it.second) } }
                retryDrafts=emptyList();retryingReader=false
            }
            if(restoringSelection) {
                val saved=draftKey()?.let(WorkMemoryDrafts::take)
                children(screens.body).filterIsInstance<EditText>().forEach { field -> saved?.edits?.get((field.tag as? MemoryTopicEdit)?.key)?.let(field::setText) }
                ui.restoreContentScroll(saved?.scroll ?: memoryScroll);restoringSelection=false
            }
            if(live)ui.scheduleActivityPoll()
        }, { error -> failure(work,error) })
    }
    private fun back(work: String) {
        if(!isCurrentWork(work))return
        draftKey()?.let(WorkMemoryDrafts::take);selected=null;identity=null;retryingReader=false;retryDrafts=emptyList();readerPendingScroll=null;pendingScroll=returnScroll;restoringSelection=false
        ui.enterDetail();screens.body.removeAllViews();screens.body.visibility=View.VISIBLE;refreshWork(work)
    }
    private fun unavailable(work: String, message: String = MoteI18n.text("请求的资源不存在或已删除。"), retry: Boolean = false) {
        if(!isCurrentWork(work))return
        val drafts=children(screens.body).filterIsInstance<EditText>().mapNotNull { field ->
            (field.tag as? MemoryTopicEdit)?.takeIf { it.forceDirty||it.initial!=field.text.toString() }?.let { it to field.text.toString() }
        }.toMutableList()
        draftKey()?.let(WorkMemoryDrafts::take)?.edits?.forEach { (key,value)->
            val label=when(key){"statement"->MoteI18n.text("陈述");"title"->MoteI18n.text("标题");"uncertainty"->MoteI18n.text("不确定性");else->return@forEach}
            if(drafts.none{it.first.key==key})drafts.add(MemoryTopicEdit(label,"",key,forceDirty=true) to value)
        }
        restoringSelection=false
        screens.body.removeAllViews();screens.setBack{back(work)}
        ui.text(message)
        if(drafts.isNotEmpty()) { ui.text(MoteI18n.text("有未保存的更改"));drafts.forEach { (edit,value)->ui.field(edit.label,value,multiline=true).tag=edit } }
        if(retry)ui.button(MoteI18n.text("重试")) {
            retryDrafts=children(screens.body).filterIsInstance<EditText>().mapNotNull { field -> (field.tag as? MemoryTopicEdit)?.let { it to field.text.toString() } }
            retryingReader=true;selected?.let { open(work,it,cursors.last(),returnScroll,preserveIdentity=true) }
        }
        ui.button(MoteI18n.text("返回活动")){back(work)}
    }
    private fun failure(work: String, error: Throwable) {
        if(!isCurrentWork(work))return
        when {
            error is WorkMemoryUnavailable -> unavailable(work)
            error is CentralFailure && error.status in setOf(401,403,404,410) -> {
                unavailable(work,if(error.status in setOf(404,410)) MoteI18n.text("请求的资源不存在或已删除。") else error.message.orEmpty())
                if(error.status==401)ui.requestFailure(error)
            }
            else -> {
                if(restoringSelection) { unavailable(work,if(error is CentralFailure) error.message.orEmpty() else MoteI18n.text("连接暂时中断，请检查网络。"),true);return }
                if(retryingReader) { unavailable(work,if(error is CentralFailure) error.message.orEmpty() else MoteI18n.text("连接暂时中断，请检查网络。"),true);return }
                if(identity==null)selected=null
                ui.notice(if(error is CentralFailure) error.message.orEmpty() else MoteI18n.text("连接暂时中断，请检查网络。"))
                if(live)ui.scheduleActivityPoll()
            }
        }
    }
    fun poll(work: String) {
        val id=selected ?: return;val cursor=cursors.last();val api=screens.client;val afterReaderScroll=readerPendingScroll
        ui.work("", { runCatching {
            if(!contains(api,work,cursor,id))throw WorkMemoryUnavailable();val row=api.get("/api/memories/"+CentralScreens.encode(id));if(!contains(api,work,cursor,id))throw WorkMemoryUnavailable();row
        } }) { result ->
            if(!current(work,cursor)||selected!=id||screens.client!==api)return@work
            if(afterReaderScroll!=null)readerPendingScroll=null
            result.onSuccess { row ->
                if(identity(id,row)!=identity)unavailable(work)
                else { if(afterReaderScroll!=null)screens.body.visibility=View.VISIBLE;afterReaderScroll?.let(ui::restoreContentScroll);if(live)ui.scheduleActivityPoll() }
            }
                .onFailure { error ->
                    if(afterReaderScroll!=null && error !is WorkMemoryUnavailable && !(error is CentralFailure && error.status in setOf(401,403,404,410)))
                        unavailable(work,if(error is CentralFailure) error.message.orEmpty() else MoteI18n.text("连接暂时中断，请检查网络。"),true)
                    else failure(work,error)
                }
            if(afterReaderScroll!=null)screens.body.visibility=View.VISIBLE
        }
    }
}
