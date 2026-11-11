package dev.mote.collector

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.content.pm.PackageManager
import android.content.Intent
import android.view.View
import android.widget.*
import dev.mote.collector.plugins.ManagedCalendarController
import dev.mote.collector.plugins.ManagedCalendarPlugin
import dev.mote.collector.plugins.PluginAvailability
import dev.mote.collector.plugins.PluginCenterPresentation
import dev.mote.collector.ui.MoteComponents
import org.json.JSONObject

internal data class NativeTodoDraft(val origin:String,val generation:Long,val text:String)

class CalendarActionsActivity : MoteActivity() {
    private lateinit var status: TextView
    private lateinit var list: LinearLayout
    private lateinit var task: UiTask
    private var calendarIdentity: Pair<String,Long>? = null
    private var calendarEpoch = 0L
    private val calendarDialogs = mutableListOf<android.app.Dialog>()
    private var permissionIdentity: Pair<String,Long>? = null
    private fun identity(): Pair<String,Long> = CentralAccess.resolve(this).let { it.server to it.generation }
    private fun current(expected: Pair<String,Long>?, epoch: Long) = !isDestroyed && calendarIdentity == expected && calendarEpoch == epoch && identity() == expected
    private fun withdrawChangedCalendar(): Pair<String,Long> {
        val next=identity()
        if(calendarIdentity != next) {
            calendarIdentity=next;calendarEpoch++;cursor=0;nextCursor=0;deviceId=""
            if(::list.isInitialized)list.removeAllViews()
            if(::status.isInitialized)status.text=""
            calendarDialogs.toList().forEach { it.dismiss() };calendarDialogs.clear();permissionIdentity=null
        }
        return next
    }
    private fun <T:android.app.Dialog> own(dialog:T):T = dialog.also { calendarDialogs.add(it) }
    private var deviceId = ""
    private var cursor = 0L
    private var nextCursor = 0L
    private var selectedTab = "calendar"
    private var active = false
    private var todoContent: CentralContent? = null
    private var todoState: Bundle? = null
    private var todoIdentity: Pair<String,Long>? = null
    private var restoredTodoDraft: NativeTodoDraft? = null
    private lateinit var tabHost: FrameLayout
    private lateinit var calendarScroll: ScrollView
    private lateinit var tabs: NativeSectionTabs
    private val handler = Handler(Looper.getMainLooper())
    private val poll = object : Runnable { override fun run() { if (selectedTab=="calendar"&&!task.busy) refresh(); if(selectedTab=="calendar")handler.postDelayed(this, 20000) } }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state); window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE); task = UiTask(this)
        restoredTodoDraft=lastNonConfigurationInstance as? NativeTodoDraft
        selectedTab=state?.getString("actionTab")?.takeIf { it in setOf("calendar","todos") } ?: "calendar";todoState=state?.getBundle("todoContent");cursor=state?.getLong("calendarCursor") ?: 0L
        val body = moteDetailPageContent(primary=null,title=MoteI18n.text("日程与待办"),onBack=::navigateBack) { calendarBody->
            LinearLayout(this).apply {
                orientation=LinearLayout.VERTICAL
                tabs=NativeSectionTabs(this@CalendarActionsActivity,listOf("calendar" to "日程","todos" to "待办"),"action-tabs",::selectTab).apply{setPadding(moteDp(20),0,moteDp(20),0)};addView(tabs)
                tabHost=FrameLayout(this@CalendarActionsActivity);addView(tabHost,LinearLayout.LayoutParams(-1,0,1f))
                calendarScroll=ScrollView(this@CalendarActionsActivity).apply{isFillViewport=true;addView(calendarBody)};tabHost.addView(calendarScroll,FrameLayout.LayoutParams(-1,-1))
            }
        }
        status = TextView(this); body.addView(status)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(list)
        showAvailability()
        val tools=SecondaryUi.disclosure(body,MoteI18n.text("更多"),"calendar-tools")
        text(tools,MoteI18n.text("从资料中发现安排。范围授权内的日程交给指定设备，其余逐条确认；结果保留在行动历史。"))
        text(tools,MoteI18n.text("首次使用：在中央网页「行动」开启发现，并授权此设备查看跨来源的建议及原文片段。"))
        button(tools,MoteI18n.text("连接本机日历")){if(calendarPermissions())connect()else {permissionIdentity=withdrawChangedCalendar();requestPermissions(arrayOf(Manifest.permission.READ_CALENDAR,Manifest.permission.WRITE_CALENDAR),401)}}
        button(tools,MoteI18n.text("最新建议")){cursor=0;refresh()}
        button(tools,MoteI18n.text("更早建议")){if(nextCursor>0){cursor=nextCursor;refresh()}}
        button(tools,MoteI18n.text("刷新并同步已确认日程"),primary=true){sync()}
        MoteUi.styleTree(body)
        if(Build.VERSION.SDK_INT>=33)onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,::navigateBack)
        selectTab(selectedTab)
    }
    private fun selectTab(next:String){
        withdrawChangedCalendar()
        selectedTab=next;tabs.select(next);handler.removeCallbacks(poll)
        calendarScroll.visibility=if(next=="calendar")View.VISIBLE else View.GONE
        if(next=="todos"){
            val access=CentralAccess.resolve(this);val identity=access.server to access.generation
            if(todoIdentity!=null&&todoIdentity!=identity){todoContent?.let { it.close();tabHost.removeView(it.root) };todoContent=null;todoState=null;restoredTodoDraft=null}
            todoIdentity=identity
            val todos=todoContent ?: CentralContent(this,todoState,initialPage="actions",embeddedActions=true,openCalendar={selectTab("calendar")}).also { it.restoreTodoDraft(restoredTodoDraft);restoredTodoDraft=null;todoContent=it;todoState=null;tabHost.addView(it.root,FrameLayout.LayoutParams(-1,-1)) }
            todos.root.visibility=View.VISIBLE;if(active)todos.resume()
        }else{
            todoContent?.root?.visibility=View.GONE;todoContent?.pause()
            if(!task.busy)refresh();if(active)handler.postDelayed(poll,20000)
        }
    }
    private fun navigateBack(){if(selectedTab=="todos"&&todoContent?.backWithinPage()==true)return;finish()}
    @Deprecated("Native back navigation") override fun onBackPressed()=navigateBack()
    override fun onSaveInstanceState(state:Bundle){state.putString("actionTab",selectedTab);state.putLong("calendarCursor",cursor);state.putBundle("todoContent",Bundle().also { todoContent?.saveState(it) ?: todoState?.let(it::putAll) });super.onSaveInstanceState(state)}
    override fun onResume(){super.onResume();active=true;selectTab(selectedTab)}
    @Deprecated("In-memory generated owner draft") override fun onRetainNonConfigurationInstance():Any?=todoContent?.retainTodoDraft() ?: restoredTodoDraft
    override fun onPause(){active=false;handler.removeCallbacks(poll);todoContent?.pause();super.onPause()}
    override fun onDestroy(){calendarDialogs.toList().forEach{it.dismiss()};calendarDialogs.clear();todoContent?.close();super.onDestroy()}
    @Deprecated("Native document picker") override fun onActivityResult(request:Int,result:Int,data:Intent?){super.onActivityResult(request,result,data);todoContent?.activityResult(request,result,data)}
    private fun text(parent: LinearLayout, value: String, size: Float = MoteTheme.fontBody.toFloat()) = TextView(this).apply { text = value; MoteUi.type(this, if (size >= 20f) MoteTheme.fontSection else size.toInt(), medium = size >= 20f); MoteUi.textColor(this, NativeColorRole.INK); setPadding(0, moteDp(MoteTheme.spaceInline), 0, moteDp(MoteTheme.spaceInline)); setTextIsSelectable(true) }.also(parent::addView)
    private fun button(parent: LinearLayout, title: String, primary: Boolean = false, fn: () -> Unit) {
        val expected=calendarIdentity;val epoch=calendarEpoch
        parent.addView(MoteUi.button(Button(this).apply { text = title; setOnClickListener {
            val valid=expected==null || current(expected,epoch)
            withdrawChangedCalendar()
            if(valid&&!task.busy)fn()
        } }, primary), LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(MoteTheme.spaceInline) })
    }
    private fun calendarPermissions() = listOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR).all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
    private fun showAvailability(): Boolean {
        val state = ManagedCalendarPlugin.availability(applicationContext)
        if (state == PluginAvailability.ACTIVE) return true
        status.text = PluginCenterPresentation.availability(state)
        return false
    }
    private fun work(label: String, read: Boolean = false, fn: ManagedCalendarController.(Long) -> JSONObject) {
        if (!showAvailability()) return
        val expected=withdrawChangedCalendar();val epoch=calendarEpoch;val page=cursor
        val show = MoteComponents.progress(status, read)
        task.start(label, { if(current(expected,epoch))show(it) else withdrawChangedCalendar() }, {
            val client=ManagedCalendarPlugin.controller(applicationContext,foreground=true,sessionIdentity=expected)
            client.fn(page) to Settings(applicationContext).deviceId
        }) { result ->
            if(!current(expected,epoch)){withdrawChangedCalendar();if(active&&selectedTab=="calendar")refresh();return@start}
            result.onSuccess { (data, device) -> deviceId=device;render(data);status.text=MoteI18n.text("已刷新。范围授权内的日程由设备执行，其余建议仍需确认。") }
                .onFailure { status.text=it.message ?: MoteI18n.text("操作失败，请重试") }
        }
    }
    private fun refresh() = work(MoteI18n.text("正在读取日程建议…"), read = true) { page -> refresh(page) }
    private fun connect() = work(MoteI18n.text("正在连接日历…")) { page -> connectAndList(page) }
    private fun sync() = work(MoteI18n.text("正在同步已确认日程…")) { page -> sync(page) }
    private fun render(data: JSONObject) {
        nextCursor = if (data.isNull("nextCursor")) 0 else data.optLong("nextCursor")
        list.removeAllViews(); val items = data.getJSONArray("items")
        if (items.length() == 0) text(list, MoteI18n.text("尚未发现日程。上传资料或继续采集后会自动分析。"))
        for (i in 0 until items.length()) {
            val a = items.getJSONObject(i); val e = a.getJSONObject("event"); val state = a.getString("status")
            val managed = a.optJSONObject("managed")
            val card = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(MoteTheme.spacePanel), moteDp(MoteTheme.spaceInline), moteDp(MoteTheme.spacePanel), moteDp(MoteTheme.spaceInline)); background = MoteUi.shape(this@CalendarActionsActivity); tag="calendar-action:"+a.getString("id") }; list.addView(card, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(MoteTheme.spaceItem) })
            text(card, e.getString("title"), 21f)
            val kind = a.getString("kind")
            text(card, when (kind) { "calendar.update" -> MoteI18n.text("更新日程"); "calendar.cancel" -> MoteI18n.text("取消日程"); "calendar.complete" -> MoteI18n.text("标记安排完成"); else -> MoteI18n.text("添加日程") })
            a.optJSONObject("related")?.getJSONObject("event")?.let { text(card, MoteI18n.text("原安排") + ": " + it.getString("title") + " · " + it.optString("start") + " → " + it.optString("end")) }
            if (managed?.has("cancelRequestedAt") == true && state == "succeeded") text(card, MoteI18n.text("取消请求后收到成功回执；未删除系统日历事件。"))
            val label = ManagedCalendarPlugin.stateKey(kind,state,a.optString("resolution"),managed?.optString("state").orEmpty())?.let { MoteI18n.text(it) } ?: state
            text(card, label).apply { tag="calendar-action-status:"+a.getString("id") }
            text(card, "${e.optString("start")} → ${e.optString("end")}\n${e.optString("timeZone")} · ${e.optString("location")}")
            if (a.optString("uncertainty").isNotBlank()) text(card, a.getString("uncertainty"))
            button(card, MoteI18n.text("查看原文依据")) { val evidence = a.getJSONArray("evidence"); val content = (0 until evidence.length()).joinToString("\n\n") { val r = evidence.getJSONObject(it); "${r.getString("source")} · ${r.getString("capturedAt")}\n${r.getString("quote")}" }; own(MoteDialogBuilder(this).setTitle(MoteI18n.text("原文依据")).setMessage(content).setPositiveButton(MoteI18n.text("关闭"), null).create()).show() }
            if (state == "proposed" && !a.has("resolution")) {
                button(card, if (kind == "calendar.create") MoteI18n.text("核对并添加到日历") else MoteI18n.text("核对变更")) { edit(a, data) }
                button(card, MoteI18n.text("忽略这条建议")) { work(MoteI18n.text("正在保存选择…")) { page -> dismiss(a); list(page) } }
            }
            if (a.optJSONObject("target")?.optString("deviceId") == deviceId && state in listOf("approved", "executing", "uncertain")) button(card, MoteI18n.text("写入 / 核实保存结果"), primary = true) { work(MoteI18n.text("正在写入已确认日程…")) { page -> execute(a.getString("id"), a.optJSONObject("managed")?.let { a.getString("operationId") }); list(page) } }
        }
    }
    private fun edit(action: JSONObject, data: JSONObject) {
        val expected=calendarIdentity;val epoch=calendarEpoch
        fun valid()=current(expected,epoch).also { if(!it)withdrawChangedCalendar() }
        val kind = action.getString("kind"); val related = action.optJSONObject("related")
        if (kind in listOf("calendar.cancel", "calendar.complete")) {
            val event = action.getJSONObject("event")
            val target = related?.optJSONObject("target")
            if (target != null && target.getString("deviceId") != deviceId) { status.text = MoteI18n.text("请在原设备确认，或使用中央网页"); return }
            val message = if (kind == "calendar.complete") MoteI18n.text("确认后仅在 Mote 中标记完成。") else if (related?.has("externalId") == true) MoteI18n.text("确认后取消原设备上的这一条日程。") else MoteI18n.text("确认后取消尚未写入日历的原建议。")
            own(MoteDialogBuilder(this).setTitle(if (kind == "calendar.cancel") MoteI18n.text("取消日程") else MoteI18n.text("标记安排完成")).setMessage(event.getString("title") + "\n" + event.optString("start") + " → " + event.optString("end") + "\n" + message).setNegativeButton(MoteI18n.text("返回"), null).setPositiveButton(MoteI18n.text("确认变更")) { _, _ -> if(valid())work(MoteI18n.text("正在确认变更…")) { page -> val confirmed = confirm(action, event, null); if (confirmed.getString("status") == "approved") execute(confirmed.getString("id")); list(page) } }.create()).show()
            return
        }
        if (related?.optJSONObject("target")?.getString("deviceId")?.let { it != deviceId } == true) { status.text = MoteI18n.text("请在原设备确认，或使用中央网页"); return }
        val requiresCalendar = related == null || related.has("externalId")
        if (requiresCalendar && !calendarPermissions()) { status.text = MoteI18n.text("请先连接本机日历"); return }
        val targets = data.getJSONArray("targets"); var choices = org.json.JSONArray()
        for (i in 0 until targets.length()) if (targets.getJSONObject(i).getString("deviceId") == deviceId) choices = targets.getJSONObject(i).getJSONArray("calendars")
        if (!requiresCalendar) choices = org.json.JSONArray().put(JSONObject().put("id", "").put("title", MoteI18n.text("仅更新原建议")))
        if (choices.length() == 0) { status.text = MoteI18n.text("请先连接本机日历，并在系统日历中添加可写账户"); return }
        val event = action.getJSONObject("event"); val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(MoteTheme.spacePanel), moteDp(MoteTheme.spaceInline), moteDp(MoteTheme.spacePanel), moteDp(MoteTheme.spaceInline)) }
        val allDay = CheckBox(this).apply { text = MoteI18n.text("全天"); isChecked = event.getBoolean("allDay") }; form.addView(allDay)
        text(form, MoteI18n.text("点击日期字段选择时间。全天日程的结束日期不包含当天。时区可修改。"))
        val fields = linkedMapOf<String, EditText>()
        for ((key, label) in listOf("title" to MoteI18n.text("标题"), "start" to MoteI18n.text("开始"), "end" to MoteI18n.text("结束"), "timeZone" to MoteI18n.text("时区"), "location" to MoteI18n.text("地点"), "description" to MoteI18n.text("备注"))) {
            text(form, label); val input = EditText(this).apply { setText(if (event.isNull(key)) "" else event.getString(key)); contentDescription = label; maxLines = 3 }; fields[key] = input; form.addView(input)
            if (key == "start" || key == "end") { input.isFocusable = false; input.setOnClickListener {
                val zone = runCatching { java.time.ZoneId.of(fields["timeZone"]?.text.toString()) }.getOrDefault(java.time.ZoneId.systemDefault())
                val previous = runCatching { java.time.OffsetDateTime.parse(input.text.toString()).atZoneSameInstant(zone) }.getOrDefault(java.time.ZonedDateTime.now(zone))
                own(DatePickerDialog(this, { _, y, m, d ->
                    val date = java.time.LocalDate.of(y, m + 1, d)
                    if (allDay.isChecked) input.setText(date.toString())
                    else own(TimePickerDialog(this, { _, h, minute ->
                        val local = date.atTime(h, minute); val offsets = zone.rules.getValidOffsets(local)
                        if (offsets.size != 1) { Toast.makeText(this, MoteI18n.text("夏令时切换时间不明确，请改用 UTC 时区"), Toast.LENGTH_LONG).show() }
                        else input.setText(local.atOffset(offsets.single()).toString())
                    }, previous.hour, previous.minute, true)).show()
                }, previous.year, previous.monthValue - 1, previous.dayOfMonth)).show()
            } }
        }
        text(form, MoteI18n.text("添加到已有日历"))
        val calendars = choices
        val picker = Spinner(this).apply { adapter = MoteUi.choiceAdapter(this@CalendarActionsActivity, (0 until calendars.length()).map { calendars.getJSONObject(it).getString("title") }) }; form.addView(picker)
        if (related != null) { val originalCalendar = related.optJSONObject("target")?.optString("calendarId"); val index = (0 until calendars.length()).indexOfFirst { calendars.getJSONObject(it).getString("id") == originalCalendar }; if (index >= 0) picker.setSelection(index); picker.isEnabled = false; text(form, if (related.has("externalId")) MoteI18n.text("确认后更新原日程，不新建另一条。") else MoteI18n.text("确认后仅更新原建议，仍需确认添加到日历。")) }
        val validation = TextView(this); form.addView(validation)
        val dialog = own(MoteDialogBuilder(this).setTitle(MoteI18n.text("确认日程")).setView(ScrollView(this).apply { addView(form) }).setNegativeButton(MoteI18n.text("返回"), null).setPositiveButton(if (related == null) MoteI18n.text("确认添加") else MoteI18n.text("确认变更"), null).create())
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            if(!valid())return@setOnClickListener
            val edited = JSONObject().put("allDay", allDay.isChecked); for ((key, value) in fields) edited.put(key, value.text.toString())
            try { CalendarActionRules.times(edited) } catch (_: Exception) { validation.text = MoteI18n.text("请核对完整日期、时间、时区和标题"); return@setOnClickListener }
            val calendarId = calendars.getJSONObject(picker.selectedItemPosition).getString("id")
            dialog.dismiss(); work(MoteI18n.text("正在确认并写入日程…")) { page -> val confirmed = confirm(action, edited, if (related == null) calendarId else null); if (confirmed.getString("status") == "approved") execute(confirmed.getString("id")); list(page) }
        } }; dialog.show()
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) { super.onRequestPermissionsResult(requestCode, permissions, grantResults); if (requestCode == 401) { val expected=permissionIdentity;permissionIdentity=null;if(expected!=identity()){withdrawChangedCalendar();return};if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) connect() else status.text = MoteI18n.text("未授权，不读取或写入日历。可随时重新连接。") } }
}
