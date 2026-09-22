package dev.mote.collector

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.content.pm.PackageManager
import android.widget.*
import org.json.JSONObject

class CalendarActionsActivity : MoteActivity() {
    private lateinit var status: TextView
    private lateinit var list: LinearLayout
    private lateinit var task: UiTask
    private lateinit var client: CalendarActions
    private var cursor = 0L
    private var nextCursor = 0L
    private val handler = Handler(Looper.getMainLooper())
    private val poll = object : Runnable { override fun run() { if (!task.busy) refresh(); handler.postDelayed(this, 20000) } }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state); client = CalendarActions(this); task = UiTask(this)
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(28, 24, 28, 32) }
        setContentView(ScrollView(this).apply { addView(body) })
        text(body, MoteI18n.text("日程建议"), 26f)
        text(body, MoteI18n.text("从上传资料和持续采集中发现安排，逐条核对后添加到你选择的已有日历。备注附加 #Mote 来源标记。"))
        text(body, MoteI18n.text("首次使用：在中央网页「行动」开启发现，并授权此设备查看跨来源的建议及原文片段。"))
        button(body, MoteI18n.text("连接本机日历")) { if (client.permissions()) connect() else requestPermissions(arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR), 401) }
        button(body, MoteI18n.text("最新建议")) { cursor = 0; refresh() }
        button(body, MoteI18n.text("更早建议")) { if (nextCursor > 0) { cursor = nextCursor; refresh() } }
        button(body, MoteI18n.text("刷新并同步已确认日程")) { sync() }
        status = TextView(this); body.addView(status)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(list)
        refresh()
    }
    override fun onResume() { super.onResume(); handler.postDelayed(poll, 20000) }
    override fun onPause() { handler.removeCallbacks(poll); super.onPause() }
    private fun text(parent: LinearLayout, value: String, size: Float = 15f) { parent.addView(TextView(this).apply { text = value; textSize = size; setPadding(0, 12, 0, 12) }) }
    private fun button(parent: LinearLayout, title: String, fn: () -> Unit) { parent.addView(Button(this).apply { text = title; isAllCaps = false; setOnClickListener { if (!task.busy) fn() } }) }
    private fun work(label: String, fn: () -> JSONObject) { task.start(label, { status.text = it }, { fn() }) { result -> result.onSuccess { render(it); status.text = MoteI18n.text("已刷新。每条日程需要确认后才写入。") }.onFailure { status.text = it.message ?: MoteI18n.text("操作失败，请重试") } } }
    private fun refresh() = work(MoteI18n.text("正在读取日程建议…")) {
        val data = client.list(cursor)
        if (client.permissions()) { val items = data.getJSONArray("items"); for (i in 0 until items.length()) { val a = items.getJSONObject(i); if (a.optJSONObject("target")?.optString("deviceId") == Settings(this).deviceId && a.optString("status") == "approved") client.execute(a.getString("id")) } }
        client.list(cursor)
    }
    private fun connect() = work(MoteI18n.text("正在连接日历…")) { client.connect(); client.list(cursor) }
    private fun sync() = work(MoteI18n.text("正在同步已确认日程…")) {
        val data = client.list(cursor); val items = data.getJSONArray("items")
        for (i in 0 until items.length()) { val a = items.getJSONObject(i); if (a.optJSONObject("target")?.optString("deviceId") == Settings(this).deviceId && a.optString("status") in listOf("approved", "executing", "uncertain")) client.execute(a.getString("id")) }
        client.list(cursor)
    }
    private fun render(data: JSONObject) {
        nextCursor = if (data.isNull("nextCursor")) 0 else data.optLong("nextCursor")
        list.removeAllViews(); val items = data.getJSONArray("items")
        if (items.length() == 0) text(list, MoteI18n.text("尚未发现日程。上传资料或继续采集后会自动分析。"))
        for (i in 0 until items.length()) {
            val a = items.getJSONObject(i); val e = a.getJSONObject("event"); val state = a.getString("status")
            val card = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(16, 22, 16, 22) }; list.addView(card)
            text(card, e.getString("title"), 21f)
            val kind = a.getString("kind")
            text(card, when (kind) { "calendar.update" -> MoteI18n.text("更新日程"); "calendar.cancel" -> MoteI18n.text("取消日程"); "calendar.complete" -> MoteI18n.text("标记安排完成"); else -> MoteI18n.text("添加日程") })
            a.optJSONObject("related")?.getJSONObject("event")?.let { text(card, MoteI18n.text("原安排") + ": " + it.getString("title") + " · " + it.optString("start") + " → " + it.optString("end")) }
            if (a.has("resolution")) text(card, if (a.getString("resolution") == "cancelled") MoteI18n.text("已取消") else MoteI18n.text("已完成"))
            val labels = mapOf("proposed" to MoteI18n.text("待确认"), "approved" to MoteI18n.text("等待客户端写入"), "executing" to MoteI18n.text("等待保存回执"), "uncertain" to MoteI18n.text("保存结果待核实"), "succeeded" to MoteI18n.text("已添加 · #Mote"), "dismissed" to MoteI18n.text("已忽略"), "stale" to MoteI18n.text("原文已更新或删除"))
            text(card, "${labels[state] ?: state}\n${e.optString("start")} → ${e.optString("end")}\n${e.optString("timeZone")} · ${e.optString("location")}")
            if (a.optString("uncertainty").isNotBlank()) text(card, a.getString("uncertainty"))
            button(card, MoteI18n.text("查看原文依据")) { val evidence = a.getJSONArray("evidence"); val content = (0 until evidence.length()).joinToString("\n\n") { val r = evidence.getJSONObject(it); "${r.getString("source")} · ${r.getString("capturedAt")}\n${r.getString("quote")}" }; MoteDialogBuilder(this).setTitle(MoteI18n.text("原文依据")).setMessage(content).setPositiveButton(MoteI18n.text("关闭"), null).show() }
            if (state == "proposed" && !a.has("resolution")) {
                button(card, if (kind == "calendar.create") MoteI18n.text("核对并添加到日历") else MoteI18n.text("核对变更")) { edit(a, data) }
                button(card, MoteI18n.text("忽略这条建议")) { work(MoteI18n.text("正在保存选择…")) { client.dismiss(a); client.list(cursor) } }
            }
            if (a.optJSONObject("target")?.optString("deviceId") == Settings(this).deviceId && state in listOf("approved", "executing", "uncertain")) button(card, MoteI18n.text("写入 / 核实保存结果")) { work(MoteI18n.text("正在写入已确认日程…")) { client.execute(a.getString("id")); client.list(cursor) } }
        }
    }
    private fun edit(action: JSONObject, data: JSONObject) {
        val kind = action.getString("kind"); val related = action.optJSONObject("related")
        if (kind in listOf("calendar.cancel", "calendar.complete")) {
            val event = action.getJSONObject("event")
            val target = related?.optJSONObject("target")
            if (target != null && target.getString("deviceId") != Settings(this).deviceId) { status.text = MoteI18n.text("请在原设备确认，或使用中央网页"); return }
            val message = if (kind == "calendar.complete") MoteI18n.text("确认后仅在 Mote 中标记完成。") else if (related?.has("externalId") == true) MoteI18n.text("确认后取消原设备上的这一条日程。") else MoteI18n.text("确认后取消尚未写入日历的原建议。")
            MoteDialogBuilder(this).setTitle(if (kind == "calendar.cancel") MoteI18n.text("取消日程") else MoteI18n.text("标记安排完成")).setMessage(event.getString("title") + "\n" + event.optString("start") + " → " + event.optString("end") + "\n" + message).setNegativeButton(MoteI18n.text("返回"), null).setPositiveButton(MoteI18n.text("确认变更")) { _, _ -> work(MoteI18n.text("正在确认变更…")) { val confirmed = client.confirm(action, event, null); if (confirmed.getString("status") == "approved") client.execute(confirmed.getString("id")); client.list(cursor) } }.show()
            return
        }
        if (related?.optJSONObject("target")?.getString("deviceId")?.let { it != Settings(this).deviceId } == true) { status.text = MoteI18n.text("请在原设备确认，或使用中央网页"); return }
        val requiresCalendar = related == null || related.has("externalId")
        if (requiresCalendar && !client.permissions()) { status.text = MoteI18n.text("请先连接本机日历"); return }
        val targets = data.getJSONArray("targets"); var choices = org.json.JSONArray()
        for (i in 0 until targets.length()) if (targets.getJSONObject(i).getString("deviceId") == Settings(this).deviceId) choices = targets.getJSONObject(i).getJSONArray("calendars")
        if (!requiresCalendar) choices = org.json.JSONArray().put(JSONObject().put("id", "").put("title", MoteI18n.text("仅更新原建议")))
        if (choices.length() == 0) { status.text = MoteI18n.text("请先连接本机日历，并在系统日历中添加可写账户"); return }
        val event = action.getJSONObject("event"); val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(28, 16, 28, 16) }
        val allDay = CheckBox(this).apply { text = MoteI18n.text("全天"); isChecked = event.getBoolean("allDay") }; form.addView(allDay)
        text(form, MoteI18n.text("点击日期字段选择时间。全天日程的结束日期不包含当天。时区可修改。"))
        val fields = linkedMapOf<String, EditText>()
        for ((key, label) in listOf("title" to MoteI18n.text("标题"), "start" to MoteI18n.text("开始"), "end" to MoteI18n.text("结束"), "timeZone" to MoteI18n.text("时区"), "location" to MoteI18n.text("地点"), "description" to MoteI18n.text("备注"))) {
            text(form, label); val input = EditText(this).apply { setText(if (event.isNull(key)) "" else event.getString(key)); contentDescription = label; maxLines = 3 }; fields[key] = input; form.addView(input)
            if (key == "start" || key == "end") { input.isFocusable = false; input.setOnClickListener {
                val zone = runCatching { java.time.ZoneId.of(fields["timeZone"]?.text.toString()) }.getOrDefault(java.time.ZoneId.systemDefault())
                val previous = runCatching { java.time.OffsetDateTime.parse(input.text.toString()).atZoneSameInstant(zone) }.getOrDefault(java.time.ZonedDateTime.now(zone))
                DatePickerDialog(this, { _, y, m, d ->
                    val date = java.time.LocalDate.of(y, m + 1, d)
                    if (allDay.isChecked) input.setText(date.toString())
                    else TimePickerDialog(this, { _, h, minute ->
                        val local = date.atTime(h, minute); val offsets = zone.rules.getValidOffsets(local)
                        if (offsets.size != 1) { Toast.makeText(this, MoteI18n.text("夏令时切换时间不明确，请改用 UTC 时区"), Toast.LENGTH_LONG).show() }
                        else input.setText(local.atOffset(offsets.single()).toString())
                    }, previous.hour, previous.minute, true).show()
                }, previous.year, previous.monthValue - 1, previous.dayOfMonth).show()
            } }
        }
        text(form, MoteI18n.text("添加到已有日历"))
        val calendars = choices
        val picker = Spinner(this).apply { adapter = ArrayAdapter(this@CalendarActionsActivity, android.R.layout.simple_spinner_dropdown_item, (0 until calendars.length()).map { calendars.getJSONObject(it).getString("title") }) }; form.addView(picker)
        if (related != null) { val originalCalendar = related.optJSONObject("target")?.optString("calendarId"); val index = (0 until calendars.length()).indexOfFirst { calendars.getJSONObject(it).getString("id") == originalCalendar }; if (index >= 0) picker.setSelection(index); picker.isEnabled = false; text(form, if (related.has("externalId")) MoteI18n.text("确认后更新原日程，不新建另一条。") else MoteI18n.text("确认后仅更新原建议，仍需确认添加到日历。")) }
        val validation = TextView(this); form.addView(validation)
        val dialog = MoteDialogBuilder(this).setTitle(MoteI18n.text("确认日程")).setView(ScrollView(this).apply { addView(form) }).setNegativeButton(MoteI18n.text("返回"), null).setPositiveButton(if (related == null) MoteI18n.text("确认添加") else MoteI18n.text("确认变更"), null).create()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val edited = JSONObject().put("allDay", allDay.isChecked); for ((key, value) in fields) edited.put(key, value.text.toString())
            try { CalendarActionRules.times(edited) } catch (_: Exception) { validation.text = MoteI18n.text("请核对完整日期、时间、时区和标题"); return@setOnClickListener }
            val calendarId = calendars.getJSONObject(picker.selectedItemPosition).getString("id")
            dialog.dismiss(); work(MoteI18n.text("正在确认并写入日程…")) { val confirmed = client.confirm(action, edited, if (related == null) calendarId else null); if (confirmed.getString("status") == "approved") client.execute(confirmed.getString("id")); client.list(cursor) }
        } }; dialog.show()
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) { super.onRequestPermissionsResult(requestCode, permissions, grantResults); if (requestCode == 401) { if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) connect() else status.text = MoteI18n.text("未授权，不读取或写入日历。可随时重新连接。") } }
}
