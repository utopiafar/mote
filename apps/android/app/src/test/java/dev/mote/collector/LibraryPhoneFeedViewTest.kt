package dev.mote.collector

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.plugins.DurableTransportPlugin
import dev.mote.collector.plugins.LibrarySourceStatus
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.io.File
import java.time.Duration
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(application = MoteApplication::class, shadows = [AssistantHostApplicationShadow::class, AssistantHostSecretBoxShadow::class], sdk = [35])
@LooperMode(LooperMode.Mode.PAUSED)
class LibraryPhoneFeedViewTest {
    @Test fun phoneSourceShowsCapturePauseAndRetainedRowsByLocalDay() {
        val app = RuntimeEnvironment.getApplication() as MoteApplication
        LocalDataFormat.requireCurrent(app)
        QueueLocationStore(app.noBackupFilesDir, File(app.noBackupFilesDir, "queue"), app.localContentCipher()).current()
        val transport = DurableTransportPlugin.start(app, app.pluginHost)
        val controller = Robolectric.buildActivity(MoteActivity::class.java).setup()
        val activity = controller.get()
        val rows = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        activity.setContentView(rows)
        val settings = Settings(activity)
        val zone = ZoneId.systemDefault()
        val today = LocalDate.of(2026, 11, 6)
        fun record(day: LocalDate, hour: Int): String {
            val id = UUID.randomUUID().toString()
            app.queue().enqueue(JSONObject().put("id", id).put("deviceId", settings.deviceId).put("source", "note")
                .put("capturedAt", day.atTime(hour, 0).atZone(zone).toInstant().toString())
                .put("ocrText", "Generated note $hour").put("privacy", JSONObject().put("excluded", false)), null)
            return id
        }
        var opened: LibraryPhoneFeed.Original? = null
        settings.enabled = true
        settings.status("capturing", "Generated active capture")
        val view = LibraryCaptureView(activity, rows, null, { _, _, _, _, _ -> fail("This phone uses the moved row renderer") }) { opened = it }
        try {
            val yesterday = record(today.minusDays(1), 23)
            val olderToday = record(today, 1)
            val latest = record(today, 3)
            val local = requireNotNull(rows.findViewWithTag<TextView>("library-source:phone"))
            assertFalse(local.text.toString().contains(LibrarySourceStatus.PAUSED.label()))
            settings.enabled = false
            view.updateSourceStatus()
            val paused = requireNotNull(rows.findViewWithTag<TextView>("library-source:phone"))
            assertTrue(paused.text.toString().contains(LibrarySourceStatus.PAUSED.label()))
            assertTrue(paused.performClick())
            assertTrue(rows.findViewWithTag<View>("library-source:phone").isSelected)
            val feed = rows.findViewWithTag<LinearLayout>("library-phone-feed")
            val deadline = System.nanoTime() + Duration.ofSeconds(8).toNanos()
            while (feed.findViewWithTag<View>("library-record:$latest") == null && System.nanoTime() < deadline) {
                shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(25))
                Thread.sleep(10)
            }
            val groups = (0 until feed.childCount).map(feed::getChildAt).filterIsInstance<ViewGroup>()
            val ids = groups.map { group -> (0 until group.childCount).map(group::getChildAt).mapNotNull { it.tag as? String } }
            assertEquals(listOf(listOf("library-record:$latest", "library-record:$olderToday"), listOf("library-record:$yesterday")), ids)
            assertTrue(feed.findViewWithTag<View>("library-record:$latest").performClick())
            val original = requireNotNull(opened)
            assertEquals(latest, original.id)
            assertTrue(original.saved)
            assertFalse(original.remote)
        } finally {
            view.close()
            controller.pause().stop().destroy()
            transport.close()
            app.pluginHost.quit()
        }
    }
}
