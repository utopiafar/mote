package dev.mote.collector

import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.mote.collector.recording.RecordingPhase
import dev.mote.collector.recording.RecordingService
import dev.mote.collector.recording.RecordingSession
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Explicitly selected generated-data fixture; checkpoint files let adb capture the real display. */
@RunWith(AndroidJUnit4::class)
class RecordingVisualInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun waitFor(check: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20_000
        while (SystemClock.elapsedRealtime() < deadline) { if (check()) return; Thread.sleep(50) }
        error("Recording fixture timed out")
    }
    private fun checkpoint(name: String) {
        val marker = File(context.filesDir, "ua11-checkpoint")
        val next = File(context.filesDir, "ua11-next")
        next.delete(); marker.writeText(name)
        waitFor { next.exists() }
        marker.delete(); next.delete()
    }
    /** The windowless emulator has no microphone input. Feed generated PCM
     * peaks to the real meter for visual comparison; encoded audio remains
     * the emulator's own silent input. */
    private fun generatedMeterInput() = synchronized(RecordingSession.lock) {
        RecordingSession.levels.clear()
        listOf(400, 1200, 2800, 1500, 4500, 2200, 3200, 6000, 2100, 1000, 3500, 6500, 4200, 1800, 900, 2500, 4600, 1700, 3100, 1300, 500).forEach { peak ->
            RecordingSession.lastLevelAt = 0
            RecordingSession.addLevel(shortArrayOf(0, peak.toShort(), 0), 3)
        }
    }
    @Test fun recordingAndPausedStatesForAdbScreenshots() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("ua11VisualFixture") == "true")
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev") && !Settings(context).enabled)
        val draft = context.recordDraftStore()
        draft.clear()
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, android.Manifest.permission.RECORD_AUDIO)
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
        instrumentation.runOnMainSync { MoteI18n.select(context, "zh-CN"); MoteAppearance.select(context, AppearancePreference.LIGHT) }
        try {
            ActivityScenario.launch(RecordEditorActivity::class.java).use { scenario ->
                waitFor { var ready = false; scenario.onActivity { ready = views(it.window.decorView).filterIsInstance<EditText>().any { field -> field.contentDescription == "正在想什么" && field.isEnabled } }; ready }
                scenario.onActivity { activity ->
                    activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) // Generated text in this dedicated test process only.
                    views(activity.window.decorView).filterIsInstance<EditText>().single { it.contentDescription == "正在想什么" }.setText("周四和房东确认：暖气费按实际用量分摊，月底前把账单照片发给他。")
                    views(activity.window.decorView).single { it.contentDescription == "录音" }.performClick()
                }
                waitFor { RecordingSession.snapshot().phase == RecordingPhase.RECORDING }
                waitFor {
                    var shown = false
                    scenario.onActivity { activity ->
                        val all = views(activity.window.decorView)
                        val editor = all.filterIsInstance<EditText>().single { it.contentDescription == "正在想什么" }
                        val wave = all.single { it.tag == "recording-wave" }
                        shown = editor.getGlobalVisibleRect(android.graphics.Rect()) && wave.getGlobalVisibleRect(android.graphics.Rect())
                    }
                    shown
                }
                generatedMeterInput(); checkpoint("recording-light")
                scenario.onActivity { MoteAppearance.select(it, AppearancePreference.DARK) }; instrumentation.waitForIdleSync()
                generatedMeterInput(); checkpoint("recording-dark")
                val audio = context.getSystemService(android.media.AudioManager::class.java)
                val other = android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).build())
                    .setOnAudioFocusChangeListener { }.build()
                assertTrue(audio.requestAudioFocus(other) == android.media.AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
                waitFor { RecordingSession.snapshot().let { it.phase == RecordingPhase.PAUSED && it.interrupted } }
                waitFor { var shown = false; scenario.onActivity { shown = views(it.window.decorView).any { view -> view.tag == "recording-paused-notice" && view.isShown } }; shown }
                audio.abandonAudioFocusRequest(other)
                generatedMeterInput(); checkpoint("paused-dark")
                scenario.onActivity { MoteAppearance.select(it, AppearancePreference.LIGHT) }; instrumentation.waitForIdleSync()
                checkpoint("paused-light")
                scenario.onActivity { views(it.window.decorView).single { view -> view.tag == "recording-pause" }.performClick() }
                waitFor { RecordingSession.snapshot().phase == RecordingPhase.RECORDING }
                checkpoint("shade-light")
                scenario.onActivity { MoteAppearance.select(it, AppearancePreference.DARK) }; instrumentation.waitForIdleSync()
                checkpoint("shade-dark")
                scenario.onActivity { views(it.window.decorView).single { view -> view.tag == "recording-stop" }.performClick() }
                waitFor { RecordingSession.snapshot().phase == RecordingPhase.IDLE }
                assertTrue(draft.draft().getJSONArray("attachments").length() == 1)
            }
        } finally {
            RecordingService.command(context, RecordingService.ACTION_STOP)
            draft.clear()
            instrumentation.runOnMainSync { MoteAppearance.select(context, AppearancePreference.AUTO) }
        }
    }
}
