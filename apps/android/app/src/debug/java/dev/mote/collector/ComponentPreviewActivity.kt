package dev.mote.collector

import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import dev.mote.collector.ui.MoteIconButtonStyle

/** Debug-only component gallery: generated content for design review. */
class ComponentPreviewActivity : MoteActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val root = NativeAppShell(this).apply { moteInsets() }
        root.header(TextView(this).apply {
            text = MoteI18n.text("组件"); MoteUi.type(this, NativeFontRole.TITLE_MOBILE, medium = true); MoteUi.textColor(this, NativeColorRole.INK)
            setPadding(moteDp(20), moteDp(MoteTheme.spaceItem), moteDp(20), moteDp(MoteTheme.spaceInline))
        })
        root.content(ScrollView(this).apply { isFillViewport = true; addView(body) })
        setContentView(root)
        body.setPadding(moteDp(16), 0, moteDp(16), moteDp(32))

        body.addView(caption("输入"))
        body.addView(field(icon = MoteGlyph.SEARCH, placeholder = "搜索资料"))
        body.addView(field(text = "暖气费按实际用量", focused = true, caret = true).apply { layoutParams = spaced() })
        body.addView(field(text = "月底前把账单照片发给房东。", minHeight = 72, top = true).apply { layoutParams = spaced() })

        body.addView(caption("按钮"))
        body.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; isBaselineAligned = false; gravity = Gravity.CENTER_VERTICAL
            addView(MoteComponents.button(context, "保存", MoteUi.ButtonRole.PRIMARY), LinearLayout.LayoutParams(0, -2, 1f))
            addView(MoteComponents.button(context, "取消"), LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(8) })
            addView(MoteComponents.iconButton(context, MoteGlyph.CAMERA, "拍照", MoteIconButtonStyle.FILLED), LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(8) })
            addView(MoteComponents.iconButton(context, MoteGlyph.MIC, "录音", MoteIconButtonStyle.FILLED), LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(8) })
        }.apply { layoutParams = spaced() })
        body.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; isBaselineAligned = false; gravity = Gravity.CENTER_VERTICAL
            addView(MoteComponents.button(context, "移除附件", MoteUi.ButtonRole.DANGER), LinearLayout.LayoutParams(-2, -2))
            addView(MoteComponents.button(context, "查看后续处理", MoteUi.ButtonRole.TEXT), LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(8) })
            addView(MoteComponents.iconButton(context, MoteGlyph.SEND, "发送", MoteIconButtonStyle.SOLID), LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(8) })
            addView(MoteComponents.iconButton(context, MoteGlyph.MORE, "更多", MoteIconButtonStyle.MUTED), LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(8) })
        }.apply { layoutParams = spaced(4) })

        body.addView(caption("分组与行"))
        body.addView(MoteComponents.group(this).apply {
            layoutParams = spaced()
            addView(MoteComponents.row(context, MoteGlyph.BELL, "通知", value = "21:38") {})
            addView(MoteComponents.divider(context))
            addView(MoteComponents.row(context, MoteGlyph.PHOTO, "媒体", value = "等待采集权限", valueColor = NativeColorRole.WARNING) {})
            addView(MoteComponents.divider(context))
            addView(MoteComponents.row(context, MoteGlyph.SCREEN, "屏幕采集", trailing = MoteComponents.switch(context, true, MoteI18n.text("屏幕采集")) {}))
        })

        body.addView(caption("状态与反馈"))
        body.addView(MoteComponents.banner(this, MoteGlyph.PAUSE, "屏幕采集已暂停", MoteComponents.MoteBannerTone.NEUTRAL, "恢复").apply { layoutParams = spaced() })
        body.addView(MoteComponents.banner(this, MoteGlyph.ALERT, "等待采集权限", MoteComponents.MoteBannerTone.AMBER, "处理").apply { layoutParams = spaced() })
        body.addView(MoteComponents.toast(this, "已清空", "撤销").apply { layoutParams = spaced() })
        body.addView(MoteComponents.MoteSegmented(this, listOf("library" to "资料", "memory" to "记忆")) {}.apply {
            layoutParams = spaced(); select("library")
        })
        body.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; isBaselineAligned = false
            addView(MoteComponents.badge(context, "正在采集", MoteComponents.MoteBadgeTone.OK))
            addView(MoteComponents.badge(context, "已暂停"), LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(8) })
            addView(MoteComponents.badge(context, "需要处理", MoteComponents.MoteBadgeTone.WARN), LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(8) })
            addView(MoteComponents.badge(context, "失联", MoteComponents.MoteBadgeTone.ERR), LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(8) })
        }.apply { layoutParams = spaced() })

        body.addView(caption("标识与底部面板"))
        body.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; isBaselineAligned = false; gravity = Gravity.CENTER_VERTICAL
            addView(MoteComponents.mark(context))
            addView(TextView(context).apply {
                text = "我的 Mote"; MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK)
            }, LinearLayout.LayoutParams(-2, -2).apply { marginStart = moteDp(10) })
        }.apply { layoutParams = spaced() })
        body.addView(MoteComponents.sheet(this, LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(MoteComponents.row(context, MoteGlyph.FOLDER, "同步文件夹", subtitle = "持续收集文件夹里的新内容与修改") {})
            addView(MoteComponents.row(context, MoteGlyph.FILE, "导入文件", subtitle = "导入一次，不跟踪后续修改。") {})
        }).apply { layoutParams = spaced() })

        body.addView(caption("底部导航"))
        body.addView(MotePrimaryNavigation(this) {}.apply { layoutParams = spaced() })

        body.addView(caption("图标"))
        val icons = MoteGlyph.entries.toList()
        val perRow = 7
        icons.chunked(perRow).forEach { chunk ->
            body.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; isBaselineAligned = false
                chunk.forEach { glyph ->
                    addView(LinearLayout(context).apply {
                        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
                        addView(MoteComponents.icon(context, glyph, NativeColorRole.INK, 24))
                        addView(TextView(context).apply {
                            text = glyph.name.lowercase(); textSize = 9f
                            MoteUi.textColor(this, NativeColorRole.MUTED)
                        })
                    }, LinearLayout.LayoutParams(0, -2, 1f))
                }
            }.apply { layoutParams = spaced(6) })
        }
    }

    private fun caption(label: String) = TextView(this).apply {
        text = label; MoteUi.type(this, NativeFontRole.META, medium = true); MoteUi.textColor(this, NativeColorRole.MUTED)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(22); bottomMargin = moteDp(8); marginStart = moteDp(2) }
    }
    private fun spaced(top: Int = 0) = LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(if (top > 0) top else 8) }

    private fun field(icon: MoteGlyph? = null, text: String? = null, placeholder: String? = null,
                      focused: Boolean = false, caret: Boolean = false, minHeight: Int = 0, top: Boolean = false): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = if (top) Gravity.TOP else Gravity.CENTER_VERTICAL; isBaselineAligned = false
            if (minHeight > 0) this.minimumHeight = moteDp(minHeight) else minimumHeight = moteDp(MoteTheme.controlHeight)
            setPadding(moteDp(12), moteDp(if (top) 10 else 0), moteDp(12), moteDp(if (top) 10 else 0))
            background = MoteUi.fieldShape(this@ComponentPreviewActivity, focused)
            icon?.let { addView(MoteComponents.icon(context, it), LinearLayout.LayoutParams(-2, -2).apply { marginEnd = moteDp(8) }) }
            addView(TextView(context).apply {
                this.text = text ?: placeholder; MoteUi.type(this, NativeFontRole.BODY)
                MoteUi.textColor(this, if (text != null) NativeColorRole.INK else NativeColorRole.MUTED)
            }, LinearLayout.LayoutParams(0, -2, 1f))
            if (caret) addView(View(context).apply {
                background = GradientDrawable().apply { setColor(NativeColorRole.ACCENT.color()); cornerRadius = resources.displayMetrics.density }
            }, LinearLayout.LayoutParams(moteDp(2), moteDp(20)).apply { marginStart = moteDp(1) })
        }
}
