package dev.mote.collector

import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant

/** Only a generated, unredeemed invitation; no credentials, camera or network is used. */
@RunWith(AndroidJUnit4::class)
class ConnectionReviewInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun shown(activity: ConnectionActivity) = views(activity.window.decorView).filter { it.isShown }
    private fun waitFor(scenario: ActivityScenario<ConnectionActivity>, label: String) {
        val deadline = SystemClock.elapsedRealtime() + 10_000
        while (SystemClock.elapsedRealtime() < deadline) {
            var found = false
            scenario.onActivity { found = shown(it).filterIsInstance<TextView>().any { field -> field.text.toString() == label } }
            if (found) return
            Thread.sleep(40)
        }
        fail("The connection surface did not show $label")
    }
    private fun click(activity: ConnectionActivity, label: String) = shown(activity).filterIsInstance<TextView>().single { it.isClickable && it.text.toString() == label }.performClick()
    private fun capture(scenario: ActivityScenario<ConnectionActivity>, name: String) {
        val frames = java.util.concurrent.CountDownLatch(1)
        scenario.onActivity { it.window.decorView.postOnAnimation { it.window.decorView.postOnAnimation { frames.countDown() } } }
        assertTrue(frames.await(5,java.util.concurrent.TimeUnit.SECONDS))
        scenario.onActivity { GeneratedWindowRendering.save(it,File(context.filesDir,"ui-final-connection").apply { mkdirs() },name) }
    }
    @Test fun reviewRetainsInvitationAndNameAcrossRecreationAndCanReturnWithoutConnecting() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("uiFinalFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        require(!Settings(context).enabled)
        val before = Settings(context).read(); val language = MoteI18n.preference()
        MoteI18n.select(context,"zh-CN")
        try {
            ActivityScenario.launch(ConnectionActivity::class.java).use { scenario ->
                waitFor(scenario,"把记录接到一起")
                capture(scenario,"connection-entry")
                scenario.onActivity { activity ->
                    shown(activity).filterIsInstance<EditText>().single().setText("not an invitation")
                    click(activity,"核对连接")
                    val notice = shown(activity).filterIsInstance<TextView>().single { it.text.toString() == MoteI18n.text("邀请已失效") }
                    val scan = shown(activity).filterIsInstance<TextView>().single { it.isClickable && it.text.toString() == MoteI18n.text("扫描二维码") }
                    val noticeBox = android.graphics.Rect(); val scanBox = android.graphics.Rect()
                    assertTrue(notice.getGlobalVisibleRect(noticeBox)); assertTrue(scan.getGlobalVisibleRect(scanBox))
                    assertTrue("P05 keeps the scan action under the expired invitation notice", scanBox.top >= noticeBox.bottom)
                    assertEquals(before,Settings(context).read())
                }
                val invitation = JSONObject().put("format","mote.connection").put("version",1).put("serverUrl","https://review.generated.invalid")
                    .put("code","B".repeat(43)).put("expiresAt",Instant.ofEpochMilli(System.currentTimeMillis() + 600_000).toString()).toString()
                scenario.onActivity { activity -> shown(activity).filterIsInstance<EditText>().single().setText(invitation); click(activity,"核对连接") }
                waitFor(scenario,"这是你的 Mote 吗？")
                scenario.onActivity { activity ->
                    assertTrue(shown(activity).filterIsInstance<TextView>().any { it.text.toString() == MoteI18n.text("本人设备") })
                    assertTrue(shown(activity).filterIsInstance<TextView>().any { it.text.toString() == MoteI18n.text("连接后发送") })
                    shown(activity).filterIsInstance<EditText>().single().setText("Generated review device")
                }
                scenario.recreate(); waitFor(scenario,"这是你的 Mote 吗？")
                scenario.onActivity { activity ->
                    assertEquals("Generated review device",shown(activity).filterIsInstance<EditText>().single().text.toString())
                    assertEquals(before,Settings(context).read())
                    val header = shown(activity).filterIsInstance<TextView>().single { it.tag == "detail-title" }
                    assertTrue("The review keeps its native navigation header visible",header.getGlobalVisibleRect(android.graphics.Rect()))
                }
                capture(scenario,"connection-review")
                scenario.onActivity { activity -> shown(activity).single { it.contentDescription == "返回上一页" }.performClick() }
                scenario.onActivity { activity ->
                    assertEquals(invitation,shown(activity).filterIsInstance<EditText>().single().text.toString())
                    click(activity,"核对连接"); activity.onBackPressed()
                    assertEquals(invitation,shown(activity).filterIsInstance<EditText>().single().text.toString())
                    click(activity,"稍后连接")
                }
                assertEquals(before,Settings(context).read())
                assertFalse(Settings(context).enabled)
            }
        } finally { MoteI18n.select(context,language) }
    }
}
