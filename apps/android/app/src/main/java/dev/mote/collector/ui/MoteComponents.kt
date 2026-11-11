package dev.mote.collector.ui

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.drawable.AnimatedVectorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.SystemClock
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.LeadingMarginSpan
import android.text.style.ReplacementSpan
import android.view.Gravity
import android.view.View
import android.view.ViewOutlineProvider
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.LinearInterpolator
import android.view.animation.PathInterpolator
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

/** A Lucide compound glyph on text actions, refreshed with the active theme. */
internal fun TextView.moteGlyph(glyph: MoteGlyph, color: NativeColorRole = NativeColorRole.MUTED,
                                sizeDp: Int = 20, atStart: Boolean = false, gapDp: Int = 6): TextView = apply {
    NativePresentationStyles.bind(this, "mote-glyph") { value ->
        (value as TextView).apply {
            val drawable = context.getDrawable(glyph.drawable)?.mutate()
            drawable?.setBounds(0, 0, context.moteDp(sizeDp), context.moteDp(sizeDp))
            drawable?.setTint(color.color())
            if (atStart) setCompoundDrawablesRelative(drawable, null, null, null)
            else setCompoundDrawablesRelative(null, null, drawable, null)
            compoundDrawablePadding = context.moteDp(gapDp)
        }
    }
}

/** Disclosure actions use the same Lucide chevron pair as the shared secondary rows. */
internal fun TextView.moteDisclosureGlyph(expanded: Boolean, color: NativeColorRole = NativeColorRole.MUTED,
                                          sizeDp: Int = 20, gapDp: Int = 6): TextView =
    moteGlyph(if (expanded) MoteGlyph.DOWN else MoteGlyph.CHEV, color, sizeDp, atStart = true, gapDp = gapDp)

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

    /** The brand mark: one stroke for the m, its last leg resting on a dot. Ink and dot follow the theme. */
    fun mark(context: Context): View = MarkView(context).apply {
        bind(this, "mark") { (it as MarkView).colors(NativeColorRole.INK.color(), NativeColorRole.ACCENT.color()) }
        layoutParams = LinearLayout.LayoutParams(context.moteDp(28), context.moteDp(28))
    }

    private class MarkView(context: Context) : View(context) {
        private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE; strokeWidth = 2.2f; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
        }
        private val dot = Paint(Paint.ANTI_ALIAS_FLAG)
        private val path = Path().apply {
            moveTo(5.25f, 16.5f); lineTo(5.25f, 7.5f)
            for ((start, end) in listOf(5.25f to 16.5f, 11.75f to 12.2f)) {
                moveTo(start, 10.75f); arcTo(start, 7.5f, start + 6.5f, 14f, 180f, 180f, false); lineTo(start + 6.5f, end)
            }
        }
        fun colors(ink: Int, accent: Int) { stroke.color = ink; dot.color = accent; invalidate() }
        override fun onDraw(canvas: Canvas) {
            val unit = minOf(width, height) / 24f
            canvas.save(); canvas.translate((width - unit * 24f) / 2f, (height - unit * 24f) / 2f); canvas.scale(unit, unit)
            canvas.drawPath(path, stroke); canvas.drawCircle(18.25f, 15.85f, 1.65f, dot)
            canvas.restore()
        }
    }

    /** Views that stand in for content still being read; fixtures wait for them to leave. */
    const val LOADING_TAG = "mote-loading"

    /** Content is on its way: quiet rows in the shape of what replaces them. TalkBack still hears the words. */
    fun skeleton(context: Context, label: String, rows: Int = 3): View = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL; tag = LOADING_TAG
        contentDescription = label; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        setPadding(0, context.moteDp(12), 0, context.moteDp(12))
        repeat(rows) { index ->
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                addView(skeletonBar(context, if (index % 2 == 0) .62f else .48f, 14))
                addView(skeletonBar(context, .34f, 11), LinearLayout.LayoutParams(-1, -2).apply { topMargin = context.moteDp(9) })
            }, LinearLayout.LayoutParams(-1, -2).apply { if (index > 0) topMargin = context.moteDp(20) })
        }
        loadingMotion(this, breathe = true)
    }

    /** An image still on its way: its own frame, quietly breathing. */
    fun skeletonTile(context: Context, label: String): View = View(context).apply {
        tag = LOADING_TAG; contentDescription = label
        bind(this, "skeleton") { it.background = MoteUi.shape(context, NativeColorRole.FILL, NativeRadiusRole.CONTAINER, false) }
        loadingMotion(this, breathe = true)
    }

    private fun skeletonBar(context: Context, fraction: Float, heightDp: Int): View = LinearLayout(context).apply {
        weightSum = 1f
        addView(View(context).apply { bind(this, "skeleton") { it.background = MoteUi.shape(context, NativeColorRole.FILL, NativeRadiusRole.PILL, false) } },
            LinearLayout.LayoutParams(0, context.moteDp(heightDp), fraction))
    }

    /** A wait that owns the whole screen: the mark writes itself, then the dot settles. */
    fun loadingMark(context: Context, label: String): View = FrameLayout(context).apply {
        tag = LOADING_TAG; contentDescription = label; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        val mark = ImageView(context).apply { setImageResource(R.drawable.avd_mote_loading); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        addView(mark, FrameLayout.LayoutParams(context.moteDp(40), context.moteDp(40), Gravity.CENTER))
        if (ValueAnimator.areAnimatorsEnabled()) addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(view: View) { (mark.drawable as? AnimatedVectorDrawable)?.start() }
            override fun onViewDetachedFromWindow(view: View) { (mark.drawable as? AnimatedVectorDrawable)?.stop() }
        })
        loadingMotion(this, breathe = false)
    }

    /** Nothing for the first 300 ms, then a slow breath; still when the system turns animation off. */
    private fun loadingMotion(view: View, breathe: Boolean) {
        if (!ValueAnimator.areAnimatorsEnabled()) return
        view.alpha = 0f
        val motion = AnimatorSet().apply {
            val appear = ObjectAnimator.ofFloat(view, View.ALPHA, 0f, 1f).apply { startDelay = 300; duration = 200 }
            if (!breathe) play(appear)
            else playSequentially(appear, ObjectAnimator.ofFloat(view, View.ALPHA, 1f, .45f, 1f).apply {
                duration = 1800; repeatCount = ValueAnimator.INFINITE; interpolator = AccelerateDecelerateInterpolator()
            })
        }
        view.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(attached: View) { motion.start() }
            override fun onViewDetachedFromWindow(detached: View) { motion.cancel() }
        })
    }

    /** Visible content is refreshing: a thin accent line runs under the header; held full and faint when animation is off. */
    fun loadingLine(context: Context, label: String): View = LinearLayout(context).apply {
        tag = LOADING_TAG; contentDescription = label; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        val still = !ValueAnimator.areAnimatorsEnabled()
        weightSum = 1f
        val runner = View(context).apply {
            bind(this, "loading-line") { it.background = MoteUi.shape(context, NativeColorRole.ACCENT, NativeRadiusRole.PILL, false) }
            if (still) alpha = .45f
        }
        addView(runner, LinearLayout.LayoutParams(0, -1, if (still) 1f else .36f))
        if (!still) {
            val run = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = 1400; repeatCount = ValueAnimator.INFINITE; interpolator = PathInterpolator(.45f, .05f, .25f, 1f)
                addUpdateListener { runner.translationX = runner.width * (-1f + 3.8f * (it.animatedValue as Float)) }
            }
            addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                override fun onViewAttachedToWindow(attached: View) { run.start() }
                override fun onViewDetachedFromWindow(detached: View) { run.cancel() }
            })
        }
        loadingMotion(this, breathe = false)
    }

    /** Work past this long says what it is doing and for how long. */
    const val SLOW_WORK_MS = 5_000L

    /** Words still on their way: a quiet bar holds their place. The words stay underneath for TalkBack; whatever is set next replaces the bar. */
    fun reading(view: TextView, label: String = MoteI18n.text("正在读取…"), prefix: CharSequence = "") {
        val current = view.text
        val bar = (current as? Spanned)?.getSpans(0, current.length, PlaceholderSpan::class.java)?.firstOrNull()
        if (bar != null && current.toString() == prefix.toString() + label) return
        val span = bar ?: PlaceholderSpan(view)
        view.text = SpannableStringBuilder(prefix).append(label, span, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        if (bar == null) span.motion.start()
    }

    /** Work under way: its words keep their place and a ring turns beside them until other text is set. */
    fun working(view: TextView, words: String, prefix: CharSequence = "") {
        val current = view.text
        val ring = (current as? Spanned)?.getSpans(0, current.length, RingSpan::class.java)?.firstOrNull()
        if (ring != null && current.toString() == prefix.toString() + words) return
        val span = ring ?: RingSpan(view)
        view.text = SpannableStringBuilder(prefix).append(words, span, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        if (ring == null) span.motion.start()
    }

    /**
     * UiTask progress shown in [view]: the bar for a read ([read]) or the words with a ring for other work.
     * Progress the work reports itself, or work past [SLOW_WORK_MS], shows its words and elapsed time beside the ring.
     */
    fun progress(view: TextView, read: Boolean = true, prefix: () -> CharSequence = { "" }): (String) -> Unit {
        val started = SystemClock.elapsedRealtime()
        var label: String? = null
        return { message ->
            val first = label ?: message.also { label = it }
            when {
                !message.startsWith(first) || SystemClock.elapsedRealtime() - started >= SLOW_WORK_MS -> working(view, message, prefix())
                read -> reading(view, first, prefix())
                else -> working(view, first, prefix())
            }
        }
    }

    /** Fades in after 300 ms, then breathes (bar) or turns (ring) while its span is in the text; still when the system turns animation off. */
    private class SpanMotion(private val view: TextView, private val turn: Boolean) : View.OnAttachStateChangeListener {
        lateinit var span: Any
        var level = if (ValueAnimator.areAnimatorsEnabled()) 0f else 1f
            private set
        var phase = 0f
            private set
        private var motion: AnimatorSet? = null
        private fun shown() = (view.text as? Spanned)?.let { it.getSpanStart(span) >= 0 } == true
        fun start() { view.addOnAttachStateChangeListener(this); if (view.isAttachedToWindow) onViewAttachedToWindow(view) }
        override fun onViewAttachedToWindow(attached: View) {
            if (!shown()) { view.removeOnAttachStateChangeListener(this); return }
            if (motion != null || !ValueAnimator.areAnimatorsEnabled()) return
            val appear = ValueAnimator.ofFloat(level, 1f).apply {
                if (level == 0f) startDelay = 300
                duration = 200; addUpdateListener { level = it.animatedValue as Float; frame() }
            }
            val keep = if (turn) ValueAnimator.ofFloat(0f, 1f).apply {
                startDelay = appear.startDelay; duration = 900; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
                addUpdateListener { phase = it.animatedValue as Float; frame() }
            } else ValueAnimator.ofFloat(1f, .45f, 1f).apply {
                duration = 1800; repeatCount = ValueAnimator.INFINITE; interpolator = AccelerateDecelerateInterpolator()
                addUpdateListener { level = it.animatedValue as Float; frame() }
            }
            motion = AnimatorSet().apply { if (turn) playTogether(appear, keep) else playSequentially(appear, keep); start() }
        }
        override fun onViewDetachedFromWindow(detached: View) { motion?.cancel(); motion = null }
        private fun frame() {
            if (shown()) view.invalidate() else { motion?.cancel(); motion = null; view.removeOnAttachStateChangeListener(this) }
        }
    }

    /** The bar that stands in for words still being read. */
    private class PlaceholderSpan(view: TextView) : ReplacementSpan() {
        val motion = SpanMotion(view, turn = false).also { it.span = this }
        override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, metrics: Paint.FontMetricsInt?): Int {
            metrics?.let { paint.getFontMetricsInt(it) }
            return (paint.textSize * 5.5f).toInt()
        }
        override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
            if (motion.level <= 0f) return
            val height = paint.textSize * .72f
            val middle = y + (paint.ascent() + paint.descent()) / 2f
            val ink = paint.color; val style = paint.style; val fill = NativeColorRole.FILL.color()
            paint.style = Paint.Style.FILL; paint.color = fill; paint.alpha = (Color.alpha(fill) * motion.level).toInt()
            canvas.drawRoundRect(x, middle - height / 2f, x + paint.textSize * 5.5f, middle + height / 2f, height / 2f, height / 2f, paint)
            paint.color = ink; paint.style = style
        }
    }

    /** The ring beside words for work under way, drawn in the margin so the words themselves stay unchanged. */
    private class RingSpan(view: TextView) : LeadingMarginSpan {
        val motion = SpanMotion(view, turn = true).also { it.span = this }
        private val margin = (view.textSize * 1.45f).toInt()
        private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
        override fun getLeadingMargin(first: Boolean) = margin
        override fun drawLeadingMargin(canvas: Canvas, paint: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int,
            text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) {
            if (!first || motion.level <= 0f || (text as? Spanned)?.getSpanStart(this) != start) return
            val radius = paint.textSize * .34f
            stroke.strokeWidth = paint.textSize * .11f
            stroke.color = paint.color; stroke.alpha = (Color.alpha(paint.color) * motion.level).toInt()
            // Beside the words wherever the alignment puts them: centred buttons keep ring and words centred together.
            val line = layout?.getLineForOffset(start)
            val edge = when {
                layout == null || line == null -> x.toFloat()
                dir > 0 -> layout.getLineLeft(line) - margin
                else -> layout.getLineRight(line) + margin
            }
            val cx = edge + dir * (radius + stroke.strokeWidth)
            val cy = baseline + (paint.ascent() + paint.descent()) / 2f
            canvas.drawArc(cx - radius, cy - radius, cx + radius, cy + radius, motion.phase * 360f - 90f, 270f, false, stroke)
        }
    }

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
