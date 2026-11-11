package dev.mote.collector

import android.app.Activity
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import dev.mote.collector.ui.moteGlyph

/** UI state only; every result and action comes from the existing archive operation. */
internal class BackupOperationView(private val activity: Activity, private val body: LinearLayout,
    private val landing: LinearLayout, private val onReturn: () -> Unit) {
    private val page = SecondaryUi.column(body).apply { visibility = View.GONE }
    private var progress: TextView? = null
    private var fileCard: LinearLayout? = null
    var showing = false; private set

    fun show(title: String, state: String, heading: String, message: String = "", loading: Boolean = false,
        file: BackupDocumentFacts? = null, content: (LinearLayout) -> Unit = {}, actions: List<Triple<String, Boolean, () -> Unit>> = emptyList()) {
        showing = true; landing.visibility = View.GONE; page.visibility = View.VISIBLE
        (activity.window.decorView.findViewWithTag<View>("detail-title") as? TextView)?.text = title
        page.removeAllViews()
        MoteUi.action(SecondaryUi.action(page, MoteI18n.text("备份与恢复")) { onReturn() }.apply {
            moteGlyph(MoteGlyph.BACK, NativeColorRole.MUTED, 20, atStart = true)
        }, MoteUi.ButtonRole.TEXT)
        val card = SecondaryUi.column(page, card = true)
        if (state.isNotBlank()) SecondaryUi.text(card, state, muted = true)
        SecondaryUi.text(card, heading, heading = true)
        fileCard = SecondaryUi.column(card, card = true).apply { tag = "backup-export-file" }
        updateFile(file)
        content(card)
        if (loading) card.addView(MoteComponents.loadingLine(activity, heading), LinearLayout.LayoutParams(-1, activity.moteDp(2)).apply { topMargin = activity.moteDp(16); bottomMargin = activity.moteDp(16) })
        progress = SecondaryUi.text(card, message, muted = true).apply { visibility = if (message.isBlank()) View.GONE else View.VISIBLE; accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        if (actions.isNotEmpty()) {
            val row = SecondaryUi.actions(card)
            actions.forEach { (label, primary, action) -> SecondaryUi.action(row, label, primary, action) }
        }
        MoteUi.styleTree(page)
    }

    fun updateFile(file: BackupDocumentFacts?) {
        val card = fileCard ?: return
        card.removeAllViews()
        card.visibility = if (file == null) View.GONE else View.VISIBLE
        if (file == null) return
        card.orientation = LinearLayout.HORIZONTAL; card.gravity = android.view.Gravity.CENTER_VERTICAL
        card.setPadding(activity.moteDp(16),activity.moteDp(16),activity.moteDp(16),activity.moteDp(16))
        card.addView(MoteComponents.icon(activity, MoteGlyph.FILE, NativeColorRole.ACCENT, 25),
            LinearLayout.LayoutParams(activity.moteDp(25), activity.moteDp(25)).apply { marginEnd = activity.moteDp(14) })
        val words = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }.also { card.addView(it,LinearLayout.LayoutParams(0,-2,1f)) }
        fun line(value:String,tagName:String,size:Float,muted:Boolean) = SecondaryUi.text(words,value,muted=muted).apply {
            tag = tagName; setTextIsSelectable(true)
            NativePresentationStyles.bind(this,"backup-file-line") { (it as TextView).apply { textSize = size; setLineSpacing(0f,1.2f) } }
        }
        line(file.displayName ?: MoteI18n.text("文件名暂不可读取"),"backup-export-name",13f,false)
        line(file.size?.let { java.text.NumberFormat.getIntegerInstance(MoteI18n.locale()).format(it) + " B" } ?: MoteI18n.text("文件大小未知"),"backup-export-size",10f,true)
        val details = SecondaryUi.disclosure(words,MoteI18n.text("技术详情"),"backup-file-details")
        SecondaryUi.text(details,file.uri,muted=true).apply { tag = "backup-export-uri"; setTextIsSelectable(true) }
        MoteUi.styleTree(card)
    }

    fun updateProgress(message: String) { progress?.apply { text = message; visibility = View.VISIBLE } }
    fun landing() {
        fileCard = null
        showing = false; page.visibility = View.GONE; landing.visibility = View.VISIBLE
        (activity.window.decorView.findViewWithTag<View>("detail-title") as? TextView)?.text = MoteI18n.text("备份与恢复")
    }
}
