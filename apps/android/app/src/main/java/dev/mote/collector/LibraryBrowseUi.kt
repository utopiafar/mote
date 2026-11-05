package dev.mote.collector

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph

/** Shared controls for the two library views. */
internal object LibraryBrowseUi {
    fun tabs(context: Context, selected: String, changed: (String) -> Unit): View {
        val choices = listOf("materials" to "资料", "memories" to "记忆")
        return MoteComponents.MoteSegmented(context, choices, changed).apply {
            tag = "library-primary-views"; select(selected)
            choices.forEachIndexed { index, (id, _) -> getChildAt(index).tag = "library-primary-views:$id" }
        }
    }

    fun search(context: Context, label: String, value: String): EditText = MoteUi.field(EditText(context).apply {
        tag = if (label == "搜索记忆") "memory-search" else "library-search"
        hint = MoteI18n.text(label); contentDescription = hint
        inputType = InputType.TYPE_CLASS_TEXT
        isSingleLine = true; imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH
        setText(value); setSelection(text.length)
        val searchIcon = context.getDrawable(MoteGlyph.SEARCH.drawable)?.mutate()
        searchIcon?.setTint(NativeColorRole.MUTED.color())
        val closeIcon = context.getDrawable(MoteGlyph.CLOSE.drawable)?.mutate()
        closeIcon?.setTint(NativeColorRole.MUTED.color())
        fun icons() {
            setCompoundDrawablesRelativeWithIntrinsicBounds(searchIcon, null, if (text.isNullOrEmpty()) null else closeIcon, null)
        }
        icons(); compoundDrawablePadding = context.moteDp(10)
        addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = icons()
            override fun afterTextChanged(s: android.text.Editable?) = Unit
        })
        setOnTouchListener { _, event ->
            val trailing = compoundDrawablesRelative[2] ?: return@setOnTouchListener false
            if (event.action == android.view.MotionEvent.ACTION_UP &&
                event.x >= width - paddingRight - trailing.intrinsicWidth - compoundDrawablePadding) {
                setText(""); true
            } else false
        }
        minimumHeight = context.moteDp(48)
    })

    fun filters(context: Context, choices: List<Pair<String, String>>, selected: String,
                choose: (String) -> Unit, history: Pair<Boolean, (Boolean) -> Unit>? = null,
                date: (() -> Unit)? = null, dateLabel: String = "") {
        val dialog = Dialog(context)
        val sheet = MoteComponents.sheet(context)
        val heading = LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL; setPadding(context.moteDp(20), 0, context.moteDp(6), 0)
            addView(android.widget.TextView(context).apply {
                text = MoteI18n.text("筛选"); MoteUi.type(this, NativeFontRole.SECTION, medium = true); MoteUi.textColor(this, NativeColorRole.INK)
            }, LinearLayout.LayoutParams(0, context.moteDp(48), 1f).apply { gravity = Gravity.CENTER_VERTICAL })
            addView(MoteComponents.iconButton(context, MoteGlyph.CLOSE, "关闭") { dialog.dismiss() }, LinearLayout.LayoutParams(context.moteDp(48), context.moteDp(48)))
        }
        sheet.addView(heading)
        val group = MoteComponents.group(context)
        choices.forEachIndexed { index, (value, label) ->
            if (index > 0) group.addView(MoteComponents.divider(context))
            val check = if (value == selected) MoteComponents.icon(context, MoteGlyph.CHECK, NativeColorRole.ACCENT) else null
            val row = MoteComponents.row(context, title = MoteI18n.text(label), trailing = check).apply {
                tag = "library-filter:$value"
                isSelected = value == selected
                isFocusable = true
                contentDescription = MoteI18n.text(label)
                background = MoteUi.clickable(context, NativeColorRole.TRANSPARENT, NativeRadiusRole.CONTAINER, false)
                setOnClickListener { choose(value); dialog.dismiss() }
                layoutParams = LinearLayout.LayoutParams(-1, context.moteDp(56))
            }
            group.addView(row)
        }
        sheet.addView(group, LinearLayout.LayoutParams(-1, -2).apply { setMargins(context.moteDp(16), context.moteDp(6), context.moteDp(16), 0) })
        if (history != null || date != null) {
            val extra = MoteComponents.group(context)
            if (history != null) {
                val toggle = MoteComponents.switch(context, history.first, "包含被替代与过期历史") { history.second(it) }
                extra.addView(MoteComponents.row(context, title = MoteI18n.text("包含被替代与过期历史"), trailing = toggle).apply {
                    tag = "memory-history-filter"
                    layoutParams = LinearLayout.LayoutParams(-1, context.moteDp(56))
                })
            }
            if (date != null) extra.addView(MoteComponents.row(context, MoteGlyph.CALENDAR, MoteI18n.text("按时间回看"),
                value = dateLabel.takeIf(String::isNotBlank), onClick = { dialog.dismiss(); date() }).apply {
                tag = "library-filter-date"
                layoutParams = LinearLayout.LayoutParams(-1, context.moteDp(56))
            })
            sheet.addView(extra, LinearLayout.LayoutParams(-1, -2).apply { setMargins(context.moteDp(16), context.moteDp(12), context.moteDp(16), 0) })
        }
        sheet.addView(View(context), LinearLayout.LayoutParams(1, context.moteDp(24)))
        sheet.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        dialog.setContentView(sheet)
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            setDimAmount(0.32f); setGravity(Gravity.BOTTOM); setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
        }
        dialog.show()
        dialog.window?.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
    }
}
