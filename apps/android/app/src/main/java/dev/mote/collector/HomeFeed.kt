package dev.mote.collector

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.UUID

/** One validated archive row the home renders and opens. Central fields are
 * untrusted: a malformed row fails the read instead of reaching the UI. */
internal object HomeFeed {
    /** A single recent original: identity, local day and the row payload the
     * shared reader re-reads before display. */
    class Original(
        val id: String,
        val capturedAt: Instant,
        val source: String,
        val deviceId: String,
        val title: String,
        val kind: String,
        val hasImage: Boolean,
        val day: String,
        val row: JSONObject,
    )

    class Day(val label: String, val items: List<Original>)

    /** The home reads one bounded page of existing originals; it never generates content. */
    fun page(read: (String) -> JSONObject): List<Original> {
        val rows = read("/api/capture-browser?limit=30").getJSONArray("items")
        return (0 until rows.length()).map { original(rows.getJSONObject(it)) }
    }

    fun original(item: JSONObject): Original {
        val id = item.getString("id")
        require(UUID.fromString(id).toString() == id)
        val capturedAt = Instant.parse(item.getString("capturedAt"))
        val source = item.getString("source")
        require(source.isNotBlank())
        val deviceId = item.getString("deviceId")
        require(deviceId.isNotBlank())
        if (item.has("hasImage")) require(item.get("hasImage") is Boolean)
        if (item.has("durationMs")) require(item.get("durationMs") is Number)
        val zone = ZoneId.systemDefault()
        return Original(
            id = id,
            capturedAt = capturedAt,
            source = source,
            deviceId = deviceId,
            title = title(item),
            kind = kind(item),
            hasImage = item.optBoolean("hasImage"),
            day = capturedAt.atZone(zone).toLocalDate().toString(),
            row = item,
        )
    }

    /** Newest first, stable for equal timestamps; consecutive rows share one day group. */
    fun days(originals: List<Original>, zone: ZoneId, now: Instant): List<Day> {
        val today = now.atZone(zone).toLocalDate()
        val ordered = originals.sortedByDescending { it.capturedAt }
        val grouped = LinkedHashMap<LocalDate, MutableList<Original>>()
        for (original in ordered) {
            grouped.getOrPut(original.capturedAt.atZone(zone).toLocalDate()) { mutableListOf() }.add(original)
        }
        return grouped.map { (date, items) -> Day(dayLabel(date, today), items) }
    }

    fun dayLabel(date: LocalDate, today: LocalDate): String = when (date) {
        today -> MoteI18n.text("今天")
        today.minusDays(1) -> MoteI18n.text("昨天")
        else -> DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(MoteI18n.locale()).format(date)
    }

    /** The row meta is always "time · type", matching the capture rows elsewhere. */
    fun detail(original: Original): String {
        val time = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)
            .withLocale(MoteI18n.locale()).withZone(ZoneId.systemDefault()).format(original.capturedAt)
        return "$time · ${original.kind}"
    }

    /** First readable line wins: captured text, then window title, then the app name. */
    fun title(item: JSONObject): String {
        for (candidate in listOf(item.optString("textPreview"), item.optString("windowTitle"), item.optString("appName"))) {
            val line = candidate.lineSequence().firstOrNull()?.trim().orEmpty()
            if (line.isNotEmpty()) return line.take(80)
        }
        return kind(item)
    }

    /** The same type wording the library capture rows already use. */
    fun kind(item: JSONObject): String {
        val source = item.optString("source")
        val recording = item.optLong("durationMs", 0)
            .takeIf { source == "media" && it > 0 }
            ?.let { "%d:%02d".format(it / 60000, (it / 1000) % 60) }
        return MoteI18n.text(when (source) {
            "note" -> when {
                item.optString("windowTitle").matches(Regex("(?i).+\\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|zip)$")) -> "文件"
                item.optString("appName").contains('.') -> item.optString("appName")
                else -> "记录"
            }
            "screen" -> if (item.optBoolean("hasImage")) "照片" else "截图"
            "notification" -> "通知"
            "ui_page" -> "网页"
            "media" -> "录音"
            "activity" -> "应用活动"
            "device_event" -> "设备事件"
            "file" -> "文件"
            else -> "采集记录"
        }) + (recording?.let { " $it" }.orEmpty())
    }
}
