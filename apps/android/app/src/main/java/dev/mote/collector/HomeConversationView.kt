package dev.mote.collector

import android.content.Context
import android.os.SystemClock
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
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId

/** Validates the exact conversation page the home renders. Central fields are
 * untrusted: a malformed row fails the read instead of reaching the UI. */
internal object HomeConversationRead {
    fun page(read: (String) -> JSONObject): JSONArray {
        val rows = read("/api/conversations?limit=5").getJSONArray("items")
        for (index in 0 until rows.length()) {
            val item = rows.getJSONObject(index)
            val id = item.getString("id")
            require(java.util.UUID.fromString(id).toString() == id)
            require(item.get("title") is String && item.get("updatedAt") is String)
            java.time.Instant.parse(item.getString("updatedAt"))
            require(item.get("turnCount") is Number && item.getInt("turnCount") >= 0)
        }
        return rows
    }
}

/** A read of existing conversation summaries; it never submits a question or starts capture. */
internal class HomeConversationView(private val activity: MoteActivity, private val archiveEmpty: (Boolean) -> Unit = {}, private val open: (String) -> Unit) : LinearLayout(activity), HomeSection {
    private val task = UiTask(activity)
    private val gate = HomeReadGate()
    private var closed = false
    private var active = false
    private var denied = false
    private var rendered = ""

    init { orientation = VERTICAL; tag = "home-recent-conversations" }

    override fun pause() { active = false; gate.wake() }
    override fun close() { closed = true; pause(); task.close() }

    override fun refresh() {
        if (closed) return
        active = true
        val access = runCatching { CentralAccess.resolve(activity) }.getOrElse {
            // A resolution failure replaces the retry with a plain label, but `denied` survives;
            // when resolution recovers the denied affordance is re-rendered below.
            clear(); label(MoteI18n.text("对话暂不可读取，请稍后重试。")); return
        }
        if (gate.adopt(access.generation, access.server)) { denied = false; clear(); archiveEmpty(false) }
        if (access.client == null) {
            denied = false
            message(if (access.server.isBlank()) MoteI18n.text("连接中央后查看对话。") else MoteI18n.text("登录中央后查看对话。"))
            return
        }
        // A revoked read leaves the gate stopped and its retry the only recovery: never read, keep the affordance.
        if (denied) { retryMessage(MoteI18n.text("对话暂不可读取，请稍后重试。")); return }
        val stamp = if (task.busy || !gate.due(SystemClock.elapsedRealtime())) return else gate.begin(SystemClock.elapsedRealtime())
        if (childCount == 0) label(MoteI18n.text("正在读取对话…"))
        task.start("", {}, {
            val rows = HomeConversationRead.page(access.client::get)
            val after = CentralAccess.resolve(activity)
            check(after.generation == access.generation && after.server == access.server && after.client != null)
            val emptyArchive = gate.archiveEmpty(rows.length() == 0, stamp, SystemClock.elapsedRealtime()) {
                HomeArchiveProbe.empty(access.client::get)
            }
            rows to emptyArchive
        }) { outcome ->
            if (closed || !active || !gate.current(stamp) || activity.isDestroyed || activity.isFinishing) return@start
            val current = runCatching { CentralAccess.resolve(activity) }.getOrNull()
            if (current == null || current.generation != access.generation || current.server != access.server || current.client == null) { clear(); gate.invalidate(); return@start }
            outcome.onSuccess { (rows, emptyArchive) ->
                gate.success(SystemClock.elapsedRealtime())
                denied = false
                archiveEmpty(emptyArchive)
                if (rendered == rows.toString()) return@onSuccess
                clear(); rendered = rows.toString()
                if (rows.length() == 0) label(MoteI18n.text("还没有对话。"))
                for (index in 0 until rows.length()) {
                    val item = rows.getJSONObject(index)
                    val id = item.optString("id")
                    val title = item.optString("title").ifBlank { MoteI18n.text("问一问") }
                    val date = runCatching {
                        java.time.Instant.parse(item.optString("updatedAt")).atZone(java.time.ZoneId.systemDefault())
                            .format(if (MoteI18n.locale().language == "zh") java.time.format.DateTimeFormatter.ofPattern("M 月 d 日 HH:mm", MoteI18n.locale()) else java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.SHORT).withLocale(MoteI18n.locale()))
                    }.getOrDefault(item.optString("updatedAt"))
                    val detail = MoteI18n.text("{0} 轮对话", item.optInt("turnCount")) + " · " + date
                    val row = LinearLayout(activity).apply {
                        gravity = Gravity.CENTER_VERTICAL; tag = "home-conversation:$id"
                        minimumHeight = activity.moteDp(78); setPadding(0, activity.moteDp(18), 0, activity.moteDp(18))
                        background = MoteUi.clickable(activity, NativeColorRole.BACKGROUND, 0, false)
                        isFocusable = true; contentDescription = "$title，$detail"
                        setOnClickListener {
                            val selected = runCatching { CentralAccess.resolve(activity) }.getOrNull()
                            if (selected?.client != null && selected.generation == access.generation && selected.server == access.server) open(id)
                            else { clear(); gate.invalidate(); refresh() }
                        }
                    }
                    row.addView(TextView(activity).apply { text = "◌"; textSize = 23f; MoteUi.textColor(this, NativeColorRole.ACCENT) }, LayoutParams(activity.moteDp(24), -2).apply { marginEnd = activity.moteDp(13) })
                    val text = LinearLayout(activity).apply {
                        orientation = VERTICAL
                        addView(TextView(activity).apply { this.text = title; MoteUi.type(this, NativeFontRole.ACTION, medium = true); MoteUi.textColor(this, NativeColorRole.INK) })
                        addView(TextView(activity).apply { this.text = detail; MoteUi.type(this, NativeFontRole.META); NativePresentationStyles.bind(this, "home-date") { (it as TextView).textSize = 10f }; MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(0, activity.moteDp(6), 0, 0) })
                    }
                    row.addView(text, LayoutParams(0, -2, 1f))
                    row.addView(TextView(activity).apply { this.text = "›"; textSize = 17f; MoteUi.textColor(this, NativeColorRole.MUTED) })
                    addView(row); divider()
                }
            }.onFailure { error ->
                val status = (error as? CentralFailure)?.status
                gate.failure(SystemClock.elapsedRealtime(), status)
                // A failed or revoked read is not an empty history, and must not expose old-target rows.
                archiveEmpty(false)
                if (status == 401 || status == 403) { denied = true; retryMessage(MoteI18n.text("对话暂不可读取，请稍后重试。")) }
                else message(MoteI18n.text("对话暂不可读取，请稍后重试。"))
            }
        }
    }
    private fun clear() { removeAllViews(); rendered = "" }
    private fun message(value: String) { if (rendered == value) return; clear(); rendered = value; label(value) }
    /** A revoked read offers an explicit retry that re-arms the gate; transient failures keep auto-retrying. */
    private fun retryMessage(value: String) {
        if (rendered == "$value\u0000retry") return
        clear(); rendered = "$value\u0000retry"
        label(value)
        addView(TextView(activity).apply {
            text = MoteI18n.text("重试"); MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.ACCENT)
            setPadding(0, 0, 0, activity.moteDp(16)); isClickable = true; isFocusable = true
            setOnClickListener { if (active && !closed) { denied = false; gate.retry(); refresh() } }
        })
    }
    private fun label(value: String) { addView(TextView(activity).apply { text = value; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(0, activity.moteDp(16), 0, activity.moteDp(16)) }) }
    private fun divider() { addView(View(activity).apply { MoteUi.backgroundColor(this, NativeColorRole.DIVIDER) }, LayoutParams(-1, activity.moteDp(1))) }
}

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
        val key = groups.joinToString("\u0001") { group -> group.key + "\u0002" + group.items.joinToString("\u0003") { it.id + ":" + it.updatedAt } }
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
        contentDescription = conversation.title + ". " + stamp
        setOnClickListener { onOpen(conversation.id) }
        setOnLongClickListener { onActions(conversation.id); true }
        addView(TextView(context).apply {
            text = conversation.title.ifBlank { MoteI18n.text("问一问") }
            MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK)
            maxLines = 1; ellipsize = TextUtils.TruncateAt.END
        }, LayoutParams(0, -2, 1f).apply { marginEnd = context.moteDp(12) })
        addView(TextView(context).apply {
            text = stamp
            MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED)
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
