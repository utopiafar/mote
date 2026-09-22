package dev.mote.collector

import androidx.test.core.app.ActivityScenario
import android.app.UiAutomation
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ProfileSupportInstrumentedTest {
    @Test fun developmentProfileIsIndependentAndSupportExportContainsNoSecretsOrDraft() {
        val instrumentation = InstrumentationRegistry.getInstrumentation(); val context = instrumentation.targetContext
        val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        val avd = automation.executeShellCommand("getprop ro.boot.qemu.avd_name").use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() } }
        assumeTrue(avd == "mote_fixture_api35" && BuildConfig.MOTE_PROFILE == "dev")
        assertEquals("dev.mote.collector.dev", context.packageName)
        assertTrue(context.noBackupFilesDir.absolutePath.contains(context.packageName))
        val settings = Settings(context); assertFalse(settings.enabled)
        val original = settings.read(); assertEquals("http://127.0.0.1:47842", original.server)
        assumeTrue("Fresh development fixture only", original.token.isBlank() && QuickNotes.draft(context).read().text.isBlank() && context.queue().depth() == 0)
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            scenario.onActivity { activity ->
                val texts = mutableListOf<String>()
                fun visit(view: android.view.View) {
                    if (view is android.widget.TextView) texts += view.text.toString()
                    if (view is android.view.ViewGroup) repeat(view.childCount) { visit(view.getChildAt(it)) }
                }
                fun views(v: android.view.View): List<android.view.View> = listOf(v) + if (v is android.view.ViewGroup) (0 until v.childCount).flatMap { views(v.getChildAt(it)) } else emptyList()
                views(activity.window.decorView).filterIsInstance<android.widget.TextView>().single { it.isShown && it.isClickable && it.text.toString()=="本机" }.performClick()
                views(activity.window.decorView).single { it.isShown && it.tag=="menu:关于与更新" }.performClick()
                views(activity.window.decorView).single { it.isShown && it.tag=="menu:开发者选项" }.performClick()
                visit(activity.window.decorView)
                assertTrue(texts.any { it.contains("环境：dev") && it.contains(context.noBackupFilesDir.absolutePath) })
                views(activity.window.decorView).filterIsInstance<android.widget.TextView>().single { it.isShown && it.isClickable && it.text.toString()=="本机" }.performClick()
                views(activity.window.decorView).single { it.isShown && it.tag=="menu:诊断与支持" }.performClick()
                texts.clear(); visit(activity.window.decorView); assertTrue(texts.contains("导出安全支持包 JSON"))
            }
        }
        val id = settings.deviceId
        val fixture = original.copy(token = "synthetic-profile-secret-0123456789", diagnosticsEnabled = true, deviceName = "private fixture name")
        try {
            settings.save(fixture); QuickNotes.draft(context).update("private fixture note", "private mood")
            SupportEvents.record(context, EventStage.UPLOAD, EventCode.AUTH, httpStatus = 401)
            val report = SupportEvents.export(context); val body = JSONObject(report)
            assertEquals("dev", body.getJSONObject("app").getString("profile"))
            val exportedStrings = mutableListOf<String>()
            fun strings(value: Any?) { when (value) {
                is String -> exportedStrings += value
                is JSONObject -> value.keys().forEach { strings(value.opt(it)) }
                is org.json.JSONArray -> repeat(value.length()) { strings(value.opt(it)) }
            } }
            strings(body)
            for (privateValue in listOf(fixture.token, fixture.deviceName, fixture.nsfw.policy, "private fixture note", "private mood", id, fixture.server)) { assertFalse(report.contains(privateValue)); assertFalse(exportedStrings.any { it.contains(privateValue) }) }
            val count = body.getJSONArray("events").length(); assertTrue(count > 0)
            settings.save(fixture.copy(diagnosticsEnabled = false)); SupportEvents.record(context, EventStage.QUEUE, EventCode.STORAGE)
            assertEquals(count, SupportEvents.journal(context).read().length())
            assertEquals(id, Settings(context).deviceId)
        } finally { QuickNotes.draft(context).clear(); context.getSharedPreferences("mote", 0).edit().clear().putString("deviceId", id).commit(); settings.enabled = false }
    }
}
