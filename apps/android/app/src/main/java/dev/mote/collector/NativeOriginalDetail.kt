package dev.mote.collector

import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.ui.MoteComponents
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** A receipt step and the source presentation for one exact original. */
internal data class OriginalReceiptStep(val title: String, val at: String?, val completed: Boolean)
internal data class OriginalDetailPresentation(
    val title: String,
    val timeline: List<OriginalReceiptStep>,
    val source: String,
    val referenceCount: Int?,
)

/** Owner-facing details for a pinned original: receipt timeline, source and the
 * conversations that use the same exact evidence or material reference. */
internal object NativeOriginalDetail {
    private val materialRef = Regex("^material:mat_[a-f0-9]{64}@[a-f0-9]{64}$")
    private val clock: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

    fun capture(record: JSONObject, conversations: List<JSONObject>? = null): OriginalDetailPresentation {
        val captured = string(record, "capturedAt")
        val received = string(record, "receivedAt")
        val status = record.optString("indexingStatus")
        val organized = status == "indexed" || status == "text_ready"
        val step = when {
            organized -> OriginalReceiptStep("已整理，可搜索", null, true)
            status == "failed" -> OriginalReceiptStep("整理未完成", null, false)
            else -> OriginalReceiptStep("正在整理", null, false)
        }
        return OriginalDetailPresentation(
            title = title(record),
            timeline = listOf(
                OriginalReceiptStep("本机已保存", captured, captured != null),
                OriginalReceiptStep("中央已接收", received, received != null),
                step,
            ),
            source = source(record),
            referenceCount = conversations?.let { count(it, record.optString("id"), record.optString("memoryMaterialRef").takeIf(materialRef::matches)) },
        )
    }

    fun material(item: JSONObject, conversations: List<JSONObject>? = null): OriginalDetailPresentation {
        val origin = item.optJSONObject("origin") ?: JSONObject()
        val created = string(item, "createdAt")
        val first = string(origin, "firstAt") ?: created
        val coverage = item.optJSONObject("coverage")?.optString("state").orEmpty()
        val complete = coverage == "complete"
        val step = when {
            complete -> OriginalReceiptStep("已整理，可搜索", null, true)
            coverage == "pending" -> OriginalReceiptStep("正在整理", null, false)
            else -> OriginalReceiptStep("整理未完成", null, false)
        }
        val ref = item.optString("ref").takeIf(materialRef::matches) ?: item.optString("memoryMaterialRef").takeIf(materialRef::matches)
        return OriginalDetailPresentation(
            title = item.optString("title").ifBlank { MoteI18n.text("记录") },
            timeline = listOf(
                OriginalReceiptStep("本机已保存", first, first != null),
                OriginalReceiptStep("中央已接收", created, created != null),
                step,
            ),
            source = materialSource(item),
            referenceCount = conversations?.let { count(it, null, ref) },
        )
    }

    fun title(record: JSONObject): String {
        string(record, "windowTitle")?.trim()?.takeIf(String::isNotEmpty)?.let { return it.take(80) }
        record.optString("ocrText").lineSequence().map(String::trim).firstOrNull(String::isNotEmpty)?.let { return it.take(80) }
        return string(record, "appName")?.trim()?.takeIf(String::isNotEmpty) ?: MoteI18n.text("记录")
    }

    fun source(record: JSONObject): String {
        val label = sourceLabel(record.optString("source"))
        val device = string(record, "deviceName")?.trim().orEmpty()
        return if (device.isEmpty()) label else label + " · " + device
    }

    fun sourceLabel(source: String): String = MoteI18n.text(when (source) {
        "note" -> "记录"
        "screen" -> "截图"
        "ui_page" -> "网页"
        "activity" -> "活动"
        "media" -> "媒体"
        "notification" -> "通知"
        "device_event" -> "设备事件"
        "file" -> "文件"
        "calendar", "event" -> "日程"
        "message" -> "消息"
        "metric" -> "指标"
        "memory" -> "记忆"
        else -> "记录"
    })

    private fun materialSource(item: JSONObject): String {
        val origin = item.optJSONObject("origin") ?: JSONObject()
        val kind = when (item.optString("kind")) {
            "mote.file" -> "文件"
            "mote.coding-session" -> "Coding Agent 会话"
            "mote.source-item" -> "来源资料"
            else -> "资料"
        }
        val device = string(origin, "deviceId") ?: string(origin, "sourceId").orEmpty()
        return if (device.isEmpty()) MoteI18n.text(kind) else MoteI18n.text(kind) + " · " + device
    }

    private fun string(value: JSONObject, key: String): String? =
        value.optString(key).takeIf { it.isNotBlank() && it != "null" }

    fun count(conversations: List<JSONObject>, evidenceId: String?, materialReference: String?): Int =
        conversations.count { conversation ->
            val scope = conversation.optJSONObject("scope") ?: return@count false
            when {
                evidenceId != null && (scope.optJSONArray("evidenceIds")?.contains(evidenceId) == true ||
                    scope.optJSONArray("anchorEvidenceIds")?.contains(evidenceId) == true) -> true
                materialReference != null && scope.optString("anchorMaterialRef") == materialReference -> true
                else -> false
            }
        }

    private fun JSONArray.contains(value: String): Boolean = (0 until length()).any { optString(it) == value }

    fun conversations(client: CentralClient): List<JSONObject> {
        val result = mutableListOf<JSONObject>()
        var cursor: String? = null
        do {
            val query = "/api/conversations?limit=100" + (cursor?.let { "&cursor=" + URLEncoder.encode(it, "UTF-8") } ?: "")
            val page = client.get(query)
            val items = page.optJSONArray("items") ?: JSONArray()
            for (index in 0 until items.length()) items.optJSONObject(index)?.let(result::add)
            cursor = page.optString("nextCursor").takeIf { !page.isNull("nextCursor") && it.isNotBlank() }
        } while (cursor != null && result.size < 1_000)
        return result
    }

    fun time(value: String?): String? = value?.let {
        runCatching { clock.format(Instant.parse(it).atZone(ZoneId.systemDefault())) }.getOrNull()
    }

    /** Shared 详情 panel body used by both original readers. */
    fun view(context: Context, detail: OriginalDetailPresentation): View = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(context.moteDp(20), context.moteDp(8), context.moteDp(20), context.moteDp(20))
        addView(MoteComponents.group(context).apply {
            detail.timeline.forEach { step -> addView(timelineRow(context, step)) }
        }, LinearLayout.LayoutParams(-1, -2))
        addView(MoteComponents.group(context).apply {
            addView(MoteComponents.row(context, title = MoteI18n.text("来源"), value = detail.source))
            addView(MoteComponents.row(context, title = MoteI18n.text("引用它的对话"), value = detail.referenceCount?.toString() ?: "—"))
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = context.moteDp(12) })
    }

    private fun timelineRow(context: Context, step: OriginalReceiptStep): View = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        minimumHeight = context.moteDp(44)
        setPadding(context.moteDp(14), context.moteDp(10), context.moteDp(14), context.moteDp(10))
        addView(View(context).apply {
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.OVAL
                setColor(if (step.completed) MoteTheme.success else MoteTheme.muted)
            }
        }, LinearLayout.LayoutParams(context.moteDp(8), context.moteDp(8)).apply { marginEnd = context.moteDp(12) })
        addView(TextView(context).apply {
            text = MoteI18n.text(step.title); MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(TextView(context).apply {
            text = time(step.at) ?: "—"; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED)
        }, LinearLayout.LayoutParams(-2, -2))
    }
}
