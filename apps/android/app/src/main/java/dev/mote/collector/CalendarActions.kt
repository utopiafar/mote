package dev.mote.collector

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.util.UUID

object CalendarActionRules {
    fun mutationAllowed(action: JSONObject, previous: String?): Boolean = action.optBoolean("mutationAllowed", false) && previous == null
    fun marker(id: String): String = "[Mote:${UUID.fromString(id)}]"
    fun times(event: JSONObject): Pair<Long, Long> {
        ZoneId.of(event.getString("timeZone"))
        val allDay = event.getBoolean("allDay")
        fun parse(key: String): Long = if (allDay) LocalDate.parse(event.getString(key)).atStartOfDay(ZoneId.of("UTC")).toInstant().toEpochMilli() else OffsetDateTime.parse(event.getString(key)).toInstant().toEpochMilli()
        val start = parse("start"); val end = parse("end")
        require(end > start && end - start <= 366L * 86400000) { MoteI18n.text("请检查开始、结束时间") }
        require(event.getString("title").isNotBlank() && event.getString("title").length <= 200)
        return start to end
    }
    fun description(id: String, event: JSONObject, operation: String? = null) = MoteI18n.text("{0}\n\n#Mote · 由 Mote 创建\n{1}", event.getString("description"), marker(id) + (operation?.let { "\n[Mote-operation:${UUID.fromString(it)}]" } ?: "")).trim()
}

class CalendarActions(private val context: Context) {
    companion object { private val executionLock = Any() }
    private val settings = Settings(context)
    fun permissions() = listOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR).all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
    private fun request(path: String, body: JSONObject? = null): JSONObject {
        val c = settings.read(); c.validateConnection()
        val (status, value) = HttpJson.request(if (body == null) "GET" else "POST", c.server.trimEnd('/') + path, body, c.token)
        if (status !in 200..299 || value == null) throw IllegalStateException(if (status == 403) MoteI18n.text("请在中央网页「行动」设置中授权此设备查看与确认建议") else MoteI18n.text("中央日程操作未完成（{0}），请刷新重试", status))
        return value
    }
    fun list(cursor: Long = 0): JSONObject = ConnectionGuard.sync { request("/api/actions?cursor=$cursor") } ?: error(MoteI18n.text("连接正在切换"))
    fun calendars(): JSONArray {
        check(permissions()) { MoteI18n.text("请先连接日历并允许权限") }
        val result = JSONArray()
        context.contentResolver.query(CalendarContract.Calendars.CONTENT_URI, arrayOf("_id", "calendar_displayName"), "calendar_access_level>=? AND visible=1", arrayOf(CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR.toString()), null)?.use { c ->
            while (c.moveToNext()) result.put(JSONObject().put("id", c.getLong(0).toString()).put("title", c.getString(1) ?: MoteI18n.text("日历")))
        } ?: error(MoteI18n.text("无法读取已有日历"))
        return result
    }
    fun connect(): JSONArray = ConnectionGuard.sync {
        val calendars = calendars()
        request("/api/actions/targets", JSONObject().put("deviceId", settings.deviceId).put("deviceName", settings.read().deviceName).put("calendars", calendars))
        CalendarActionWorker.schedule(context)
        calendars
    } ?: error(MoteI18n.text("连接正在切换"))
    fun deliver() {
        if (!permissions()) return
        val data = ConnectionGuard.sync { request("/api/actions/deliveries?deviceId=${java.net.URLEncoder.encode(settings.deviceId, "UTF-8")}") } ?: return
        val items = data.getJSONArray("items")
        for (i in 0 until items.length()) execute(items.getJSONObject(i).getString("id"))
    }
    fun confirm(action: JSONObject, event: JSONObject, calendarId: String?): JSONObject = ConnectionGuard.sync {
        if (action.getString("kind") in listOf("calendar.create", "calendar.update")) CalendarActionRules.times(event)
        val target = action.optJSONObject("related")?.optJSONObject("target") ?: if (calendarId != null) JSONObject().put("deviceId", settings.deviceId).put("calendarId", calendarId) else null
        request("/api/actions/${action.getString("id")}/confirm", JSONObject().put("version", action.getInt("version")).put("event", event).put("target", target))
    } ?: error(MoteI18n.text("连接正在切换"))
    fun dismiss(action: JSONObject) = ConnectionGuard.sync { request("/api/actions/${action.getString("id")}/dismiss", JSONObject().put("version", action.getInt("version"))) }
    fun execute(id: String) = synchronized(executionLock) { ConnectionGuard.sync {
        UUID.fromString(id)
        check(permissions()) { MoteI18n.text("日历权限不可用，请先连接日历") }
        val action = request("/api/actions/$id/claim", JSONObject().put("deviceId", settings.deviceId))
        require(action.getString("id") == id && action.getString("kind") in listOf("calendar.create", "calendar.update", "calendar.cancel"))
        require(action.getJSONObject("target").getString("deviceId") == settings.deviceId)
        if (action.getString("status") == "succeeded") return@sync
        require(action.getString("status") in listOf("executing", "uncertain"))
        val operation = UUID.fromString(action.getString("operationId")).toString()
        val event = action.getJSONObject("event"); val (start, end) = CalendarActionRules.times(event)
        val calendarId = action.getJSONObject("target").getString("calendarId").toLong()
        val availableCalendars = calendars()
        check((0 until availableCalendars.length()).any { availableCalendars.getJSONObject(it).getString("id") == calendarId.toString() }) { MoteI18n.text("目标日历已不可写") }
        val origin = settings.read().server.trimEnd('/')
        val root = File(context.noBackupFilesDir, "calendar-actions/${SourceRules.hash(origin + settings.deviceId)}").apply { mkdirs() }
        val ledger = File(root, operation)
        fun save(value: String) { val temp = File(root, "$operation.tmp"); FileOutputStream(temp).use { it.write(SecretBox().seal(value.toByteArray(Charsets.UTF_8))); it.fd.sync() }; check(temp.renameTo(ledger)) }
        val previous = if (ledger.exists()) String(SecretBox().open(ledger.readBytes()), Charsets.UTF_8) else null
        try {
            var externalId = previous?.takeIf { it != "attempting" }
            if (externalId == null) {
                val related = action.optJSONObject("related")
                if (action.getString("kind") != "calendar.create") {
                    require(related != null && related.getJSONObject("target").getString("deviceId") == settings.deviceId && related.getJSONObject("target").getString("calendarId") == calendarId.toString())
                    val existingId = related.getString("externalId").toLong()
                    val uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, existingId)
                    val columns = arrayOf("calendar_id", "title", "dtstart", "dtend", "allDay", "eventLocation", "description", "rrule", "rdate")
                    val currentCursor = context.contentResolver.query(uri, columns, "deleted=0", null, null) ?: error(MoteI18n.text("无法核实原日程"))
                    val current = currentCursor.use { c ->
                        if (!c.moveToFirst()) null else columns.indices.associate { columns[it] to (if (c.isNull(it)) "" else c.getString(it)) }
                    }
                    val operationMarker = "[Mote-operation:$operation]"
                    if (current == null) {
                        check(action.getString("kind") == "calendar.cancel") { MoteI18n.text("原日程已不存在，请核实") }
                    } else {
                        check(current["calendar_id"] == calendarId.toString() && current["description"]!!.contains(CalendarActionRules.marker(related.getString("actionId")))) { MoteI18n.text("原日程身份已改变，请核实") }
                        if (!(action.getString("kind") == "calendar.update" && current["description"]!!.contains(operationMarker))) {
                            check(CalendarActionRules.mutationAllowed(action, previous)) { MoteI18n.text("上次修改结果不明，请核实；不会重复执行") }
                            val expected = related.getJSONObject("event"); val oldTimes = CalendarActionRules.times(expected)
                            val oldDescription = CalendarActionRules.description(related.getString("actionId"), expected, related.optString("operationId").takeIf { it.isNotEmpty() })
                            check(current["title"] == expected.getString("title") && current["dtstart"] == oldTimes.first.toString() && current["dtend"] == oldTimes.second.toString() && current["allDay"] == (if (expected.getBoolean("allDay")) "1" else "0") && current["eventLocation"] == expected.getString("location") && current["description"] == oldDescription && current["rrule"].isNullOrEmpty() && current["rdate"].isNullOrEmpty()) { MoteI18n.text("系统日历已被修改，请重新核实") }
                            context.contentResolver.query(CalendarContract.Attendees.CONTENT_URI, arrayOf("_id"), "event_id=?", arrayOf(existingId.toString()), null)?.use { check(it.count == 0) { MoteI18n.text("不修改包含参与人的日程") } } ?: error(MoteI18n.text("无法核实日程参与人"))
                            save("attempting")
                            val selection = "calendar_id=? AND title=? AND dtstart=? AND dtend=? AND allDay=? AND coalesce(eventLocation,'')=? AND coalesce(description,'')=? AND deleted=0"
                            val args = arrayOf(calendarId.toString(), expected.getString("title"), oldTimes.first.toString(), oldTimes.second.toString(), if (expected.getBoolean("allDay")) "1" else "0", expected.getString("location"), oldDescription)
                            val changed = if (action.getString("kind") == "calendar.cancel") context.contentResolver.delete(uri, selection, args) else {
                                check(end > Instant.now().toEpochMilli()) { MoteI18n.text("日程已过期") }
                                val values = ContentValues().apply {
                                    put(CalendarContract.Events.TITLE, event.getString("title")); put(CalendarContract.Events.DTSTART, start); put(CalendarContract.Events.DTEND, end)
                                    put(CalendarContract.Events.EVENT_TIMEZONE, if (event.getBoolean("allDay")) "UTC" else event.getString("timeZone")); put(CalendarContract.Events.ALL_DAY, if (event.getBoolean("allDay")) 1 else 0)
                                    put(CalendarContract.Events.EVENT_LOCATION, event.getString("location")); put(CalendarContract.Events.DESCRIPTION, CalendarActionRules.description(related.getString("actionId"), event, operation))
                                }
                                context.contentResolver.update(uri, values, selection, args)
                            }
                            check(changed == 1) { MoteI18n.text("原日程已改变，请核实修改结果") }
                        }
                    }
                    externalId = existingId.toString(); save(externalId)
                } else {
                val marker = CalendarActionRules.marker(id)
                val existing = mutableListOf<String>()
                context.contentResolver.query(CalendarContract.Events.CONTENT_URI, arrayOf("_id", "description"), "calendar_id=? AND deleted=0 AND description LIKE ?", arrayOf(calendarId.toString(), "%$marker%"), null)?.use { c -> while (c.moveToNext()) if ((c.getString(1) ?: "").contains(marker)) existing.add(c.getLong(0).toString()) } ?: error(MoteI18n.text("无法核实已有日程"))
                if (existing.size == 1) externalId = existing.single()
                else {
                    check(existing.isEmpty() && CalendarActionRules.mutationAllowed(action, previous)) { MoteI18n.text("上次保存结果不明，请在系统日历核实；不会重复创建") }
                    check(end > Instant.now().toEpochMilli()) { MoteI18n.text("日程已过期") }
                    save("attempting")
                    val values = ContentValues().apply {
                        put(CalendarContract.Events.CALENDAR_ID, calendarId); put(CalendarContract.Events.TITLE, event.getString("title"))
                        put(CalendarContract.Events.DTSTART, start); put(CalendarContract.Events.DTEND, end)
                        put(CalendarContract.Events.EVENT_TIMEZONE, if (event.getBoolean("allDay")) "UTC" else event.getString("timeZone"))
                        put(CalendarContract.Events.ALL_DAY, if (event.getBoolean("allDay")) 1 else 0)
                        put(CalendarContract.Events.EVENT_LOCATION, event.getString("location")); put(CalendarContract.Events.DESCRIPTION, CalendarActionRules.description(id, event, operation))
                    }
                    val uri = context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values) ?: error(MoteI18n.text("保存结果不明"))
                    externalId = ContentUris.parseId(uri).toString()
                }
                save(externalId!!)
                }
            }
            request("/api/actions/$id/receipt", JSONObject().put("deviceId", settings.deviceId).put("operationId", operation).put("status", "succeeded").put("externalId", externalId))
        } catch (e: Exception) {
            runCatching { request("/api/actions/$id/receipt", JSONObject().put("deviceId", settings.deviceId).put("operationId", operation).put("status", "uncertain")) }
            throw IllegalStateException(MoteI18n.text("日程保存结果待核实。检查日历和网络后再次同步；不会重复插入。"), e)
        }
    } ?: error(MoteI18n.text("连接正在切换")) }
}
