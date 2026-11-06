package dev.mote.collector.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewOutlineProvider
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.DesignTokens
import dev.mote.collector.MoteI18n
import dev.mote.collector.MoteTheme
import dev.mote.collector.MoteUi
import dev.mote.collector.NativeColorRole
import dev.mote.collector.NativeFontRole
import dev.mote.collector.NativePresentationStyles
import dev.mote.collector.NativeRadiusRole
import dev.mote.collector.NativeThemeShape
import dev.mote.collector.R
import dev.mote.collector.moteDp

/** Lucide-family line icons (24 grid, 1.65 round stroke) as vector drawables.
 * `a11yKey` is the fallback accessible name; call sites pass a contextual one. */
internal enum class MoteGlyph(val drawable: Int, val a11yKey: String) {
    ASK(R.drawable.ic_ask, "问一问"),
    ALERT(R.drawable.ic_alert, "需要处理"),
    BACK(R.drawable.ic_back, "返回上一页"),
    BELL(R.drawable.ic_bell, "通知"),
    BLUETOOTH(R.drawable.ic_bluetooth, "蓝牙"),
    BOLT(R.drawable.ic_bolt, "活动"),
    CALENDAR(R.drawable.ic_calendar, "查看日程"),
    CAMERA(R.drawable.ic_camera, "拍照"),
    CHECK(R.drawable.ic_check, "确定"),
    CHEV(R.drawable.ic_chev, "查看"),
    CLOCK(R.drawable.ic_clock, "时间"),
    CLOSE(R.drawable.ic_close, "收起"),
    COMPOSE(R.drawable.ic_compose, "记录"),
    COPY(R.drawable.ic_copy, "复制"),
    DISK(R.drawable.ic_disk, "存储"),
    DOWN(R.drawable.ic_down, "展开"),
    EXTERNAL(R.drawable.ic_external, "查看"),
    FILE(R.drawable.ic_file, "导入文件"),
    FOLDER(R.drawable.ic_folder, "同步文件夹"),
    GEAR(R.drawable.ic_gear, "设置"),
    GLOBE(R.drawable.ic_globe, "语言"),
    HISTORY(R.drawable.ic_history, "历史"),
    HOME(R.drawable.ic_home, "首页"),
    KEYBOARD(R.drawable.ic_keyboard, "键盘"),
    LAPTOP(R.drawable.ic_laptop, "设备"),
    LIBRARY(R.drawable.ic_library, "资料库"),
    LINK(R.drawable.ic_link, "连接"),
    LOCK(R.drawable.ic_lock, "权限"),
    MEMORY(R.drawable.ic_memory, "记忆"),
    MIC(R.drawable.ic_mic, "录音"),
    MOON(R.drawable.ic_moon, "深色"),
    MORE(R.drawable.ic_more, "更多"),
    PAUSE(R.drawable.ic_pause, "暂停"),
    PHONE(R.drawable.ic_phone, "设备"),
    PHOTO(R.drawable.ic_photo, "添加图片"),
    PLAY(R.drawable.ic_play, "播放"),
    PLUG(R.drawable.ic_plug, "来源"),
    PLUS(R.drawable.ic_plus, "添加"),
    PULSE(R.drawable.ic_pulse, "活动"),
    QR(R.drawable.ic_qr, "二维码"),
    QUOTE(R.drawable.ic_quote, "引用"),
    REFRESH(R.drawable.ic_refresh, "刷新"),
    SCREEN(R.drawable.ic_screen, "屏幕采集"),
    SEARCH(R.drawable.ic_search, "搜索"),
    SEND(R.drawable.ic_send, "发送"),
    SHARE(R.drawable.ic_share, "分享"),
    SLIDERS(R.drawable.ic_sliders, "筛选"),
    STOP(R.drawable.ic_stop, "停止"),
    TRASH(R.drawable.ic_trash, "删除"),
    UNDO(R.drawable.ic_undo, "撤销"),
    UP(R.drawable.ic_up, "更新"),
    WAVE(R.drawable.ic_wave, "录音"),
    WIFI(R.drawable.ic_wifi, "网络"),
    ;

    companion object {
        /** Historical icon kinds resolve onto the shared line set; nothing bespoke remains. */
        private val kinds = mapOf(
            "dropdown" to DOWN, "search" to SEARCH, "calendar" to CALENDAR, "ask" to ASK,
            "warning" to ALERT, "pause" to PAUSE, "camera" to CAMERA, "microphone" to MIC,
            "capture" to SCREEN, "shield" to LOCK, "folder" to FOLDER, "sync" to REFRESH,
            "chart" to PULSE, "activity" to PULSE, "settings" to GEAR, "history" to HISTORY,
            "library" to LIBRARY, "notes" to COMPOSE, "note" to COMPOSE, "import" to FILE,
            "sources" to PLUG, "plugin" to PLUG, "code" to KEYBOARD, "info" to ALERT,
            "language" to GLOBE, "overview" to HOME, "record" to WAVE, "photo" to PHOTO,
            "audio" to WAVE, "mic" to MIC,
        )
        fun forKind(kind: String): MoteGlyph = kinds[kind] ?: FILE
        fun hasKind(kind: String): Boolean = kinds.containsKey(kind)
    }
}

internal enum class MoteIconButtonStyle { PLAIN, FILLED, MUTED, SOLID }

/** The icon-button contract every produced button must satisfy: a readable
 * accessible name and a full 48dp touch target. */
internal data class MoteIconButtonSpec(
    val glyph: MoteGlyph,
    val description: String,
    val style: MoteIconButtonStyle = MoteIconButtonStyle.PLAIN,
    val touchSizeDp: Int = MIN_TOUCH_DP,
) {
    init {
        require(description.isNotBlank()) { "Icon buttons need an accessible name" }
        require(touchSizeDp >= MIN_TOUCH_DP) { "Icon buttons need a ${MIN_TOUCH_DP}dp touch target" }
    }
    companion object { const val MIN_TOUCH_DP = 48 }
}

/** Shared components: grouped rows, capsule buttons, segmented control,
 * banners, bottom sheet, toast, badges, switch and the m mark. */
internal object MoteComponents {
    private fun bind(view: View, role: String, apply: (View) -> Unit) = NativePresentationStyles.bind(view, role, apply)

    fun icon(context: Context, glyph: MoteGlyph, color: NativeColorRole = NativeColorRole.MUTED, sizeDp: Int = 20): ImageView =
        ImageView(context).apply {
            setImageResource(glyph.drawable); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            bind(this, "glyph-tint") { (it as ImageView).imageTintList = ColorStateList.valueOf(color.color()) }
            layoutParams = LinearLayout.LayoutParams(context.moteDp(sizeDp), context.moteDp(sizeDp))
        }

    fun iconButton(context: Context, spec: MoteIconButtonSpec, onClick: (View) -> Unit = {}): ImageButton = ImageButton(context).apply {
        val glyphColor = when (spec.style) {
            MoteIconButtonStyle.SOLID -> NativeColorRole.PRIMARY_INK
            MoteIconButtonStyle.MUTED -> NativeColorRole.MUTED
            else -> NativeColorRole.INK
        }
        val fill = when (spec.style) {
            MoteIconButtonStyle.SOLID -> NativeColorRole.PRIMARY_BACKGROUND
            MoteIconButtonStyle.FILLED -> NativeColorRole.FILL
            else -> NativeColorRole.TRANSPARENT
        }
        minimumWidth = context.moteDp(spec.touchSizeDp); minimumHeight = context.moteDp(spec.touchSizeDp)
        elevation = 0f; stateListAnimator = null; scaleType = ImageView.ScaleType.CENTER
        setImageResource(spec.glyph.drawable)
        bind(this, "icon-button") { view ->
            (view as ImageButton).imageTintList = ColorStateList.valueOf(glyphColor.color())
            view.background = MoteUi.clickable(context, fill, NativeRadiusRole.PILL, false)
        }
        contentDescription = MoteI18n.text(spec.description); isFocusable = true
        setOnClickListener(onClick)
    }

    fun iconButton(context: Context, glyph: MoteGlyph, description: String = glyph.a11yKey,
                  style: MoteIconButtonStyle = MoteIconButtonStyle.PLAIN, onClick: (View) -> Unit = {}) =
        iconButton(context, MoteIconButtonSpec(glyph, description, style), onClick)

    /** Rows in one hair-outlined container; children get rounded clipping and hair dividers. */
    fun group(context: Context): LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        bind(this, "group") { it.background = MoteUi.shape(context, NativeColorRole.SURFACE, NativeRadiusRole.CONTAINER, true, NativeColorRole.HAIR) }
        outlineProvider = ViewOutlineProvider.BACKGROUND; clipToOutline = true
    }

    fun divider(context: Context): View = View(context).apply {
        bind(this, "divider") { it.setBackgroundColor(NativeColorRole.HAIR.color()) }
        layoutParams = LinearLayout.LayoutParams(-1, context.moteDp(MoteTheme.borderWidth))
    }

    fun row(
        context: Context,
        icon: MoteGlyph? = null,
        title: String,
        subtitle: String? = null,
        value: String? = null,
        valueFont: NativeFontRole = NativeFontRole.META,
        valueColor: NativeColorRole = NativeColorRole.MUTED,
        titleColor: NativeColorRole = NativeColorRole.INK,
        iconColor: NativeColorRole = NativeColorRole.MUTED,
        subtitleColor: NativeColorRole = NativeColorRole.MUTED,
        trailing: View? = null,
        chevron: Boolean = true,
        verticalPaddingDp: Int = 9,
        iconSizeDp: Int = 24,
        onClick: ((View) -> Unit)? = null,
    ): View = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
        minimumHeight = context.moteDp(MoteTheme.controlHeight)
        setPadding(context.moteDp(14), context.moteDp(verticalPaddingDp), context.moteDp(14), context.moteDp(verticalPaddingDp))
        icon?.let { addView(MoteComponents.icon(context, it, iconColor, iconSizeDp), LinearLayout.LayoutParams(context.moteDp(iconSizeDp), context.moteDp(iconSizeDp)).apply { marginEnd = context.moteDp(12) }) }
        addView(LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(context).apply { text = title; MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, titleColor) })
            subtitle?.let { addView(TextView(context).apply { text = it; MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, subtitleColor) }) }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        value?.let { addView(TextView(context).apply { text = it; MoteUi.type(this, valueFont); MoteUi.textColor(this, valueColor) }, LinearLayout.LayoutParams(-2, -2).apply { marginStart = context.moteDp(12) }) }
        when {
            trailing != null -> addView(trailing, LinearLayout.LayoutParams(-2, -2).apply { marginStart = context.moteDp(12) })
            onClick != null && chevron -> addView(MoteComponents.icon(context, MoteGlyph.CHEV, NativeColorRole.MUTED, 16), LinearLayout.LayoutParams(-2, -2).apply { marginStart = context.moteDp(12) })
        }
        if (onClick != null) {
            bind(this, "row") { it.background = MoteUi.clickable(context, NativeColorRole.TRANSPARENT, NativeRadiusRole.CONTAINER, false) }
            contentDescription = title; isFocusable = true; setOnClickListener(onClick)
        }
    }

    /** All buttons are capsules: primary ink, secondary fill without outline, text, danger. */
    fun button(context: Context, label: String, role: MoteUi.ButtonRole = MoteUi.ButtonRole.SECONDARY, onClick: (View) -> Unit = {}): Button =
        MoteUi.action(Button(context).apply { text = label; setOnClickListener(onClick) }, role)

    /** A 32dp visual capsule inside a full 48dp touch target for the compact row action. */
    fun smallButton(context: Context, label: String, onClick: (View) -> Unit = {}): View = FrameLayout(context).apply {
        minimumHeight = context.moteDp(MoteIconButtonSpec.MIN_TOUCH_DP)
        contentDescription = MoteI18n.text(label)
        isFocusable = true
        setOnClickListener(onClick)
        val visual = Button(context).apply {
            text = MoteI18n.text(label); isAllCaps = false
            minWidth = 0; minimumWidth = 0; minHeight = 0; minimumHeight = 0
            includeFontPadding = false; isFocusable = false; isClickable = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            MoteUi.type(this, NativeFontRole.ACTION, medium = true)
            MoteUi.textColor(this, NativeColorRole.INK)
            setPadding(context.moteDp(12), 0, context.moteDp(12), 0)
            bind(this, "small-button") { view ->
                view.background = MoteUi.shape(context, NativeColorRole.FILL, NativeRadiusRole.PILL, false)
            }
        }
        addView(visual, FrameLayout.LayoutParams(-2, context.moteDp(32)).apply { gravity = Gravity.CENTER_VERTICAL })
    }

    /** Inner items are capsule buttons; the frame radius is the button radius + gap. */
    internal class MoteSegmented(context: Context, options: List<Pair<String, String>>, private val onSelect: (String) -> Unit) : LinearLayout(context) {
        private val gap get() = context.moteDp(2)
        private val itemHeight get() = context.moteDp(DesignTokens.controlHeight)
        private val entries = options.map { (id, key) -> id to TextView(context).apply {
            text = MoteI18n.text(key); contentDescription = text; gravity = Gravity.CENTER
            minHeight = itemHeight
            MoteUi.type(this, NativeFontRole.ACTION, medium = true); isFocusable = true
            setOnClickListener { onSelect(id) }
        } }
        init {
            orientation = HORIZONTAL; isBaselineAligned = false
            setPadding(gap, gap, gap, gap)
            bind(this, "segmented") {
                it.background = NativeThemeShape(resources.displayMetrics.density, NativeColorRole.SURFACE_HOVER,
                    { DesignTokens.controlHeight / 2 + 2 }, false, NativeColorRole.HAIR)
            }
            entries.forEach { (_, view) -> addView(view, LayoutParams(0, itemHeight, 1f)) }
        }
        fun select(id: String) {
            entries.forEach { (entryId, view) ->
                val selected = entryId == id
                MoteUi.textColor(view, if (selected) NativeColorRole.INK else NativeColorRole.MUTED)
                bind(view, "segmented-item") {
                    it.background = if (selected) MoteUi.shape(context, NativeColorRole.SURFACE, NativeRadiusRole.PILL, true, NativeColorRole.HAIR) else null
                }
                view.isSelected = selected
            }
        }
    }

    enum class MoteBannerTone { NEUTRAL, AMBER }

    /** Capsule banner; the optional action is a capsule button too. */
    fun banner(context: Context, icon: MoteGlyph?, text: String, tone: MoteBannerTone = MoteBannerTone.NEUTRAL,
               actionLabel: String? = null, onAction: (View) -> Unit = {}): View = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
        minimumHeight = context.moteDp(MoteTheme.controlHeight) + context.moteDp(12)
        setPadding(context.moteDp(16), context.moteDp(6), context.moteDp(6), context.moteDp(6))
        bind(this, "banner") {
            it.background = if (tone == MoteBannerTone.AMBER) MoteUi.shape(context, NativeColorRole.WARNING_TINT, NativeRadiusRole.PILL, false)
                else MoteUi.shape(context, NativeColorRole.SURFACE, NativeRadiusRole.PILL, true, NativeColorRole.HAIR)
        }
        icon?.let { addView(MoteComponents.icon(context, it, if (tone == MoteBannerTone.AMBER) NativeColorRole.WARNING else NativeColorRole.MUTED),
            LinearLayout.LayoutParams(-2, -2).apply { marginEnd = context.moteDp(10) }) }
        addView(TextView(context).apply {
            this.text = text; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
            MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        actionLabel?.let { label ->
            addView(button(context, label, MoteUi.ButtonRole.SECONDARY, onAction), LinearLayout.LayoutParams(-2, -2).apply { marginStart = context.moteDp(8) })
        }
    }

    /** Raised panel rounding only the top corners, with a grab handle. */
    fun sheet(context: Context, content: View? = null): LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        bind(this, "sheet") {
            val r = resources.displayMetrics.density * MoteTheme.radiusPanelMobile
            it.background = GradientDrawable().apply {
                setColor(NativeColorRole.SURFACE_RAISED.color()); cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
            }
        }
        addView(View(context).apply {
            bind(this, "grab") { it.background = MoteUi.shape(context, NativeColorRole.BORDER, NativeRadiusRole.PILL, false) }
        }, LinearLayout.LayoutParams(context.moteDp(36), context.moteDp(5)).apply {
            gravity = Gravity.CENTER_HORIZONTAL; topMargin = context.moteDp(6); bottomMargin = context.moteDp(2)
        })
        content?.let { addView(it, LinearLayout.LayoutParams(-1, -2).apply {
            setMargins(context.moteDp(16), context.moteDp(8), context.moteDp(16), context.moteDp(16)) }) }
    }

    /** Ink capsule confirming the owner's own action; never an overlay status. */
    fun toast(context: Context, text: String, actionLabel: String? = null, onAction: (View) -> Unit = {}): View = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
        minimumHeight = context.moteDp(MoteTheme.controlHeight)
        setPadding(context.moteDp(18), 0, 0, 0)
        bind(this, "toast") { it.background = MoteUi.shape(context, NativeColorRole.PRIMARY_BACKGROUND, NativeRadiusRole.PILL, false) }
        addView(TextView(context).apply {
            this.text = text; MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.PRIMARY_INK)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        actionLabel?.let { label ->
            addView(Button(context).apply {
                this.text = label; isAllCaps = false
                MoteUi.type(this, NativeFontRole.ACTION, medium = true); MoteUi.textColor(this, NativeColorRole.PRIMARY_INK)
                minimumHeight = context.moteDp(MoteTheme.controlHeight); minHeight = minimumHeight
                setPadding(context.moteDp(12), 0, context.moteDp(18), 0)
                bind(this, "toast-action") { it.background = MoteUi.clickable(context, NativeColorRole.TRANSPARENT, NativeRadiusRole.PILL, false) }
                setOnClickListener(onAction)
            })
        }
    }

    enum class MoteBadgeTone { NEUTRAL, OK, WARN, ERR }

    fun badge(context: Context, text: String, tone: MoteBadgeTone = MoteBadgeTone.NEUTRAL): View = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
        val (fill, ink) = when (tone) {
            MoteBadgeTone.NEUTRAL -> NativeColorRole.SURFACE_HOVER to NativeColorRole.INK
            MoteBadgeTone.OK -> NativeColorRole.SUCCESS_TINT to NativeColorRole.SUCCESS
            MoteBadgeTone.WARN -> NativeColorRole.WARNING_TINT to NativeColorRole.WARNING
            MoteBadgeTone.ERR -> NativeColorRole.DANGER_TINT to NativeColorRole.DANGER
        }
        bind(this, "badge") { it.background = MoteUi.shape(context, fill, NativeRadiusRole.PILL, false) }
        setPadding(context.moteDp(8), 0, context.moteDp(8), 0)
        addView(View(context).apply {
            bind(this, "badge-dot") { it.background = MoteUi.shape(context, ink, NativeRadiusRole.PILL, false) }
        }, LinearLayout.LayoutParams(context.moteDp(8), context.moteDp(8)).apply { marginEnd = context.moteDp(6) })
        addView(TextView(context).apply { this.text = text; MoteUi.type(this, NativeFontRole.META, medium = true); MoteUi.textColor(this, ink) })
        layoutParams = LinearLayout.LayoutParams(-2, context.moteDp(22))
    }

    /** The brand mark is fixed at 28 x 28 with a 6dp corner and never follows radius tokens. */
    fun mark(context: Context): View = TextView(context).apply {
        text = "m"; gravity = Gravity.CENTER
        setTextSize(TypedValue.COMPLEX_UNIT_DIP, 23f); letterSpacing = -0.065f; includeFontPadding = false
        typeface = Typeface.create(MoteTheme.fontFamily(false), Typeface.BOLD)
        bind(this, "mark") { view ->
            view.background = MoteUi.shape(context, NativeColorRole.PRIMARY_BACKGROUND, MARK_RADIUS_DP, false)
            MoteUi.textColor(view as TextView, NativeColorRole.PRIMARY_INK)
        }
        layoutParams = LinearLayout.LayoutParams(context.moteDp(28), context.moteDp(28))
    }
    private const val MARK_RADIUS_DP = 6

    /** M3-style switch: bordered track off, accent track and raised thumb on. */
    internal class MoteSwitch(context: Context, initial: Boolean, private val onChange: (Boolean) -> Unit) : View(context) {
        var checked = initial
            private set
        private val track = Paint(Paint.ANTI_ALIAS_FLAG)
        private val thumb = Paint(Paint.ANTI_ALIAS_FLAG)
        init {
            isFocusable = true
            setOnClickListener { checked = !checked; invalidate(); onChange(checked) }
        }
        fun setChecked(value: Boolean) {
            if (checked != value) { checked = value; invalidate() }
        }
        override fun onInitializeAccessibilityNodeInfo(info: android.view.accessibility.AccessibilityNodeInfo) {
            super.onInitializeAccessibilityNodeInfo(info)
            info.className = android.widget.Switch::class.java.name
            info.isCheckable = true; info.isChecked = checked
        }
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            setMeasuredDimension(context.moteDp(52), context.moteDp(MoteTheme.controlHeight))
        }
        override fun onDraw(canvas: Canvas) {
            val d = resources.displayMetrics.density
            val w = width.toFloat()
            // The visual track stays 52 x 32; the extra height is touch area.
            val top = (height - 32 * d) / 2; val bottom = top + 32 * d; val cy = top + 16 * d
            track.style = Paint.Style.FILL; track.color = if (checked) MoteTheme.accent else MoteTheme.surface
            canvas.drawRoundRect(0f, top, w, bottom, 16 * d, 16 * d, track)
            track.style = Paint.Style.STROKE; track.strokeWidth = 2 * d
            track.color = if (checked) MoteTheme.accent else MoteTheme.controlBorder
            canvas.drawRoundRect(d, top + d, w - d, bottom - d, 15 * d, 15 * d, track)
            if (checked) {
                thumb.color = MoteTheme.onAccent
                canvas.drawCircle(36 * d, cy, 12 * d, thumb)
            } else {
                thumb.color = MoteTheme.controlBorder
                canvas.drawCircle(16 * d, cy, 8 * d, thumb)
            }
        }
    }

    fun switch(context: Context, checked: Boolean, description: String, onChange: (Boolean) -> Unit = {}): MoteSwitch =
        MoteSwitch(context, checked, onChange).apply { contentDescription = description }
}
