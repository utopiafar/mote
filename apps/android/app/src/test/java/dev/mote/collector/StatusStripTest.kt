package dev.mote.collector

import android.app.Activity
import android.os.Looper
import android.view.View
import dev.mote.collector.recording.RecordingPhase
import dev.mote.collector.recording.RecordingSession
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.io.File

/** The one row above the tab bar: recording first, then a retained draft. */
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, sdk = [35])
@LooperMode(LooperMode.Mode.PAUSED)
class StatusStripTest {
    private lateinit var activity: Activity

    @Before fun setUp() {
        val app = RuntimeEnvironment.getApplication()
        MoteI18n.initialize(app)
        if (runCatching { NativeUiPacks.registry.theme() }.isFailure) NativeUiPacks.initialize(app)
        RecordingSession.machine.finished()
        RecordingSession.accumulatedMs = 0
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    }

    @After fun tearDown() {
        RecordingSession.machine.finished()
        activity.finish()
    }

    /** AN7-01: a live recording keeps the way back on every authored tab. */
    @Test fun theRecordingRowShowsOnEveryAuthoredTab() {
        val strip = StatusStrip(activity) {}
        activity.setContentView(strip)
        for (tab in listOf("chat", "feed", "ideas", "goals", "library")) {
            strip.setTab(tab)
            RecordingSession.machine.prepare()
            RecordingSession.machine.started(focusGranted = true)
            RecordingSession.startClock()
            RecordingSession.changed()
            shadowOf(Looper.getMainLooper()).idle()

            assertEquals("$tab keeps the recording row", View.VISIBLE, strip.visibility)
            assertEquals("status-strip-recording", strip.tag)
            assertEquals(View.VISIBLE, strip.findViewWithTag<View>("status-strip-stop")!!.visibility)
            assertNull("A recording hides the draft action", strip.findViewWithTag<View>("status-strip-draft-action")!!.takeIf { it.visibility == View.VISIBLE })

            RecordingSession.machine.finished()
            RecordingSession.changed()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    /** AN7-02: a retained draft shows on the same tabs and "继续" opens the same editor without new media. */
    @Test fun continuingADraftOpensTheRetainedDraftEditor() {
        val strip = StatusStrip(activity) { activity.openRecordEditor() }
        activity.setContentView(strip)
        strip.setTab("library")
        strip.setDraft(true)
        shadowOf(Looper.getMainLooper()).idle()

        assertEquals(View.VISIBLE, strip.visibility)
        assertEquals("status-strip-draft", strip.tag)
        assertEquals(View.GONE, strip.findViewWithTag<View>("status-strip-stop")!!.visibility)
        val action = strip.findViewWithTag<View>("status-strip-draft-action")!!
        assertEquals(View.VISIBLE, action.visibility)

        action.performClick()
        val opened = shadowOf(activity).nextStartedActivity
        assertEquals(RecordEditorActivity::class.java.name, opened.component!!.className)
        assertNull("Continuing a draft starts no recording", opened.getStringExtra("startMedia"))
        assertNull("Continuing a draft sends no question text", opened.getStringExtra("recordText"))
    }

    /** AN7-03: a live recording owns the strip even while a draft is retained. */
    @Test fun aRecordingOutranksARetainedDraft() {
        val strip = StatusStrip(activity) {}
        activity.setContentView(strip)
        strip.setTab("goals")
        strip.setDraft(true)
        RecordingSession.machine.prepare()
        RecordingSession.machine.started(focusGranted = true)
        RecordingSession.startClock()
        RecordingSession.changed()
        shadowOf(Looper.getMainLooper()).idle()

        assertEquals("status-strip-recording", strip.tag)
        assertEquals(View.GONE, strip.findViewWithTag<View>("status-strip-draft-action")!!.visibility)
    }

    /** AN7-06: capture attention stays in the system notification and adds no row to any tab. */
    @Test fun captureAttentionPostsTheSystemNotificationAndNoTabNoticeRow() {
        val row = CaptureStatusMapping.row(CaptureStatusId.INTERRUPTED)
        assertEquals(CaptureStatusLevel.NEEDS_ACTION, row.level)
        assertTrue("The interruption still posts", CaptureAttentionDedup().update(row))
        assertNotNull("The system notification keeps its title", captureAttentionTitle(row))

        val source = File(checkNotNull(System.getProperty("user.dir")), "src/main/java/dev/mote/collector/MainActivity.kt").readText()
        assertFalse("No top notice row is mounted", source.contains("HomeNoticeRow") || source.contains("home-notice"))
        val sources = File(checkNotNull(System.getProperty("user.dir")), "src/main/java/dev/mote/collector").listFiles().orEmpty().map { it.name }
        assertFalse(sources.contains("HomeNotice.kt"))
        assertFalse(sources.contains("HomeNoticeRow.kt"))
    }

    /** The strip only lives on the five tabs; manage and detail pages keep the bar alone. */
    @Test fun aManagePageHasNoStrip() {
        val strip = StatusStrip(activity) {}
        activity.setContentView(strip)
        strip.setTab(null)
        strip.setDraft(true)
        RecordingSession.machine.prepare()
        RecordingSession.machine.started(focusGranted = true)
        RecordingSession.startClock()
        RecordingSession.changed()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(View.GONE, strip.visibility)
        assertEquals("status-strip-hidden", strip.tag)
    }

    /** The timer label follows the same policy as the editor and the notification. */
    @Test fun theRecordingRowUsesTheSharedTimerLabel() {
        val strip = StatusStrip(activity) {}
        activity.setContentView(strip)
        strip.setTab("chat")
        RecordingSession.machine.prepare()
        RecordingSession.machine.started(focusGranted = true)
        RecordingSession.startClock()
        RecordingSession.changed()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("00:00", strip.findViewWithTag<android.widget.TextView>("status-strip-duration")!!.text.toString())
        assertEquals(RecordingPhase.RECORDING, RecordingSession.snapshot().phase)
    }
}
