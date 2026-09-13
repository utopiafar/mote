package dev.mote.collector

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NotesDiagnosticsInstrumentedTest {
    @Test fun encryptedDraftRestoresNativeEditorAfterActivityRecreation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val drafts = QuickNotes.draft(context); drafts.clear()
        val value = "合成草稿：页面重建后仍保留\n  以及原来的空白。"
        fun editor(view: android.view.View): android.widget.EditText? {
            if (view is android.widget.EditText && view.hint?.toString() == "记下此刻的想法…") return view
            if (view is android.view.ViewGroup) for (index in 0 until view.childCount) editor(view.getChildAt(index))?.let { return it }
            return null
        }
        androidx.test.core.app.ActivityScenario.launch(MainActivity::class.java).use { activity ->
            try {
                activity.onActivity { editor(it.window.decorView)!!.setText(value) }
                assertEquals(value, drafts.read().text)
                val stored = java.io.File(context.noBackupFilesDir, "note-draft/draft.enc").readBytes()
                assertFalse(String(stored).contains("合成草稿"))
                activity.recreate()
                activity.onActivity { assertEquals(value, editor(it.window.decorView)!!.text.toString()) }
            } finally { drafts.clear() }
        }
    }
    @Test fun numericDiagnosticsContainOnlyAllowedFieldsAndRespectOptIn() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val settings = Settings(context); val original = settings.read()
        val config = original.copy(server = "http://127.0.0.1:1", token = "synthetic-diagnostics-fixture-token-only", debugHttp = true, diagnosticsEnabled = true)
        try {
            settings.save(config)
            val diagnostics = Diagnostics(context)
            diagnostics.add("capturedCount"); diagnostics.timing("inferenceMs", 1234)
            diagnostics.sample(config, true)
            val result = JSONObject(diagnostics.export()); val samples = result.getJSONArray("samples")
            val sample = samples.getJSONObject(samples.length() - 1)
            assertEquals(1234, sample.getLong("inferenceMs")); assertTrue(sample.has("batteryPct")); assertTrue(sample.has("queueBytes"))
            assertThrows(IllegalArgumentException::class.java) { diagnostics.add("ocrText") }
            settings.save(config.copy(diagnosticsEnabled = false)); diagnostics.add("capturedCount"); diagnostics.sample(config.copy(diagnosticsEnabled = false), true)
            assertEquals(result.toString(), JSONObject(diagnostics.export()).toString())
        } finally { if (original.server.isNotBlank()) settings.save(original) else settings.save(config.copy(diagnosticsEnabled = false)) }
    }
    @Test fun explicitNoteUploadsWithoutScreenshotOrModelDependency() {
        val args = InstrumentationRegistry.getArguments()
        val url = args.getString("fixtureServer") ?: return
        val token = args.getString("fixtureToken") ?: error("fixtureToken required")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val settings = Settings(context); val original = settings.read()
        val config = original.copy(server = url, token = token, debugHttp = true, wifiOnly = false, deviceName = "Android generated-note fixture")
        try {
            assertEquals(0, context.queue().depth()); settings.save(config)
            val id = QuickNotes.save(context, "合成随手记：今天完成了本机模型和离线同步验证。", "平静（合成）")
            val deadline = System.nanoTime() + 45_000_000_000L
            while (context.queue().depth() > 0 && System.nanoTime() < deadline) Thread.sleep(100)
            assertEquals("Central must acknowledge the generated note", 0, context.queue().depth())
            java.io.File(context.filesDir, "note-fixture-result.txt").writeText(id)
        } finally { if (original.server.isNotBlank()) settings.save(original) }
    }
}
