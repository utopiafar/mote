package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Parcel
import android.provider.DocumentsContract
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

/** Generated invitations/files only. No camera, screenshots, external service or model is used. */
@RunWith(AndroidJUnit4::class)
class ConnectionPickerStateInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun raw(node: String) = JSONObject().put("format", "mote.connection").put("version", 1)
        .put("serverUrl", node).put("code", "P".repeat(43))
        .put("expiresAt", Instant.ofEpochMilli(System.currentTimeMillis() + 600_000).toString()).toString()
    private fun field(activity: ConnectionActivity, name: String) = ConnectionActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(activity)
    private fun arm(activity: ConnectionActivity, request: Int) = ConnectionActivity::class.java.getDeclaredMethod("armPicker", Int::class.javaPrimitiveType)
        .apply { isAccessible = true }.invoke(activity, request)
    private fun receive(activity: ConnectionActivity, request: Int, code: Int, data: Intent?) = ConnectionActivity::class.java
        .getDeclaredMethod("onActivityResult", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Intent::class.java)
        .apply { isAccessible = true }.invoke(activity, request, code, data)
    private fun noSecretsInBundle(activity: ConnectionActivity, vararg secrets: String) {
        val saved = Bundle()
        ConnectionActivity::class.java.getDeclaredMethod("onSaveInstanceState", Bundle::class.java).apply { isAccessible = true }.invoke(activity, saved)
        assertEquals(SourceRules.hash(Settings(context).read().toString()), saved.getString("pickerSelectionStamp"))
        assertFalse(saved.containsKey("pendingPickerPayload")); assertFalse(saved.containsKey("pendingPickerRequest"))
        val parcel = Parcel.obtain()
        try {
            saved.writeToParcel(parcel, 0)
            val bytes = parcel.marshall()
            for (secret in secrets) {
                assertFalse(String(bytes, Charsets.UTF_8).contains(secret))
                assertFalse(String(bytes, Charsets.UTF_16LE).contains(secret))
            }
        } finally { parcel.recycle() }
    }

    @Test fun pendingScanAndDocumentSurviveRecreationWithoutPersistingCapabilities() {
        val before = Settings(context).read(); require(!Settings(context).enabled)
        val node = "https://generated-picker.invalid"; val invitation = raw(node)
        val file = File(context.filesDir, "generated-file-sync/picker-invitation.json").apply { parentFile!!.mkdirs(); writeText(invitation) }
        val uri = DocumentsContract.buildDocumentUri(context.packageName + ".file-fixtures", file.name)
        try {
            for (request in 1..2) ActivityScenario.launch(ConnectionActivity::class.java).awaitUiText(MoteI18n.text("确认连接此节点")).use { scenario ->
                scenario.onActivity { activity ->
                    arm(activity, request)
                    ConnectionActivity::class.java.getDeclaredField("working").apply { isAccessible = true }.setBoolean(activity, true)
                    receive(activity, request, Activity.RESULT_OK, if (request == 1) Intent().putExtra("invitation", invitation) else Intent().setData(uri))
                    val pending = field(activity, "pendingPicker"); assertNotNull(pending)
                    // Unrelated/cancelled callbacks must not consume an already accepted result.
                    receive(activity, 99, Activity.RESULT_CANCELED, null)
                    receive(activity, if (request == 1) 2 else 1, Activity.RESULT_CANCELED, null)
                    receive(activity, request, Activity.RESULT_CANCELED, null)
                    assertEquals(pending, field(activity, "pendingPicker"))
                    noSecretsInBundle(activity, "P".repeat(43), uri.toString(), before.token.takeIf { it.isNotBlank() } ?: "generated-absent-token")
                }
                scenario.recreate(); scenario.awaitUiText(MoteI18n.text("将连接：{0}\n有效至：{1}\n确认后连接", node, "").substringBefore('\n'))
                scenario.onActivity { activity -> assertNull(field(activity, "pendingPicker")); assertNull(field(activity, "selection")) }
            }
            assertEquals(before, Settings(context).read())
        } finally { file.delete() }
    }

    @Test fun rotationDuringAcceptedLocalReadRetainsSelectionUntilItsUiCallback() {
        val before = Settings(context).read(); require(!Settings(context).enabled)
        val release = CountDownLatch(1); val entered = CountDownLatch(1); val done = CountDownLatch(1)
        var oldExecutor: ExecutorService? = null
        val node = "https://generated-inflight-picker.invalid"
        try {
            ActivityScenario.launch(ConnectionActivity::class.java).awaitUiText(MoteI18n.text("确认连接此节点")).use { scenario ->
                scenario.onActivity { activity ->
                    oldExecutor = field(activity, "executor") as ExecutorService
                    oldExecutor!!.execute { entered.countDown(); try { check(release.await(20, TimeUnit.SECONDS)) } finally { done.countDown() } }
                }
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                scenario.onActivity { activity ->
                    arm(activity, 1); receive(activity, 1, Activity.RESULT_OK, Intent().putExtra("invitation", raw(node)))
                    assertEquals(true, field(activity, "working")); assertNotNull(field(activity, "pendingPicker")); assertNotNull(field(activity, "selection"))
                    noSecretsInBundle(activity, "P".repeat(43))
                }
                scenario.recreate(); scenario.awaitUiText(MoteI18n.text("将连接：{0}\n有效至：{1}\n确认后连接", node, "").substringBefore('\n'))
                scenario.onActivity { activity -> assertNull(field(activity, "pendingPicker")); assertNull(field(activity, "selection")) }
            }
            assertEquals(before, Settings(context).read())
        } finally { release.countDown(); assertTrue(done.await(5, TimeUnit.SECONDS)); assertTrue(oldExecutor!!.awaitTermination(5, TimeUnit.SECONDS)) }
    }

    @Test fun changedConfigurationRejectsThePickerWithItsSpecificSafeMessage() {
        val settings = Settings(context); val before = settings.read(); require(!settings.enabled)
        try {
            ActivityScenario.launch(ConnectionActivity::class.java).awaitUiText(MoteI18n.text("确认连接此节点")).use { scenario ->
                scenario.onActivity { arm(it, 1) }
                settings.save(before.copy(deviceName = "Generated changed device"))
                scenario.onActivity { receive(it, 1, Activity.RESULT_OK, Intent().putExtra("invitation", raw("https://generated-stale-picker.invalid"))) }
                scenario.awaitUiText(SettingsChangedFailure().message!!)
                scenario.onActivity { activity -> assertNull(field(activity, "pendingPicker")); assertNull(field(activity, "selection")) }
                assertEquals(before.server, settings.read().server)
            }
        } finally { settings.save(before) }
    }
}
