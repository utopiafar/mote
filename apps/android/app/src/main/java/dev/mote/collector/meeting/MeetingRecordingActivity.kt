package dev.mote.collector.meeting

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import dev.mote.collector.MoteActivity
import dev.mote.collector.MoteI18n
import dev.mote.collector.SecondaryUi
import dev.mote.collector.moteDetailPage
import java.time.Instant
import java.util.UUID

/** Explicit owner entry. There is no BroadcastReceiver, calendar trigger or
 * source scan that can create a session; only this screen starts the service. */
class MeetingRecordingActivity : MoteActivity() {
    private lateinit var state: TextView
    private lateinit var summary: TextView
    private lateinit var last: TextView
    private lateinit var start: Button
    private lateinit var stop: Button
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable { override fun run() { render(); handler.postDelayed(this, 1000) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val content = moteDetailPage(title = MoteI18n.text("本机会议录音"))
        SecondaryUi.text(content, MoteI18n.text("一场一记 · 由你开始和结束"), muted = true)
        state = SecondaryUi.text(content, "", heading = true)
        summary = SecondaryUi.text(content, "", muted = true)
        val actions = SecondaryUi.actions(content)
        start = SecondaryUi.action(actions, MoteI18n.text("开始会议录音"), primary = true) { begin() }
        stop = SecondaryUi.action(actions, MoteI18n.text("结束并入库")) { MeetingRecordingService.stop(this) }
        SecondaryUi.action(actions, MoteI18n.text("上传本机录音")) { MeetingRecordingUploadWorker.schedule(this); summary.text = MoteI18n.text("已尝试上传本机会议录音。") }
        SecondaryUi.action(actions, MoteI18n.text("麦克风与系统音频权限")) { openPermissions() }
        SecondaryUi.text(content, MoteI18n.text("只有点击开始后才会录音；不会按日历或日程自动开始。第一次开始时先请告知在场的人。结束后音频进入中央已有转写，不会与记录页的语音附件或飞书妙记、钉钉闪记合并。"), muted = true)
        last = SecondaryUi.text(content, "", muted = true)
    }

    override fun onResume() { super.onResume(); handler.post(refresh) }
    override fun onPause() { handler.removeCallbacks(refresh); super.onPause() }

    private fun render() {
        val store = meetingRecordings()
        val recording = store.sessions().firstOrNull { it.state == "recording" }
        if (recording != null && MeetingRecordingService.runningSession != recording.id) {
            store.fail(recording.id, MoteI18n.text("上一次会议录音因应用退出而中断，未自动续录。"))
        }
        val active = store.sessions().firstOrNull { it.state == "recording" }
        start.isEnabled = active == null
        stop.isEnabled = active != null
        state.text = if (active != null) MoteI18n.text("正在录音") else MoteI18n.text("未在录音")
        summary.text = if (active != null) MoteI18n.text("已于 {0} 开始。麦克风与系统音频同时采集；仅在你点击结束后生成一场会议的音频。", active.startedAt.take(19).replace('T', ' '))
        else if (!microphoneGranted()) MoteI18n.text("麦克风权限未授予，会议录音不会开始。")
        else MoteI18n.text("麦克风与系统音频权限将在开始时检查；缺少任一项都不会开始。")
        val latest = store.sessions().maxByOrNull { it.startedAt }
        last.text = when {
            latest == null -> MoteI18n.text("尚无会议录音。")
            latest.state == "uploaded" -> MoteI18n.text("最近一场 {0} 已进入中央转写。", latest.startedAt.take(16).replace('T', ' '))
            latest.state == "completed" -> MoteI18n.text("最近一场 {0} 保存在本机，连接中央后上传。", latest.startedAt.take(16).replace('T', ' '))
            latest.state == "failed" -> MoteI18n.text("最近一场未完成：{0}", latest.error ?: MoteI18n.text("请重试"))
            else -> MoteI18n.text("最近一场 {0} 正在进行。", latest.startedAt.take(16).replace('T', ' '))
        }
    }

    private fun begin() {
        if (MeetingRecordingService.runningSession != null) return
        if (!microphoneGranted()) { requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MICROPHONE); return }
        if (meetingRecordings().noticeAcknowledgedAt() == null) { notice(); return }
        requestSystemAudio()
    }

    private fun notice() {
        AlertDialog.Builder(this).setTitle(MoteI18n.text("先告知在场的人"))
            .setMessage(MoteI18n.text("这场会议将同时录制麦克风与系统音频，结束后上传到你的中央并转写。请确认已告知在场的人并得到同意。该确认只在本机记住一次；取消则不会开始录音。"))
            .setNegativeButton(MoteI18n.text("取消"), null)
            .setPositiveButton(MoteI18n.text("已告知，开始录音")) { _, _ -> meetingRecordings().acknowledgeNotice(); requestSystemAudio() }
            .show()
    }

    private fun requestSystemAudio() {
        val manager = getSystemService(MediaProjectionManager::class.java)
        startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_SYSTEM_AUDIO)
    }

    private fun openPermissions() {
        startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:$packageName")))
    }

    @Deprecated("Native permission and projection results")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_SYSTEM_AUDIO) return
        if (resultCode != RESULT_OK || data == null) {
            summary.text = MoteI18n.text("系统音频权限未授予，会议录音没有开始；不会在缺少系统声时只录麦克风。")
            return
        }
        val notice = meetingRecordings().noticeAcknowledgedAt() ?: return notice()
        val id = UUID.randomUUID().toString()
        try {
            meetingRecordings().begin(id, Instant.now(), notice)
            MeetingRecordingService.start(this, id, resultCode, data)
            render()
        } catch (error: Exception) {
            meetingRecordings().fail(id, error.message ?: MoteI18n.text("会议录音没有开始。"))
            summary.text = error.message ?: MoteI18n.text("会议录音没有开始。")
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_MICROPHONE) return
        if (grantResults.firstOrNull() != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            summary.text = MoteI18n.text("麦克风权限未授予，会议录音没有开始。")
            return
        }
        if (meetingRecordings().noticeAcknowledgedAt() == null) notice() else requestSystemAudio()
    }

    companion object {
        private const val REQUEST_MICROPHONE = 4303
        private const val REQUEST_SYSTEM_AUDIO = 4304
    }
}
