package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.*
import java.time.ZoneId

internal class UploadHistoryPanel(private val activity: Activity, private val body: LinearLayout, state: Bundle?) {
    private val task = UiTask(activity)
    private val status = TextView(activity)
    private val dates = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
    private val filter = Spinner(activity)
    private val expanded = state?.getStringArrayList("history-dates")?.toMutableSet() ?: mutableSetOf()
    private var resultFilter = state?.getInt("history-filter") ?: 0
    private var page = state?.getInt("history-page") ?: 0
    private var scroll = state?.getInt("history-scroll") ?: 0
    private var batches = emptyList<HistoryBatch>()
    private val previous = Button(activity)
    private val next = Button(activity)
    init {
        body.addView(status)
        body.addView(TextView(activity).apply { text = MoteI18n.text("采集、随手记、来源、文件与附件的上传批次。") })
        filter.tag = "history-result-filter"
        filter.adapter = MoteUi.choiceAdapter(activity, listOf(MoteI18n.text("全部结果"), MoteI18n.text("有已确认记录"), MoteI18n.text("有未确认记录")))
        filter.setSelection(resultFilter); body.addView(filter)
        filter.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) {
                if (resultFilter != position) { resultFilter = position; page = 0; scroll = 0; render() }
            }
        }
        body.addView(dates)
        val paging = LinearLayout(activity).also(body::addView)
        previous.text = MoteI18n.text("上一页"); previous.setOnClickListener { page--; scroll = 0; render() }
        next.text = MoteI18n.text("下一页"); next.setOnClickListener { page++; scroll = 0; render() }
        paging.addView(previous, LinearLayout.LayoutParams(0, -2, 1f)); paging.addView(next, LinearLayout.LayoutParams(0, -2, 1f))
        body.addView(Button(activity).apply { text = MoteI18n.text("上传历史保存时长"); setOnClickListener { activity.startActivity(Intent(activity, UploadHistorySettingsActivity::class.java)) } })
        body.addView(Button(activity).apply { text = MoteI18n.text("采集与存储详情"); setOnClickListener { activity.startActivity(Intent(activity, ActivityStatsActivity::class.java)) } })
        MoteUi.styleTree(body)
    }
    private fun scroller(): ScrollView? { var p = body.parent; while (p != null) { if (p is ScrollView) return p; p = p.parent }; return null }
    fun save(state: Bundle) {
        state.putStringArrayList("history-dates", ArrayList(expanded)); state.putInt("history-filter", resultFilter)
        state.putInt("history-page", page); state.putInt("history-scroll", scroller()?.scrollY ?: scroll)
    }
    fun load() {
        if (task.busy) return
        task.start(MoteI18n.text("正在读取…"), { status.text = it }, { UploadHistoryModel.read(activity.applicationContext) }) { result ->
            result.onSuccess { batches = it; render() }.onFailure {
                dates.removeAllViews(); previous.isEnabled = false; next.isEnabled = false
                status.text = MoteI18n.text("上传历史暂不可读取，请刷新重试。")
            }
        }
    }
    private fun render() {
        val filtered = UploadHistoryModel.filter(batches, resultFilter)
        page = page.coerceIn(0, ((filtered.size - 1).coerceAtLeast(0) / 10))
        previous.isEnabled = page > 0; next.isEnabled = (page + 1) * 10 < filtered.size
        status.text = MoteI18n.text("仅显示本机保留的最近上传结果；中央接收不代表已完成处理。")
        dates.removeAllViews()
        if (filtered.isEmpty()) dates.addView(TextView(activity).apply { text = MoteI18n.text("暂无上传历史") })
        filtered.drop(page * 10).take(10).groupBy { it.date(ZoneId.systemDefault()) }.forEach { (date, rows) ->
            dates.addView(MoteUi.button(Button(activity).apply {
                text = (if (date in expanded) "▾ " else "▸ ") + date
                tag = "history-date-$date"
                setOnClickListener { scroll = scroller()?.scrollY ?: 0; if (!expanded.add(date)) expanded.remove(date); render() }
            }))
            if (date in expanded) rows.forEach { batch ->
                dates.addView(MoteUi.button(Button(activity).apply {
                    tag = "history-batch-${batch.id}"
                    text = java.time.Instant.ofEpochMilli(batch.at).atZone(ZoneId.systemDefault()).toLocalTime().withNano(0).toString() + " · " + MoteI18n.text("已确认 {0} · 未确认 {1}", batch.received, batch.unconfirmed)
                    setOnClickListener { scroll = scroller()?.scrollY ?: 0; activity.startActivity(Intent(activity, UploadBatchActivity::class.java).putExtra("batchId", batch.id)) }
                }))
            }
        }
        body.post { scroller()?.scrollTo(0, scroll) }
    }
}
