package dev.mote.collector

import android.app.Application
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.ui.MoteComponents
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.util.concurrent.PausedExecutorService
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.util.ReflectionHelpers
import org.robolectric.util.ReflectionHelpers.ClassParameter
import java.net.URI

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [35])
@LooperMode(LooperMode.Mode.PAUSED)
class SystemEntriesNotificationPageTest {
    private lateinit var activity: MainActivity
    private lateinit var content: LinearLayout
    private lateinit var body: LinearLayout
    private val executor = PausedExecutorService()
    private lateinit var task: UiTask

    @Before fun setUp() {
        val app = RuntimeEnvironment.getApplication()
        MoteI18n.initialize(app)
        if (runCatching { NativeUiPacks.registry.theme() }.isFailure) NativeUiPacks.initialize(app)
        // Mount the production notification body without starting capture or the other pages.
        activity = Robolectric.buildActivity(MainActivity::class.java).get()
        content = LinearLayout(activity)
        body = LinearLayout(activity)
        content.addView(body)
        ReflectionHelpers.setField(activity, "content", content)
        task = UiTask(activity, executor)
        ReflectionHelpers.setField(activity, "uiTask\$delegate", lazyOf(task))
    }

    @After fun closeTask() {
        if (::task.isInitialized) task.close()
    }

    @Test fun disconnectedPageMountsItsNoticeAndConnectionAction() {
        load()

        assertBodyOwnsItsViews()
        assertNoticeAndAction()
    }

    @Test fun loadedPageMountsControlsAndSavesEditedNotificationSettings() {
        val requests = mutableListOf<Pair<String, String>>()
        var saved: JSONObject? = null
        load(client { method, path, bytes ->
            requests += method to path
            if (method == "PUT") saved = JSONObject(requireNotNull(bytes).toString(Charsets.UTF_8))
            200 to configuration()
        })
        deliverRequest()

        val (enabled, quiet) = descendants(body).filterIsInstance<MoteComponents.MoteSwitch>().toList()
        assertTrue(enabled.checked)
        assertFalse(quiet.checked)
        val hours = body.findViewWithTag<LinearLayout>("notifications-quiet-hours")
        assertEquals(View.GONE, hours.visibility)
        assertTrue(quiet.performClick())
        assertEquals(View.VISIBLE, hours.visibility)
        assertEquals(4, hours.childCount)
        assertTrue(hours.getChildAt(0) is TextView)
        assertTrue(hours.getChildAt(2) is TextView)
        val (start, end) = descendants(hours).filterIsInstance<EditText>().toList()
        start.setText("23:15")
        end.setText("06:45")
        assertTrue(enabled.performClick())
        assertTrue(action().isEnabled)
        assertTrue(action().performClick())
        deliverRequest()
        deliverRequest()

        assertEquals(listOf("GET" to "/api/configuration", "PUT" to "/api/configuration/notifications", "GET" to "/api/configuration"), requests)
        val request = requireNotNull(saved)
        assertEquals(4L, request.getLong("revision"))
        val value = request.getJSONObject("value")
        assertFalse(value.getBoolean("enabled"))
        assertEquals("Asia/Shanghai", value.getString("timeZone"))
        assertEquals(30, value.getInt("minIntervalMinutes"))
        assertEquals("23:15", value.getJSONObject("quietHours").getString("start"))
        assertEquals("06:45", value.getJSONObject("quietHours").getString("end"))
        assertTrue(action().isEnabled)
    }

    @Test fun failedReadMountsRetryAndReplacesTheErrorWithTheLoadedPage() {
        var reads = 0
        load(client { _, _, _ ->
            if (++reads == 1) 500 to null else 200 to configuration()
        })
        deliverRequest()

        assertNoticeAndAction()
        val retry = action()
        assertTrue(retry.performClick())
        deliverRequest()

        assertEquals(2, reads)
        assertFalse(retry in descendants(body))
        assertEquals(2, descendants(body).filterIsInstance<MoteComponents.MoteSwitch>().count())
        assertTrue(action().isEnabled)
    }

    @Test fun readOnlyPageMountsItsNoticeAndDisablesSave() {
        load(client { _, _, _ -> 200 to configuration(readOnly = true) })
        deliverRequest()

        val notices = descendants(body).filterIsInstance<TextView>()
            .filter { it.parent === body && it !is Button }.toList()
        assertEquals(2, notices.size) // Time zone and the read-only notice.
        assertFalse(action().isEnabled)
    }

    private fun load(client: CentralClient? = null) {
        ReflectionHelpers.callInstanceMethod<Unit>(activity, "loadNotifications",
            ClassParameter.from(LinearLayout::class.java, body), ClassParameter.from(CentralClient::class.java, client))
    }

    private fun deliverRequest() {
        assertTrue(executor.runNext())
        shadowOf(Looper.getMainLooper()).idle()
        assertBodyOwnsItsViews()
    }

    private fun assertBodyOwnsItsViews() {
        assertEquals(1, content.childCount)
        assertSame(body, content.getChildAt(0))
    }

    private fun assertNoticeAndAction() {
        assertEquals(2, body.childCount)
        val notice = body.getChildAt(0) as TextView
        assertTrue(notice.text.isNotBlank())
        assertTrue(action().isEnabled)
        assertTrue(action().hasOnClickListeners())
    }

    private fun action(): Button = descendants(body).filterIsInstance<Button>().single()

    private fun descendants(group: ViewGroup): Sequence<View> = sequence {
        for (index in 0 until group.childCount) {
            val child = group.getChildAt(index)
            yield(child)
            if (child is ViewGroup) yieldAll(descendants(child))
        }
    }

    private fun client(respond: (String, String, ByteArray?) -> Pair<Int, JSONObject?>) =
        CentralClient("https://generated-fixture.invalid", "generated-token", transport = { method, url, body, _, _ ->
            respond(method, URI(url).path, body)
        })

    private fun configuration(readOnly: Boolean = false) = JSONObject("""
        {"revision":4,"readOnly":$readOnly,"domains":[{"id":"notifications",
         "saved":{"enabled":true,"timeZone":"Asia/Shanghai","quietHours":null,"minIntervalMinutes":30}}]}
    """.trimIndent())
}
