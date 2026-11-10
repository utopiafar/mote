package dev.mote.collector

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.view.Gravity
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import dev.mote.collector.ui.MoteIconButtonStyle
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** One action in the reader's ⋯ sheet. */
internal data class OriginalAction(val glyph: MoteGlyph, val label: String, val chevron: Boolean = false, val enabled: Boolean = true, val run: () -> Unit)

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
        val organizedAt = record.optJSONObject("ocr")?.optString("updatedAt")?.takeIf { it.isNotBlank() }
            ?: record.optString("indexedAt").takeIf { it.isNotBlank() }
        val step = when {
            organized -> OriginalReceiptStep("已整理，可搜索", organizedAt, true)
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

    /** Shared 详情 bottom sheet used by both original readers. */
    fun show(activity: Activity, detail: OriginalDetailPresentation) {
        val dialog = Dialog(activity).apply { requestWindowFeature(Window.FEATURE_NO_TITLE) }
        val sheet = MoteComponents.sheet(activity).apply {
            addView(titleBar(activity, MoteI18n.text("详情")) { dialog.dismiss() }, LinearLayout.LayoutParams(-1, -2))
            addView(MoteComponents.group(activity).apply {
                detail.timeline.forEach { step -> addView(timelineRow(activity, step), LinearLayout.LayoutParams(-1, -2)) }
            }, groupParams(activity, 6))
            addView(MoteComponents.group(activity).apply {
                addView(detailRow(activity, MoteI18n.text("来源"), detail.source, null), LinearLayout.LayoutParams(-1, -2))
                addView(MoteComponents.divider(activity))
                addView(detailRow(activity, MoteI18n.text("引用它的对话"), detail.referenceCount?.toString() ?: "—", MoteGlyph.CHEV),
                    LinearLayout.LayoutParams(-1, -2))
            }, groupParams(activity, 12))
            addView(View(activity), LinearLayout.LayoutParams(-1, activity.moteDp(40)))
        }
        present(activity, dialog, sheet, secure = false)
    }

    /** The reader's ⋯ sheet: everyday actions in one group, the destructive one apart. */
    fun more(activity: Activity, actions: List<OriginalAction>, danger: OriginalAction?, note: String?): Dialog {
        val dialog = Dialog(activity).apply { requestWindowFeature(Window.FEATURE_NO_TITLE) }
        val sheet = MoteComponents.sheet(activity).apply {
            if (actions.isNotEmpty()) addView(MoteComponents.group(activity).apply {
                actions.forEachIndexed { index, action ->
                    if (index > 0) addView(MoteComponents.divider(activity))
                    addView(actionRow(activity, action.glyph, action.label, action.chevron, danger = false) { dialog.dismiss(); action.run() }
                        .apply { isEnabled = action.enabled }, LinearLayout.LayoutParams(-1, -2))
                }
            }, groupParams(activity, 8))
            danger?.let { action ->
                addView(MoteComponents.group(activity).apply {
                    addView(actionRow(activity, action.glyph, action.label, chevron = false, danger = true) { dialog.dismiss(); action.run() }
                        .apply { isEnabled = action.enabled }, LinearLayout.LayoutParams(-1, -2))
                }, groupParams(activity, 12))
            }
            note?.let { value ->
                addView(TextView(activity).apply {
                    text = value; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED)
                    setPadding(activity.moteDp(4), 0, activity.moteDp(4), 0)
                }, groupParams(activity, 12))
            }
            addView(View(activity), LinearLayout.LayoutParams(-1, activity.moteDp(32)))
        }
        present(activity, dialog, sheet, secure = false)
        return dialog
    }

    /** 资料说明: the owner's own words about this original, read in a sheet like 详情. */
    fun description(activity: Activity, descriptions: List<String>) {
        val dialog = Dialog(activity).apply { requestWindowFeature(Window.FEATURE_NO_TITLE) }
        val sheet = MoteComponents.sheet(activity).apply {
            addView(titleBar(activity, MoteI18n.text("资料说明")) { dialog.dismiss() }, LinearLayout.LayoutParams(-1, -2))
            addView(ScrollView(activity).apply {
                addView(LinearLayout(activity).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(activity.moteDp(20), activity.moteDp(2), activity.moteDp(20), activity.moteDp(8))
                    descriptions.forEach { value ->
                        addView(TextView(activity).apply {
                            text = value; MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK)
                            setTextIsSelectable(true); setPadding(0, activity.moteDp(4), 0, activity.moteDp(4))
                        }, LinearLayout.LayoutParams(-1, -2))
                    }
                })
            }, LinearLayout.LayoutParams(-1, -2))
            addView(View(activity), LinearLayout.LayoutParams(-1, activity.moteDp(32)))
        }
        present(activity, dialog, sheet, secure = true)
    }

    /** A sheet or list action: a text control, so it keeps its label for TalkBack and tests. */
    fun actionRow(context: Context, glyph: MoteGlyph, label: String, chevron: Boolean, danger: Boolean, onClick: () -> Unit): TextView = TextView(context).apply {
        text = label; gravity = Gravity.CENTER_VERTICAL or Gravity.START
        minHeight = context.moteDp(48); setPadding(context.moteDp(14), 0, context.moteDp(14), 0)
        MoteUi.type(this, 15); MoteUi.textColor(this, if (danger) NativeColorRole.DANGER else NativeColorRole.INK)
        NativePresentationStyles.bind(this, "original-action") { view ->
            (view as TextView).setCompoundDrawablesRelative(
                tinted(context, glyph, 20, if (danger) NativeColorRole.DANGER else NativeColorRole.MUTED), null,
                if (chevron) tinted(context, MoteGlyph.CHEV, 16, NativeColorRole.MUTED) else null, null)
            view.compoundDrawablePadding = context.moteDp(12)
            view.background = MoteUi.clickable(context, NativeColorRole.TRANSPARENT, 0, false)
        }
        isFocusable = true; announceAsButton(); setOnClickListener { onClick() }
    }

    /** An icon in the reader's top bar, sized to the 48dp touch target. */
    fun barButton(context: Context, glyph: MoteGlyph, label: String, key: String, onClick: () -> Unit): TextView = TextView(context).apply {
        tag = key; contentDescription = MoteI18n.text(label); gravity = Gravity.CENTER
        minWidth = context.moteDp(48); minHeight = context.moteDp(48)
        setPadding(context.moteDp(13), 0, context.moteDp(13), 0)
        NativePresentationStyles.bind(this, "original-bar-button") { view ->
            (view as TextView).setCompoundDrawablesRelative(tinted(context, glyph, 22, NativeColorRole.INK), null, null, null)
            view.compoundDrawablePadding = 0
            view.background = MoteUi.clickable(context, NativeColorRole.TRANSPARENT, NativeRadiusRole.PILL, false)
        }
        isFocusable = true; announceAsButton(); setOnClickListener { onClick() }
    }

    /** The ask entry docked under the reader. */
    fun askBar(context: Context, onClick: () -> Unit): View = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        MoteUi.backgroundColor(this, NativeColorRole.BACKGROUND)
        addView(MoteComponents.divider(context))
        addView(TextView(context).apply {
            text = MoteI18n.text("围绕这份资料提问"); tag = "capture-reader-ask"
            MoteUi.type(this, NativeFontRole.ACTION); MoteUi.textColor(this, NativeColorRole.MUTED)
            gravity = Gravity.CENTER_VERTICAL or Gravity.START; minHeight = context.moteDp(48)
            setPadding(context.moteDp(18), 0, context.moteDp(18), 0)
            NativePresentationStyles.bind(this, "original-ask") {
                it.background = MoteUi.clickable(context, NativeColorRole.BACKGROUND, NativeRadiusRole.PILL, true, NativeColorRole.CONTROL_BORDER)
            }
            isFocusable = true; announceAsButton(); setOnClickListener { onClick() }
        }, LinearLayout.LayoutParams(-1, -2).apply {
            setMargins(context.moteDp(16), context.moteDp(10), context.moteDp(16), context.moteDp(10))
        })
    }

    private fun tinted(context: Context, glyph: MoteGlyph, sizeDp: Int, color: NativeColorRole) =
        context.getDrawable(glyph.drawable)?.mutate()?.apply { setBounds(0, 0, context.moteDp(sizeDp), context.moteDp(sizeDp)); setTint(color.color()) }

    private fun TextView.announceAsButton() {
        accessibilityDelegate = object : View.AccessibilityDelegate() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(host, info); info.className = Button::class.java.name
            }
        }
    }

    private fun groupParams(context: Context, top: Int) = LinearLayout.LayoutParams(-1, -2).apply {
        topMargin = context.moteDp(top); marginStart = context.moteDp(20); marginEnd = context.moteDp(20)
    }

    private fun present(activity: Activity, dialog: Dialog, sheet: View, secure: Boolean) {
        dialog.setContentView(sheet)
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
            setGravity(Gravity.BOTTOM)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            if (secure) addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            attributes = attributes.apply { dimAmount = 0.32f }
        }
        dialog.show()
        dialog.window?.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
        MoteUi.styleTree(dialog.window?.decorView ?: sheet)
    }

    private fun titleBar(context: Context, title: String, close: () -> Unit): View = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(context.moteDp(20), 0, context.moteDp(6), 0)
        addView(TextView(context).apply {
            text = title; MoteUi.type(this, 20); setTypeface(Typeface.create(typeface, Typeface.BOLD))
            MoteUi.textColor(this, NativeColorRole.INK)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(MoteComponents.iconButton(context, MoteGlyph.CLOSE, "关闭", MoteIconButtonStyle.MUTED) { close() },
            LinearLayout.LayoutParams(context.moteDp(48), context.moteDp(48)))
    }

    private fun timelineRow(context: Context, step: OriginalReceiptStep): View = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        minimumHeight = context.moteDp(44)
        setPadding(context.moteDp(14), 0, context.moteDp(14), 0)
        addView(View(context).apply {
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.OVAL
                setColor(if (step.completed) MoteTheme.success else MoteTheme.muted)
            }
        }, LinearLayout.LayoutParams(context.moteDp(8), context.moteDp(8)).apply { marginEnd = context.moteDp(12) })
        addView(TextView(context).apply {
            text = MoteI18n.text(step.title); MoteUi.type(this, 15); MoteUi.textColor(this, NativeColorRole.INK)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(TextView(context).apply {
            text = time(step.at) ?: "—"; MoteUi.type(this, 13); MoteUi.textColor(this, NativeColorRole.MUTED)
        }, LinearLayout.LayoutParams(-2, -2))
    }

    private fun detailRow(context: Context, title: String, value: String, chevron: MoteGlyph?): View = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        minimumHeight = context.moteDp(44)
        setPadding(context.moteDp(14), 0, context.moteDp(14), 0)
        addView(TextView(context).apply {
            text = title; MoteUi.type(this, 15); MoteUi.textColor(this, NativeColorRole.INK)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(TextView(context).apply {
            text = value; MoteUi.type(this, 15); MoteUi.textColor(this, NativeColorRole.MUTED); maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }, LinearLayout.LayoutParams(-2, -2))
        chevron?.let {
            addView(MoteComponents.icon(context, it, NativeColorRole.MUTED, 16), LinearLayout.LayoutParams(-2, -2).apply { marginStart = context.moteDp(6) })
        }
    }
}
