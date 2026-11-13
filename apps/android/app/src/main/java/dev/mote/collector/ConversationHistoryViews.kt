package dev.mote.collector

import android.content.Context
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import dev.mote.collector.ui.MoteIconButtonStyle
import java.time.Instant
import java.time.ZoneId

/** The AND-History list body: week groups of question rows. Rows open on tap
 * and expose row actions on long-press; the screen owns loading and failures. */
internal class ConversationListView(
    context: Context,
    private val onOpen: (String) -> Unit,
    private val onActions: (String) -> Unit,
) : LinearLayout(context) {
    private var renderedKey = ""

    init { orientation = VERTICAL }

    fun render(conversations: List<HistoryConversation>) {
        val now = Instant.now(); val zone = ZoneId.systemDefault()
        val groups = ConversationHistory.groups(conversations, now, zone)
        val key = groups.joinToString("\u0001") { group -> group.key + "\u0002" + group.items.joinToString("\u0003") { it.id + ":" + it.updatedAt + ":" + it.status } }
        if (key == renderedKey) return
        removeAllViews(); renderedKey = key
        for (group in groups) {
            addView(TextView(context).apply {
                text = MoteI18n.text(group.key)
                MoteUi.type(this, NativeFontRole.META, medium = true); MoteUi.textColor(this, NativeColorRole.MUTED)
                setPadding(context.moteDp(15), 0, context.moteDp(15), 0)
            }, LayoutParams(-1, -2).apply { topMargin = context.moteDp(22); bottomMargin = context.moteDp(8) })
            val container = MoteComponents.group(context)
            group.items.forEachIndexed { index, conversation ->
                if (index > 0) container.addView(MoteComponents.divider(context))
                container.addView(row(conversation, now, zone))
            }
            addView(container, LayoutParams(-1, -2))
        }
    }

    private fun row(conversation: HistoryConversation, now: Instant, zone: ZoneId): View = LinearLayout(context).apply {
        orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
        minimumHeight = context.moteDp(MoteTheme.controlHeight)
        setPadding(context.moteDp(14), context.moteDp(9), context.moteDp(14), context.moteDp(9))
        isFocusable = true; isClickable = true
        val stamp = ConversationHistory.dateLabel(conversation.updatedAt, now, zone)
        val statusLabel = ConversationHistory.statusLabel(conversation.status)
        contentDescription = conversation.title + ". " + (statusLabel?.let { it + " · " } ?: "") + stamp
        setOnClickListener { onOpen(conversation.id) }
        setOnLongClickListener { onActions(conversation.id); true }
        addView(TextView(context).apply {
            text = conversation.title.ifBlank { MoteI18n.text("问一问") }
            MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK)
            maxLines = 1; ellipsize = TextUtils.TruncateAt.END
        }, LayoutParams(0, -2, 1f).apply { marginEnd = context.moteDp(12) })
        addView(TextView(context).apply {
            text = if (statusLabel.isNullOrBlank()) stamp else statusLabel + " · " + stamp
            MoteUi.type(this, NativeFontRole.META)
            MoteUi.textColor(this, if (conversation.status == "failed") NativeColorRole.WARNING else NativeColorRole.MUTED)
            maxLines = 1
        }, LayoutParams(-2, -2))
    }
}

/** The AND-History dock composer: image action, 问一问 field, send only with text. */
internal class ConversationComposerView(
    context: Context,
    private val onAddImage: () -> Unit,
    private val onSend: (String) -> Unit,
) : LinearLayout(context) {
    private val input = EditText(context)
    private val sendButton: View
    val text: String get() = input.text.toString()
    private fun composerBackground() = if (input.text.isNotBlank()) {
        MoteUi.shape(context, NativeColorRole.SURFACE, NativeRadiusRole.PILL, true, NativeColorRole.ACCENT)
            .apply { setStroke(context.moteDp(2 * MoteTheme.borderWidth), NativeColorRole.ACCENT.color()) }
    } else MoteUi.shape(context, NativeColorRole.SURFACE, NativeRadiusRole.PILL, true, NativeColorRole.CONTROL_BORDER)

    init {
        orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        minimumHeight = context.moteDp(MoteTheme.controlHeight)
        NativePresentationStyles.bind(this, "conversation-composer") { it.background = composerBackground() }
        setPadding(context.moteDp(2), 0, context.moteDp(4), 0)
        addView(MoteComponents.iconButton(context, MoteGlyph.PHOTO, style = MoteIconButtonStyle.MUTED) { onAddImage() },
            LayoutParams(context.moteDp(MoteTheme.controlHeight), context.moteDp(MoteTheme.controlHeight)))
        input.hint = MoteI18n.text("问一问"); input.contentDescription = MoteI18n.text("问一问")
        input.isSaveEnabled = false; input.background = null; input.minHeight = 0
        NativePresentationStyles.bind(input, "hint-color") { (it as EditText).setHintTextColor(MoteTheme.muted) }
        MoteUi.textInput(input, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES)
        MoteUi.type(input, NativeFontRole.BODY); MoteUi.textColor(input, NativeColorRole.INK)
        input.filters = arrayOf(InputFilter.LengthFilter(8000))
        input.imeOptions = EditorInfo.IME_ACTION_SEND
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) { onSend(input.text.toString()); true } else false
        }
        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = sync()
            override fun afterTextChanged(s: Editable?) = Unit
        })
        addView(input, LayoutParams(0, -2, 1f).apply { marginStart = context.moteDp(8); marginEnd = context.moteDp(8) })
        sendButton = FrameLayout(context).apply {
            isClickable = true; isFocusable = true
            contentDescription = MoteI18n.text("发送")
            minimumWidth = context.moteDp(MoteTheme.controlHeight); minimumHeight = context.moteDp(MoteTheme.controlHeight)
            background = MoteUi.clickable(context, NativeColorRole.TRANSPARENT, NativeRadiusRole.PILL, false)
            setOnClickListener { onSend(input.text.toString()) }
            val disc = View(context).apply { background = MoteUi.shape(context, NativeColorRole.PRIMARY_BACKGROUND, NativeRadiusRole.PILL, false) }
            addView(disc, FrameLayout.LayoutParams(context.moteDp(40), context.moteDp(40), Gravity.CENTER))
            addView(MoteComponents.icon(context, MoteGlyph.UP, NativeColorRole.PRIMARY_INK, 20),
                FrameLayout.LayoutParams(context.moteDp(20), context.moteDp(20), Gravity.CENTER))
        }.also { it.visibility = View.GONE }
        addView(sendButton, LayoutParams(context.moteDp(MoteTheme.controlHeight), context.moteDp(MoteTheme.controlHeight)))
    }

    private fun sync() {
        val typing = input.text.isNotBlank()
        sendButton.visibility = if (typing) View.VISIBLE else View.GONE
        background = composerBackground()
    }
}
