package dev.mote.collector

import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import dev.mote.collector.ui.MoteComponents

class UploadHistorySettingsActivity : MoteActivity() {
    private val task by lazy { UiTask(this) }
    private lateinit var choice: Spinner
    private lateinit var status: TextView
    private lateinit var save: Button
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val body = moteDetailPage(primary = MotePrimaryTab.SOURCES, title = MoteI18n.text("上传历史保存时长"))
        SecondaryUi.text(body, MoteI18n.text("保存天数"))
        choice = Spinner(this).apply { tag = "history-retention-choice"; adapter = MoteUi.choiceAdapter(this@UploadHistorySettingsActivity, UploadHistoryRetention.choices.map { MoteI18n.text("{0} 天", it) }) }.also(body::addView)
        val notice = SecondaryUi.column(body, card = true).apply { background = MoteUi.shape(context, fill = NativeColorRole.TINT, outline = true) }
        SecondaryUi.text(notice, MoteI18n.text("只清理上传历史"), heading = true)
        SecondaryUi.text(notice, MoteI18n.text("默认保存30天。到期只清理上传历史，不删除资料、待传原件或草稿。"), muted = true)
        status = TextView(this).also(body::addView)
        save = Button(this).apply { text = MoteI18n.text("保存设置"); setTag(R.id.mote_primary, true); isEnabled = false; tag = "history-retention-save"; setOnClickListener {
            val days = UploadHistoryRetention.choices[choice.selectedItemPosition]
            isEnabled = false
            task.start(MoteI18n.text("正在保存…"), MoteComponents.progress(status, read = false), { UploadHistoryRetention.save(applicationContext, days) }) { result ->
                isEnabled = true
                status.text = if (result.isSuccess) MoteI18n.text("已保存") else MoteI18n.text("保存未完成，请重试；资料和待传原件保留。")
            }
        } }.also { body.addView(it, LinearLayout.LayoutParams(-2, -2)) }
        MoteUi.styleTree(body)
        task.start(MoteI18n.text("正在读取…"), MoteComponents.progress(status), { UploadHistoryRetention.read(applicationContext) }) { result ->
            result.onSuccess { days -> choice.setSelection(savedInstanceState?.getInt("selection") ?: UploadHistoryRetention.choices.indexOf(days)); save.isEnabled = true; status.text = "" }
                .onFailure { status.text = MoteI18n.text("设置无法读取，原数据保留。请退出后检查存储或重试。") }
        }
    }
    override fun onSaveInstanceState(state: Bundle) { state.putInt("selection", choice.selectedItemPosition); super.onSaveInstanceState(state) }
}
